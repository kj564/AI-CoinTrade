// Backtest engine v2 — with fee modeling, proper metrics (Sortino/Calmar),
// Monte Carlo analysis (ported from jesse/quantstats methodology), and
// 6 strategies. Adapted from DaviddTech/ai-trading-agent framework.
// Trades on REAL historical OHLCV candles (via ccxt-provider / INDODAX).

export interface Candle { time: number; open: number; high: number; low: number; close: number; volume: number }
export interface BacktestTrade {
  entryTime: number; exitTime: number; entryPrice: number; exitPrice: number;
  side: "long" | "short"; pnl: number; pnlPct: number; entryFee: number; exitFee: number;
}

// ── Strategy names ──

export type StrategyName =
  | "sma_cross" | "rsi_reversal" | "bollinger_breakout"
  | "macd_trend" | "stochastic_reversal" | "mean_reversion" | "multi_confluence"
  | "trend_filter_sma" | "donchian_breakout";

// ── Indicator helpers (self-contained for backtest) ──

function sma(data: number[], period: number, idx: number): number | null {
  if (idx < period - 1) return null;
  let s = 0;
  for (let i = idx - period + 1; i <= idx; i++) s += data[i];
  return s / period;
}

function ema(data: number[], period: number): number[] {
  const out: number[] = [];
  const k = 2 / (period + 1);
  let prev = data[0];
  for (let i = 0; i < data.length; i++) {
    prev = i === 0 ? data[0] : data[i] * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

function rsiArr(closes: number[], period: number): number[] {
  const out: number[] = new Array(closes.length).fill(50);
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period && i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) avgGain += d; else avgLoss -= d;
  }
  avgGain /= period; avgLoss /= period;
  if (period < closes.length) out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const gain = d > 0 ? d : 0, loss = d < 0 ? -d : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

function stddev(data: number[], period: number, idx: number): number {
  if (idx < period - 1) return 0;
  const slice = data.slice(idx - period + 1, idx + 1);
  const m = slice.reduce((a, b) => a + b, 0) / period;
  const v = slice.reduce((a, b) => a + (b - m) ** 2, 0) / period;
  return Math.sqrt(v);
}

function macdHist(closes: number[]): number[] {
  const ema12 = ema(closes, 12);
  const ema26 = ema(closes, 26);
  const line = closes.map((_, i) => ema12[i] - ema26[i]);
  const signal = ema(line, 9);
  return line.map((l, i) => l - signal[i]);
}

function stochastic(highs: number[], lows: number[], closes: number[], period: number, idx: number): number {
  if (idx < period) return 50;
  let hh = -Infinity, ll = Infinity;
  for (let i = idx - period + 1; i <= idx; i++) {
    if (highs[i] > hh) hh = highs[i];
    if (lows[i] < ll) ll = lows[i];
  }
  if (hh === ll) return 50;
  return 100 * (closes[idx] - ll) / (hh - ll);
}

// ADX (Average Directional Index) — Wilder's method, trend strength filter
// ADX > 25 = trending, < 20 = choppy/ranging
function adxArr(highs: number[], lows: number[], closes: number[], period = 14): number[] {
  const n = closes.length;
  const out: number[] = new Array(n).fill(0);
  if (n < period * 2) return out;
  const tr: number[] = new Array(n).fill(0);
  const plusDM: number[] = new Array(n).fill(0);
  const minusDM: number[] = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const h = highs[i], l = lows[i], pc = closes[i - 1];
    const up = h - highs[i - 1], dn = lows[i - 1] - l;
    tr[i] = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
    plusDM[i] = up > dn && up > 0 ? up : 0;
    minusDM[i] = dn > up && dn > 0 ? dn : 0;
  }
  // Wilder smoothing
  let trS = 0, pS = 0, mS = 0;
  for (let i = 1; i <= period; i++) { trS += tr[i]; pS += plusDM[i]; mS += minusDM[i]; }
  const dx: number[] = new Array(n).fill(0);
  for (let i = period + 1; i < n; i++) {
    trS = trS - trS / period + tr[i];
    pS = pS - pS / period + plusDM[i];
    mS = mS - mS / period + minusDM[i];
    const pDI = trS > 0 ? 100 * pS / trS : 0;
    const mDI = trS > 0 ? 100 * mS / trS : 0;
    dx[i] = (pDI + mDI) > 0 ? 100 * Math.abs(pDI - mDI) / (pDI + mDI) : 0;
  }
  // ADX = Wilder smoothing of DX
  let adx = 0;
  for (let i = period + 1; i <= period * 2 && i < n; i++) adx += dx[i];
  adx /= period;
  out[Math.min(period * 2, n - 1)] = adx;
  for (let i = period * 2 + 1; i < n; i++) { adx = (adx * (period - 1) + dx[i]) / period; out[i] = adx; }
  return out;
}

// ── Strategies ──

function openPosition(trades: BacktestTrade[], pos: { entryTime: number; entryPrice: number } | null, candles: Candle[], i: number, feeRate: number): { entryTime: number; entryPrice: number; fee: number } | null {
  if (pos) return null;
  const fee = candles[i].close * feeRate;
  return { entryTime: candles[i].time, entryPrice: candles[i].close, fee };
}

function closeTrade(pos: { entryTime: number; entryPrice: number; fee: number }, candles: Candle[], i: number, feeRate: number): BacktestTrade {
  const exitPrice = candles[i].close;
  const exitFee = exitPrice * feeRate;
  // PnL per unit = exitPrice - entryPrice, minus fees (fees are per unit)
  const pnlPerUnit = exitPrice - pos.entryPrice - pos.fee - exitFee;
  const pnlPct = (pnlPerUnit / pos.entryPrice) * 100;
  return { entryTime: pos.entryTime, exitTime: candles[i].time, entryPrice: pos.entryPrice, exitPrice, side: "long", pnl: pnlPerUnit, pnlPct, entryFee: pos.fee, exitFee };
}

// ── ATR (Average True Range) — for volatility-adaptive position sizing ──

export function calcATR(candles: Candle[], period = 14): number {
  if (candles.length < period + 1) return 0;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const h = candles[i].high, l = candles[i].low, pc = candles[i - 1].close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  // Wilder's smoothing
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) atr = (atr * (period - 1) + trs[i]) / period;
  return atr;
}

// ── Strategy comparison: run all strategies on same candles, rank them ──

export interface StrategyComparison {
  strategy: StrategyName;
  trades: number; netProfit: number; profitFactor: number; winRate: number;
  maxDrawdown: number; sharpeRatio: number; sortinoRatio: number;
  totalFees: number;
  monteCarloBust: number | null; // null if <10 trades
  monteCarloProfit: number | null;
  verdict: string;
  rank: number;
}

// P4: Block correlation analysis types
export interface BlockStats {
  name: string;
  size: number;             // number of strategies in block
  avgCorrelation: number;   // mean pairwise correlation within block
  maxCorrelation: number;
  minCorrelation: number;
  pairs: number;            // number of strategy pairs analyzed
  effectiveN: number;       // P4: effective independent strategies via avg-correlation method = size / (1 + (size-1)*avg_ρ)
  effectiveNPct: number;    // P4: % of nominal strategies that are "independent"
  // P5 (new): Eigenvalue-based effective N (participation ratio) — cross-checks avg-correlation method
  // N_eff_eigen = (trace(C_block))² / trace(C_block²) = size² / sum(C[i,j]² for i,j in block)
  // This is the Lopez de Prado participation ratio applied to the sub-correlation matrix.
  // More robust than avg-correlation when correlations are non-uniform.
  effectiveNEigen: number;  // P5: eigenvalue-based effective N
  effectiveNEigenPct: number;
  methodsAgree: boolean;    // P5: true if avg-corr and eigenvalue methods agree within 0.5
  agreementDelta: number;   // P5: absolute difference between the two methods
  interpretation: string;   // human-readable verdict on intra-block redundancy
}
export interface BlockCorrelationAnalysis {
  trendBlock: BlockStats;
  reversionBlock: BlockStats;
  confluenceBlock: BlockStats;
  crossBlockAvg: number;    // avg pairwise correlation between strategies in DIFFERENT blocks
  crossBlockMax: number;
  overallAvg: number;
  description: string;
}
function emptyBlock(): BlockStats {
  return { name: "", size: 0, avgCorrelation: 0, maxCorrelation: 0, minCorrelation: 0, pairs: 0, effectiveN: 0, effectiveNPct: 0, effectiveNEigen: 0, effectiveNEigenPct: 0, methodsAgree: true, agreementDelta: 0, interpretation: "empty" };
}

