// Tail risk metrics: Value at Risk (VaR) + Expected Shortfall (ES).
//
// Computed from the closed SignalJournal P&L distribution. These complement
// drawdown %: drawdown measures peak-to-trough equity erosion, while VaR/ES
// measure single-trade tail risk.
//
//   VaR 95%: the 5th percentile loss. "With 95% confidence, a single trade
//            will not lose more than X% of its position size."
//   ES 95%:  the average loss in the worst 5% of trades. "If we DO hit the
//            tail, expect to lose ~X% on average."
//
// Both are expressed in P&L % terms (per-trade). We also compute VaR/ES in
// IDR terms using the average position size, plus portfolio-level VaR (scaled
// by concurrent open positions).
//
// Honesty: with n<30 closed trades, VaR/ES estimates are highly uncertain.
// We expose the sample size + a CI5/CI95 bootstrap interval so the UI can
// flag low-confidence estimates.

import { db } from "@/lib/db";

export interface TailRiskMetrics {
  // Per-trade metrics (in pnlPct terms)
  var95Pct: number;       // 5th percentile pnlPct (negative = loss)
  es95Pct: number;        // mean of pnlPct values below var95
  var99Pct: number;       // 1st percentile pnlPct (more extreme)
  es99Pct: number;        // mean of pnlPct values below var99
  // IDR terms (using average position size)
  avgPositionSizeIdr: number;
  var95Idr: number;
  es95Idr: number;
  // Portfolio-level (assuming max 3 concurrent positions)
  portfolioVar95Idr: number;
  portfolioEs95Idr: number;
  // Sample + confidence
  sampleSize: number;
  tailSampleSize: number;     // how many trades are in the worst 5%
  ciAdequate: boolean;        // true if n >= 30 AND tailSampleSize >= 3
  // Bootstrap CI for VaR 95% (1000 resamples)
  var95BootstrapCI5: number;
  var95BootstrapCI95: number;
  // Bootstrap CI for ES 95% (1000 resamples) — measures uncertainty in tail mean
  es95BootstrapCI5: number;
  es95BootstrapCI95: number;
  // Bootstrap CI for VaR 99% + ES 99%
  var99BootstrapCI5: number;
  var99BootstrapCI95: number;
  es99BootstrapCI5: number;
  es99BootstrapCI95: number;
  // Worst single trade observed
  worstTradePct: number;
  worstTradeIdr: number;
  computedAt: string;
}

const MAX_CONCURRENT_POSITIONS = 3;
const BOOTSTRAP_SAMPLES = 1000;

