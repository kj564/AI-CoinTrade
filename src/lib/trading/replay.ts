// Historical Signal Replay Engine
//
// Instead of waiting 30-90 days for live paper trading, this module replays
// the last 500 1h candles (≈21 days) with the FULL signal engine logic to
// determine what signals WOULD have fired and what their outcomes WOULD
// have been.
//
// At each historical candle, we reconstruct:
//   1. Funding z-score: align Binance funding rate history (180 rates, 8h each)
//      to candle timestamps. For each candle, find the funding rate active at
//      that time and compute z-score using rates available up to that point.
//   2. Regime: compute ADX + ATR from candle history up to that point.
//   3. Absorption proxy: volume / |body| ratio (same as absorption-validation.ts)
//
// Then apply the same signal logic as alpha-engine.ts:
//   - If funding z > 2 + regime aligned → contrarian signal
//   - If ADX > 25 + trend → trend-following signal
//   - If ADX < 20 + RSI extreme → mean-reversion signal
//   - Else → FLAT
//
// For each non-FLAT signal, simulate the trade:
//   - Entry at candle close
//   - Stop at 2 ATR below/above
//   - Target at 3 ATR (1.5R since risk=2 ATR, reward=3 ATR)
//   - Walk forward through subsequent candles to check stop/target hit
//   - Record outcome: win/loss, PnL, hold hours
//
// Aggregate all replayed signals into portfolio stats. This gives immediate
// OOS data: "In the last 21 days, the engine would have generated N signals.
// Win rate X%, P&L Y, Sharpe Z."

import { getBinanceKlinesWithMeta } from "./binance-klines";
import { getFundingRate } from "./funding";
import { calcATR, type Candle } from "./backtest";
import { detectRegime } from "./regime";

export interface ReplayedSignal {
  pair: string;
  candleTime: number;          // unix sec
  action: "LONG" | "SHORT";
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  fundingZScore: number;
  adx: number;
  rsi: number;
  regime: string;
  edgeSource: string;          // "funding_contrarian" | "trend_follow" | "mean_revert"
  // Outcome
  status: "target_hit" | "stopped_out" | "expired";
  exitPrice: number;
  exitTime: number;            // unix sec
  pnlPct: number;
  holdHours: number;
  won: boolean;
}

export interface ReplayResult {
  pair: string;
  totalSignals: number;
  wins: number;
  losses: number;
  winRate: number;
  avgPnlPct: number;
  totalPnlPct: number;         // cumulative P&L as % of capital per trade
  avgHoldHours: number;
  sharpeRatio: number;
  maxDrawdownPct: number;
  bestTrade: number;
  worstTrade: number;
  byEdge: { edge: string; count: number; winRate: number; pnlPct: number }[];
  signals: ReplayedSignal[];
  description: string;
}

// Fetch funding rate history and align to candle timestamps.
// Each funding rate covers 8h. We need the funding rate that was active at
// each candle's timestamp.
async function getFundingHistoryAligned(pair: string): Promise<{ time: number; rate: number }[]> {
  const coin = pair.replace("_idr", "").toUpperCase();
  const symbol = `${coin}USDT`;
  try {
    const r = await fetch(`https://fapi.binance.com/fapi/v1/fundingRate?symbol=${symbol}&limit=180`, { next: { revalidate: 300 } });
    if (!r.ok) return [];
    const data = await r.json();
    if (!Array.isArray(data)) return [];
    return data.map((h: any) => ({ time: Math.floor(h.fundingTime / 1000), rate: parseFloat(h.fundingRate || "0") }));
  } catch {
    return [];
  }
}

// Compute RSI from candle closes
function calcRSI(candles: Candle[], period = 14): number {
  const closes = candles.map((c) => c.close);
  if (closes.length < period + 1) return 50;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) avgGain += d; else avgLoss -= d;
  }
  avgGain /= period; avgLoss /= period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const gain = d > 0 ? d : 0, loss = d < 0 ? -d : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }
  return avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
}

// Approximate ADX
function approximateADX(candles: Candle[]): number {
  const n = candles.length;
  if (n < 30) return 20;
  const period = 14;
  let plusDM = 0, minusDM = 0;
  for (let i = n - period; i < n; i++) {
    if (i < 1) continue;
    const up = candles[i].high - candles[i - 1].high;
    const dn = candles[i - 1].low - candles[i].low;
    if (up > dn && up > 0) plusDM += up;
    if (dn > up && dn > 0) minusDM += dn;
  }
  const total = plusDM + minusDM;
  if (total === 0) return 15;
  return Math.min(60, (Math.abs(plusDM - minusDM) / total) * 100 * 1.3);
}

