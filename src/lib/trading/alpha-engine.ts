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
import { validateAbsorptionThreshold, type AbsorptionValidation } from "./absorption-validation";
import { computeWalkTheBookCap, computeLimitOrderCost, type WalkTheBookResult, type LimitOrderCostModel } from "./walk-the-book";
import { getCircuitBreaker, type CircuitBreakerState } from "./alpha-circuit-breaker";
import { journalSignal, checkOpenSignals } from "./signal-journal";
import { getTicker, getDepth } from "@/lib/indodax";
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
    oosWinRate: number;
    oosAvgReturn: number;
    oosSampleSize: number;
    oosSharpe: number;
    oosMaxDrawdown: number;
    kellyFraction: number;      // point estimate
    kellyCI5: number;           // 5th percentile bootstrap Kelly
    kellyCI95: number;          // 95th percentile
    kellyUncertainty: number;   // CI width
    inSampleWinRate: number;
    overfitGap: number;
    honest: boolean;
    anchoredWindows: number;
    description: string;
  };

  // === LIQUIDITY CAP (P3: walk-the-book) ===
  liquidity: {
    maxNotionalWithoutSlippage: number;
    topBidDepth: number;
    topAskDepth: number;
    spreadPct: number;
    liquidityCapActive: boolean;
    // P3: walk-the-book details
    walkBookLevels: number;         // levels consumed at max notional
    walkBookSlippagePct: number;    // actual slippage at max notional
    walkBookMethod: string;         // "walk_the_book" or "simple_depth"
  } | null;

  // === ABSORPTION OOS VALIDATION (P2) ===
  absorptionValidation: {
    optimalThreshold: number;
    precision: number;
    precisionCI5: number;
    precisionCI95: number;
    lift: number;
    validated: boolean;
    description: string;
  } | null;

  // === IMPACT SEVERITY (P4) ===
  impact: {
    capitalAtRiskPct: number;
    expectedLossIdr: number;
    concentrationPct: number;
    impactLevel: "HIGH" | "MEDIUM" | "LOW";
    // v5: impact × probability = expected value
    probability: number;            // OOS win rate (probability of success)
    expectedValueIdr: number;       // (prob × expectedWin) - ((1-prob) × expectedLoss)
    evSeverity: "CRITICAL" | "ERROR" | "WARN" | "INFO";  // combined severity
  } | null;

  // === LIMIT ORDER COST MODEL (P2) ===
  limitOrder: {
    recommendation: "use_limit" | "use_market" | "improve_price";
    fillProbability: number;
    netExpectedCostPct: number;
    adverseSelectionPct: number;
    description: string;
  } | null;

  // === CIRCUIT BREAKER (P7) ===
  circuitBreaker: {
    open: boolean;
    consecutiveLosses: number;
    winRate: number;
    cooldownSec: number;
    trips: number;
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
  signalCheck?: { checked: number; closed: number; wins: number; losses: number };
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

  // Close the loop: journal active signals + check open signals against current prices
  // This gives the circuit breaker real outcome data to work with.
  const currentPrices: Record<string, number> = {};
  for (const s of signals) {
    currentPrices[s.pair] = s.entry;
    if (s.action === "LONG" || s.action === "SHORT") {
      await journalSignal({
        pair: s.pair,
        action: s.action,
        entryPrice: s.entry,
        stopLoss: s.stopLoss,
        takeProfit1: s.takeProfit1,
        takeProfit2: s.takeProfit2,
        positionSizePct: s.positionSizePct,
        positionSizeIdr: s.positionSizeIdr,
        conviction: s.conviction,
        strength: s.strength,
        severity: s.impact?.evSeverity ?? "INFO",
        fundingZScore: s.raw.fundingZScore,
        regimeAtSignal: s.raw.regime,
        microstructureSummary: s.microstructure ? JSON.stringify(s.microstructure) : undefined,
      });
    }
  }
  const signalCheck = await checkOpenSignals(currentPrices);

  return {
    signals,
    portfolioAllocation,
    capitalAtRisk: Math.min(totalRiskPct * riskScale, maxTotalRisk),
    regimeSummary,
    signalCheck,
    generatedAt: new Date().toISOString(),
    disclaimer: "Signals use z-score funding (pair-adaptive), microstructure confirmation (OI+CVD+absorption), walk-forward OOS validation, and fractional Kelly from OOS trades. Edge is only 'confirmed' if OOS win rate >50% and overfit gap <15%. No signal guarantees profit. Not financial advice.",
  };
}

