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
  candleTime: number;          // unix sec — signal candle
  entryTime: number;           // unix sec — entry candle (next candle)
  action: "LONG" | "SHORT";
  entryPrice: number;          // next candle OPEN (no lookahead)
  stopLoss: number;
  takeProfit: number;
  fundingZScore: number;
  adx: number;
  rsi: number;
  regime: string;
  edgeSource: string;
  // Outcome
  status: "target_hit" | "stopped_out" | "gap_stopped" | "expired";
  exitPrice: number;
  exitTime: number;
  rawPnlPct: number;           // P&L before costs
  costPct: number;             // total round-trip cost (fee + slippage)
  netPnlPct: number;           // P&L after costs
  holdHours: number;
  won: boolean;                // netPnlPct > 0
}

export interface ReplayResult {
  pair: string;
  totalSignals: number;
  wins: number;
  losses: number;
  winRate: number;             // net win rate (after costs)
  avgPnlPct: number;           // net avg P&L
  totalPnlPct: number;         // net cumulative P&L
  avgHoldHours: number;
  sharpeRatio: number;         // net Sharpe
  maxDrawdownPct: number;
  bestTrade: number;
  worstTrade: number;
  // Frictionless comparison (before costs)
  frictionlessWinRate: number;
  frictionlessTotalPnl: number;
  frictionlessSharpe: number;
  // Cost stats
  avgCostPct: number;
  totalCostPct: number;
  byEdge: { edge: string; count: number; winRate: number; netPnlPct: number; frictionlessPnlPct: number }[];
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

  // Cost model: INDODAX fee 0.3% per side (taker) + ~0.05% slippage per side
  // for small orders. Total round-trip: 0.7%.
  // This is CONSERVATIVE — actual could be higher for thin pairs.
  const FEE_PER_SIDE = 0.003;      // 0.3%
  const SLIPPAGE_PER_SIDE = 0.0005; // 0.05% (small orders)
  const ROUND_TRIP_COST = (FEE_PER_SIDE + SLIPPAGE_PER_SIDE) * 2; // 0.7%