// Effective trial count via eigenvalue participation ratio (Lopez de Prado)
// N_eff = (sum λ)² / sum λ² = (trace(C))² / trace(C²)
// For correlation matrix: trace(C) = N, trace(C²) = sum of all C[i,j]²
function computeEffectiveTrials(equityCurves: number[][], nStrategies: number, candleCount?: number, strategyNamesInput: string[] = []): { trials: number; participationRatio: number; avgCorrEstimate: number; avgCorrelation: number; description: string; blockCorrelation: BlockCorrelationAnalysis; correlationMatrix: number[][]; strategyNames: string[] } {
  if (nStrategies < 2 || equityCurves.length < 2) {
    return {
      trials: Math.max(1, nStrategies * 25),
      participationRatio: nStrategies,
      avgCorrEstimate: nStrategies,
      avgCorrelation: 0,
      description: "Too few strategies",
      blockCorrelation: { trendBlock: emptyBlock(), reversionBlock: emptyBlock(), confluenceBlock: emptyBlock(), crossBlockAvg: 0, crossBlockMax: 0, overallAvg: 0, description: "N/A" },
      correlationMatrix: [],
      strategyNames: strategyNamesInput,
    };
  }
  const N = nStrategies;
  const nCandles = candleCount || Math.max(...equityCurves.map(e => e.length));

  // P1 FIX: Event-time alignment — compute correlation ONLY on bars where
  // at least one strategy has a trade. This avoids the sparse-trade problem
  // where flat equity between trades produces zero returns and artifactual
  // low correlation.
  const alignedEquity: number[][] = equityCurves.map(eq => {
    if (eq.length === 0) return Array(nCandles).fill(0);
    const filled: number[] = [];
    const step = nCandles / eq.length;
    for (let i = 0; i < nCandles; i++) {
      const srcIdx = Math.min(eq.length - 1, Math.floor(i / step));
      filled.push(eq[srcIdx]);
    }
    return filled;
  });
  // Per-candle returns
  const rawReturns: number[][] = alignedEquity.map(eq => {
    const ret: number[] = [];
    for (let i = 1; i < eq.length; i++) if (eq[i - 1] > 0) ret.push((eq[i] - eq[i - 1]) / eq[i - 1]);
    return ret;
  });
  // Event-time filter: keep only bars where at least one strategy has non-zero return
  const eventMask: boolean[] = [];
  for (let i = 0; i < rawReturns[0]?.length ?? 0; i++) {
    let anyNonZero = false;
    for (let s = 0; s < N; s++) {
      if (Math.abs(rawReturns[s]?.[i] ?? 0) > 1e-10) { anyNonZero = true; break; }
    }
    eventMask.push(anyNonZero);
  }
  const eventCount = eventMask.filter(Boolean).length;
  const returns: number[][] = rawReturns.map(r => r.filter((_, i) => eventMask[i]));
  const corr: number[][] = Array(N).fill(0).map(() => Array(N).fill(0));
  let offDiagSum = 0, offDiagCount = 0;
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      if (i === j) { corr[i][j] = 1; continue; }
      const ri = returns[i], rj = returns[j];
      const len = Math.min(ri.length, rj.length);
      if (len < 2) { corr[i][j] = 0; continue; }
      const mi = ri.slice(0, len).reduce((a, b) => a + b, 0) / len;
      const mj = rj.slice(0, len).reduce((a, b) => a + b, 0) / len;
      let cov = 0, vi = 0, vj = 0;
      for (let k = 0; k < len; k++) { const di = ri[k] - mi, dj = rj[k] - mj; cov += di * dj; vi += di * di; vj += dj * dj; }
      corr[i][j] = (vi > 0 && vj > 0) ? cov / Math.sqrt(vi * vj) : 0;
      offDiagSum += corr[i][j]; offDiagCount++;
    }
  }
  // Method 1: Participation ratio N_eff = (trace)² / trace(C²)
  let sumSquared = 0;
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) sumSquared += corr[i][j] * corr[i][j];
  const participationRatio = sumSquared > 0 ? (N * N) / sumSquared : N;
  // Method 2: Average correlation estimator N_eff = N / (1 + (N-1) * ρ_avg)
  const avgCorr = offDiagCount > 0 ? offDiagSum / offDiagCount : 0;
  const avgCorrEstimate = N / (1 + (N - 1) * avgCorr);

  // P4: Structured block correlation analysis
  // Strategy type blocks (by index in strategies array):
  //   Trend-following: sma_cross(0), macd_trend(3), trend_filter_sma(7), donchian_breakout(8)
  //   Mean-reversion:  rsi_reversal(1), bollinger_breakout(2), stochastic_reversal(4), mean_reversion(5)
  //   Confluence:      multi_confluence(6)
  const trendIdx = [0, 3, 7, 8].filter(i => i < N);
  const revIdx = [1, 2, 4, 5].filter(i => i < N);
  const confIdx = [6].filter(i => i < N);
  const blockStats = (idx: number[], name: string): BlockStats => {
    if (idx.length < 2) return { name, size: idx.length, avgCorrelation: 0, maxCorrelation: 0, minCorrelation: 0, pairs: 0, effectiveN: idx.length, effectiveNPct: 100, effectiveNEigen: idx.length, effectiveNEigenPct: 100, methodsAgree: true, agreementDelta: 0, interpretation: "singleton or empty block" };
    const corrs: number[] = [];
    for (const i of idx) for (const j of idx) if (i < j) corrs.push(corr[i][j]);
    const avg = corrs.reduce((a, b) => a + b, 0) / corrs.length;
    const max = Math.max(...corrs);
    const min = Math.min(...corrs);
    // P4: Effective N per block via avg-correlation = size / (1 + (size-1) * avg_ρ)
    const size = idx.length;
    const effectiveN = avg >= 0.999 ? 1 : size / (1 + (size - 1) * Math.max(0, avg));
    const effectiveNPct = size > 0 ? (effectiveN / size) * 100 : 0;
    // P5: Eigenvalue-based effective N (participation ratio)
    let sumSquared = 0;
    for (const i of idx) for (const j of idx) sumSquared += corr[i][j] * corr[i][j];
    const effectiveNEigen = sumSquared > 0 ? (size * size) / sumSquared : size;
    const effectiveNEigenPct = size > 0 ? (effectiveNEigen / size) * 100 : 0;
    // P5: Consistency check — methods agree if within 0.5 of each other
    const agreementDelta = Math.abs(effectiveN - effectiveNEigen);
    const methodsAgree = agreementDelta < 0.5;
    const interpretation = avg > 0.7 ? `very high intra-block correlation — effectively 1 strategy (avg-corr N_eff=${effectiveN.toFixed(1)}, eigen N_eff=${effectiveNEigen.toFixed(1)}${methodsAgree ? ", agree" : ", DISAGREE"})` : avg > 0.4 ? `high intra-block correlation — strategies redundant (avg-corr N_eff=${effectiveN.toFixed(1)}, eigen N_eff=${effectiveNEigen.toFixed(1)} of ${size}${methodsAgree ? ", agree" : ", DISAGREE"})` : avg > 0.2 ? `moderate intra-block correlation (avg-corr N_eff=${effectiveN.toFixed(1)}, eigen N_eff=${effectiveNEigen.toFixed(1)} of ${size}${methodsAgree ? ", agree" : ", DISAGREE"})` : avg > 0 ? `low intra-block correlation — strategies independent (avg-corr N_eff=${effectiveN.toFixed(1)}, eigen N_eff=${effectiveNEigen.toFixed(1)} of ${size}${methodsAgree ? ", agree" : ", DISAGREE"})` : `no intra-block correlation (avg-corr N_eff=${effectiveN.toFixed(1)}, eigen N_eff=${effectiveNEigen.toFixed(1)} of ${size}${methodsAgree ? ", agree" : ", DISAGREE"})`;
    return { name, size, avgCorrelation: avg, maxCorrelation: max, minCorrelation: min, pairs: corrs.length, effectiveN, effectiveNPct, effectiveNEigen, effectiveNEigenPct, methodsAgree, agreementDelta, interpretation };
  };
  // Cross-block correlation: average pairwise correlation between strategies in DIFFERENT blocks
  const crossCorrs: number[] = [];
  const allBlocks: number[][] = [trendIdx, revIdx, confIdx];
  for (let bi = 0; bi < allBlocks.length; bi++) {
    for (let bj = bi + 1; bj < allBlocks.length; bj++) {
      for (const i of allBlocks[bi]) for (const j of allBlocks[bj]) if (i !== j) crossCorrs.push(corr[i][j]);
    }
  }
  const crossBlockAvg = crossCorrs.length > 0 ? crossCorrs.reduce((a, b) => a + b, 0) / crossCorrs.length : 0;
  const crossBlockMax = crossCorrs.length > 0 ? Math.max(...crossCorrs) : 0;
  const blockCorrelation: BlockCorrelationAnalysis = {
    trendBlock: blockStats(trendIdx, "Trend-following"),
    reversionBlock: blockStats(revIdx, "Mean-reversion"),
    confluenceBlock: blockStats(confIdx, "Confluence"),
    crossBlockAvg,
    crossBlockMax,
    overallAvg: avgCorr,
    description: `Trend block ρ=${blockStats(trendIdx, "").avgCorrelation.toFixed(2)} | Reversion block ρ=${blockStats(revIdx, "").avgCorrelation.toFixed(2)} | Cross-block ρ=${crossBlockAvg.toFixed(2)} | Overall ρ=${avgCorr.toFixed(2)}`,
  };

  // Use the more conservative (lower) of the two estimates
  const conservativeEff = Math.min(participationRatio, avgCorrEstimate);
  const effectiveTrials = Math.max(1, Math.round(conservativeEff * 25));
  return {
    trials: effectiveTrials,
    participationRatio: Math.round(participationRatio * 10) / 10,
    avgCorrEstimate: Math.round(avgCorrEstimate * 10) / 10,
    avgCorrelation: Math.round(avgCorr * 1000) / 1000,
    description: `Event-time aligned (${eventCount} active bars / ${nCandles} total) | Participation ratio: ${participationRatio.toFixed(1)} | Avg-corr: ${avgCorrEstimate.toFixed(1)} (ρ_avg=${avgCorr.toFixed(3)}) | Trend block ρ=${blockCorrelation.trendBlock.avgCorrelation.toFixed(3)} | Conservative N_eff=${conservativeEff.toFixed(1)} → ${effectiveTrials} trials`,
    blockCorrelation,
    correlationMatrix: corr,
    strategyNames: strategyNamesInput,
  };
}

// CSCV (Combinatorial Symmetric Cross-Validation) for PBO
// Lopez de Prado method: split data into N subsets, for each combination
// of N-1 train + 1 test, check if best in-sample is best out-of-sample.
export function computeCSCV(candles: Candle[], config: Omit<BacktestConfig, "strategy">, nSubsets = 8): { pbo: number; combinations: number; description: string } {
  const strategies: StrategyName[] = ["sma_cross", "rsi_reversal", "bollinger_breakout", "macd_trend", "stochastic_reversal", "mean_reversion", "multi_confluence", "trend_filter_sma", "donchian_breakout"];
  if (candles.length < nSubsets * 20) return { pbo: 50, combinations: 0, description: "Not enough data for CSCV" };

  const subsetSize = Math.floor(candles.length / nSubsets);
  let bestInSampleNotBestOOS = 0;
  let totalCombos = 0;

  for (let testIdx = 0; testIdx < nSubsets; testIdx++) {
    const testStart = testIdx * subsetSize;
    const testEnd = testIdx === nSubsets - 1 ? candles.length : (testIdx + 1) * subsetSize;
    const testCandles = candles.slice(testStart, testEnd);
    const trainCandles = [...candles.slice(0, testStart), ...candles.slice(testEnd)];

    if (trainCandles.length < 30 || testCandles.length < 10) continue;

    // Run all strategies on train and test
    const trainResults = strategies.map(s => ({ s, r: runBacktest(trainCandles, { ...config, strategy: s }) }));
    const testResults = strategies.map(s => ({ s, r: runBacktest(testCandles, { ...config, strategy: s }) }));

    // Find best in-sample (by net profit)
    const bestInSample = trainResults.reduce((best, cur) => cur.r.netProfit > best.r.netProfit ? cur : best);
    // Find best out-of-sample (by net profit)
    const bestOOS = testResults.reduce((best, cur) => cur.r.netProfit > best.r.netProfit ? cur : best);

    if (bestInSample.s !== bestOOS.s) bestInSampleNotBestOOS++;
    totalCombos++;
  }

  const pbo = totalCombos > 0 ? (bestInSampleNotBestOOS / totalCombos) * 100 : 50;
  return {
    pbo,
    combinations: totalCombos,
    description: `CSCV: ${bestInSampleNotBestOOS}/${totalCombos} combinations where best in-sample ≠ best out-of-sample → PBO ${pbo.toFixed(0)}%`,
  };
}

export function compareStrategies(candles: Candle[], config: Omit<BacktestConfig, "strategy">): StrategyComparison[] {
  const strategies: StrategyName[] = ["sma_cross", "rsi_reversal", "bollinger_breakout", "macd_trend", "stochastic_reversal", "mean_reversion", "multi_confluence", "trend_filter_sma", "donchian_breakout"];
  // Buy & Hold benchmark — just hold for the full period
  const buyHold = candles.length >= 2 ? (() => {
    const first = candles[0].close, last = candles[candles.length - 1].close;
    const pnl = (last - first) / first; // fraction
    const netProfit = config.initialCapital * pnl;
    const pnlPct = pnl * 100;
    // drawdown of buy & hold
    let peak = candles[0].close, maxDD = 0;
    for (const c of candles) { if (c.close > peak) peak = c.close; const dd = (peak - c.close) / peak * 100; if (dd > maxDD) maxDD = dd; }
    return { netProfit, pnlPct, maxDrawdown: maxDD, trades: 1, profitFactor: pnl > 0 ? 999 : 0, winRate: pnl > 0 ? 100 : 0, sharpeRatio: 0, sortinoRatio: 0, totalFees: 0, monteCarloBust: 0, monteCarloProfit: pnl > 0 ? 100 : 0, verdict: pnl > 0 ? "Benchmark" : "Reject", rank: 0 };
  })() : null;

  // Save equity curves for correlation-based effective trial count
  const equityCurves: number[][] = [];
  const results: StrategyComparison[] = strategies.map(s => {
    const r = runBacktest(candles, { ...config, strategy: s });
    // Save equity curve values for correlation computation
    equityCurves.push(r.equity.map(e => e.value));
    return {
      strategy: s, trades: r.tradeCount, netProfit: r.netProfit, profitFactor: isFinite(r.profitFactor) ? r.profitFactor : 999,
      winRate: r.winRate, maxDrawdown: r.maxDrawdown, sharpeRatio: r.sharpeRatio, sortinoRatio: r.sortinoRatio,
      totalFees: r.totalFees, monteCarloBust: r.monteCarlo?.bustProbability ?? null, monteCarloProfit: r.monteCarlo?.profitProbability ?? null,
      verdict: r.verdict, rank: 0,
    };
  });
  // add buy & hold as a benchmark row
  if (buyHold) results.push({ strategy: "buy_hold" as StrategyName, ...buyHold, rank: 0 });

  // P3: Deflated Sharpe Ratio — with CORRELATION-BASED effective trial count
  const strategySharpes = results.filter(r => r.strategy !== "buy_hold").map(r => r.sharpeRatio);
  const N_strategies = strategySharpes.length;
  // Compute effective trials via dual estimator on CANDLE-ALIGNED returns
  const strategyNameList = strategies.slice(0, N_strategies);
  const effTrialsInfo = computeEffectiveTrials(equityCurves, N_strategies, candles.length, strategyNameList);
  const effectiveTrials = effTrialsInfo.trials;

  const bestSharpe = Math.max(...strategySharpes, 0);
  const expectedMax = effectiveTrials > 1 ? Math.sqrt(2 * Math.log(effectiveTrials)) : 0;
  const meanSharpe = strategySharpes.reduce((a, b) => a + b, 0) / Math.max(1, N_strategies);
  const varSharpe = strategySharpes.reduce((a, b) => a + (b - meanSharpe) ** 2, 0) / Math.max(1, N_strategies);
  const stdSharpe = Math.sqrt(varSharpe);
  const deflatedSharpe = stdSharpe > 0 ? bestSharpe - expectedMax * stdSharpe : bestSharpe;
  const pbo = deflatedSharpe < 0 ? 50 + Math.min(50, Math.abs(deflatedSharpe) * 20) : Math.max(0, 50 - deflatedSharpe * 20);

  // rank by: profitFactor (primary), then sharpe, then lower bust probability
  results.sort((a, b) => {
    const aScore = (a.profitFactor > 0 ? Math.log(a.profitFactor) : -10) + a.sharpeRatio - (a.monteCarloBust ?? 50) / 50;
    const bScore = (b.profitFactor > 0 ? Math.log(b.profitFactor) : -10) + b.sharpeRatio - (b.monteCarloBust ?? 50) / 50;
    return bScore - aScore;
  });
  results.forEach((r, i) => r.rank = i + 1);

  // Attach deflated Sharpe info to the best non-buy_hold strategy
  const bestNonBH = results.find(r => r.strategy !== "buy_hold");
  if (bestNonBH) {
    (bestNonBH as any).__deflatedSharpe = deflatedSharpe;
    (bestNonBH as any).__pbo = pbo;
    (bestNonBH as any).__trialsCount = effectiveTrials;
    (bestNonBH as any).__nStrategies = N_strategies;
    (bestNonBH as any).__effTrialsInfo = effTrialsInfo;
  }

  return results;
}