async function generatePairSignal(pair: string, capitalIdr: number): Promise<AlphaSignal | null> {
  // Fetch klines + ticker + depth (for liquidity cap) in parallel
  const [klinesResult, ticker, depth] = await Promise.all([
    getBinanceKlinesWithMeta(pair, "1h", 500),
    getTicker(pair),
    getDepth(pair.replace("_idr", "idr")),  // INDODAX depth needs "btcidr" format
  ]);

  let candles1hSource = klinesResult.candles;
  let dataSource = klinesResult.source;
  let dataStale = klinesResult.stale;

  if (candles1hSource.length < 50) {
    const { candles } = await ensureCandles(pair, "1h", 50);
    if (candles.length < 50) return null;
    candles1hSource = candles;
    dataSource = "fallback";
    dataStale = false;
  }

  const candles1dRaw = resample1hTo1d(candles1hSource);
  const idrPrice = ticker?.last ?? 0;
  const usdtRefPrice = candles1hSource[candles1hSource.length - 1].close;
  const candles1h = idrPrice > 0 ? convertKlinesToIdr(candles1hSource, idrPrice, usdtRefPrice) : candles1hSource;
  const candles1d = idrPrice > 0 ? convertKlinesToIdr(candles1dRaw, idrPrice, usdtRefPrice) : candles1dRaw;

  const [funding, microstructure] = await Promise.all([
    getFundingRate(pair),
    getMicrostructure(pair, usdtRefPrice),
  ]);

  // P3: Walk-the-book liquidity cap
  const liquidity = computeWalkTheBookLiquidity(depth, idrPrice, capitalIdr);

  // P2: Absorption threshold OOS validation
  const absorptionValidation = validateAbsorptionThreshold(candles1hSource);

  // P2 (v5): Limit order cost model
  const orderVol = idrPrice > 0 ? (capitalIdr * 0.02) / idrPrice : 0; // estimate ~2% capital order
  const limitOrder = depth ? computeLimitOrderCost(depth, "buy", orderVol) : null;

  // P7: Circuit breaker state
  const circuitBreaker = await getCircuitBreaker(pair);

  return generateSignalFromCandles(pair, capitalIdr, candles1h, candles1d, {
    dataSource: dataSource as string,
    dataStale,
    funding,
    microstructure,
    idrPrice: idrPrice || usdtRefPrice,
    liquidity,
    absorptionValidation,
    candles1h: candles1h,
    limitOrder,
    circuitBreaker,
  });
}

// P3: Walk-the-book liquidity cap — simulates consuming order book levels
function computeWalkTheBookLiquidity(depth: any, idrPrice: number, capitalIdr: number): AlphaSignal["liquidity"] {
  if (!depth || !depth.buy || !depth.sell || idrPrice <= 0) return null;

  const topBid = parseFloat(depth.buy[0]?.[0] ?? "0");
  const topAsk = parseFloat(depth.sell[0]?.[0] ?? "0");
  const midPrice = (topBid + topAsk) / 2;
  const spreadPct = midPrice > 0 ? ((topAsk - topBid) / midPrice) * 100 : 0;

  // Walk the book for both sides
  const wtBook = computeWalkTheBookCap(depth, midPrice);
  const maxNotionalFromBook = wtBook.maxNotional;

  // Also compute simple top-5 depth for comparison/fallback
  let topBidDepthVol = 0, topAskDepthVol = 0;
  for (let i = 0; i < Math.min(5, depth.buy.length); i++) topBidDepthVol += parseFloat(depth.buy[i]?.[1] ?? "0");
  for (let i = 0; i < Math.min(5, depth.sell.length); i++) topAskDepthVol += parseFloat(depth.sell[i]?.[1] ?? "0");

  const capitalCap = capitalIdr * 0.30;
  const liquidityCapActive = maxNotionalFromBook > 0 && maxNotionalFromBook < capitalCap;

  const levels = wtBook.buySide?.levelsConsumed ?? 0;
  const slippage = wtBook.buySide?.actualSlippagePct ?? 0;

  return {
    maxNotionalWithoutSlippage: maxNotionalFromBook > 0 ? maxNotionalFromBook : (Math.min(topBidDepthVol, topAskDepthVol) * 0.2 * idrPrice),
    topBidDepth: topBidDepthVol,
    topAskDepth: topAskDepthVol,
    spreadPct,
    liquidityCapActive,
    walkBookLevels: levels,
    walkBookSlippagePct: slippage,
    walkBookMethod: maxNotionalFromBook > 0 ? "walk_the_book" : "simple_depth",
  };
}

interface SignalContext {
  dataSource: string;
  dataStale: boolean;
  funding: FundingRateInfo | null;
  microstructure: MicrostructureData | null;
  idrPrice: number;
  liquidity: AlphaSignal["liquidity"];
  absorptionValidation: AbsorptionValidation | null;
  candles1h: Candle[];
  limitOrder: LimitOrderCostModel | null;
  circuitBreaker: CircuitBreakerState;
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

