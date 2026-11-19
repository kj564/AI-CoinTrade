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
import { detectRegime } from "./regime";
import { getFundingRate, type FundingRateInfo } from "./funding";
import { getBinanceKlinesWithMeta, convertKlinesToIdr, type KlinesResult } from "./binance-klines";
import { getMicrostructure, type MicrostructureData } from "./microstructure";
import { walkForwardBacktest, type WalkForwardResult } from "./walk-forward";
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

  // === DATA QUALITY ===
  dataStale: boolean;       // true if candle data is > 10min old
  dataSource: string;       // "binance" | "fallback" | "stale"

  // === THE SIGNAL ===
  action: "LONG" | "SHORT" | "REDUCE" | "FLAT" | "CLOSE";
  strength: "strong" | "moderate" | "weak" | "none";
  conviction: number; // 0-100, edge-weighted
  confirmed: boolean; // true ONLY if microstructure confirms (OI + absorption)

  // === RISK PARAMETERS ===
  entry: number;
  stopLoss: number;
  takeProfit1: number;
  takeProfit2: number;
  positionSizePct: number;
  positionSizeIdr: number;
  notionalIdr: number;      // notional position value (entry × quantity)
  notionalCapPct: number;   // notional as % of capital (capped at 30%)
  leverage: number;         // notional / capital (capped at 3x)
  rewardRiskRatio: number;

  // === EDGE SOURCES ===
  edges: {
    funding: "contrarian_short" | "contrarian_long" | "neutral";
    fundingZScore: number;   // z-score of current funding vs 30d distribution
    regime: "trend_follow" | "mean_revert" | "no_trade";
    volatility: "low_vol_size_up" | "normal" | "high_vol_size_down";
    trend: "aligned" | "counter_trend" | "no_trend";
  };

  // === MICROSTRUCTURE CONFIRMATION ===
  microstructure: {
    oiTrend: string;
    oiChange4hPct: number;
    cvd1h: number;
    cvdDivergence: boolean;
    absorptionDetected: boolean;
    takerBuyRatio: number;
    confirmation: string;
  } | null;

  // === WALK-FORWARD OOS BACKTEST ===
  backtest: {
    oosWinRate: number;       // out-of-sample win rate
    oosAvgReturn: number;
    oosSampleSize: number;
    oosSharpe: number;
    oosMaxDrawdown: number;
    kellyFraction: number;    // Kelly from OOS trades
    inSampleWinRate: number;  // for comparison
    overfitGap: number;       // in-sample - OOS (large = overfit)
    honest: boolean;          // edge confirmed OOS
    description: string;
  };

  rationale: string[];
  invalidation: string;
  warning: string | null;

  raw: {
    price: number;
    atr: number;
    atrPercent: number;
    rsi: number;
    adx: number;
    fundingRate: number;
    fundingZScore: number;
    fundingPercentile: number;
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
    disclaimer: "Signals use z-score funding (pair-adaptive), microstructure confirmation (OI+CVD+absorption), walk-forward OOS validation, and fractional Kelly from OOS trades. Edge is only 'confirmed' if OOS win rate >50% and overfit gap <15%. No signal guarantees profit. Not financial advice.",
  };
}

async function generatePairSignal(pair: string, capitalIdr: number): Promise<AlphaSignal | null> {
  // Fetch 500 1h klines from Binance + staleness metadata + INDODAX ticker
  const [klinesResult, ticker] = await Promise.all([
    getBinanceKlinesWithMeta(pair, "1h", 500),
    getTicker(pair),
  ]);

  // P6: DATA STALENESS — if Binance fails or data is old, try DB fallback
  let candles1hSource = klinesResult.candles;
  let dataSource = klinesResult.source;
  let dataStale = klinesResult.stale;

  if (candles1hSource.length < 50) {
    // Fallback to INDODAX DB candles
    const { candles } = await ensureCandles(pair, "1h", 50);
    if (candles.length < 50) return null;
    candles1hSource = candles;
    dataSource = "fallback";
    dataStale = false; // DB candles are at least recent
  }

  // Resample 1h → 1d (avoids second Binance API call)
  const candles1dRaw = resample1hTo1d(candles1hSource);

  // Convert USDT prices to IDR using INDODAX ticker
  const idrPrice = ticker?.last ?? 0;
  const usdtRefPrice = candles1hSource[candles1hSource.length - 1].close;
  const candles1h = idrPrice > 0 ? convertKlinesToIdr(candles1hSource, idrPrice, usdtRefPrice) : candles1hSource;
  const candles1d = idrPrice > 0 ? convertKlinesToIdr(candles1dRaw, idrPrice, usdtRefPrice) : candles1dRaw;

  // Fetch funding + microstructure in parallel
  const [funding, microstructure] = await Promise.all([
    getFundingRate(pair),
    getMicrostructure(pair, usdtRefPrice),
  ]);

  return generateSignalFromCandles(pair, capitalIdr, candles1h, candles1d, {
    dataSource: dataSource as string,
    dataStale,
    funding,
    microstructure,
    idrPrice: idrPrice || usdtRefPrice,
  });
}