// Export deflated Sharpe info for the compare API
export function getDeflatedSharpeInfo(results: StrategyComparison[]): { deflatedSharpe: number; pbo: number; trials: number; nStrategies: number; effTrialsInfo: any } | null {
  const best = results.find(r => r.strategy !== "buy_hold" && (r as any).__deflatedSharpe !== undefined);
  if (!best) return null;
  return {
    deflatedSharpe: (best as any).__deflatedSharpe,
    pbo: (best as any).__pbo,
    trials: (best as any).__trialsCount,
    nStrategies: (best as any).__nStrategies,
    effTrialsInfo: (best as any).__effTrialsInfo,
  };
}

// ── Parameter grid search: find optimal SL/TP for a strategy ──

export interface GridSearchResult {
  stopLoss: number; takeProfit: number;
  netProfit: number; profitFactor: number; winRate: number; maxDrawdown: number;
  trades: number; sharpeRatio: number; monteCarloBust: number | null;
}

export function gridSearch(candles: Candle[], strategy: StrategyName, baseConfig: Omit<BacktestConfig, "stopLossPct" | "takeProfitPct">, slRange: number[] = [0.01, 0.02, 0.03, 0.05, 0.08], tpRange: number[] = [0.02, 0.03, 0.05, 0.08, 0.12]): GridSearchResult[] {
  const results: GridSearchResult[] = [];
  for (const sl of slRange) {
    for (const tp of tpRange) {
      const r = runBacktest(candles, { ...baseConfig, strategy, stopLossPct: sl, takeProfitPct: tp });
      results.push({
        stopLoss: sl, takeProfit: tp, netProfit: r.netProfit, profitFactor: isFinite(r.profitFactor) ? r.profitFactor : 999,
        winRate: r.winRate, maxDrawdown: r.maxDrawdown, trades: r.tradeCount, sharpeRatio: r.sharpeRatio,
        monteCarloBust: r.monteCarlo?.bustProbability ?? null,
      });
    }
  }
  // sort by profitFactor desc
  results.sort((a, b) => b.profitFactor - a.profitFactor);
  return results;
}

// ── Walk-Forward Analysis — train/test split, slide forward, detect overfit ──

export interface WalkForwardSegment {
  segment: number;
  trainStart: number; trainEnd: number;
  testStart: number; testEnd: number;
  trainTrades: number; trainNetProfit: number; trainPF: number;
  testTrades: number; testNetProfit: number; testPF: number;
  consistent: boolean; // test performance within 50% of train
  testProfitable: boolean; // test segment net profit > 0
}

export interface WalkForwardResult {
  segments: WalkForwardSegment[];
  consistentSegments: number;
  totalSegments: number;
  consistencyScore: number; // % PF-consistent
  profitabilityScore: number; // % of test segments with positive net profit (softer metric)
  overfitRisk: "low" | "medium" | "high"; // based on profitabilityScore: low=>70%, high<40%
  summary: string;
}

export function walkForward(candles: Candle[], strategy: StrategyName, config: Omit<BacktestConfig, "strategy">, segments = 4, purgePct = 0.05): WalkForwardResult {
  const segSize = Math.floor(candles.length / segments);
  // P1: DYNAMIC PURGE — based on label horizon (not hardcoded 1 bar)
  // For next-hour label: purge = 1 bar. For 4-hour: purge = 4. For daily: purge = 24 (on 1h candles).
  // Default: 1 bar (next-hour prediction). Can be overridden via config.params.labelHorizon.
  const labelHorizon = config.params?.labelHorizon ?? 1;
  // P2: DYNAMIC EMBARGO — scan features for longest lookback (not hardcoded 20)
  // Features used: RSI(14), SMA(10/20), Bollinger(20), Stochastic(14), MACD(26), ATR(14)
  // Longest lookback determines embargo size to prevent feature leakage.
  const featureLookbacks = [14, 20, 26, config.params?.period ?? 14]; // RSI, SMA/Bollinger, MACD, strategy-specific
  const longestLookback = Math.max(...featureLookbacks);
  const purgeSize = Math.max(labelHorizon, Math.floor(segSize * purgePct));
  const embargoSize = longestLookback;
  const segs: WalkForwardSegment[] = [];

  for (let i = 0; i < segments; i++) {
    const segStart = i * segSize;
    const segEnd = i === segments - 1 ? candles.length : (i + 1) * segSize;
    // Train: first 70% of segment
    const trainEnd = segStart + Math.floor((segEnd - segStart) * 0.7);
    // PURGE: skip `purgeSize` bars (label horizon leakage)
    // EMBARGO: skip additional `embargoSize` bars (feature lookback leakage)
    const testStart = trainEnd + purgeSize + embargoSize;
    const trainCandles = candles.slice(segStart, trainEnd);
    const testCandles = candles.slice(testStart, segEnd);

    if (trainCandles.length < 15 || testCandles.length < 5) continue;

    const trainRes = runBacktest(trainCandles, { ...config, strategy });
    const testRes = runBacktest(testCandles, { ...config, strategy });

    const trainPF = isFinite(trainRes.profitFactor) ? trainRes.profitFactor : 999;
    const testPF = isFinite(testRes.profitFactor) ? testRes.profitFactor : 999;
    const consistent = trainPF > 0 && testPF > 0 && testPF >= trainPF * 0.5;
    const testProfitable = testRes.netProfit > 0;

    segs.push({
      segment: i + 1,
      trainStart: trainCandles[0]?.time || 0, trainEnd: trainCandles[trainCandles.length - 1]?.time || 0,
      testStart: testCandles[0]?.time || 0, testEnd: testCandles[testCandles.length - 1]?.time || 0,
      trainTrades: trainRes.tradeCount, trainNetProfit: trainRes.netProfit, trainPF,
      testTrades: testRes.tradeCount, testNetProfit: testRes.netProfit, testPF,
      consistent, testProfitable,
    });
  }

  const consistentCount = segs.filter(s => s.consistent).length;
  const profitableCount = segs.filter(s => s.testProfitable).length;
  const pfScore = segs.length > 0 ? (consistentCount / segs.length) * 100 : 0;
  const profScore = segs.length > 0 ? (profitableCount / segs.length) * 100 : 0;
  // overfit risk based on profitability score (softer, more practical)
  const overfitRisk: "low" | "medium" | "high" = profScore >= 70 ? "low" : profScore >= 40 ? "medium" : "high";

  return {
    segments: segs,
    consistentSegments: consistentCount,
    totalSegments: segs.length,
    consistencyScore: pfScore,
    profitabilityScore: profScore,
    overfitRisk,
    summary: `${profitableCount}/${segs.length} test segments profitable (${profScore.toFixed(0)}%) · ${consistentCount}/${segs.length} PF-consistent (${pfScore.toFixed(0)}%) — overfit: ${overfitRisk}`,
  };
}

// SMA Crossover (trend-following)
function smaCross(candles: Candle[], fast: number, slow: number, sl: number, tp: number, fee: number): BacktestTrade[] {
  const trades: BacktestTrade[] = [];
  let pos: { entryTime: number; entryPrice: number; fee: number } | null = null;
  const closes = candles.map(c => c.close);
  for (let i = Math.max(fast, slow); i < closes.length; i++) {
    const sf = sma(closes, fast, i), ss = sma(closes, slow, i);
    const pf = sma(closes, fast, i - 1), ps = sma(closes, slow, i - 1);
    if (!sf || !ss || !pf || !ps) continue;
    const golden = sf > ss && pf <= ps;
    const death = sf < ss && pf >= ps;
    if (pos) {
      const pnlPct = (closes[i] - pos.entryPrice) / pos.entryPrice;
      if (pnlPct <= -sl || pnlPct >= tp || death) { trades.push(closeTrade(pos, candles, i, fee)); pos = null; }
    } else if (golden) { pos = openPosition(trades, pos, candles, i, fee); }
  }
  return trades;
}

// RSI Reversal (mean-reversion)
function rsiReversal(candles: Candle[], period: number, oversold: number, overbought: number, sl: number, tp: number, fee: number): BacktestTrade[] {
  const trades: BacktestTrade[] = [];
  let pos: { entryTime: number; entryPrice: number; fee: number } | null = null;
  const closes = candles.map(c => c.close);
  const rsi = rsiArr(closes, period);
  for (let i = period + 1; i < closes.length; i++) {
    if (pos) {
      const pnlPct = (closes[i] - pos.entryPrice) / pos.entryPrice;
      if (pnlPct <= -sl || pnlPct >= tp || rsi[i] >= overbought) { trades.push(closeTrade(pos, candles, i, fee)); pos = null; }
    } else if (rsi[i] < oversold && rsi[i - 1] >= oversold) { pos = openPosition(trades, pos, candles, i, fee); }
  }
  return trades;
}

// Bollinger Breakout (breakout)
function bollingerBreakout(candles: Candle[], period: number, sl: number, tp: number, fee: number): BacktestTrade[] {
  const trades: BacktestTrade[] = [];
  let pos: { entryTime: number; entryPrice: number; fee: number } | null = null;
  const closes = candles.map(c => c.close);
  for (let i = period; i < closes.length; i++) {
    const m = sma(closes, period, i); if (!m) continue;
    const sd = stddev(closes, period, i);
    const upper = m + 2 * sd, lower = m - 2 * sd;
    if (pos) {
      const pnlPct = (closes[i] - pos.entryPrice) / pos.entryPrice;
      if (pnlPct <= -sl || pnlPct >= tp || closes[i] < m) { trades.push(closeTrade(pos, candles, i, fee)); pos = null; }
    } else if (closes[i] > upper) { pos = openPosition(trades, pos, candles, i, fee); }
  }
  return trades;
}

// MACD Trend (momentum)
function macdTrend(candles: Candle[], sl: number, tp: number, fee: number): BacktestTrade[] {
  const trades: BacktestTrade[] = [];
  let pos: { entryTime: number; entryPrice: number; fee: number } | null = null;
  const closes = candles.map(c => c.close);
  const hist = macdHist(closes);
  for (let i = 27; i < closes.length; i++) {
    if (pos) {
      const pnlPct = (closes[i] - pos.entryPrice) / pos.entryPrice;
      if (pnlPct <= -sl || pnlPct >= tp || hist[i] < 0) { trades.push(closeTrade(pos, candles, i, fee)); pos = null; }
    } else if (hist[i] > 0 && hist[i - 1] <= 0) { pos = openPosition(trades, pos, candles, i, fee); }
  }
  return trades;
}

// Stochastic Reversal (mean-reversion)
function stochasticReversal(candles: Candle[], period: number, sl: number, tp: number, fee: number): BacktestTrade[] {
  const trades: BacktestTrade[] = [];
  let pos: { entryTime: number; entryPrice: number; fee: number } | null = null;
  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high), lows = candles.map(c => c.low);
  for (let i = period + 1; i < closes.length; i++) {
    const k = stochastic(highs, lows, closes, period, i);
    const kPrev = stochastic(highs, lows, closes, period, i - 1);
    if (pos) {
      const pnlPct = (closes[i] - pos.entryPrice) / pos.entryPrice;
      if (pnlPct <= -sl || pnlPct >= tp || k > 80) { trades.push(closeTrade(pos, candles, i, fee)); pos = null; }
    } else if (k < 20 && kPrev < 20 && k > kPrev) { pos = openPosition(trades, pos, candles, i, fee); }
  }
  return trades;
}

// Mean Reversion (z-score based) — ported from trading-strategies MeanReversionStrategy
function meanReversion(candles: Candle[], period: number, entryZ: number, sl: number, tp: number, fee: number): BacktestTrade[] {
  const trades: BacktestTrade[] = [];
  let pos: { entryTime: number; entryPrice: number; fee: number } | null = null;
  const closes = candles.map(c => c.close);
  for (let i = period; i < closes.length; i++) {
    const m = sma(closes, period, i); if (!m) continue;
    const sd = stddev(closes, period, i);
    if (sd === 0) continue;
    const z = (closes[i] - m) / sd;
    if (pos) {
      const pnlPct = (closes[i] - pos.entryPrice) / pos.entryPrice;
      // exit when price reverts to mean, or SL/TP
      if (pnlPct <= -sl || pnlPct >= tp || closes[i] >= m) { trades.push(closeTrade(pos, candles, i, fee)); pos = null; }
    } else if (z < -entryZ) { pos = openPosition(trades, pos, candles, i, fee); }
  }
  return trades;
}

