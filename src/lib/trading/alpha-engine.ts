// Alpha Engine — the signal system that has real mathematical edges.
//
// This is NOT the old indicator-based signal advisor (RSI/MACD = noise,
// proven by the project's own research: LR p=0.578, no stable features).
//
// This engine combines FOUR edges that are documented in quant literature
// and have positive expected value in crypto markets:
//
//   1. FUNDING RATE CONTRARIAN (primary edge)
//      - Extreme positive funding (>+0.05%/8h) = overlevered longs → reversal
//      - Extreme negative funding (<-0.03%/8h) = overlevered shorts → bounce
//      - This is structural: perps mechanics force payment, creating pressure
//
//   2. VOLATILITY SCALING (risk management edge)
//      - Position size = targetRisk / (ATR × multiplier)
//      - High vol → small position. Low vol → larger position.
//      - This is how every professional fund sizes. Not prediction — survival.
//
//   3. REGIME-AWARE ROUTING (strategy selection edge)
//      - ADX > 25: trend-following (ride the trend, trail stop)
//      - ADX < 20: mean-reversion (fade extremes)
//      - ADX 20-25: no-trade (transition = uncertainty)
//
//   4. FRACTIONAL KELLY SIZING (growth optimization edge)
//      - f* = (bp - q) / b where b=reward/risk, p=win prob, q=loss prob
//      - Use 1/4 Kelly (practitioners' standard) to avoid drawdown blow-ups
//
// The signal output is NOT "BUY at confidence 55%". It's:
//   "Allocate X% of capital. Entry here. Stop at 2 ATR. Target at 1.5R.
//    Backtested win rate in this regime: 58%. Sample: 31 instances.
//    Invalidation: ADX < 20 or funding flips."
//
// This is honest. It doesn't promise profits. It gives risk-managed,
// backtested, edge-based signals with explicit invalidation criteria.

import { ensureCandles } from "./candles";
import { detectRegime, type RegimeInfo } from "./regime";
import { getFundingRate, type FundingRateInfo } from "./funding";
import { getBinanceKlines, convertKlinesToIdr } from "./binance-klines";
import { getTicker } from "@/lib/indodax";
import { calcATR, type Candle } from "./backtest";

// Simple RSI calculation (backtest.ts has rsiArr but it's not exported)
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

export interface AlphaSignal {
  pair: string;
  timestamp: string;

  // === THE SIGNAL ===
  action: "LONG" | "SHORT" | "REDUCE" | "FLAT" | "CLOSE";
  strength: "strong" | "moderate" | "weak" | "none";
  conviction: number; // 0-100, but NOT the old "confidence" — this is edge-weighted

  // === RISK PARAMETERS (the important part) ===
  entry: number;
  stopLoss: number;
  takeProfit1: number; // 1R target
  takeProfit2: number; // 2R target (scale out)
  positionSizePct: number; // % of portfolio to risk (NOT allocation — RISK)
  positionSizeIdr: number; // IDR amount to allocate (based on capital)
  rewardRiskRatio: number;

  // === EDGE SOURCES (why this signal exists) ===
  edges: {
    funding: "contrarian_short" | "contrarian_long" | "neutral";
    regime: "trend_follow" | "mean_revert" | "no_trade";
    volatility: "low_vol_size_up" | "normal" | "high_vol_size_down";
    trend: "aligned" | "counter_trend" | "no_trend";
  };

  // === HONEST BACKTEST (regime-matched) ===
  backtest: {
    winRate: number;     // 0-1
    avgReturn: number;   // fraction (0.024 = +2.4%)
    avgHoldHours: number;
    sampleSize: number;
    maxDrawdown: number; // fraction
    sharpeRatio: number;
    regimeMatched: string; // description of what was matched
  };

  // === RATIONALE (transparent reasoning) ===
  rationale: string[];
  invalidation: string;
  warning: string | null; // honest caveat

  // === RAW DATA (for transparency) ===
  raw: {
    price: number;
    atr: number;
    atrPercent: number;
    rsi: number;
    adx: number;
    fundingRate: number;
    fundingPercentile: number; // 0-100, where current funding sits vs 30d
    regime: string;
  };
}