interface SignalContext {
  dataSource: string;
  dataStale: boolean;
  funding: FundingRateInfo | null;
  microstructure: MicrostructureData | null;
  idrPrice: number;
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

async function generateSignalFromCandles(
  pair: string,
  capitalIdr: number,
  candles1h: Candle[],
  candles1d: Candle[],
  ctx: SignalContext,
): Promise<AlphaSignal | null> {
  if (candles1h.length < 50 || candles1d.length < 7) return null;

  const price = candles1h[candles1h.length - 1].close;
  const atr = calcATR(candles1h, 14);
  const atrPercent = (atr / price) * 100;
  const rsi = calcRSI(candles1h, 14);
  const regime = detectRegime(candles1h, candles1d);

  // P1: Z-SCORE FUNDING — pair-adaptive, not fixed threshold
  const funding = ctx.funding;
  const fundingRate = funding?.current ?? 0;
  const fundingPct = funding?.currentPct ?? 0;
  const fundingZScore = funding?.zScore ?? 0;
  const fundingPercentile = funding?.percentile ?? 50;

  let fundingEdge: AlphaSignal["edges"]["funding"] = "neutral";
  if (funding) {
    if (funding.extremeHigh) fundingEdge = "contrarian_short";
    else if (funding.extremeLow) fundingEdge = "contrarian_long";
  }

  // VOLATILITY SCALING
  const atrRatio = regime.atrRatio;
  let volEdge: AlphaSignal["edges"]["volatility"] = "normal";
  let volScale = 1.0;
  if (atrRatio > 1.5) { volEdge = "high_vol_size_down"; volScale = 0.5; }
  else if (atrRatio < 0.8) { volEdge = "low_vol_size_up"; volScale = 1.3; }

  // REGIME ROUTING
  let regimeEdge: AlphaSignal["edges"]["regime"] = "no_trade";
  if (regime.adx > 25) regimeEdge = "trend_follow";
  else if (regime.adx < 20) regimeEdge = "mean_revert";

  // DETERMINE ACTION
  let action: AlphaSignal["action"] = "FLAT";
  let strength: AlphaSignal["strength"] = "none";
  let conviction = 0;
  let trendEdge: AlphaSignal["edges"]["trend"] = "no_trend";
  const rationale: string[] = [];
  const dailyTrend = regime.dailyTrend;

  // P2: MICROSTRUCTURE CONFIRMATION — only allow contrarian fade if OI/absorption confirms
  const micro = ctx.microstructure;
  const microConfirmed = micro?.confirmation === "reversal_likely";
  const momentumAlive = micro?.confirmation === "momentum_alive";

  if (fundingEdge === "contrarian_short" && (regimeEdge === "mean_revert" || dailyTrend === "bearish")) {
    // P2: Block fade if momentum is still alive (OI rising + strong CVD)
    if (momentumAlive) {
      action = "FLAT";
      strength = "none";
      conviction = 0;
      rationale.push(`Funding ${fundingPct.toFixed(4)}%/8h (z=${fundingZScore.toFixed(2)}) = extreme → contrarian SHORT signal`);
      rationale.push(`BLOCKED: Microstructure shows momentum alive (OI ${micro?.oiTrend} ${micro?.oiChange4hPct.toFixed(1)}%, CVD ${micro?.cvd1h > 0 ? "buy" : "sell"}). Blind fade = dangerous. Wait for OI to decline or absorption.`);
    } else {
      action = "SHORT";
      strength = (funding.extremeHigh && microConfirmed) ? "strong" : funding.extremeHigh ? "moderate" : "weak";
      conviction = 55 + (microConfirmed ? 15 : 0) + (fundingZScore > 2.5 ? 10 : 0);
      trendEdge = dailyTrend === "bearish" ? "aligned" : "counter_trend";
      rationale.push(`Funding ${fundingPct.toFixed(4)}%/8h (z=${fundingZScore.toFixed(2)}, ${fundingPercentile.toFixed(0)}th %ile) → contrarian SHORT`);
      if (microConfirmed) rationale.push(`CONFIRMED: Microstructure shows ${micro?.confirmation} — OI ${micro?.oiTrend}, ${micro?.absorptionDetected ? "absorption detected" : "CVD divergence"}`);
      else rationale.push(`Microstructure: ${micro?.description ?? "no data"}`);
    }
  } else if (fundingEdge === "contrarian_long" && (regimeEdge === "mean_revert" || dailyTrend === "bullish")) {
    if (momentumAlive) {
      action = "FLAT";
      strength = "none";
      conviction = 0;
      rationale.push(`Funding ${fundingPct.toFixed(4)}%/8h (z=${fundingZScore.toFixed(2)}) = extreme negative → contrarian LONG signal`);
      rationale.push(`BLOCKED: Microstructure shows momentum alive. Wait for confirmation.`);
    } else {
      action = "LONG";
      strength = (funding.extremeLow && microConfirmed) ? "strong" : funding.extremeLow ? "moderate" : "weak";
      conviction = 55 + (microConfirmed ? 15 : 0) + (fundingZScore < -2.5 ? 10 : 0);
      trendEdge = dailyTrend === "bullish" ? "aligned" : "counter_trend";
      rationale.push(`Funding ${fundingPct.toFixed(4)}%/8h (z=${fundingZScore.toFixed(2)}, ${fundingPercentile.toFixed(0)}th %ile) → contrarian LONG`);
      if (microConfirmed) rationale.push(`CONFIRMED: Microstructure shows ${micro?.confirmation}`);
      else rationale.push(`Microstructure: ${micro?.description ?? "no data"}`);
    }
  } else if (regimeEdge === "trend_follow" && dailyTrend !== "neutral") {
    if (dailyTrend === "bullish") {
      action = "LONG";
      strength = regime.adx > 30 ? "strong" : "moderate";
      conviction = 50 + Math.min(20, regime.adx - 25);
      trendEdge = "aligned";
      rationale.push(`ADX ${regime.adx.toFixed(0)} = strong trend → trend-following LONG`);
      rationale.push(`Funding ${fundingPct.toFixed(4)}%/8h (z=${fundingZScore.toFixed(2)}) = neutral`);
    } else if (dailyTrend === "bearish") {
      action = "SHORT";
      strength = regime.adx > 30 ? "strong" : "moderate";
      conviction = 50 + Math.min(20, regime.adx - 25);
      trendEdge = "aligned";
      rationale.push(`ADX ${regime.adx.toFixed(0)} = strong trend → trend-following SHORT`);
      rationale.push(`Funding ${fundingPct.toFixed(4)}%/8h (z=${fundingZScore.toFixed(2)}) = neutral`);
    }
  } else if (regimeEdge === "mean_revert" && (rsi < 30 || rsi > 70)) {
    if (rsi < 30) {
      action = "LONG";
      strength = rsi < 25 ? "strong" : "moderate";
      conviction = 45 + (rsi < 25 ? 10 : 0);
      trendEdge = "no_trend";
      rationale.push(`ADX ${regime.adx.toFixed(0)} = ranging → mean-reversion LONG (RSI ${rsi.toFixed(0)} oversold)`);
    } else {
      action = "SHORT";
      strength = rsi > 75 ? "strong" : "moderate";
      conviction = 45 + (rsi > 75 ? 10 : 0);
      trendEdge = "no_trend";
      rationale.push(`ADX ${regime.adx.toFixed(0)} = ranging → mean-reversion SHORT (RSI ${rsi.toFixed(0)} overbought)`);
    }
    rationale.push(`Funding ${fundingPct.toFixed(4)}%/8h (z=${fundingZScore.toFixed(2)}) = neutral`);
  } else if (fundingEdge !== "neutral") {
    action = fundingEdge === "contrarian_short" ? "SHORT" : "LONG";
    strength = "weak";
    conviction = 30;
    trendEdge = "counter_trend";
    rationale.push(`Funding ${fundingPct.toFixed(4)}%/8h (z=${fundingZScore.toFixed(2)}) = extreme → contrarian ${action}`);
    rationale.push(`WARNING: Regime not confirming (ADX ${regime.adx.toFixed(0)}, trend ${dailyTrend}). Microstructure: ${micro?.confirmation ?? "unknown"}`);
  } else {
    action = "FLAT";
    strength = "none";
    conviction = 0;
    rationale.push(`No aligned edge: funding neutral (${fundingPct.toFixed(4)}%/8h, z=${fundingZScore.toFixed(2)}), regime ${regime.label} (ADX ${regime.adx.toFixed(0)})`);
    rationale.push(`FLAT is a position. Not trading IS the signal when no edge exists.`);
  }

  if (volEdge === "high_vol_size_down") rationale.push(`ATR ratio ${atrRatio.toFixed(2)}x = high vol → size halved`);
  else if (volEdge === "low_vol_size_up") rationale.push(`ATR ratio ${atrRatio.toFixed(2)}x = low vol → size increased`);

  // RISK PARAMETERS
  let stopLoss: number, takeProfit1: number, takeProfit2: number;
  if (action === "LONG") {
    stopLoss = price - 2 * atr;
    takeProfit1 = price + 1.5 * atr;
    takeProfit2 = price + 3 * atr;
  } else if (action === "SHORT") {
    stopLoss = price + 2 * atr;
    takeProfit1 = price - 1.5 * atr;
    takeProfit2 = price - 3 * atr;
  } else {
    stopLoss = price; takeProfit1 = price; takeProfit2 = price;
  }
  const rewardRisk = action !== "FLAT" ? Math.abs(takeProfit1 - price) / Math.abs(price - stopLoss) : 0;

  // P3+P4: WALK-FORWARD OOS BACKTEST + KELLY FROM OOS
  const wfResult = walkForwardBacktest(candles1h, regime, action);

  // Kelly from OOS trades (not in-sample)
  const oosKelly = wfResult.kellyFraction;
  const fractionalKelly = Math.max(0, oosKelly * KELLY_FRACTION);
  let positionSizePct = action !== "FLAT" ? Math.min(fractionalKelly, 0.05) * volScale : 0;

  // P5: NOTIONAL CAP — prevent notional explosion when ATR is small
  // notional = (riskAmount / stopDistance) × entryPrice
  // If ATR is tiny, stop is tight, so notional = riskAmount / (2*ATR) × price → can be huge
  const riskAmount = capitalIdr * (positionSizePct > 0 ? RISK_PER_TRADE_PCT : 0) * volScale;
  const stopDistance = action !== "FLAT" ? Math.abs(price - stopLoss) : 0;
  let notionalIdr = stopDistance > 0 ? (riskAmount / stopDistance) * price : 0;
  const maxNotionalPct = 0.30; // cap notional at 30% of capital
  const maxLeverage = 3.0;     // cap leverage at 3x
  let notionalCapPct = notionalIdr / capitalIdr;
  let leverage = notionalCapPct;

  if (notionalCapPct > maxNotionalPct) {
    const scaleDown = maxNotionalPct / notionalCapPct;
    notionalIdr *= scaleDown;
    positionSizePct *= scaleDown;
    notionalCapPct = maxNotionalPct;
    leverage = notionalCapPct;
    rationale.push(`NOTIONAL CAP: original notional ${(notionalIdr / scaleDown / capitalIdr * 100).toFixed(0)}% of capital → scaled down to ${maxNotionalPct * 100}% (leverage cap ${maxLeverage}x)`);
  }

  const positionSizeIdr = capitalIdr * positionSizePct;

  // INVALIDATION
  const invalidation = action === "LONG"
    ? `Invalidation: price closes below ${stopLoss.toFixed(0)} (2 ATR) OR funding z-score flips to >+2 OR ADX < 15 OR OI starts rising again`
    : action === "SHORT"
      ? `Invalidation: price closes above ${stopLoss.toFixed(0)} (2 ATR) OR funding z-score flips to <-2 OR ADX < 15 OR OI starts rising again`
      : "No active position — no invalidation needed.";

  // WARNINGS — honest caveats
  let warning: string | null = null;
  if (action !== "FLAT" && wfResult.oosSampleSize < 5) {
    warning = `WARNING: Only ${wfResult.oosSampleSize} OOS trades. Statistical confidence is LOW. Kelly=${(oosKelly * 100).toFixed(1)}% (from OOS).`;
  }
  if (action !== "FLAT" && wfResult.oosWinRate < 0.50) {
    warning = `WARNING: OOS win rate ${(wfResult.oosWinRate * 100).toFixed(0)}% — below 50%. Edge NOT confirmed out-of-sample. Kelly set to ${(oosKelly * 100).toFixed(1)}%.`;
  }
  if (action !== "FLAT" && !wfResult.honest) {
    warning = `WARNING: Walk-forward validation says edge is NOT confirmed (OOS=${(wfResult.oosWinRate * 100).toFixed(0)}%, overfit gap ${(wfResult.overfitGap * 100).toFixed(0)}%). Treat as hypothesis, not certainty.`;
  }
  if (action !== "FLAT" && trendEdge === "counter_trend") {
    warning = `WARNING: Counter-trend signal. Daily trend is against you. Higher risk.`;
  }
  if (ctx.dataStale && action !== "FLAT") {
    warning = `WARNING: Candle data is STALE (source: ${ctx.dataSource}). Signal may be based on outdated prices. Verify before executing.`;
  }

  return {
    pair,
    timestamp: new Date().toISOString(),
    dataStale: ctx.dataStale,
    dataSource: ctx.dataSource,
    action,
    strength,
    conviction,
    confirmed: microConfirmed,
    entry: price,
    stopLoss,
    takeProfit1,
    takeProfit2,
    positionSizePct,
    positionSizeIdr,
    notionalIdr,
    notionalCapPct,
    leverage,
    rewardRiskRatio: rewardRisk,
    edges: { funding: fundingEdge, fundingZScore, regime: regimeEdge, volatility: volEdge, trend: trendEdge },
    microstructure: micro ? {
      oiTrend: micro.oiTrend,
      oiChange4hPct: micro.oiChange4hPct,
      cvd1h: micro.cvd1h,
      cvdDivergence: micro.cvdDivergence,
      absorptionDetected: micro.absorptionDetected,
      takerBuyRatio: micro.takerBuyRatio1h,
      confirmation: micro.confirmation,
    } : null,
    backtest: {
      oosWinRate: wfResult.oosWinRate,
      oosAvgReturn: wfResult.oosAvgReturn,
      oosSampleSize: wfResult.oosSampleSize,
      oosSharpe: wfResult.oosSharpe,
      oosMaxDrawdown: wfResult.oosMaxDrawdown,
      kellyFraction: wfResult.kellyFraction,
      inSampleWinRate: wfResult.inSampleWinRate,
      overfitGap: wfResult.overfitGap,
      honest: wfResult.honest,
      description: wfResult.description,
    },
    rationale,
    invalidation,
    warning,
    raw: {
      price, atr, atrPercent, rsi,
      adx: regime.adx,
      fundingRate, fundingZScore, fundingPercentile,
      regime: regime.regime,
    },
  };
}

function summarizeRegime(signals: AlphaSignal[]): string {
  const trendCount = signals.filter((s) => s.raw.adx > 25).length;
  const rangeCount = signals.filter((s) => s.raw.adx < 20).length;
  const longSignals = signals.filter((s) => s.action === "LONG").length;
  const shortSignals = signals.filter((s) => s.action === "SHORT").length;
  const flatSignals = signals.filter((s) => s.action === "FLAT").length;
  const fundingExtreme = signals.filter((s) => s.edges.funding !== "neutral").length;
  const confirmed = signals.filter((s) => s.confirmed).length;
  const stale = signals.filter((s) => s.dataStale).length;

  let summary = `Market: `;
  if (trendCount > rangeCount) summary += `trending (${trendCount}/${signals.length} pairs). `;
  else if (rangeCount > trendCount) summary += `ranging (${rangeCount}/${signals.length} pairs). `;
  else summary += `mixed. `;
  summary += `Signals: ${longSignals} long, ${shortSignals} short, ${flatSignals} flat. `;
  if (fundingExtreme > 0) summary += `${fundingExtreme} pair(s) with extreme funding (z-score >2). `;
  if (confirmed > 0) summary += `${confirmed} confirmed by microstructure. `;
  if (stale > 0) summary += `${stale} pair(s) with STALE data. `;
  return summary;
}