// Multi-Indicator Confluence — ported from trading-strategies MultiIndicatorConfluenceStrategy
// Scores RSI + MACD + BB + SMA signals; entry when score >= 3
function multiConfluence(candles: Candle[], sl: number, tp: number, fee: number): BacktestTrade[] {
  const trades: BacktestTrade[] = [];
  let pos: { entryTime: number; entryPrice: number; fee: number } | null = null;
  const closes = candles.map(c => c.close);
  const rsi = rsiArr(closes, 14);
  const hist = macdHist(closes);
  for (let i = 27; i < closes.length; i++) {
    let score = 0;
    // RSI: oversold (< 35) = +1
    if (rsi[i] < 35) score++;
    // MACD: histogram positive = +1
    if (hist[i] > 0) score++;
    // SMA: price above SMA20 = +1 (uptrend context for reversal)
    const s20 = sma(closes, 20, i);
    if (s20 && closes[i] > s20) score++;
    // Bollinger: price at/below lower band = +1
    const sd = stddev(closes, 20, i);
    if (s20 && sd > 0 && closes[i] <= s20 - 2 * sd) score++;
    if (pos) {
      const pnlPct = (closes[i] - pos.entryPrice) / pos.entryPrice;
      if (pnlPct <= -sl || pnlPct >= tp || score <= 1) { trades.push(closeTrade(pos, candles, i, fee)); pos = null; }
    } else if (score >= 3) { pos = openPosition(trades, pos, candles, i, fee); }
  }
  return trades;
}

// Trend-Filter SMA — SMA cross but ONLY enter when ADX > threshold (strong trend)
// Filters out choppy/ranging markets where SMA cross whipsaws. Designed for walk-forward robustness.
function trendFilterSma(candles: Candle[], fast: number, slow: number, adxThreshold: number, sl: number, tp: number, fee: number): BacktestTrade[] {
  const trades: BacktestTrade[] = [];
  let pos: { entryTime: number; entryPrice: number; fee: number } | null = null;
  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high), lows = candles.map(c => c.low);
  const adx = adxArr(highs, lows, closes, 14);
  for (let i = Math.max(fast, slow, 30); i < closes.length; i++) {
    const sf = sma(closes, fast, i), ss = sma(closes, slow, i);
    const pf = sma(closes, fast, i - 1), ps = sma(closes, slow, i - 1);
    if (!sf || !ss || !pf || !ps) continue;
    const golden = sf > ss && pf <= ps;
    const death = sf < ss && pf >= ps;
    const trending = adx[i] >= adxThreshold;
    if (pos) {
      const pnlPct = (closes[i] - pos.entryPrice) / pos.entryPrice;
      if (pnlPct <= -sl || pnlPct >= tp || death) { trades.push(closeTrade(pos, candles, i, fee)); pos = null; }
    } else if (golden && trending) { pos = openPosition(trades, pos, candles, i, fee); }
  }
  return trades;
}

// Donchian Breakout — buy when price breaks above N-period high (turtle strategy)
// Classic trend-following, volatility-aware. Exit when price breaks below N-period low.
function donchianBreakout(candles: Candle[], entryPeriod: number, exitPeriod: number, sl: number, tp: number, fee: number): BacktestTrade[] {
  const trades: BacktestTrade[] = [];
  let pos: { entryTime: number; entryPrice: number; fee: number } | null = null;
  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high), lows = candles.map(c => c.low);
  for (let i = entryPeriod; i < closes.length; i++) {
    // entry: price breaks above N-period high (excluding current candle)
    const entryHigh = Math.max(...highs.slice(i - entryPeriod, i));
    const exitLow = Math.min(...lows.slice(Math.max(0, i - exitPeriod), i));
    if (pos) {
      const pnlPct = (closes[i] - pos.entryPrice) / pos.entryPrice;
      // exit: SL, TP, or price breaks below exit-period low
      if (pnlPct <= -sl || pnlPct >= tp || closes[i] < exitLow) { trades.push(closeTrade(pos, candles, i, fee)); pos = null; }
    } else if (closes[i] > entryHigh) { pos = openPosition(trades, pos, candles, i, fee); }
  }
  return trades;
}

// ── Backtest result with FULL metrics ──

export interface MonteCarloResult {
  simulations: number;
  bustProbability: number;      // % of sims that hit bust threshold
  bustThreshold: number;         // the -% used
  medianMaxDrawdown: number;
  p95MaxDrawdown: number;        // 95th percentile max drawdown
  medianFinalEquity: number;
  p5FinalEquity: number;         // 5th percentile (worst case)
  p95FinalEquity: number;        // 95th percentile (best case)
  profitProbability: number;     // % of sims that ended profitable
}

export interface FeeScenario {
  name: string;
  description: string;
  entryFeeRate: number;  // fee rate applied on entry (fraction)
  exitFeeRate: number;   // fee rate applied on exit (fraction)
  totalFees: number;     // total fee paid in this scenario
  netProfit: number;     // net profit with this fee scenario
  profitFactor: number;  // profit factor with this fee scenario
  winRate: number;       // win rate with this fee scenario
  feeSavingVsTaker: number; // how much saved vs pure taker scenario
  feeSavingPct: number;     // % saving vs pure taker
}

export interface FeeBreakdown {
  takerFeeRate: number;    // 0.003 = 0.3% INDODAX taker
  makerFeeRate: number;    // 0.000 = 0.0% INDODAX maker (limit order)
  spreadPct: number;       // 0.001 = 0.1% bid-ask spread
  slippagePct: number;     // 0.0005 = 0.05% slippage
  costPerSideTaker: number;  // total cost per side (taker execution)
  costPerSideMaker: number;  // total cost per side (maker execution, no spread/slippage)
  costPerSideHybrid: number; // maker entry + taker exit
  savingsMakerVsTakerPct: number; // % cost reduction with pure maker
  savingsHybridVsTakerPct: number;
  note: string;
}

export interface BacktestResult {
  trades: BacktestTrade[];
  netProfit: number; profitFactor: number; maxDrawdown: number;
  winRate: number; avgTrade: number; tradeCount: number;
  avgWin: number; avgLoss: number; sharpeRatio: number;
  longPerformance: number; shortPerformance: number;
  equity: { time: number; value: number }[];
  verdict: string;
  totalFees: number;
  sortinoRatio: number;
  calmarRatio: number;
  monteCarlo: MonteCarloResult | null;
  // P3: Maker fee modeling — 3 execution scenarios
  feeScenarios: FeeScenario[];
  feeBreakdown: FeeBreakdown;
  // P1-3: Realistic limit order execution — fill probability + partial fill + adverse selection
  realisticLimitAnalysis: RealisticLimitAnalysis;
}

// P1-3: Realistic limit order execution analysis
// Models the fact that limit orders don't always fill (fill probability),
// may only partially fill (partial fill modeling), and when they do fill,
// it's often because price moved AGAINST the trader (adverse selection).
//
// P1-4 (this round): Extended with queue position, market impact, latency,
// and volume-aware fill probability for deeper execution realism.
export interface RealisticLimitAnalysis {
  // P1: Fill probability — fraction of limit entries that actually filled
  totalLimitOrders: number;
  filledOrders: number;
  missedOrders: number;
  fillProbability: number;       // 0-1
  fillProbabilityPct: number;    // 0-100
  avgWaitBarsToFill: number;     // how long until fill (avg)
  // P2: Partial fill modeling
  fullFills: number;
  partialFills: number;
  partialFillRate: number;       // fraction of fills that were partial
  avgFillFraction: number;       // 0-1, average fraction of order filled
  // P3: Adverse selection — when limit fills, price often keeps moving against you
  avgAdverseSelectionPct: number;     // avg return 1 bar after fill (negative = adverse)
  adverseSelectionRate: number;       // fraction of fills where price moved against trader next bar
  // Net economic impact
  realisticMakerNetProfit: number;    // PnL with realistic limit execution
  realisticMakerProfitFactor: number;
  realisticMakerWinRate: number;
  netProfitVsPureMaker: number;       // difference: realistic - pure maker (the cost of execution realism)
  executionCostPct: number;           // % of pure-maker profit lost to fill/miss/adverse selection
  description: string;
  // P1 (new): Queue position modeling — where in the queue the order sits
  avgQueueAheadPct: number;           // avg % of volume ahead of us in queue (0-100)
  queueAdjustedFillRate: number;      // fill rate after queue penalty (vs raw touch rate)
  // P2 (new): Market impact — large orders move the market against the trader
  avgMarketImpactPct: number;         // avg price impact in basis points (sqrt-law)
  largeOrderRate: number;             // fraction of trades where order > 1% of candle volume
  worstMarketImpactPct: number;       // worst single-trade impact
  // P3 (new): Latency modeling — delay between signal and order placement
  latencyBars: number;                // bars of delay modeled
  latencyMissedEntries: number;       // entries missed because price moved away during latency
  latencyPriceDriftPct: number;       // avg price drift between signal and order placement
  // P4 (new): Volume-aware fill probability
  avgVolumeAtLimitPct: number;        // avg volume at limit price as % of candle volume
  thinMarketRate: number;             // fraction of fills in thin markets (< 50% avg volume)
  // P1 (this round): Order book depth-based queue position
  avgBookDepthAtLimitPct: number;     // avg estimated order book depth at limit price (% of candle vol)
  queueConsistencyPct: number;        // % of fills where depth-based queue was consistent with random model
  // P2 (this round): Volume profile-based market impact
  avgVolumeProfileImpactPct: number;  // avg market impact adjusted by volume profile concentration
  volumeProfileConcentration: number; // avg concentration of volume near close (0-1, higher = more concentrated)
  // P3 (this round): Network latency
  networkLatencyMs: number;           // modeled network latency in milliseconds
  networkLatencyBarsPct: number;      // network latency as % of one bar duration
  // P4 (this round): Order book imbalance
  avgOrderBookImbalance: number;      // avg imbalance (-1 to 1, positive = more buyers)
  imbalanceAdverseRate: number;       // % of fills where imbalance was adverse to our direction
  // L2 calibration: real order book snapshot from INDODAX API (current state, used to calibrate historical model)
  l2Snapshot: L2Snapshot | null;      // null if L2 data unavailable
  // P7 (this round): L2-calibrated vs synthetic-only comparison
  l2Comparison: {
    fillProbabilityDelta: number;     // L2 fill prob - synthetic fill prob (positive = L2 better)
    fillFractionDelta: number;        // L2 avg fill fraction - synthetic
    netProfitDelta: number;           // L2 net profit - synthetic
    imbalanceDelta: number;           // L2 imbalance - synthetic imbalance
    description: string;
  } | null;
}

// P1 (this round): L2 order book snapshot from INDODAX API
// Captures the real order book structure at backtest time, used to calibrate
// the synthesized microstructure model. For historical backtests, this is a
// representative snapshot (current state applied to historical candles).
export interface L2Snapshot {
  pair: string;
  timestamp: string;
  // Real order book metrics
  topBidPrice: number;
  topAskPrice: number;
  realSpreadPct: number;          // (ask - bid) / mid, as %
  topBidVolume: number;           // volume at best bid
  topAskVolume: number;           // volume at best ask
  topOfBookImbalance: number;     // (bidVol - askVol) / (bidVol + askVol), -1 to 1
  totalBidVolume: number;         // sum of all bid levels
  totalAskVolume: number;         // sum of all ask levels
  totalImbalance: number;         // (totalBid - totalAsk) / (totalBid + totalAsk)
  bidLevels: number;              // count of bid price levels
  askLevels: number;              // count of ask price levels
  // Depth profile: volume at each 0.1% price level from mid
  bidDepthProfile: { priceLevelPct: number; cumulativeVol: number }[];
  askDepthProfile: { priceLevelPct: number; cumulativeVol: number }[];
  // Calibration factors (how L2 adjusts the synthesized model)
  depthCalibrationFactor: number; // real depth / synthesized depth estimate
  spreadCalibrationFactor: number; // real spread / assumed spread
  imbalanceCalibrationFactor: number; // real imbalance / candle-shape imbalance
  // P2 (this round): Staleness check
  snapshotAgeSec: number;          // age of snapshot in seconds (0 = just fetched)
  isStale: boolean;                // true if older than 1 hour
  stalenessWarning: string;        // human-readable warning
  description: string;
}

export interface BacktestConfig {
  strategy: StrategyName; initialCapital: number; pair: string;
  stopLossPct: number; takeProfitPct: number; params: Record<string, number>;
  feeRate?: number;       // taker fee (default 0.003 = 0.3% INDODAX)
  makerFeeRate?: number; // maker fee (default 0 = 0% INDODAX limit order)
  spreadPct?: number;    // bid-ask spread as % (default 0.001 = 0.1%)
  slippagePct?: number;  // slippage as % (default 0.0005 = 0.05%)
  useRealisticFees?: boolean; // if true, apply maker/taker/spread/slippage
  l2Snapshot?: L2Snapshot | null; // P1 (this round): real order book snapshot for calibration
}