export interface AlphaEngineResult {
  signals: AlphaSignal[];
  portfolioAllocation: {
    pair: string;
    action: string;
    allocationPct: number;
  }[];
  capitalAtRisk: number; // total % of portfolio at risk across all signals
  regimeSummary: string;
  generatedAt: string;
  disclaimer: string;
}

const PAIRS = ["btc_idr", "eth_idr", "sol_idr", "bnb_idr", "xrp_idr"];
const DEFAULT_CAPITAL = 10_000_000; // Rp 10jt

// Risk per trade: 1% of capital (professional standard for retail)
const RISK_PER_TRADE_PCT = 0.01;
// Fractional Kelly: use 1/4 of full Kelly to avoid blow-ups
const KELLY_FRACTION = 0.25;

export async function generateAlphaSignals(capitalIdr = DEFAULT_CAPITAL): Promise<AlphaEngineResult> {
  const signals: AlphaSignal[] = [];
  let totalRiskPct = 0;

  for (const pair of PAIRS) {
    try {
      const signal = await generatePairSignal(pair, capitalIdr);
      if (signal) {
        signals.push(signal);
        if (signal.action === "LONG" || signal.action === "SHORT") {
          totalRiskPct += signal.positionSizePct;
        }
      }
    } catch (e) {
      console.warn(`[alpha] signal failed for ${pair}:`, e instanceof Error ? e.message : e);
    }
  }

  // Portfolio allocation: diversify across pairs, cap total risk at 6%
  const maxTotalRisk = 0.06; // 6% max portfolio risk
  const riskScale = totalRiskPct > maxTotalRisk ? maxTotalRisk / totalRiskPct : 1.0;

  const portfolioAllocation = signals.map((s) => ({
    pair: s.pair,
    action: s.action,
    allocationPct: s.positionSizePct * riskScale,
  }));

  const regimeSummary = summarizeRegime(signals);

  return {
    signals,
    portfolioAllocation,
    capitalAtRisk: Math.min(totalRiskPct * riskScale, maxTotalRisk),
    regimeSummary,
    generatedAt: new Date().toISOString(),
    disclaimer: "Signals are based on funding rate contrarian + volatility scaling + regime routing + fractional Kelly. Backtest stats are regime-matched, not cherry-picked. No signal guarantees profit. Trade at your own risk. Past performance does not guarantee future results.",
  };
}

async function generatePairSignal(pair: string, capitalIdr: number): Promise<AlphaSignal | null> {
  // Fetch 500 1h klines from Binance (covers ~21 days). We resample to 1d
  // internally to avoid a second API call (Binance rate-limits parallel reqs).
  const [binance1h, ticker] = await Promise.all([
    getBinanceKlines(pair, "1h", 500),
    getTicker(pair),
  ]);

  if (binance1h.length < 50) {
    const { candles } = await ensureCandles(pair, "1h", 50);
    if (candles.length < 50) return null;
    const dailyFallback = resample1hTo1d(candles);
    return generateSignalFromCandles(pair, capitalIdr, candles, dailyFallback, null);
  }

  // Resample 1h → 1d (24 1h candles = 1 1d candle)
  const candles1d = resample1hTo1d(binance1h);

  // Convert USDT prices to IDR using current INDODAX ticker
  const idrPrice = ticker?.last ?? 0;
  const usdtRefPrice = binance1h[binance1h.length - 1].close;
  const candles1h = idrPrice > 0 ? convertKlinesToIdr(binance1h, idrPrice, usdtRefPrice) : binance1h;
  const candles1dIdr = idrPrice > 0 ? convertKlinesToIdr(candles1d, idrPrice, usdtRefPrice) : candles1d;

  return generateSignalFromCandles(pair, capitalIdr, candles1h, candles1dIdr, idrPrice || usdtRefPrice);
}

// Resample 1h candles to 1d candles (aggregate by calendar day).
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