export async function getTailRiskMetrics(): Promise<TailRiskMetrics> {
  const closed = await db.signalJournal.findMany({
    where: { status: { not: "open" }, pnlPct: { not: null } },
  });

  if (closed.length === 0) {
    return {
      var95Pct: 0, es95Pct: 0, var99Pct: 0, es99Pct: 0,
      avgPositionSizeIdr: 0, var95Idr: 0, es95Idr: 0,
      portfolioVar95Idr: 0, portfolioEs95Idr: 0,
      sampleSize: 0, tailSampleSize: 0, ciAdequate: false,
      var95BootstrapCI5: 0, var95BootstrapCI95: 0,
      es95BootstrapCI5: 0, es95BootstrapCI95: 0,
      var99BootstrapCI5: 0, var99BootstrapCI95: 0,
      es99BootstrapCI5: 0, es99BootstrapCI95: 0,
      worstTradePct: 0, worstTradeIdr: 0,
      computedAt: new Date().toISOString(),
    };
  }

  const pnlPcts = closed.map((s) => s.pnlPct ?? 0);
  const positionSizes = closed.map((s) => s.positionSizeIdr ?? 0);
  const pnlIdrs = closed.map((s) => s.pnlIdr ?? 0);

  const n = pnlPcts.length;
  const sortedPct = [...pnlPcts].sort((a, b) => a - b);
  const sortedIdr = [...pnlIdrs].sort((a, b) => a - b);

  // Percentile helper (linear interpolation)
  const percentile = (sorted: number[], p: number): number => {
    if (sorted.length === 0) return 0;
    if (sorted.length === 1) return sorted[0];
    const idx = p * (sorted.length - 1);
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    const frac = idx - lo;
    return sorted[lo] * (1 - frac) + sorted[hi] * frac;
  };

  // VaR 95% = 5th percentile (we're 95% confident a trade won't be worse than this)
  const var95Pct = percentile(sortedPct, 0.05);
  const var99Pct = percentile(sortedPct, 0.01);

  // ES 95% = mean of all trades below VaR 95
  const tail95 = sortedPct.filter((p) => p <= var95Pct);
  const tail99 = sortedPct.filter((p) => p <= var99Pct);
  const es95Pct = tail95.length > 0 ? tail95.reduce((a, b) => a + b, 0) / tail95.length : var95Pct;
  const es99Pct = tail99.length > 0 ? tail99.reduce((a, b) => a + b, 0) / tail99.length : var99Pct;

  // IDR terms
  const avgPositionSizeIdr = positionSizes.reduce((a, b) => a + b, 0) / positionSizes.length;
  const var95Idr = avgPositionSizeIdr * var95Pct;
  const es95Idr = avgPositionSizeIdr * es95Pct;

  // Portfolio-level: assume up to MAX_CONCURRENT_POSITIONS open at once.
  // This is a conservative upper bound on tail exposure.
  const portfolioVar95Idr = var95Idr * MAX_CONCURRENT_POSITIONS;
  const portfolioEs95Idr = es95Idr * MAX_CONCURRENT_POSITIONS;

  // Worst single trade observed
  const worstTradePct = sortedPct[0];
  const worstTradeIdr = sortedIdr[0];

  // Bootstrap CI for VaR 95%, ES 95%, VaR 99%, ES 99% (1000 resamples, with replacement)
  const bootstrapVar95s: number[] = [];
  const bootstrapEs95s: number[] = [];
  const bootstrapVar99s: number[] = [];
  const bootstrapEs99s: number[] = [];
  for (let i = 0; i < BOOTSTRAP_SAMPLES; i++) {
    const sample: number[] = [];
    for (let j = 0; j < n; j++) {
      sample.push(pnlPcts[Math.floor(Math.random() * n)]);
    }
    sample.sort((a, b) => a - b);
    const bVar95 = percentile(sample, 0.05);
    const bVar99 = percentile(sample, 0.01);
    bootstrapVar95s.push(bVar95);
    bootstrapVar99s.push(bVar99);
    const bTail95 = sample.filter((p) => p <= bVar95);
    const bTail99 = sample.filter((p) => p <= bVar99);
    bootstrapEs95s.push(bTail95.length > 0 ? bTail95.reduce((a, b) => a + b, 0) / bTail95.length : bVar95);
    bootstrapEs99s.push(bTail99.length > 0 ? bTail99.reduce((a, b) => a + b, 0) / bTail99.length : bVar99);
  }
  bootstrapVar95s.sort((a, b) => a - b);
  bootstrapEs95s.sort((a, b) => a - b);
  bootstrapVar99s.sort((a, b) => a - b);
  bootstrapEs99s.sort((a, b) => a - b);
  const var95BootstrapCI5 = percentile(bootstrapVar95s, 0.05);
  const var95BootstrapCI95 = percentile(bootstrapVar95s, 0.95);
  const es95BootstrapCI5 = percentile(bootstrapEs95s, 0.05);
  const es95BootstrapCI95 = percentile(bootstrapEs95s, 0.95);
  const var99BootstrapCI5 = percentile(bootstrapVar99s, 0.05);
  const var99BootstrapCI95 = percentile(bootstrapVar99s, 0.95);
  const es99BootstrapCI5 = percentile(bootstrapEs99s, 0.05);
  const es99BootstrapCI95 = percentile(bootstrapEs99s, 0.95);

  const tailSampleSize = tail95.length;
  const ciAdequate = n >= 30 && tailSampleSize >= 3;

  return {
    var95Pct, es95Pct, var99Pct, es99Pct,
    avgPositionSizeIdr, var95Idr, es95Idr,
    portfolioVar95Idr, portfolioEs95Idr,
    sampleSize: n, tailSampleSize, ciAdequate,
    var95BootstrapCI5, var95BootstrapCI95,
    es95BootstrapCI5, es95BootstrapCI95,
    var99BootstrapCI5, var99BootstrapCI95,
    es99BootstrapCI5, es99BootstrapCI95,
    worstTradePct, worstTradeIdr,
    computedAt: new Date().toISOString(),
  };
}

// Format a tail risk metric for the UI: shows the loss as a positive number
// with a minus sign prefix (so -2.5% pnlPct becomes "2.5% loss").
export function formatLoss(pct: number): string {
  const loss = Math.abs(pct * 100);
  return `${loss.toFixed(2)}%`;
}

// ── REGIME-CONDITIONED VaR/ES ──
// Tail risk conditioned on the market regime at signal time. Different regimes
// have different loss distributions — trend_follow signals may have tighter
// tails (rides trend) while mean_revert signals may have fatter tails (fades
// can blow through stops in strong trends).
//
// We split closed signals by `regimeAtSignal` and compute VaR/ES per regime.

export interface RegimeTailRisk {
  regime: string;             // trend_follow | mean_revert | no_trade | unknown
  sampleSize: number;
  var95Pct: number;
  es95Pct: number;
  var99Pct: number;
  es99Pct: number;
  worstTradePct: number;
  ciAdequate: boolean;
  // Bootstrap CI for each metric (1000 resamples within this regime)
  var95BootstrapCI5: number;
  var95BootstrapCI95: number;
  es95BootstrapCI5: number;
  es95BootstrapCI95: number;
  var99BootstrapCI5: number;
  var99BootstrapCI95: number;
  es99BootstrapCI5: number;
  es99BootstrapCI95: number;
}