  for (let i = minWarmup; i < candles.length - 25; i++) {
    const candle = candles[i];
    const candleTime = candle.time;

    // === PREFIX-ONLY: all data used here is from candle i and before ===

    // Funding z-score: only rates available up to candleTime
    let activeRate: number | null = null;
    let fundingRatesUpToNow: number[] = [];
    for (const f of fundingHistory) {
      if (f.time <= candleTime) {
        activeRate = f.rate;
        fundingRatesUpToNow.push(f.rate);
      }
    }
    if (activeRate === null || fundingRatesUpToNow.length < 20) continue;

    const ratesForZ = fundingRatesUpToNow.slice(-180);
    const mean = ratesForZ.reduce((a, b) => a + b, 0) / ratesForZ.length;
    const std = Math.sqrt(ratesForZ.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / ratesForZ.length);
    const zScore = std > 0 ? (activeRate - mean) / std : 0;

    // Regime: only candles up to i
    const candleSlice = candles.slice(0, i + 1);
    const atr = calcATR(candleSlice, 14);
    const adx = approximateADX(candleSlice);
    const rsi = calcRSI(candleSlice, 14);
    const dailySlice = resample1hTo1d(candleSlice);
    const regime = dailySlice.length >= 7 ? detectRegime(candleSlice, dailySlice) : null;
    const dailyTrend = regime?.dailyTrend ?? "neutral";

    // Determine action
    let action: "LONG" | "SHORT" | null = null;
    let edgeSource = "";

    if (zScore > 2 && (adx < 20 || dailyTrend === "bearish")) {
      action = "SHORT"; edgeSource = "funding_contrarian";
    } else if (zScore < -2 && (adx < 20 || dailyTrend === "bullish")) {
      action = "LONG"; edgeSource = "funding_contrarian";
    } else if (adx > 25 && dailyTrend !== "neutral") {
      action = dailyTrend === "bullish" ? "LONG" : "SHORT"; edgeSource = "trend_follow";
    } else if (adx < 20 && (rsi < 30 || rsi > 70)) {
      action = rsi < 30 ? "LONG" : "SHORT"; edgeSource = "mean_revert";
    }

    if (!action) continue;

    // === ANTI-LOOKAHEAD: entry at NEXT candle's open ===
    // Signal is generated at candle i's close. Entry executes at candle i+1's open.
    // This simulates 1-bar latency (you see the signal, then place order).
    const entryCandle = candles[i + 1];
    const entry = entryCandle.open;
    const entryTime = entryCandle.time;
    const stop = action === "LONG" ? entry - 2 * atr : entry + 2 * atr;
    const target = action === "LONG" ? entry + 3 * atr : entry - 3 * atr;

    // === GAP-THROUGH CHECK: if entry candle opens beyond stop/target ===
    // If price gaps through the stop on entry, fill at open (worse than stop).
    // If price gaps through the target on entry, fill at open (better than target).
    let exitPrice = 0;
    let exitTime = entryTime;
    let status: "target_hit" | "stopped_out" | "gap_stopped" | "expired" = "expired";
    let holdHours = 0;

    if (action === "LONG") {
      if (entryCandle.open <= stop) {
        // Gap through stop on entry — fill at open (worse)
        exitPrice = entryCandle.open;
        status = "gap_stopped";
        holdHours = 0; // stopped on entry candle
      } else if (entryCandle.open >= target) {
        // Gap through target on entry — fill at open (better)
        exitPrice = entryCandle.open;
        status = "target_hit";
        holdHours = 0;
      } else {
        // Walk forward from entry candle to find stop/target
        for (let j = i + 1; j < Math.min(i + 49, candles.length); j++) {
          const future = candles[j];
          holdHours = j - i;
          if (future.low <= stop) { exitPrice = stop; exitTime = future.time; status = "stopped_out"; break; }
          if (future.high >= target) { exitPrice = target; exitTime = future.time; status = "target_hit"; break; }
        }
      }
    } else { // SHORT
      if (entryCandle.open >= stop) {
        exitPrice = entryCandle.open;
        status = "gap_stopped";
        holdHours = 0;
      } else if (entryCandle.open <= target) {
        exitPrice = entryCandle.open;
        status = "target_hit";
        holdHours = 0;
      } else {
        for (let j = i + 1; j < Math.min(i + 49, candles.length); j++) {
          const future = candles[j];
          holdHours = j - i;
          if (future.high >= stop) { exitPrice = stop; exitTime = future.time; status = "stopped_out"; break; }
          if (future.low <= target) { exitPrice = target; exitTime = future.time; status = "target_hit"; break; }
        }
      }
    }

    // If not exited, mark-to-market
    if (status === "expired") {
      const lastIdx = Math.min(i + 48, candles.length - 1);
      exitPrice = candles[lastIdx].close;
      exitTime = candles[lastIdx].time;
      holdHours = lastIdx - i;
    }

    // Raw P&L (frictionless)
    const rawPnlPct = action === "LONG"
      ? (exitPrice - entry) / entry
      : (entry - exitPrice) / entry;

    // Net P&L (after costs)
    const costPct = ROUND_TRIP_COST;
    const netPnlPct = rawPnlPct - costPct;

    signals.push({
      pair,
      candleTime,
      entryTime,
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
      rawPnlPct,
      costPct,
      netPnlPct,
      holdHours,
      won: netPnlPct > 0,
    });
  }

  if (signals.length === 0) {
    return emptyReplay(pair, "no signals would have fired in the replay period");
  }

  // NET stats (after costs)
  const wins = signals.filter((s) => s.won);
  const losses = signals.filter((s) => !s.won);
  const winRate = wins.length / signals.length;
  const avgNetPnl = signals.reduce((a, s) => a + s.netPnlPct, 0) / signals.length;
  const totalNetPnl = signals.reduce((a, s) => a + s.netPnlPct, 0);
  const avgHold = signals.reduce((a, s) => a + s.holdHours, 0) / signals.length;
  const stdNetPnl = Math.sqrt(signals.reduce((a, s) => a + Math.pow(s.netPnlPct - avgNetPnl, 2), 0) / signals.length);
  const netSharpe = stdNetPnl > 0 && avgHold > 0 ? (avgNetPnl / stdNetPnl) * Math.sqrt(365 * 24 / avgHold) : 0;