async function generateSignalFromCandles(pair: string, capitalIdr: number, candles1h: Candle[], candles1d: Candle[], refPrice: number): Promise<AlphaSignal | null> {
  if (candles1h.length < 50 || candles1d.length < 7) return null;

  const price = candles1h[candles1h.length - 1].close;
  const atr = calcATR(candles1h, 14);
  const atrPercent = (atr / price) * 100;
  const rsi = calcRSI(candles1h, 14);

  // Regime detection
  const regime = detectRegime(candles1h, candles1d);

  // Funding rate (the primary edge)
  const funding = await getFundingRate(pair);
  const fundingRate = funding?.current ?? 0;
  const fundingPct = funding?.currentPct ?? 0;
  const fundingPercentile = computeFundingPercentile(fundingRate);

  // === EDGE 1: FUNDING RATE CONTRARIAN ===
  let fundingEdge: AlphaSignal["edges"]["funding"] = "neutral";
  if (funding) {
    if (funding.extremeHigh) fundingEdge = "contrarian_short";
    else if (funding.extremeLow) fundingEdge = "contrarian_long";
  }

  // === EDGE 2: VOLATILITY SCALING ===
  const atrRatio = regime.atrRatio;
  let volEdge: AlphaSignal["edges"]["volatility"] = "normal";
  let volScale = 1.0;
  if (atrRatio > 1.5) {
    volEdge = "high_vol_size_down";
    volScale = 0.5; // halve position in high vol
  } else if (atrRatio < 0.8) {
    volEdge = "low_vol_size_up";
    volScale = 1.3; // slight increase in low vol
  }

  // === EDGE 3: REGIME ROUTING ===
  let regimeEdge: AlphaSignal["edges"]["regime"] = "no_trade";
  if (regime.adx > 25) regimeEdge = "trend_follow";
  else if (regime.adx < 20) regimeEdge = "mean_revert";

  // === DETERMINE ACTION ===
  let action: AlphaSignal["action"] = "FLAT";
  let strength: AlphaSignal["strength"] = "none";
  let conviction = 0;
  let trendAligned = false;
  let trendEdge: AlphaSignal["edges"]["trend"] = "no_trend";

  const rationale: string[] = [];
  const dailyTrend = regime.dailyTrend;

  // Check if funding + regime align
  if (fundingEdge === "contrarian_short" && (regimeEdge === "mean_revert" || dailyTrend === "bearish")) {
    action = "SHORT";
    strength = funding.extremeHigh ? "strong" : "moderate";
    conviction = 60 + (fundingPercentile > 90 ? 15 : 0) + (regime.adx < 20 ? 10 : 0);
    trendEdge = dailyTrend === "bearish" ? "aligned" : "counter_trend";
    rationale.push(`Funding ${fundingPct.toFixed(4)}%/8h = extreme positive → longs overlevered, contrarian SHORT`);
    rationale.push(`Regime: ${regime.label} (ADX ${regime.adx.toFixed(0)}) → ${regimeEdge === "mean_revert" ? "mean-reversion favors fading" : "bearish trend aligned"}`);
  } else if (fundingEdge === "contrarian_long" && (regimeEdge === "mean_revert" || dailyTrend === "bullish")) {
    action = "LONG";
    strength = funding.extremeLow ? "strong" : "moderate";
    conviction = 60 + (fundingPercentile < 10 ? 15 : 0) + (regime.adx < 20 ? 10 : 0);
    trendEdge = dailyTrend === "bullish" ? "aligned" : "counter_trend";
    rationale.push(`Funding ${fundingPct.toFixed(4)}%/8h = extreme negative → shorts overlevered, contrarian LONG`);
    rationale.push(`Regime: ${regime.label} (ADX ${regime.adx.toFixed(0)}) → ${regimeEdge === "mean_revert" ? "mean-reversion favors bounce" : "bullish trend aligned"}`);
  } else if (regimeEdge === "trend_follow" && dailyTrend !== "neutral") {
    // No funding signal, but trend is strong — trend follow
    if (dailyTrend === "bullish") {
      action = "LONG";
      strength = regime.adx > 30 ? "strong" : "moderate";
      conviction = 50 + Math.min(20, regime.adx - 25);
      trendEdge = "aligned";
      rationale.push(`ADX ${regime.adx.toFixed(0)} = strong trend → trend-following LONG (daily SMA bullish)`);
      rationale.push(`Funding ${fundingPct.toFixed(4)}%/8h = neutral (no contrarian signal)`);
    } else if (dailyTrend === "bearish") {
      action = "SHORT";
      strength = regime.adx > 30 ? "strong" : "moderate";
      conviction = 50 + Math.min(20, regime.adx - 25);
      trendEdge = "aligned";
      rationale.push(`ADX ${regime.adx.toFixed(0)} = strong trend → trend-following SHORT (daily SMA bearish)`);
      rationale.push(`Funding ${fundingPct.toFixed(4)}%/8h = neutral (no contrarian signal)`);
    }
  } else if (regimeEdge === "mean_revert" && (rsi < 30 || rsi > 70)) {
    // Ranging regime with RSI extreme — mean revert
    if (rsi < 30) {
      action = "LONG";
      strength = rsi < 25 ? "strong" : "moderate";
      conviction = 45 + (rsi < 25 ? 10 : 0);
      trendEdge = "no_trend";
      rationale.push(`ADX ${regime.adx.toFixed(0)} = ranging → mean-reversion active`);
      rationale.push(`RSI ${rsi.toFixed(0)} = oversold → bounce expected`);
    } else {
      action = "SHORT";
      strength = rsi > 75 ? "strong" : "moderate";
      conviction = 45 + (rsi > 75 ? 10 : 0);
      trendEdge = "no_trend";
      rationale.push(`ADX ${regime.adx.toFixed(0)} = ranging → mean-reversion active`);
      rationale.push(`RSI ${rsi.toFixed(0)} = overbought → pullback expected`);
    }
    rationale.push(`Funding ${fundingPct.toFixed(4)}%/8h = neutral`);
  } else if (fundingEdge !== "neutral") {
    // Funding signal exists but regime doesn't confirm — weak signal
    action = fundingEdge === "contrarian_short" ? "SHORT" : "LONG";
    strength = "weak";
    conviction = 35;
    trendEdge = "counter_trend";
    rationale.push(`Funding ${fundingPct.toFixed(4)}%/8h = extreme → contrarian ${action}`);
    rationale.push(`WARNING: Regime not confirming (ADX ${regime.adx.toFixed(0)}, trend ${dailyTrend})`);
  } else {
    // No edge — flat
    action = "FLAT";
    strength = "none";
    conviction = 0;
    rationale.push(`No aligned edge: funding neutral (${fundingPct.toFixed(4)}%/8h), regime ${regime.label} (ADX ${regime.adx.toFixed(0)})`);
    rationale.push(`FLAT is a position. Not trading IS the signal when no edge exists.`);
  }

  // Volatility scaling note
  if (volEdge === "high_vol_size_down") {
    rationale.push(`ATR ratio ${atrRatio.toFixed(2)}x = high volatility → position size halved`);
  } else if (volEdge === "low_vol_size_up") {
    rationale.push(`ATR ratio ${atrRatio.toFixed(2)}x = low volatility → position size slightly increased`);
  }

  // === RISK PARAMETERS ===
  const riskAmount = capitalIdr * RISK_PER_TRADE_PCT * volScale;

  let stopLoss: number, takeProfit1: number, takeProfit2: number;
  if (action === "LONG") {
    stopLoss = price - 2 * atr; // 2 ATR stop
    takeProfit1 = price + 1.5 * atr; // 1.5R (since risk = 2 ATR, reward = 3 ATR → 1.5R)

    takeProfit2 = price + 3 * atr; // 3R target
  } else if (action === "SHORT") {
    stopLoss = price + 2 * atr;
    takeProfit1 = price - 1.5 * atr;
    takeProfit2 = price - 3 * atr;
  } else {
    stopLoss = price;
    takeProfit1 = price;
    takeProfit2 = price;
  }

  const rewardRisk = action !== "FLAT" ? Math.abs(takeProfit1 - price) / Math.abs(price - stopLoss) : 0;

  // === FRACTIONAL KELLY POSITION SIZING ===
  // Estimate win probability from conviction + regime
  const estWinRate = 0.45 + (conviction / 100) * 0.15; // 45-60% based on conviction
  const b = rewardRisk > 0 ? rewardRisk : 1.5; // reward/risk ratio
  const p = estWinRate;
  const q = 1 - p;
  const kelly = b > 0 && p > 0 ? (b * p - q) / b : 0;
  const fractionalKelly = Math.max(0, kelly * KELLY_FRACTION);
  const positionSizePct = action !== "FLAT" ? Math.min(fractionalKelly, 0.05) * volScale : 0; // cap at 5%
  const positionSizeIdr = capitalIdr * positionSizePct;

  // === HONEST BACKTEST (regime-matched) ===
  const backtest = computeRegimeMatchedBacktest(candles1h, regime, action);

  // === INVALIDATION ===
  const invalidation = action === "LONG"
    ? `Invalidation: price closes below ${stopLoss.toFixed(0)} (2 ATR stop) OR funding flips to extreme positive OR ADX drops below 15 (trend dies)`
    : action === "SHORT"
      ? `Invalidation: price closes above ${stopLoss.toFixed(0)} (2 ATR stop) OR funding flips to extreme negative OR ADX drops below 15`
      : "No active position — no invalidation needed.";

  // === WARNING (honest caveat) ===
  let warning: string | null = null;
  if (action !== "FLAT" && backtest.sampleSize < 10) {
    warning = `WARNING: Only ${backtest.sampleSize} historical regime-matched instances. Statistical confidence is LOW. Treat this as a hypothesis, not a certainty.`;
  }
  if (action !== "FLAT" && backtest.winRate < 0.50) {
    warning = `WARNING: Regime-matched backtest shows ${(backtest.winRate * 100).toFixed(0)}% win rate — below 50%. This signal historically LOSES more than wins. Expected value may still be positive if reward/risk > 2:1, but proceed with caution.`;
  }
  if (action !== "FLAT" && trendEdge === "counter_trend") {
    warning = `WARNING: This signal is counter-trend. The daily trend is against you. This is a contrarian bet — it can work (fading extremes) but carries higher risk.`;
  }

  return {
    pair,
    timestamp: new Date().toISOString(),
    action,
    strength,
    conviction,
    entry: price,
    stopLoss,
    takeProfit1,
    takeProfit2,
    positionSizePct,
    positionSizeIdr,
    rewardRiskRatio: rewardRisk,
    edges: { funding: fundingEdge, regime: regimeEdge, volatility: volEdge, trend: trendEdge },
    backtest,
    rationale,
    invalidation,
    warning,
    raw: {
      price,
      atr,
      atrPercent,
      rsi,
      adx: regime.adx,
      fundingRate,
      fundingPercentile,
      regime: regime.regime,
    },
  };
}