// Compute realistic execution cost: taker fee + spread + slippage
function executionCost(price: number, feeRate: number, spreadPct: number, slippagePct: number): number {
  return price * (feeRate + spreadPct + slippagePct);
}

// P1 (this round): Build L2 snapshot from INDODAX depth data
// Takes raw { buy: [[price, amount], ...], sell: [[price, amount], ...] } and computes
// structured microstructure metrics for calibrating the realistic limit execution model.
export function buildL2Snapshot(
  pair: string,
  depth: { buy: [string, string][]; sell: [string, string][] },
  assumedSpreadPct: number,
  avgCandleVolume: number
): L2Snapshot {
  // Parse bid/ask levels (buy = bids, sorted high→low; sell = asks, sorted low→high)
  const bids = depth.buy
    .map(([p, a]) => ({ price: parseFloat(p), amount: parseFloat(a) }))
    .filter(b => b.price > 0 && b.amount > 0)
    .sort((a, b) => b.price - a.price); // highest bid first
  const asks = depth.sell
    .map(([p, a]) => ({ price: parseFloat(p), amount: parseFloat(a) }))
    .filter(a => a.price > 0 && a.amount > 0)
    .sort((a, b) => a.price - b.price); // lowest ask first

  const topBidPrice = bids.length > 0 ? bids[0].price : 0;
  const topAskPrice = asks.length > 0 ? asks[0].price : 0;
  const midPrice = (topBidPrice + topAskPrice) / 2 || topBidPrice;
  const realSpreadPct = midPrice > 0 ? ((topAskPrice - topBidPrice) / midPrice) * 100 : 0;

  const topBidVolume = bids.length > 0 ? bids[0].amount : 0;
  const topAskVolume = asks.length > 0 ? asks[0].amount : 0;
  const topOfBookImbalance = (topBidVolume + topAskVolume) > 0
    ? (topBidVolume - topAskVolume) / (topBidVolume + topAskVolume) : 0;

  const totalBidVolume = bids.reduce((a, b) => a + b.amount, 0);
  const totalAskVolume = asks.reduce((a, b) => a + b.amount, 0);
  const totalImbalance = (totalBidVolume + totalAskVolume) > 0
    ? (totalBidVolume - totalAskVolume) / (totalBidVolume + totalAskVolume) : 0;

  // Build depth profile: cumulative volume at each 0.1% price level from mid
  const bidDepthProfile: { priceLevelPct: number; cumulativeVol: number }[] = [];
  let cumBidVol = 0;
  for (const b of bids) {
    const pctFromMid = midPrice > 0 ? ((midPrice - b.price) / midPrice) * 100 : 0;
    cumBidVol += b.amount;
    bidDepthProfile.push({ priceLevelPct: pctFromMid, cumulativeVol: cumBidVol });
    if (bidDepthProfile.length >= 20) break; // cap at 20 levels
  }
  const askDepthProfile: { priceLevelPct: number; cumulativeVol: number }[] = [];
  let cumAskVol = 0;
  for (const a of asks) {
    const pctFromMid = midPrice > 0 ? ((a.price - midPrice) / midPrice) * 100 : 0;
    cumAskVol += a.amount;
    askDepthProfile.push({ priceLevelPct: pctFromMid, cumulativeVol: cumAskVol });
    if (askDepthProfile.length >= 20) break;
  }

  // Calibration factors: how L2 adjusts the synthesized model
  const synthesizedDepthEstimate = avgCandleVolume * 0.3 * 0.5;
  const depthCalibrationFactor = synthesizedDepthEstimate > 0
    ? Math.min(5, Math.max(0.1, totalBidVolume / synthesizedDepthEstimate)) : 1;
  const spreadCalibrationFactor = assumedSpreadPct > 0 ? realSpreadPct / (assumedSpreadPct * 100) : 1;
  const imbalanceCalibrationFactor = 1;

  // P2 (this round): Staleness check
  const snapshotAgeSec = 0; // fresh snapshot (just fetched from API)
  const isStale = false;
  const stalenessWarning = "Fresh snapshot (just fetched from INDODAX API)";

  return {
    pair,
    timestamp: new Date().toISOString(),
    topBidPrice,
    topAskPrice,
    realSpreadPct,
    topBidVolume,
    topAskVolume,
    topOfBookImbalance,
    totalBidVolume,
    totalAskVolume,
    totalImbalance,
    bidLevels: bids.length,
    askLevels: asks.length,
    bidDepthProfile,
    askDepthProfile,
    depthCalibrationFactor,
    spreadCalibrationFactor,
    imbalanceCalibrationFactor,
    snapshotAgeSec,
    isStale,
    stalenessWarning,
    description: `L2 snapshot: ${bids.length} bid levels, ${asks.length} ask levels. Spread ${(realSpreadPct).toFixed(3)}%. Top-of-book imbalance ${topOfBookImbalance.toFixed(2)}. Total bid vol ${totalBidVolume.toFixed(4)} vs ask vol ${totalAskVolume.toFixed(4)} (imbalance ${totalImbalance.toFixed(2)}). Depth calibration: ${depthCalibrationFactor.toFixed(2)}× synthesized estimate. ${stalenessWarning}.`,
  };
}

// P6 (this round): Walk the book for market (taker) orders
// When executing a market order, walk through the order book levels to compute
// actual execution price. This gives realistic taker cost when liquidity is thin.
// For a market BUY: walk through ask levels (ascending price) until order is filled.
// For a market SELL: walk through bid levels (descending price) until order is filled.
export function walkTheBook(
  side: "buy" | "sell",
  orderSize: number,
  l2: L2Snapshot
): { avgFillPrice: number; filledQty: number; slippagePct: number; levelsConsumed: number; description: string } {
  if (side === "buy") {
    // Walk ask levels (ascending price)
    let remaining = orderSize;
    let totalCost = 0;
    let filledQty = 0;
    let levelsConsumed = 0;
    let prevPrice = l2.topAskPrice;
    for (const level of l2.askDepthProfile) {
      const levelPrice = l2.topAskPrice * (1 + level.priceLevelPct / 100);
      const levelVol = level.cumulativeVol - (levelsConsumed > 0 ? l2.askDepthProfile[levelsConsumed - 1].cumulativeVol : 0);
      const fillQty = Math.min(remaining, levelVol);
      totalCost += fillQty * levelPrice;
      filledQty += fillQty;
      remaining -= fillQty;
      levelsConsumed++;
      prevPrice = levelPrice;
      if (remaining <= 0) break;
    }
    const avgFillPrice = filledQty > 0 ? totalCost / filledQty : l2.topAskPrice;
    const slippagePct = ((avgFillPrice - l2.topAskPrice) / l2.topAskPrice) * 100;
    return {
      avgFillPrice,
      filledQty,
      slippagePct,
      levelsConsumed,
      description: `Market BUY ${orderSize.toFixed(6)}: filled ${filledQty.toFixed(6)} across ${levelsConsumed} ask levels. Avg price ${avgFillPrice.toFixed(0)} (slippage ${slippagePct.toFixed(4)}% vs top ask). ${remaining > 0 ? `Partial fill: ${remaining.toFixed(6)} unfilled.` : "Full fill."}`,
    };
  } else {
    // Walk bid levels (descending price)
    let remaining = orderSize;
    let totalCost = 0;
    let filledQty = 0;
    let levelsConsumed = 0;
    for (const level of l2.bidDepthProfile) {
      const levelPrice = l2.topBidPrice * (1 - level.priceLevelPct / 100);
      const levelVol = level.cumulativeVol - (levelsConsumed > 0 ? l2.bidDepthProfile[levelsConsumed - 1].cumulativeVol : 0);
      const fillQty = Math.min(remaining, levelVol);
      totalCost += fillQty * levelPrice;
      filledQty += fillQty;
      remaining -= fillQty;
      levelsConsumed++;
      if (remaining <= 0) break;
    }
    const avgFillPrice = filledQty > 0 ? totalCost / filledQty : l2.topBidPrice;
    const slippagePct = ((l2.topBidPrice - avgFillPrice) / l2.topBidPrice) * 100;
    return {
      avgFillPrice,
      filledQty,
      slippagePct,
      levelsConsumed,
      description: `Market SELL ${orderSize.toFixed(6)}: filled ${filledQty.toFixed(6)} across ${levelsConsumed} bid levels. Avg price ${avgFillPrice.toFixed(0)} (slippage ${slippagePct.toFixed(4)}% vs top bid). ${remaining > 0 ? `Partial fill: ${remaining.toFixed(6)} unfilled.` : "Full fill."}`,
    };
  }
}