export async function replaySignals(pair: string): Promise<ReplayResult> {
  const [klinesResult] = await Promise.all([
    getBinanceKlinesWithMeta(pair, "1h", 500),
  ]);
  const candles = klinesResult.candles;
  if (candles.length < 100) {
    return emptyReplay(pair, "insufficient candle data");
  }

  const fundingHistory = await getFundingHistoryAligned(pair);
  if (fundingHistory.length < 30) {
    return emptyReplay(pair, "insufficient funding history");
  }

  const signals: ReplayedSignal[] = [];
  const minWarmup = 50;

  for (let i = minWarmup; i < candles.length - 24; i++) {
    const candle = candles[i];
    const candleTime = candle.time;

    // Find funding rate active at this candle's time
    // Funding rates are 8h apart. Find the most recent rate before candleTime.
    let activeRate: number | null = null;
    let fundingRatesUpToNow: number[] = [];
    for (const f of fundingHistory) {
      if (f.time <= candleTime) {
        activeRate = f.rate;
        fundingRatesUpToNow.push(f.rate);
      }
    }
    if (activeRate === null || fundingRatesUpToNow.length < 20) continue;

    // Compute funding z-score using rates available up to this point
    const ratesForZ = fundingRatesUpToNow.slice(-180); // up to 180 rates
    const mean = ratesForZ.reduce((a, b) => a + b, 0) / ratesForZ.length;
    const std = Math.sqrt(ratesForZ.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / ratesForZ.length);
    const zScore = std > 0 ? (activeRate - mean) / std : 0;

    // Compute regime from candle history up to this point
    const candleSlice = candles.slice(0, i + 1);
    const atr = calcATR(candleSlice, 14);
    const adx = approximateADX(candleSlice);
    const rsi = calcRSI(candleSlice, 14);
    const dailySlice = resample1hTo1d(candleSlice);
    const regime = dailySlice.length >= 7 ? detectRegime(candleSlice, dailySlice) : null;
    const dailyTrend = regime?.dailyTrend ?? "neutral";

    // Determine what action WOULD have fired
    let action: "LONG" | "SHORT" | null = null;
    let edgeSource = "";

    // Edge 1: Funding contrarian
    if (zScore > 2 && (adx < 20 || dailyTrend === "bearish")) {
      action = "SHORT";
      edgeSource = "funding_contrarian";
    } else if (zScore < -2 && (adx < 20 || dailyTrend === "bullish")) {
      action = "LONG";
      edgeSource = "funding_contrarian";
    }
    // Edge 2: Trend following
    else if (adx > 25 && dailyTrend !== "neutral") {
      action = dailyTrend === "bullish" ? "LONG" : "SHORT";
      edgeSource = "trend_follow";
    }
    // Edge 3: Mean reversion
    else if (adx < 20 && (rsi < 30 || rsi > 70)) {
      action = rsi < 30 ? "LONG" : "SHORT";
      edgeSource = "mean_revert";
    }

    if (!action) continue; // would have been FLAT

    // Simulate the trade
    const entry = candle.close;
    const stop = action === "LONG" ? entry - 2 * atr : entry + 2 * atr;
    const target = action === "LONG" ? entry + 3 * atr : entry - 3 * atr;

    // Walk forward through subsequent candles to find exit
    let exitPrice = entry;
    let exitTime = candleTime;
    let status: "target_hit" | "stopped_out" | "expired" = "expired";
    let holdHours = 0;

    for (let j = i + 1; j < Math.min(i + 48, candles.length); j++) {
      const future = candles[j];
      holdHours = j - i;

      if (action === "LONG") {
        if (future.low <= stop) { exitPrice = stop; exitTime = future.time; status = "stopped_out"; break; }
        if (future.high >= target) { exitPrice = target; exitTime = future.time; status = "target_hit"; break; }
      } else {
        if (future.high >= stop) { exitPrice = stop; exitTime = future.time; status = "stopped_out"; break; }
        if (future.low <= target) { exitPrice = target; exitTime = future.time; status = "target_hit"; break; }
      }
    }

    // If not exited, mark-to-market at last checked candle
    if (status === "expired") {
      const lastIdx = Math.min(i + 47, candles.length - 1);
      exitPrice = candles[lastIdx].close;
      exitTime = candles[lastIdx].time;
      holdHours = lastIdx - i;
    }

    const pnlPct = action === "LONG"
      ? (exitPrice - entry) / entry
      : (entry - exitPrice) / entry;

    signals.push({
      pair,
      candleTime,
      action,
      entryPrice: entry,
      stopLoss: stop,
      takeProfit: target,
      fundingZScore: zScore,
      adx,
      rsi,
      regime: regime?.regime ?? "unknown",
      edgeSource,
      status,
      exitPrice,
      exitTime,
      pnlPct,
      holdHours,
      won: pnlPct > 0,
    });
  }

  if (signals.length === 0) {
    return emptyReplay(pair, "no signals would have fired in the replay period");
  }

  // Aggregate stats
  const wins = signals.filter((s) => s.won);
  const losses = signals.filter((s) => !s.won);
  const winRate = wins.length / signals.length;
  const avgPnl = signals.reduce((a, s) => a + s.pnlPct, 0) / signals.length;
  const totalPnl = signals.reduce((a, s) => a + s.pnlPct, 0);
  const avgHold = signals.reduce((a, s) => a + s.holdHours, 0) / signals.length;
  const stdPnl = Math.sqrt(signals.reduce((a, s) => a + Math.pow(s.pnlPct - avgPnl, 2), 0) / signals.length);
  const sharpe = stdPnl > 0 && avgHold > 0 ? (avgPnl / stdPnl) * Math.sqrt(365 * 24 / avgHold) : 0;

  // Max drawdown (cumulative P&L peak-to-trough)
  let cumPnl = 0, peak = 0, maxDD = 0;
  for (const s of signals) {
    cumPnl += s.pnlPct;
    if (cumPnl > peak) peak = cumPnl;
    const dd = peak - cumPnl;
    if (dd > maxDD) maxDD = dd;
  }

  // Per-edge breakdown
  const edgeMap = new Map<string, { count: number; wins: number; pnl: number }>();
  for (const s of signals) {
    const e = edgeMap.get(s.edgeSource) ?? { count: 0, wins: 0, pnl: 0 };
    e.count++;
    if (s.won) e.wins++;
    e.pnl += s.pnlPct;
    edgeMap.set(s.edgeSource, e);
  }
  const byEdge = Array.from(edgeMap.entries()).map(([edge, e]) => ({
    edge, count: e.count, winRate: e.wins / e.count, pnlPct: e.pnl,
  }));

  return {
    pair,
    totalSignals: signals.length,
    wins: wins.length,
    losses: losses.length,
    winRate,
    avgPnlPct: avgPnl,
    totalPnlPct: totalPnl,
    avgHoldHours: avgHold,
    sharpeRatio: sharpe,
    maxDrawdownPct: maxDD,
    bestTrade: Math.max(...signals.map((s) => s.pnlPct)),
    worstTrade: Math.min(...signals.map((s) => s.pnlPct)),
    byEdge,
    signals,
    description: `Replay (${candles.length} candles, ≈${Math.floor(candles.length / 24)} days): ${signals.length} signals would have fired. Win rate ${(winRate * 100).toFixed(0)}%, avg P&L ${(avgPnl * 100).toFixed(2)}%, Sharpe ${sharpe.toFixed(1)}, max DD ${(maxDD * 100).toFixed(1)}%. Edges: ${byEdge.map((e) => `${e.edge}(${e.count}w/${(e.winRate * 100).toFixed(0)}%)`).join(", ")}`,
  };
}

function emptyReplay(pair: string, reason: string): ReplayResult {
  return {
    pair, totalSignals: 0, wins: 0, losses: 0, winRate: 0, avgPnlPct: 0,
    totalPnlPct: 0, avgHoldHours: 0, sharpeRatio: 0, maxDrawdownPct: 0,
    bestTrade: 0, worstTrade: 0, byEdge: [], signals: [],
    description: `Replay: ${reason}`,
  };
}

function resample1hTo1d(candles1h: Candle[]): Candle[] {
  const daySec = 86400;
  const buckets = new Map<number, Candle>();
  for (const c of candles1h) {
    const bucket = Math.floor(c.time / daySec) * daySec;
    const existing = buckets.get(bucket);
    if (!existing) {
      buckets.set(bucket, { time: bucket, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume });
    } else {
      existing.high = Math.max(existing.high, c.high);
      existing.low = Math.min(existing.low, c.low);
      existing.close = c.close;
      existing.volume += c.volume;
    }
  }
  return Array.from(buckets.values()).sort((a, b) => a.time - b.time);
}