  // Max drawdown (net)
  let cumNet = 0, peakNet = 0, maxDD = 0;
  for (const s of signals) {
    cumNet += s.netPnlPct;
    if (cumNet > peakNet) peakNet = cumNet;
    const dd = peakNet - cumNet;
    if (dd > maxDD) maxDD = dd;
  }

  // FRICTIONLESS stats (before costs — for comparison)
  const frictionlessWins = signals.filter((s) => s.rawPnlPct > 0);
  const frictionlessWinRate = frictionlessWins.length / signals.length;
  const frictionlessTotalPnl = signals.reduce((a, s) => a + s.rawPnlPct, 0);
  const avgRawPnl = signals.reduce((a, s) => a + s.rawPnlPct, 0) / signals.length;
  const stdRawPnl = Math.sqrt(signals.reduce((a, s) => a + Math.pow(s.rawPnlPct - avgRawPnl, 2), 0) / signals.length);
  const frictionlessSharpe = stdRawPnl > 0 && avgHold > 0 ? (avgRawPnl / stdRawPnl) * Math.sqrt(365 * 24 / avgHold) : 0;

  // Cost stats
  const avgCost = signals.reduce((a, s) => a + s.costPct, 0) / signals.length;
  const totalCost = signals.reduce((a, s) => a + s.costPct, 0);

  // Per-edge breakdown (net + frictionless)
  const edgeMap = new Map<string, { count: number; wins: number; netPnl: number; rawPnl: number }>();
  for (const s of signals) {
    const e = edgeMap.get(s.edgeSource) ?? { count: 0, wins: 0, netPnl: 0, rawPnl: 0 };
    e.count++;
    if (s.won) e.wins++;
    e.netPnl += s.netPnlPct;
    e.rawPnl += s.rawPnlPct;
    edgeMap.set(s.edgeSource, e);
  }
  const byEdge = Array.from(edgeMap.entries()).map(([edge, e]) => ({
    edge, count: e.count, winRate: e.wins / e.count, netPnlPct: e.netPnl, frictionlessPnlPct: e.rawPnl,
  }));

  return {
    pair,
    totalSignals: signals.length,
    wins: wins.length,
    losses: losses.length,
    winRate,
    avgPnlPct: avgNetPnl,
    totalPnlPct: totalNetPnl,
    avgHoldHours: avgHold,
    sharpeRatio: netSharpe,
    maxDrawdownPct: maxDD,
    bestTrade: Math.max(...signals.map((s) => s.netPnlPct)),
    worstTrade: Math.min(...signals.map((s) => s.netPnlPct)),
    frictionlessWinRate,
    frictionlessTotalPnl,
    frictionlessSharpe,
    avgCostPct: avgCost,
    totalCostPct: totalCost,
    byEdge,
    signals,
    description: `Replay (${candles.length} candles, ≈${Math.floor(candles.length / 24)} days, anti-lookahead + cost-adjusted): ${signals.length} signals. NET win ${(winRate * 100).toFixed(0)}%, net P&L ${(totalNetPnl * 100).toFixed(1)}%, net Sharpe ${netSharpe.toFixed(1)}, max DD ${(maxDD * 100).toFixed(1)}%. Frictionless: ${(frictionlessWinRate * 100).toFixed(0)}% win, ${(frictionlessTotalPnl * 100).toFixed(1)}% P&L. Cost drag: ${(totalCost * 100).toFixed(1)}% total. Edges: ${byEdge.map((e) => `${e.edge}(n=${e.count} net=${(e.netPnlPct * 100).toFixed(1)}% vs raw=${(e.frictionlessPnlPct * 100).toFixed(1)}%)`).join(", ")}`,
  };
}

function emptyReplay(pair: string, reason: string): ReplayResult {
  return {
    pair, totalSignals: 0, wins: 0, losses: 0, winRate: 0, avgPnlPct: 0,
    totalPnlPct: 0, avgHoldHours: 0, sharpeRatio: 0, maxDrawdownPct: 0,
    bestTrade: 0, worstTrade: 0, frictionlessWinRate: 0, frictionlessTotalPnl: 0,
    frictionlessSharpe: 0, avgCostPct: 0, totalCostPct: 0, byEdge: [], signals: [],
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