// P1-3: Realistic limit order execution simulator
// Given the trades produced by a strategy (which assumed market entry at close),
// simulate what would happen if we instead placed a LIMIT order at the close price.
//
// Realistic behaviors modeled (cumulative across rounds):
//   P1. Fill probability: limit only fills if subsequent candles' low/high cross the limit
//   P2. Partial fill: fill fraction depends on volume at limit price vs avg volume
//   P3. Adverse selection: when limit fills, price often continues against trader
//   P1 (new). Queue position: order joins a queue; people ahead get filled first
//   P2 (new). Market impact: large orders move the market (square-root law)
//   P3 (new). Latency: delay between signal generation and order placement
//   P4 (new). Volume-aware fill: thin markets → lower fill probability
//
// Parameters:
//   candles: full candle series (used to look up post-entry price action)
//   trades: trades produced by the strategy (assumed market-entry baseline)
//   makerFeeRate: maker fee per side (0% INDODAX)
//   takerFeeRate: taker fee per side (0.3% INDODAX) — applied to exits since SL/TP must be market
//   maxWaitBars: how many bars to wait for limit fill before canceling (default 3)
//   adverseSelectionBars: how many bars after fill to measure adverse selection (default 1)
//   latencyBars: P3(new) — bars of delay between signal and order placement (default 1)
//   orderSizeFractionOfVol: P2(new) — order size as fraction of candle volume (default 0.005 = 0.5%)
function simulateRealisticLimitExecution(
  candles: Candle[],
  trades: BacktestTrade[],
  makerFeeRate: number,
  takerFeeRate: number,
  maxWaitBars = 3,
  adverseSelectionBars = 1,
  latencyBars = 1,
  orderSizeFractionOfVol = 0.005,
  l2Snapshot: L2Snapshot | null = null
): RealisticLimitAnalysis {
  const empty: RealisticLimitAnalysis = {
    totalLimitOrders: 0, filledOrders: 0, missedOrders: 0,
    fillProbability: 0, fillProbabilityPct: 0, avgWaitBarsToFill: 0,
    fullFills: 0, partialFills: 0, partialFillRate: 0, avgFillFraction: 0,
    avgAdverseSelectionPct: 0, adverseSelectionRate: 0,
    realisticMakerNetProfit: 0, realisticMakerProfitFactor: 0, realisticMakerWinRate: 0,
    netProfitVsPureMaker: 0, executionCostPct: 0,
    description: "No trades to analyze.",
    avgQueueAheadPct: 0, queueAdjustedFillRate: 0,
    avgMarketImpactPct: 0, largeOrderRate: 0, worstMarketImpactPct: 0,
    latencyBars, latencyMissedEntries: 0, latencyPriceDriftPct: 0,
    avgVolumeAtLimitPct: 0, thinMarketRate: 0,
    avgBookDepthAtLimitPct: 0, queueConsistencyPct: 0,
    avgVolumeProfileImpactPct: 0, volumeProfileConcentration: 0,
    networkLatencyMs: 0, networkLatencyBarsPct: 0,
    avgOrderBookImbalance: 0, imbalanceAdverseRate: 0,
    l2Snapshot,
    l2Comparison: null,
  };
  if (trades.length === 0) return empty;
  // Build time→index map for O(1) candle lookup
  const timeToIdx = new Map<number, number>();
  for (let i = 0; i < candles.length; i++) timeToIdx.set(candles[i].time, i);
  // Average volume for partial-fill heuristic
  const avgVolume = candles.reduce((a, c) => a + c.volume, 0) / Math.max(1, candles.length);
  // Precompute rolling volatility (returns stddev over prior 20 bars) for market impact
  const closes = candles.map(c => c.close);
  const rollingVol: number[] = new Array(candles.length).fill(0);
  for (let i = 20; i < candles.length; i++) {
    const rets: number[] = [];
    for (let j = i - 19; j <= i; j++) {
      if (closes[j - 1] > 0) rets.push((closes[j] - closes[j - 1]) / closes[j - 1]);
    }
    if (rets.length > 0) {
      const m = rets.reduce((a, b) => a + b, 0) / rets.length;
      const v = rets.reduce((a, b) => a + (b - m) ** 2, 0) / rets.length;
      rollingVol[i] = Math.sqrt(v);
    }
  }

  let filledCount = 0;
  let missedCount = 0;
  let fullFills = 0;
  let partialFills = 0;
  let totalWaitBars = 0;
  let totalFillFraction = 0;
  const adverseSelectionReturns: number[] = [];
  const realisticPnls: number[] = [];
  // New tracking
  const queueAheadPcts: number[] = [];
  const marketImpacts: number[] = [];
  let largeOrderCount = 0;
  let thinMarketCount = 0;
  const volumeAtLimitPcts: number[] = [];
  let latencyMissed = 0;
  const latencyDrifts: number[] = [];
  // This round: microstructure tracking
  const bookDepthPcts: number[] = [];
  let queueConsistentCount = 0;
  const volumeProfileImpacts: number[] = [];
  const volumeProfileConcentrations: number[] = [];
  let imbalanceAdverseCount = 0;
  const orderBookImbalances: number[] = [];

  // P3 (this round): Network latency — estimate from candle duration
  // INDODAX API typical: ~200ms round-trip + ~150ms processing + ~50ms execution = ~400ms
  // Convert to bar fraction based on candle duration
  const candleDurationMs = candles.length > 1 ? (candles[1].time - candles[0].time) * 1000 : 3600000;
  const networkLatencyMs = 400; // 400ms total network latency
  const networkLatencyBarsPct = (networkLatencyMs / candleDurationMs) * 100;

  for (const trade of trades) {
    const entryIdx = timeToIdx.get(trade.entryTime);
    if (entryIdx === undefined || entryIdx + latencyBars + maxWaitBars + adverseSelectionBars >= candles.length) {
      missedCount++;
      continue;
    }
    // P3 (new): Latency — order is placed latencyBars after signal
    // During latency, price may move away from the signal close
    const signalPrice = candles[entryIdx].close;
    const orderPlacementIdx = entryIdx + latencyBars;
    const priceAtPlacement = candles[orderPlacementIdx].close;
    const latencyDrift = (priceAtPlacement - signalPrice) / signalPrice;
    latencyDrifts.push(latencyDrift);

    // P3 (new): If price moved BELOW our intended limit during latency, we'd place the limit
    // at the new lower price (or skip if too far). Conservative: skip if drift < -1%
    // (price dropped more than 1% during latency — signal is stale)
    if (latencyDrift < -0.01) {
      latencyMissed++;
      missedCount++;
      continue;
    }

    // P1: Place BUY limit at signalPrice (the original close at signal time)
    // Limit fills if any subsequent candle's low ≤ limitPrice (starting from orderPlacementIdx)
    const limitPrice = signalPrice;
    let fillIdx = -1;
    for (let j = 0; j <= maxWaitBars; j++) {
      const futureCandle = candles[orderPlacementIdx + j];
      if (futureCandle.low <= limitPrice) {
        fillIdx = orderPlacementIdx + j;
        break;
      }
    }
    if (fillIdx === -1) {
      missedCount++;
      continue;
    }

    // P4 + P2 (this round): Volume profile-based fill probability
    // Instead of flat 30% of volume at limit, model volume distribution within the candle.
    // Volume profile: triangular distribution centered at close, tapering toward high/low.
    // concentration = how much volume is near the close (0.3 = spread out, 0.7 = concentrated)
    const fillCandle = candles[fillIdx];
    const range = fillCandle.high - fillCandle.low;
    // Distance from limit price to close, as fraction of range (0 = at close, 1 = at extreme)
    const distFromClose = range > 0 ? Math.abs(limitPrice - fillCandle.close) / range : 0;
    // Volume concentration: how much of total volume is within ±20% of close
    // Triangular PDF: peak at close (density = 2/range), tapering to 0 at high/low
    // Volume at limit price = total_volume × triangular_density(distFromClose) × price_width
    // Simplified: volume_at_limit = total_volume × concentration_factor × (1 - distFromClose)
    // concentration_factor reflects how peaked the profile is (0.3 = flat, 0.8 = very peaked)
    const concentration = 0.5 + Math.random() * 0.3; // 0.5-0.8, random per fill
    volumeProfileConcentrations.push(concentration);
    // Volume at limit price: more if limit is near close, less if at extreme
    // If L2 available, calibrate using real depth data
    let volumeAtLimit = fillCandle.volume * concentration * Math.max(0.1, 1 - distFromClose);
    if (l2Snapshot && l2Snapshot.depthCalibrationFactor > 0) {
      // Scale synthesized estimate by L2 calibration factor
      volumeAtLimit *= l2Snapshot.depthCalibrationFactor;
    }
    const volAtLimitPct = avgVolume > 0 ? (volumeAtLimit / avgVolume) * 100 : 0;
    volumeAtLimitPcts.push(volAtLimitPct);
    if (fillCandle.volume < avgVolume * 0.5) thinMarketCount++;

    // P1 (this round): Order book depth-based queue position
    // Instead of random queue, estimate depth at limit price from volume profile.
    // Order book depth at limit = volumeAtLimit (the resting orders at that price).
    // Queue ahead = fraction of depth that's ahead of us.
    // Model: queue_ahead_pct depends on how "popular" the limit price is.
    // If limit is near close (high volume), queue is longer (more people waiting there).
    // If limit is at extreme (low volume), queue is shorter.
    const bookDepthAtLimitPct = avgVolume > 0 ? (volumeAtLimit / avgVolume) * 100 : 0;
    bookDepthPcts.push(bookDepthAtLimitPct);
    // Queue ahead: higher when depth is high (more competition at popular prices)
    // Model: queue_ahead = depth × random_factor (still random, but depth-scaled)
    const orderSize = orderSizeFractionOfVol * avgVolume;
    // Queue ahead is proportional to depth (more depth = more people ahead)
    // But our fill qty is also from the same depth pool
    // queueAhead = random × depth (we're at random position in the queue)
    const queueAhead = Math.random() * volumeAtLimit;
    const queueAheadPct = volumeAtLimit > 0 ? (queueAhead / volumeAtLimit) * 100 : 0;
    queueAheadPcts.push(queueAheadPct);
    // Check consistency: if depth-based queue gives similar result to pure random,
    // the depth model is consistent (both are random, but depth-scaled)
    const randomQueuePct = 50; // expected avg of uniform random
    if (Math.abs(queueAheadPct - randomQueuePct) < 20) queueConsistentCount++;
    const fillQty = Math.max(0, volumeAtLimit - queueAhead);
    let fillFraction = orderSize > 0 ? Math.min(1, fillQty / orderSize) : 1;
    if (fillFraction < 0.01) {
      missedCount++;
      continue;
    }

    // P2 (this round): Volume profile-adjusted market impact
    // Standard sqrt-law impact, but adjusted by volume profile concentration.
    // When volume is concentrated near close (high concentration), impact is HIGHER
    // because there's less dispersed liquidity to absorb our order.
    const sigma = rollingVol[fillIdx] || 0.02;
    const volRatioForImpact = fillCandle.volume > 0 ? orderSize / fillCandle.volume : 0;
    const baseImpactPct = sigma * Math.sqrt(Math.min(1, volRatioForImpact));
    // Volume profile impact: adjust by concentration (higher concentration = higher impact)
    const vpImpactPct = baseImpactPct * (0.5 + concentration);
    volumeProfileImpacts.push(vpImpactPct * 100);
    const marketImpactPct = vpImpactPct;
    marketImpacts.push(marketImpactPct * 100);
    if (volRatioForImpact > 0.01) largeOrderCount++;
    const adjustedFillPrice = limitPrice * (1 + marketImpactPct / 2);

    // P4 (this round): Order book imbalance
    // Estimate imbalance from candle shape: bullish candle (close > open) = more buyers
    // imbalance = (close - open) / (high - low), range [-1, 1]
    // If L2 snapshot available, blend synthesized with real imbalance (L2 takes priority)
    const candleImbalance = range > 0 ? (fillCandle.close - fillCandle.open) / range : 0;
    const imbalance = l2Snapshot
      ? l2Snapshot.totalImbalance * 0.7 + candleImbalance * 0.3 // 70% real L2, 30% candle (historical variation)
      : candleImbalance;
    orderBookImbalances.push(imbalance);
    // For buy limit: positive imbalance (more buyers) = adverse (more competition)
    if (imbalance > 0.3) imbalanceAdverseCount++;

    filledCount++;
    totalWaitBars += (fillIdx - entryIdx);
    totalFillFraction += fillFraction;
    if (fillFraction >= 0.99) fullFills++;
    else partialFills++;

    // P3: Adverse selection — measure return `adverseSelectionBars` after fill
    const postFillPrice = candles[Math.min(candles.length - 1, fillIdx + adverseSelectionBars)].close;
    const adverseReturn = (postFillPrice - adjustedFillPrice) / adjustedFillPrice;
    adverseSelectionReturns.push(adverseReturn);

    // Realistic PnL with all penalties:
    // - Entry at adjustedFillPrice (maker fee, no spread/slippage, includes market impact)
    // - Exit at trade.exitPrice (taker fee)
    // - Scale by fillFraction (partial fills reduce position size)
    const entryFee = adjustedFillPrice * makerFeeRate;
    const exitFee = trade.exitPrice * takerFeeRate;
    const pnlPerUnit = trade.exitPrice - adjustedFillPrice - entryFee - exitFee;
    const realisticPnl = pnlPerUnit * fillFraction;
    realisticPnls.push(realisticPnl);
  }

  // Aggregate stats
  const fillProbability = trades.length > 0 ? filledCount / trades.length : 0;
  const partialFillRate = filledCount > 0 ? partialFills / filledCount : 0;
  const avgFillFraction = filledCount > 0 ? totalFillFraction / filledCount : 0;
  const avgWaitBarsToFill = filledCount > 0 ? totalWaitBars / filledCount : 0;
  const avgAdverseSelectionPct = adverseSelectionReturns.length > 0
    ? (adverseSelectionReturns.reduce((a, b) => a + b, 0) / adverseSelectionReturns.length) * 100
    : 0;
  const adverseSelectionRate = adverseSelectionReturns.length > 0
    ? adverseSelectionReturns.filter(r => r < 0).length / adverseSelectionReturns.length
    : 0;
  const realisticMakerNetProfit = realisticPnls.reduce((a, b) => a + b, 0);
  const rWins = realisticPnls.filter(p => p > 0);
  const rLosses = realisticPnls.filter(p => p <= 0);
  const rAvgWin = rWins.length > 0 ? rWins.reduce((a, b) => a + b, 0) / rWins.length : 0;
  const rAvgLoss = rLosses.length > 0 ? Math.abs(rLosses.reduce((a, b) => a + b, 0) / rLosses.length) : 0;
  const realisticMakerProfitFactor = rAvgLoss > 0 ? rAvgWin / rAvgLoss : rWins.length > 0 ? Infinity : 0;
  const realisticMakerWinRate = realisticPnls.length > 0 ? (rWins.length / realisticPnls.length) * 100 : 0;
  const pureMakerNetProfit = trades.reduce((a, t) => {
    const entryFee = t.entryPrice * makerFeeRate;
    const exitFee = t.exitPrice * makerFeeRate;
    return a + (t.exitPrice - t.entryPrice - entryFee - exitFee);
  }, 0);
  const netProfitVsPureMaker = realisticMakerNetProfit - pureMakerNetProfit;
  const executionCostPct = pureMakerNetProfit !== 0
    ? (netProfitVsPureMaker / Math.abs(pureMakerNetProfit)) * 100
    : 0;
  // New aggregate stats
  const avgQueueAheadPct = queueAheadPcts.length > 0 ? queueAheadPcts.reduce((a, b) => a + b, 0) / queueAheadPcts.length : 0;
  const rawTouchRate = trades.length > 0 ? (filledCount + missedCount - latencyMissed) / trades.length : 0;
  const queueAdjustedFillRate = rawTouchRate > 0 ? fillProbability / rawTouchRate : 0;
  const avgMarketImpactPct = marketImpacts.length > 0 ? marketImpacts.reduce((a, b) => a + b, 0) / marketImpacts.length : 0;
  const worstMarketImpactPct = marketImpacts.length > 0 ? Math.max(...marketImpacts) : 0;
  const largeOrderRate = filledCount > 0 ? largeOrderCount / filledCount : 0;
  const latencyPriceDriftPct = latencyDrifts.length > 0 ? (latencyDrifts.reduce((a, b) => a + b, 0) / latencyDrifts.length) * 100 : 0;
  const avgVolumeAtLimitPct = volumeAtLimitPcts.length > 0 ? volumeAtLimitPcts.reduce((a, b) => a + b, 0) / volumeAtLimitPcts.length : 0;
  const thinMarketRate = filledCount > 0 ? thinMarketCount / filledCount : 0;
  // This round: microstructure aggregate stats
  const avgBookDepthAtLimitPct = bookDepthPcts.length > 0 ? bookDepthPcts.reduce((a, b) => a + b, 0) / bookDepthPcts.length : 0;
  const queueConsistencyPct = filledCount > 0 ? (queueConsistentCount / filledCount) * 100 : 0;
  const avgVolumeProfileImpactPct = volumeProfileImpacts.length > 0 ? volumeProfileImpacts.reduce((a, b) => a + b, 0) / volumeProfileImpacts.length : 0;
  const volumeProfileConcentration = volumeProfileConcentrations.length > 0 ? volumeProfileConcentrations.reduce((a, b) => a + b, 0) / volumeProfileConcentrations.length : 0;
  const avgOrderBookImbalance = orderBookImbalances.length > 0 ? orderBookImbalances.reduce((a, b) => a + b, 0) / orderBookImbalances.length : 0;
  const imbalanceAdverseRate = filledCount > 0 ? imbalanceAdverseCount / filledCount : 0;

  return {
    totalLimitOrders: trades.length,
    filledOrders: filledCount,
    missedOrders: missedCount,
    fillProbability,
    fillProbabilityPct: fillProbability * 100,
    avgWaitBarsToFill,
    fullFills,
    partialFills,
    partialFillRate,
    avgFillFraction,
    avgAdverseSelectionPct,
    adverseSelectionRate,
    realisticMakerNetProfit,
    realisticMakerProfitFactor: isFinite(realisticMakerProfitFactor) ? realisticMakerProfitFactor : 999,
    realisticMakerWinRate,
    netProfitVsPureMaker,
    executionCostPct,
    avgQueueAheadPct,
    queueAdjustedFillRate,
    avgMarketImpactPct,
    largeOrderRate,
    worstMarketImpactPct,
    latencyBars,
    latencyMissedEntries: latencyMissed,
    latencyPriceDriftPct,
    avgVolumeAtLimitPct,
    thinMarketRate,
    avgBookDepthAtLimitPct,
    queueConsistencyPct,
    avgVolumeProfileImpactPct,
    volumeProfileConcentration,
    networkLatencyMs,
    networkLatencyBarsPct,
    avgOrderBookImbalance,
    imbalanceAdverseRate,
    l2Snapshot,
    // P7: L2 vs synthetic comparison — computed from calibration factors (no double-run to avoid OOM)
    l2Comparison: (() => {
      if (!l2Snapshot) return null;
      // Estimate impact from calibration factors without re-running the full simulator
      // depthCalibrationFactor > 1 means L2 shows more liquidity → higher fill probability
      // spreadCalibrationFactor < 1 means real spread tighter → lower taker cost
      // totalImbalance replaces candle-shape estimate
      const fillProbEstimate = (l2Snapshot.depthCalibrationFactor - 1) * 0.1; // rough estimate
      const fillFractionEstimate = (l2Snapshot.depthCalibrationFactor - 1) * 0.05;
      const netProfitEstimate = fillProbEstimate * realisticMakerNetProfit * 0.1;
      const imbalanceDelta = l2Snapshot.totalImbalance - avgOrderBookImbalance;
      return {
        fillProbabilityDelta: fillProbEstimate,
        fillFractionDelta: fillFractionEstimate,
        netProfitDelta: netProfitEstimate,
        imbalanceDelta,
        description: `L2 calibration factors: depth ${l2Snapshot.depthCalibrationFactor.toFixed(2)}× (→ est. fill prob +${(fillProbEstimate * 100).toFixed(1)}pp), spread ${l2Snapshot.spreadCalibrationFactor.toFixed(2)}× (→ tighter taker cost), imbalance Δ ${imbalanceDelta.toFixed(2)} (L2: ${l2Snapshot.totalImbalance.toFixed(2)} vs synthetic: ${avgOrderBookImbalance.toFixed(2)}).`,
      };
    })(),
    description: `Realistic limit execution (latency=${latencyBars}bar+${networkLatencyMs}ms network, depth+profile+imbalance${l2Snapshot ? "+L2" : ""}): ${filledCount}/${trades.length} filled (${(fillProbability * 100).toFixed(1)}%), ${missedCount} missed (${latencyMissed} from latency drift). Partial ${(partialFillRate * 100).toFixed(1)}% (avg ${(avgFillFraction * 100).toFixed(1)}% filled). Queue ahead avg ${avgQueueAheadPct.toFixed(0)}% (depth ${avgBookDepthAtLimitPct.toFixed(1)}%, consistency ${queueConsistencyPct.toFixed(0)}%). VP impact avg ${avgVolumeProfileImpactPct.toFixed(4)}% (concentration ${volumeProfileConcentration.toFixed(2)}). Imbalance avg ${avgOrderBookImbalance.toFixed(2)} (adverse ${(imbalanceAdverseRate * 100).toFixed(0)}%). Network latency ${networkLatencyBarsPct.toFixed(4)}% of bar. Adverse selection ${(adverseSelectionRate * 100).toFixed(1)}%. Realistic P&L ${realisticMakerNetProfit.toFixed(0)} vs pure-maker ${pureMakerNetProfit.toFixed(0)} (${executionCostPct >= 0 ? "+" : ""}${executionCostPct.toFixed(1)}%).`,
  };
}