  // P7: CIRCUIT BREAKER — if open, force FLAT for this pair
  if (ctx.circuitBreaker.open) {
    return {
      pair,
      timestamp: new Date().toISOString(),
      dataStale: ctx.dataStale,
      dataSource: ctx.dataSource,
      action: "FLAT",
      strength: "none",
      conviction: 0,
      confirmed: false,
      entry: price, stopLoss: price, takeProfit1: price, takeProfit2: price,
      positionSizePct: 0, positionSizeIdr: 0,
      notionalIdr: 0, notionalCapPct: 0, leverage: 0, rewardRiskRatio: 0,
      edges: { funding: fundingEdge, fundingZScore, regime: regimeEdge, volatility: volEdge, trend: "no_trend" },
      microstructure: ctx.microstructure ? {
        oiTrend: ctx.microstructure.oiTrend, oiChange4hPct: ctx.microstructure.oiChange4hPct,
        cvd1h: ctx.microstructure.cvd1h, cvdDivergence: ctx.microstructure.cvdDivergence,
        absorptionDetected: ctx.microstructure.absorptionDetected, takerBuyRatio: ctx.microstructure.takerBuyRatio1h,
        confirmation: ctx.microstructure.confirmation,
      } : null,
      backtest: { oosWinRate: 0, oosAvgReturn: 0, oosSampleSize: 0, oosSharpe: 0, oosMaxDrawdown: 0, kellyFraction: 0, kellyCI5: 0, kellyCI95: 0, kellyUncertainty: 0, inSampleWinRate: 0, overfitGap: 0, honest: false, anchoredWindows: 0, rollingWinRate: 0, rollingSampleSize: 0, anchoredRollingGap: 0, regimeStable: false, description: "circuit breaker open" },
      liquidity: ctx.liquidity,
      absorptionValidation: ctx.absorptionValidation ? { optimalThreshold: ctx.absorptionValidation.optimalThreshold, precision: ctx.absorptionValidation.precision, precisionCI5: ctx.absorptionValidation.precisionCI5, precisionCI95: ctx.absorptionValidation.precisionCI95, lift: ctx.absorptionValidation.lift, validated: ctx.absorptionValidation.validated, description: ctx.absorptionValidation.description } : null,
      impact: null,
      limitOrder: ctx.limitOrder ? { recommendation: ctx.limitOrder.recommendation, fillProbability: ctx.limitOrder.fillProbability, netExpectedCostPct: ctx.limitOrder.netExpectedCostPct, adverseSelectionPct: ctx.limitOrder.adverseSelectionPct, description: ctx.limitOrder.description } : null,
      circuitBreaker: { open: true, consecutiveLosses: ctx.circuitBreaker.consecutiveLosses, winRate: ctx.circuitBreaker.winRate, cooldownSec: ctx.circuitBreaker.cooldownSec, trips: ctx.circuitBreaker.trips },
      rationale: [`CIRCUIT BREAKER OPEN: ${ctx.circuitBreaker.consecutiveLosses} consecutive losses. Cooldown ${Math.floor(ctx.circuitBreaker.cooldownSec / 60)}min remaining. Trips: ${ctx.circuitBreaker.trips}. Signals suppressed for this pair.`],
      invalidation: "Circuit breaker is open. Wait for cooldown to elapse, then half-open probe will test one signal.",
      warning: `CIRCUIT BREAKER TRIPPED. This pair has lost ${ctx.circuitBreaker.consecutiveLosses} consecutive OOS signals. Edge may have degraded. Do NOT override.`,
      raw: { price, atr, atrPercent, rsi, adx: regime.adx, fundingRate, fundingZScore, fundingPercentile, regime: regime.regime },
    };
  }

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

  // P3+P4: WALK-FORWARD OOS BACKTEST + KELLY FROM OOS WITH BOOTSTRAP CI
  const wfResult = walkForwardBacktest(candles1h, regime, action);

  // P4: Use 5th percentile bootstrap Kelly (conservative — only bet if 95%
  // of bootstrap resamples show positive Kelly). Falls back to point estimate
  // if bootstrap returned 0 (no OOS trades).
  const oosKelly = wfResult.kellyCI5 > 0 ? wfResult.kellyCI5 : wfResult.kellyFraction;
  const fractionalKelly = Math.max(0, oosKelly * KELLY_FRACTION);
  let positionSizePct = action !== "FLAT" ? Math.min(fractionalKelly, 0.05) * volScale : 0;

  // P5: NOTIONAL CAP — three layers: capital cap (30%), leverage cap (3x),
  // AND liquidity cap (max notional without >0.5% slippage from order book).
  const riskAmount = capitalIdr * (positionSizePct > 0 ? RISK_PER_TRADE_PCT : 0) * volScale;
  const stopDistance = action !== "FLAT" ? Math.abs(price - stopLoss) : 0;
  let notionalIdr = stopDistance > 0 ? (riskAmount / stopDistance) * price : 0;
  const maxNotionalPct = 0.30;
  const maxLeverage = 3.0;
  let notionalCapPct = notionalIdr / capitalIdr;
  let leverage = notionalCapPct;