export interface RegimeTailRiskResult {
  regimes: RegimeTailRisk[];
  overallSampleSize: number;
  computedAt: string;
}

const REGIME_BOOTSTRAP_SAMPLES = 500; // fewer than global (per-regime sample is smaller)

export async function getRegimeConditionedTailRisk(): Promise<RegimeTailRiskResult> {
  const closed = await db.signalJournal.findMany({
    where: { status: { not: "open" }, pnlPct: { not: null } },
  });

  if (closed.length === 0) {
    return { regimes: [], overallSampleSize: 0, computedAt: new Date().toISOString() };
  }

  // Group by regimeAtSignal
  const regimeGroups = new Map<string, number[]>();
  for (const s of closed) {
    const regime = s.regimeAtSignal ?? "unknown";
    const arr = regimeGroups.get(regime) ?? [];
    arr.push(s.pnlPct ?? 0);
    regimeGroups.set(regime, arr);
  }

  const regimes: RegimeTailRisk[] = [];
  for (const [regime, pnlPcts] of regimeGroups) {
    const n = pnlPcts.length;
    if (n === 0) continue;
    const sorted = [...pnlPcts].sort((a, b) => a - b);
    const percentile = (p: number, arr: number[] = sorted) => {
      if (arr.length === 1) return arr[0];
      const idx = p * (arr.length - 1);
      const lo = Math.floor(idx), hi = Math.ceil(idx), frac = idx - lo;
      return arr[lo] * (1 - frac) + arr[hi] * frac;
    };
    const var95 = percentile(0.05);
    const var99 = percentile(0.01);
    const tail95 = sorted.filter((p) => p <= var95);
    const tail99 = sorted.filter((p) => p <= var99);
    const es95 = tail95.length > 0 ? tail95.reduce((a, b) => a + b, 0) / tail95.length : var95;
    const es99 = tail99.length > 0 ? tail99.reduce((a, b) => a + b, 0) / tail99.length : var99;

    // Bootstrap CI within this regime (500 resamples — fewer since per-regime sample is smaller)
    const bootVar95s: number[] = [], bootEs95s: number[] = [];
    const bootVar99s: number[] = [], bootEs99s: number[] = [];
    if (n >= 5) {
      for (let i = 0; i < REGIME_BOOTSTRAP_SAMPLES; i++) {
        const sample: number[] = [];
        for (let j = 0; j < n; j++) sample.push(pnlPcts[Math.floor(Math.random() * n)]);
        sample.sort((a, b) => a - b);
        const bVar95 = percentile(0.05, sample);
        const bVar99 = percentile(0.01, sample);
        bootVar95s.push(bVar95);
        bootVar99s.push(bVar99);
        const bTail95 = sample.filter((p) => p <= bVar95);
        const bTail99 = sample.filter((p) => p <= bVar99);
        bootEs95s.push(bTail95.length > 0 ? bTail95.reduce((a, b) => a + b, 0) / bTail95.length : bVar95);
        bootEs99s.push(bTail99.length > 0 ? bTail99.reduce((a, b) => a + b, 0) / bTail99.length : bVar99);
      }
      bootVar95s.sort((a, b) => a - b);
      bootEs95s.sort((a, b) => a - b);
      bootVar99s.sort((a, b) => a - b);
      bootEs99s.sort((a, b) => a - b);
    }

    regimes.push({
      regime,
      sampleSize: n,
      var95Pct: var95,
      es95Pct: es95,
      var99Pct: var99,
      es99Pct: es99,
      worstTradePct: sorted[0],
      ciAdequate: n >= 20 && tail95.length >= 2,
      var95BootstrapCI5: bootVar95s.length > 0 ? percentile(0.05, bootVar95s) : 0,
      var95BootstrapCI95: bootVar95s.length > 0 ? percentile(0.95, bootVar95s) : 0,
      es95BootstrapCI5: bootEs95s.length > 0 ? percentile(0.05, bootEs95s) : 0,
      es95BootstrapCI95: bootEs95s.length > 0 ? percentile(0.95, bootEs95s) : 0,
      var99BootstrapCI5: bootVar99s.length > 0 ? percentile(0.05, bootVar99s) : 0,
      var99BootstrapCI95: bootVar99s.length > 0 ? percentile(0.95, bootVar99s) : 0,
      es99BootstrapCI5: bootEs99s.length > 0 ? percentile(0.05, bootEs99s) : 0,
      es99BootstrapCI95: bootEs99s.length > 0 ? percentile(0.95, bootEs99s) : 0,
    });
  }

  return {
    regimes,
    overallSampleSize: closed.length,
    computedAt: new Date().toISOString(),
  };
}