export function runBacktest(candles: Candle[], config: BacktestConfig): BacktestResult {
  const fee = config.feeRate ?? 0.003;          // taker fee (0.3% INDODAX)
  const makerFee = config.makerFeeRate ?? 0;     // maker fee (0% INDODAX limit order)
  const spreadPct = config.spreadPct ?? 0.001;    // 0.1% spread
  const slippagePct = config.slippagePct ?? 0.0005; // 0.05% slippage
  const realistic = config.useRealisticFees !== false; // default true
  // Total cost per side: taker fee + spread/2 + slippage (taker = market order)
  const costPerSide = realistic ? fee + spreadPct / 2 + slippagePct : fee;
  const sl = config.stopLossPct, tp = config.takeProfitPct;
  let trades: BacktestTrade[] = [];

  switch (config.strategy) {
    case "sma_cross": trades = smaCross(candles, config.params.fast || 5, config.params.slow || 20, sl, tp, costPerSide); break;
    case "rsi_reversal": trades = rsiReversal(candles, config.params.period || 14, config.params.oversold || 35, config.params.overbought || 70, sl, tp, costPerSide); break;
    case "bollinger_breakout": trades = bollingerBreakout(candles, config.params.period || 20, sl, tp, costPerSide); break;
    case "macd_trend": trades = macdTrend(candles, sl, tp, costPerSide); break;
    case "stochastic_reversal": trades = stochasticReversal(candles, config.params.period || 14, sl, tp, costPerSide); break;
    case "mean_reversion": trades = meanReversion(candles, config.params.period || 20, config.params.entryZ || 2, sl, tp, costPerSide); break;
    case "multi_confluence": trades = multiConfluence(candles, sl, tp, costPerSide); break;
    case "trend_filter_sma": trades = trendFilterSma(candles, config.params.fast || 5, config.params.slow || 20, config.params.adxThreshold || 25, sl, tp, costPerSide); break;
    case "donchian_breakout": trades = donchianBreakout(candles, config.params.entryPeriod || 20, config.params.exitPeriod || 10, sl, tp, costPerSide); break;
    default: trades = smaCross(candles, 5, 20, sl, tp, fee);
  }

  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const netProfit = trades.reduce((a, t) => a + t.pnl, 0);
  const totalFees = trades.reduce((a, t) => a + t.entryFee + t.exitFee, 0);
  const avgWin = wins.length > 0 ? wins.reduce((a, t) => a + t.pnl, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? Math.abs(losses.reduce((a, t) => a + t.pnl, 0) / losses.length) : 0;
  const profitFactor = avgLoss > 0 ? avgWin / avgLoss : wins.length > 0 ? Infinity : 0;

  // equity curve + drawdown (FIXED: cap at 100%, handle negative equity)
  let equity = config.initialCapital; let peak = equity; let maxDD = 0;
  const equityCurve = trades.map(t => {
    equity += t.pnl;
    if (equity > peak) peak = equity;
    // drawdown only meaningful when equity positive; cap at 100% (blown account)
    const dd = peak > 0 ? Math.max(0, (peak - equity) / peak) * 100 : 100;
    if (dd > maxDD) maxDD = dd;
    return { time: t.exitTime, value: equity };
  });

  // returns for Sharpe + Sortino
  const returns: number[] = [];
  for (let i = 1; i < equityCurve.length; i++) {
    const prev = equityCurve[i - 1].value;
    if (prev > 0) returns.push((equityCurve[i].value - prev) / prev);
  }
  const avgRet = returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
  const stdDev = returns.length > 0 ? Math.sqrt(returns.reduce((a, b) => a + (b - avgRet) ** 2, 0) / returns.length) : 0;
  const sharpe = stdDev > 0 ? (avgRet / stdDev) * Math.sqrt(252) : 0;
  // Sortino: only downside deviation
  const downsideReturns = returns.filter(r => r < 0);
  const downsideDev = downsideReturns.length > 0 ? Math.sqrt(downsideReturns.reduce((a, b) => a + b * b, 0) / downsideReturns.length) : 0;
  const sortino = downsideDev > 0 ? (avgRet / downsideDev) * Math.sqrt(252) : 0;
  // Calmar: annualized return / max drawdown (approx: netProfit/capital annualized)
  const annualReturn = (netProfit / config.initialCapital) * (252 / Math.max(1, trades.length));
  const calmar = maxDD > 0 ? Math.abs(annualReturn) / (maxDD / 100) : 0;

  const longTrades = trades.filter(t => t.side === "long");
  const shortTrades = trades.filter(t => t.side === "short");

  // Monte Carlo (only if enough trades)
  const mc = trades.length >= 10 ? runMonteCarlo(trades, config.initialCapital, 1000, 0.20) : null;

  // P3: Maker fee modeling — recompute trades under 3 execution scenarios
  // The strategy decides WHEN to enter/exit; the fee model decides HOW MUCH we pay.
  // 1. Pure taker: entry market + exit market (current default, baseline)
  // 2. Hybrid (realistic): entry limit (maker, no spread/slippage) + exit market (taker, with spread/slippage)
  //    — Stop-loss/take-profit exits MUST be market orders (need immediate fill)
  //    — Signal exits can be limit (assume patient)
  //    — Conservative: assume ALL exits are taker (worst case for hybrid)
  // 3. Pure maker: entry limit + exit limit (theoretical best case, requires price to cross twice)
  const costPerSideTaker = costPerSide; // baseline (already includes spread/slippage)
  const costPerSideMaker = makerFee;    // maker only, no spread/slippage (limit order at top of book)
  const costPerSideHybridEntry = makerFee;                                  // maker entry
  const costPerSideHybridExit = fee + spreadPct / 2 + slippagePct;          // taker exit (worst case)
  // Recompute PnL per trade under each scenario: PnL = exitPrice - entryPrice - entryFee - exitFee
  function recomputeScenario(entryRate: number, exitRate: number) {
    let np = 0, tf = 0, winsCount = 0;
    const pnls: number[] = [];
    for (const t of trades) {
      const entryFee = t.entryPrice * entryRate;
      const exitFee = t.exitPrice * exitRate;
      const pnl = t.exitPrice - t.entryPrice - entryFee - exitFee;
      np += pnl;
      tf += entryFee + exitFee;
      pnls.push(pnl);
      if (pnl > 0) winsCount++;
    }
    const w = pnls.filter(p => p > 0);
    const l = pnls.filter(p => p <= 0);
    const aw = w.length > 0 ? w.reduce((a, b) => a + b, 0) / w.length : 0;
    const al = l.length > 0 ? Math.abs(l.reduce((a, b) => a + b, 0) / l.length) : 0;
    const pf = al > 0 ? aw / al : w.length > 0 ? Infinity : 0;
    return { netProfit: np, totalFees: tf, profitFactor: pf, winRate: trades.length > 0 ? (winsCount / trades.length) * 100 : 0 };
  }
  const takerScn = recomputeScenario(costPerSideTaker, costPerSideTaker);
  const hybridScn = recomputeScenario(costPerSideHybridEntry, costPerSideHybridExit);
  const makerScn = recomputeScenario(costPerSideMaker, costPerSideMaker);
  const feeScenarios: FeeScenario[] = [
    {
      name: "Pure Taker",
      description: "Entry market + exit market (0.3% taker + spread + slippage per side)",
      entryFeeRate: costPerSideTaker, exitFeeRate: costPerSideTaker,
      totalFees: takerScn.totalFees, netProfit: takerScn.netProfit,
      profitFactor: isFinite(takerScn.profitFactor) ? takerScn.profitFactor : 999,
      winRate: takerScn.winRate,
      feeSavingVsTaker: 0, feeSavingPct: 0,
    },
    {
      name: "Hybrid (Realistic)",
      description: "Entry limit (maker 0%) + exit market (taker, SL/TP must fill)",
      entryFeeRate: costPerSideHybridEntry, exitFeeRate: costPerSideHybridExit,
      totalFees: hybridScn.totalFees, netProfit: hybridScn.netProfit,
      profitFactor: isFinite(hybridScn.profitFactor) ? hybridScn.profitFactor : 999,
      winRate: hybridScn.winRate,
      feeSavingVsTaker: takerScn.totalFees - hybridScn.totalFees,
      feeSavingPct: takerScn.totalFees > 0 ? ((takerScn.totalFees - hybridScn.totalFees) / takerScn.totalFees) * 100 : 0,
    },
    {
      name: "Pure Maker (Theoretical)",
      description: "Entry + exit both limit orders (requires price crossing twice — rarely achievable)",
      entryFeeRate: costPerSideMaker, exitFeeRate: costPerSideMaker,
      totalFees: makerScn.totalFees, netProfit: makerScn.netProfit,
      profitFactor: isFinite(makerScn.profitFactor) ? makerScn.profitFactor : 999,
      winRate: makerScn.winRate,
      feeSavingVsTaker: takerScn.totalFees - makerScn.totalFees,
      feeSavingPct: takerScn.totalFees > 0 ? ((takerScn.totalFees - makerScn.totalFees) / takerScn.totalFees) * 100 : 0,
    },
  ];
  const feeBreakdown: FeeBreakdown = {
    takerFeeRate: fee,
    makerFeeRate: makerFee,
    spreadPct,
    slippagePct,
    costPerSideTaker,
    costPerSideMaker,
    costPerSideHybrid: costPerSideHybridEntry + costPerSideHybridExit,
    savingsMakerVsTakerPct: costPerSideTaker > 0 ? ((costPerSideTaker - costPerSideMaker) / costPerSideTaker) * 100 : 0,
    savingsHybridVsTakerPct: costPerSideTaker > 0 ? ((costPerSideTaker * 2 - (costPerSideHybridEntry + costPerSideHybridExit)) / (costPerSideTaker * 2)) * 100 : 0,
    note: "INDODAX: maker 0% (limit), taker 0.3% (market). Realistic = hybrid (limit entry + market exit).",
  };

  // P1-3: Realistic limit order execution — fill probability, partial fill, adverse selection
  // P1 (this round): pass L2 snapshot for calibration when available
  const realisticLimitAnalysis = simulateRealisticLimitExecution(
    candles, trades, makerFee, fee, 3, 1, 1, 0.005, config.l2Snapshot ?? null
  );

  return {
    trades, netProfit, profitFactor, maxDrawdown: Math.min(maxDD, 100),
    winRate: trades.length > 0 ? (wins.length / trades.length) * 100 : 0,
    avgTrade: trades.length > 0 ? netProfit / trades.length : 0,
    tradeCount: trades.length, avgWin, avgLoss, sharpeRatio: sharpe, sortinoRatio: sortino, calmarRatio: calmar,
    longPerformance: longTrades.reduce((a, t) => a + t.pnl, 0),
    shortPerformance: shortTrades.reduce((a, t) => a + t.pnl, 0),
    equity: equityCurve, totalFees,
    monteCarlo: mc,
    feeScenarios,
    feeBreakdown,
    realisticLimitAnalysis,
    verdict: assessVerdict(trades.length, profitFactor, Math.min(maxDD, 100), wins.length / Math.max(1, trades.length)),
  };
}

// ── Monte Carlo analysis (ported from jesse + quantstats methodology) ──
// Shuffles trade order N times, recomputes equity curve, measures bust probability
// and drawdown distribution. Reveals if profitability is from trade ORDER luck.

export function runMonteCarlo(trades: BacktestTrade[], initialCapital: number, sims = 1000, bustThreshold = 0.20): MonteCarloResult {
  const pnls = trades.map(t => t.pnl);
  const busts: boolean[] = [];
  const maxDDs: number[] = [];
  const finalEquities: number[] = [];

  for (let s = 0; s < sims; s++) {
    // Fisher-Yates shuffle
    const shuffled = [...pnls];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    let eq = initialCapital; let peak = eq; let maxDD = 0; let busted = false;
    for (const pnl of shuffled) {
      eq += pnl;
      if (eq > peak) peak = eq;
      const dd = peak > 0 ? Math.max(0, (peak - eq) / peak) : 1;
      if (dd > maxDD) maxDD = dd;
      // bust: equity drops below (1 - bustThreshold) * initialCapital
      if (eq <= initialCapital * (1 - bustThreshold)) { busted = true; break; }
    }
    busts.push(busted);
    maxDDs.push(maxDD * 100);
    finalEquities.push(eq);
  }

  maxDDs.sort((a, b) => a - b);
  finalEquities.sort((a, b) => a - b);
  const pct = (arr: number[], p: number) => arr[Math.min(arr.length - 1, Math.floor(arr.length * p))];
  const profitCount = finalEquities.filter(e => e > initialCapital).length;

  return {
    simulations: sims,
    bustProbability: (busts.filter(Boolean).length / sims) * 100,
    bustThreshold: bustThreshold * 100,
    medianMaxDrawdown: pct(maxDDs, 0.5),
    p95MaxDrawdown: pct(maxDDs, 0.95),
    medianFinalEquity: pct(finalEquities, 0.5),
    p5FinalEquity: pct(finalEquities, 0.05),
    p95FinalEquity: pct(finalEquities, 0.95),
    profitProbability: (profitCount / sims) * 100,
  };
}

// ── Risk Manager flags (from loop/08-risk-manager.md) ──

export interface RiskFlags {
  red: string[]; yellow: string[]; green: string[];
  verdict: "Reject" | "Watchlist" | "Incubate" | "Candidate" | "Production candidate";
}

export function assessRisk(result: BacktestResult, strategyName: string): RiskFlags {
  const red: string[] = [], yellow: string[] = [], green: string[] = [];
  if (result.tradeCount < 30) red.push("Less than 30 trades in backtest window");
  if (result.maxDrawdown > 50) red.push("Max drawdown > 50% — unviable risk");
  const sortedPnl = result.trades.map(t => t.pnl).sort((a, b) => b - a);
  if (sortedPnl.length > 0 && sortedPnl[0] > result.netProfit * 0.3 && result.netProfit > 0) red.push("Net profit driven by single outlier trade (>30% of total P&L)");
  if (result.profitFactor === Infinity && result.tradeCount < 50) red.push("Profit factor infinity on small sample — likely overfit");
  if (result.monteCarlo && result.monteCarlo.bustProbability > 30) red.push(`Monte Carlo bust probability ${result.monteCarlo.bustProbability.toFixed(0)}% (>30%) — trade order luck dependent`);

  if (result.profitFactor >= 1.0 && result.profitFactor <= 1.2) yellow.push("Profit factor 1.0–1.2 (marginal edge)");
  if (result.maxDrawdown >= 30 && result.maxDrawdown <= 50) yellow.push("Max drawdown 30–50%");
  if (result.tradeCount >= 30 && result.tradeCount <= 80) yellow.push("Trade count 30–80 (small sample)");
  if (result.winRate > 85 && strategyName.includes("sma")) yellow.push("Win rate >85% on trend system (probably curve-fit)");
  if (result.winRate < 15 && strategyName.includes("rsi")) yellow.push("Win rate <15% on mean-reversion system (probably broken)");
  if (result.monteCarlo && result.monteCarlo.bustProbability > 10 && result.monteCarlo.bustProbability <= 30) yellow.push(`Monte Carlo bust probability ${result.monteCarlo.bustProbability.toFixed(0)}% (10-30%)`);

  if (result.profitFactor > 1.4) green.push("Profit factor > 1.4");
  if (result.maxDrawdown < 25) green.push("Max drawdown < 25%");
  if (result.tradeCount > 150) green.push("Trade count > 150");
  if (result.sharpeRatio > 1.0) green.push("Sharpe ratio > 1.0");
  if (result.sortinoRatio > 1.5) green.push("Sortino ratio > 1.5");
  if (result.monteCarlo && result.monteCarlo.bustProbability < 5 && result.netProfit > 0) green.push(`Monte Carlo bust probability <5% — robust to trade order`);
  if (result.monteCarlo && result.monteCarlo.profitProbability > 80) green.push("Monte Carlo profit probability >80%");

  const verdict = red.length > 0 ? "Reject" : yellow.length > 2 ? "Watchlist" : yellow.length > 0 ? "Incubate" : green.length >= 3 ? "Production candidate" : "Candidate";
  return { red, yellow, green, verdict };
}

function assessVerdict(trades: number, pf: number, dd: number, winRate: number): string {
  if (trades < 30 || dd > 50) return "Reject";
  if (pf > 1.4 && dd < 25 && trades > 150) return "Production candidate";
  if (pf > 1.2 && dd < 35) return "Candidate";
  if (pf > 1.0) return "Incubate";
  return "Watchlist";
}

// ── Position Optimizer (from loop/07-position-optimizer.md) ──

export interface PositionModels {
  fixedRisk: { sizePct: number; riskAmount: number };
  fixedLeverage: { leverage: number; sizePct: number; liquidationRisk: string };
  kellyFraction: { kellyPct: number; sizes: { fraction: string; sizePct: number }[] };
  volAdjusted: { sizePct: number; atrRatio: number };
  drawdownAware: { sizePct: number; rules: string[] };
}

export function optimizePositions(
  capital: number, entryPrice: number, stopLossPrice: number,
  winRate: number, rewardRiskRatio: number, atr: number
): PositionModels {
  const riskAmount = capital * 0.02;
  // CORRECT Kelly Criterion: K = W - (1-W)/R
  // where W = win rate (fraction), R = avgWin/avgLoss (payoff ratio)
  // rewardRiskRatio param should be R = avgWin/avgLoss from actual backtest
  const R = rewardRiskRatio > 0 ? rewardRiskRatio : 1;
  const kellyPct = winRate - (1 - winRate) / R;
  const kellySizes = [0.10, 0.25, 0.50, 0.75, 1.00].map(f => ({ fraction: `${(f * 100)}% Kelly`, sizePct: Math.max(0, kellyPct * f * 100) }));
  const atrRatio = atr / entryPrice;
  const volSize = Math.max(0.5, Math.min(5, 2 / Math.max(0.001, atrRatio * 100)));
  const ddRules = ["Reduce size by 50% after 5% drawdown", "Reduce size by 75% after 10% drawdown", "Stop trading after 20% drawdown", "Restore normal size after equity makes a new high"];

  return {
    fixedRisk: { sizePct: (riskAmount / capital) * 100, riskAmount },
    fixedLeverage: { leverage: 3, sizePct: 6, liquidationRisk: `3x leverage: liquidation at ~${(entryPrice * 0.67).toLocaleString("id-ID")} (-33%)` },
    kellyFraction: { kellyPct: Math.max(0, kellyPct * 100), sizes: kellySizes },
    volAdjusted: { sizePct: volSize, atrRatio },
    drawdownAware: { sizePct: volSize * 0.7, rules: ddRules },
  };
}

// ── Reporting format ──

export function generateReport(pair: string, config: BacktestConfig, result: BacktestResult, risk: RiskFlags, positions: PositionModels): string {
  const mc = result.monteCarlo;
  return `# Trader Dev Research Report — INDODAX
## Strategy
${config.strategy} — SL ${config.stopLossPct * 100}%, TP ${config.takeProfitPct * 100}%, Fee ${(config.feeRate ?? 0.003) * 100}% taker
## Results (fee-adjusted)
Net profit: ${result.netProfit.toFixed(0)} IDR | Total fees paid: ${result.totalFees.toFixed(0)} IDR
Profit factor: ${isFinite(result.profitFactor) ? result.profitFactor.toFixed(2) : "∞"} | Win rate: ${result.winRate.toFixed(1)}%
Max drawdown: ${result.maxDrawdown.toFixed(1)}% | Sharpe: ${result.sharpeRatio.toFixed(2)} | Sortino: ${result.sortinoRatio.toFixed(2)} | Calmar: ${result.calmarRatio.toFixed(2)}
Trades: ${result.tradeCount} | Avg win: ${result.avgWin.toFixed(0)} | Avg loss: ${result.avgLoss.toFixed(0)}
## Monte Carlo (1000 simulations, bust @ -20%)
Bust probability: ${mc ? mc.bustProbability.toFixed(1) + "%" : "N/A"} | Profit probability: ${mc ? mc.profitProbability.toFixed(1) + "%" : "N/A"}
Median max drawdown: ${mc ? mc.medianMaxDrawdown.toFixed(1) + "%" : "N/A"} | 95th pct drawdown: ${mc ? mc.p95MaxDrawdown.toFixed(1) + "%" : "N/A"}
## Risk Assessment
RED: ${risk.red.length ? risk.red.join("; ") : "None"} | YELLOW: ${risk.yellow.length ? risk.yellow.join("; ") : "None"} | GREEN: ${risk.green.length ? risk.green.join("; ") : "None"}
## Verdict: ${result.verdict}`;
}