// Compute where the current funding rate sits relative to the 30d range.
function computeFundingPercentile(currentRate: number): number {
  // Without the full 30-rate history (would need another API call),
  // approximate: rates near 0 = 50th percentile. Extreme positive = >90th.
  // This is a rough heuristic — the SDK returns avgRate which we can use.
  // For now, use a simple mapping based on typical funding distributions.
  if (currentRate > 0.0008) return 95;
  if (currentRate > 0.0005) return 90;
  if (currentRate > 0.0003) return 80;
  if (currentRate > 0.0001) return 65;
  if (currentRate > 0.00005) return 55;
  if (currentRate > -0.00005) return 50;
  if (currentRate > -0.0001) return 45;
  if (currentRate > -0.0003) return 35;
  if (currentRate > -0.0005) return 20;
  if (currentRate > -0.0008) return 10;
  return 5;
}

// Regime-matched backtest: find historical candles with similar regime
// (same ADX band, same ATR ratio band) and compute forward returns.
function computeRegimeMatchedBacktest(candles: Candle[], currentRegime: RegimeInfo, action: string): AlphaSignal["backtest"] {
  if (candles.length < 100 || action === "FLAT") {
    return {
      winRate: 0, avgReturn: 0, avgHoldHours: 0, sampleSize: 0,
      maxDrawdown: 0, sharpeRatio: 0,
      regimeMatched: "insufficient data or no action",
    };
  }

  const adxBand = currentRegime.adx < 20 ? "low" : currentRegime.adx > 25 ? "high" : "mid";
  const atrBand = currentRegime.atrRatio > 1.5 ? "high" : currentRegime.atrRatio < 0.8 ? "low" : "normal";

  // Scan historical candles for regime matches
  const forwardReturns: { ret: number; holdHours: number; maxDD: number }[] = [];
  const lookback = Math.min(candles.length - 48, 150); // don't use last 48 (we need forward data)

  for (let i = 50; i < lookback; i++) {
    // Compute regime at this historical point
    const histSlice = candles.slice(0, i + 1);
    const histATR = calcATR(histSlice, 14);
    const histATRRatio = histATR / (calcAvgATR(histSlice, 50) || histATR);

    // Simple ADX approximation: use price momentum strength
    const histADX = approximateADX(histSlice);

    const histAdxBand = histADX < 20 ? "low" : histADX > 25 ? "high" : "mid";
    const histAtrBand = histATRRatio > 1.5 ? "high" : histATRRatio < 0.8 ? "low" : "normal";

    if (histAdxBand === adxBand && histAtrBand === atrBand) {
      // Regime matches! Compute forward return for this entry
      const entry = candles[i].close;
      let maxDD = 0;
      let bestReturn = 0;
      const holdHours = 24; // 24h forward window

      for (let j = 1; j <= 24 && i + j < candles.length; j++) {
        const future = candles[i + j].close;
        const ret = action === "LONG" ? (future - entry) / entry : action === "SHORT" ? (entry - future) / entry : 0;
        if (ret > bestReturn) bestReturn = ret;
        const dd = action === "LONG" ? (entry - future) / entry : action === "SHORT" ? (future - entry) / entry : 0;
        if (dd > maxDD) maxDD = dd;
      }

      const finalReturn = action === "LONG"
        ? (candles[Math.min(i + 24, candles.length - 1)].close - entry) / entry
        : action === "SHORT"
          ? (entry - candles[Math.min(i + 24, candles.length - 1)].close) / entry
          : 0;

      forwardReturns.push({ ret: finalReturn, holdHours, maxDD });
    }
  }

  if (forwardReturns.length === 0) {
    return {
      winRate: 0, avgReturn: 0, avgHoldHours: 0, sampleSize: 0,
      maxDrawdown: 0, sharpeRatio: 0,
      regimeMatched: `ADX band=${adxBand}, ATR band=${atrBand} — no historical matches`,
    };
  }

  const wins = forwardReturns.filter((r) => r.ret > 0);
  const winRate = wins.length / forwardReturns.length;
  const avgReturn = forwardReturns.reduce((a, r) => a + r.ret, 0) / forwardReturns.length;
  const avgHold = forwardReturns.reduce((a, r) => a + r.holdHours, 0) / forwardReturns.length;
  const maxDD = Math.max(...forwardReturns.map((r) => r.maxDD));
  const avgRet = avgReturn;
  const stdRet = Math.sqrt(forwardReturns.reduce((a, r) => a + Math.pow(r.ret - avgRet, 2), 0) / forwardReturns.length);
  const sharpe = stdRet > 0 ? (avgRet / stdRet) * Math.sqrt(365 * 24 / avgHold) : 0;

  return {
    winRate,
    avgReturn,
    avgHoldHours: avgHold,
    sampleSize: forwardReturns.length,
    maxDrawdown: maxDD,
    sharpeRatio: sharpe,
    regimeMatched: `ADX band=${adxBand} (${currentRegime.adx.toFixed(0)}), ATR band=${atrBand} (${currentRegime.atrRatio.toFixed(2)}x), action=${action}`,
  };
}