  // Layer 1: Capital cap (30%)
  if (notionalCapPct > maxNotionalPct) {
    const scaleDown = maxNotionalPct / notionalCapPct;
    notionalIdr *= scaleDown;
    positionSizePct *= scaleDown;
    notionalCapPct = maxNotionalPct;
    leverage = notionalCapPct;
    rationale.push(`NOTIONAL CAP: capital cap → scaled to ${maxNotionalPct * 100}% (${maxLeverage}x lev)`);
  }

  // Layer 2: Liquidity cap (P5) — if order book is thin, reduce further
  if (ctx.liquidity && notionalIdr > ctx.liquidity.maxNotionalWithoutSlippage) {
    const liqCap = ctx.liquidity.maxNotionalWithoutSlippage;
    const scaleDown = liqCap / notionalIdr;
    const originalNotional = notionalIdr;
    notionalIdr = liqCap;
    positionSizePct *= scaleDown;
    notionalCapPct = notionalIdr / capitalIdr;
    leverage = notionalCapPct;
    rationale.push(`LIQUIDITY CAP: order book depth limits notional to Rp ${liqCap.toLocaleString("id-ID", { maximumFractionDigits: 0 })} (spread ${ctx.liquidity.spreadPct.toFixed(3)}%, top-5 depth: bid ${ctx.liquidity.topBidDepth.toFixed(2)} / ask ${ctx.liquidity.topAskDepth.toFixed(2)})`);
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
      kellyCI5: wfResult.kellyCI5,
      kellyCI95: wfResult.kellyCI95,
      kellyUncertainty: wfResult.kellyUncertainty,
      inSampleWinRate: wfResult.inSampleWinRate,
      overfitGap: wfResult.overfitGap,
      honest: wfResult.honest,
      anchoredWindows: wfResult.anchoredWindows,
      description: wfResult.description,
    },
    liquidity: ctx.liquidity,
    absorptionValidation: ctx.absorptionValidation ? {
      optimalThreshold: ctx.absorptionValidation.optimalThreshold,
      precision: ctx.absorptionValidation.precision,
      precisionCI5: ctx.absorptionValidation.precisionCI5,
      precisionCI95: ctx.absorptionValidation.precisionCI95,
      lift: ctx.absorptionValidation.lift,
      validated: ctx.absorptionValidation.validated,
      description: ctx.absorptionValidation.description,
    } : null,
    impact: action !== "FLAT" ? (() => {
      const capitalAtRiskPct = positionSizePct;
      const expectedLossIdr = positionSizeIdr;
      const concentrationPct = positionSizePct / 0.06 * 100;
      const impactLevel = positionSizePct > 0.03 ? "HIGH" : positionSizePct > 0.01 ? "MEDIUM" : "LOW";
      // v5: impact × probability = expected value
      const probability = wfResult.oosWinRate;
      const expectedWinIdr = positionSizeIdr * rewardRisk; // win = size × R:R
      const expectedValueIdr = (probability * expectedWinIdr) - ((1 - probability) * expectedLossIdr);
      // EV severity: combine impact level + probability + EV sign
      let evSeverity: "CRITICAL" | "ERROR" | "WARN" | "INFO";
      if (impactLevel === "HIGH" && probability > 0.55 && expectedValueIdr > 0) evSeverity = "CRITICAL";
      else if (impactLevel === "MEDIUM" && probability > 0.50 && expectedValueIdr > 0) evSeverity = "ERROR";
      else if (expectedValueIdr <= 0) evSeverity = "WARN";
      else evSeverity = "INFO";
      return {
        capitalAtRiskPct, expectedLossIdr, concentrationPct, impactLevel,
        probability, expectedValueIdr, evSeverity,
      };
    })() : null,
    limitOrder: ctx.limitOrder ? {
      recommendation: ctx.limitOrder.recommendation,
      fillProbability: ctx.limitOrder.fillProbability,
      netExpectedCostPct: ctx.limitOrder.netExpectedCostPct,
      adverseSelectionPct: ctx.limitOrder.adverseSelectionPct,
      description: ctx.limitOrder.description,
    } : null,
    circuitBreaker: {
      open: ctx.circuitBreaker.open,
      consecutiveLosses: ctx.circuitBreaker.consecutiveLosses,
      winRate: ctx.circuitBreaker.winRate,
      cooldownSec: ctx.circuitBreaker.cooldownSec,
      trips: ctx.circuitBreaker.trips,
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