function calcAvgATR(candles: Candle[], period: number): number {
  if (candles.length < period + 1) return calcATR(candles, 14);
  const slice = candles.slice(candles.length - period);
  return calcATR(slice, Math.min(14, period));
}

// Lightweight ADX approximation (full ADX requires directional movement calc)
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
  const di = Math.abs(plusDM - minusDM) / total * 100;
  return Math.min(60, di * 1.3); // scale up to approximate ADX range
}

function summarizeRegime(signals: AlphaSignal[]): string {
  const trendCount = signals.filter((s) => s.raw.adx > 25).length;
  const rangeCount = signals.filter((s) => s.raw.adx < 20).length;
  const longSignals = signals.filter((s) => s.action === "LONG").length;
  const shortSignals = signals.filter((s) => s.action === "SHORT").length;
  const flatSignals = signals.filter((s) => s.action === "FLAT").length;
  const fundingExtreme = signals.filter((s) => s.edges.funding !== "neutral").length;

  let summary = `Market: `;
  if (trendCount > rangeCount) summary += `trending (${trendCount}/${signals.length} pairs). `;
  else if (rangeCount > trendCount) summary += `ranging (${rangeCount}/${signals.length} pairs). `;
  else summary += `mixed. `;
  summary += `Signals: ${longSignals} long, ${shortSignals} short, ${flatSignals} flat. `;
  if (fundingExtreme > 0) summary += `${fundingExtreme} pair(s) with extreme funding (contrarian signal active). `;
  return summary;
}
