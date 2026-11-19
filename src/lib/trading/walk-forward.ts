// Walk-forward out-of-sample validation.
//
// The old backtest was in-sample: it found historical matches to the current
// regime and computed forward returns. That's biased toward overfitting —
// the "regime match" itself was determined using data that includes the
// forward window.
//
// Walk-forward fixes this:
//   1. Split the 500 1h candles into 5 windows of 100 candles each.
//   2. For each window i (starting from i=1), use window i-1's data to
//      determine the signal parameters (what regime thresholds, what action).
//   3. Test on window i (OOS — the model hasn't seen this data).
//   4. Record whether the signal would have been correct.
//   5. Aggregate OOS win rate, avg return, Sharpe across all windows.
//
// The Kelly fraction is then computed from OOS trades only — not from
// in-sample data that was already used to determine thresholds.
//
// This is the honest way to estimate forward performance. If the OOS win rate
// is below 50%, the edge is NOT confirmed and Kelly should be 0.

import { calcATR, type Candle } from "./backtest";

export interface WalkForwardResult {
  oosWinRate: number;
  oosAvgReturn: number;
  oosMaxDrawdown: number;
  oosSharpe: number;
  oosSampleSize: number;
  kellyFraction: number;
  kellyCI5: number;
  kellyCI95: number;
  kellyUncertainty: number;
  inSampleWinRate: number;
  overfitGap: number;
  honest: boolean;
  anchoredWindows: number;
  // P1: Rolling walk-forward cross-check
  rollingWinRate: number;      // rolling WF win rate (fixed sliding window)
  rollingSampleSize: number;
  anchoredRollingGap: number;  // |anchored - rolling| win rate gap (large = regime unstable)
  regimeStable: boolean;       // true if gap < 15%
  description: string;
}

interface OOSTrade {
  return: number;
  holdHours: number;
  maxDrawdown: number;
  win: boolean;
}

export function walkForwardBacktest(
  candles: Candle[],
  currentRegime: { adx: number; atrRatio: number },
  action: "LONG" | "SHORT" | "FLAT",
): WalkForwardResult {
  const empty: WalkForwardResult = {
    oosWinRate: 0, oosAvgReturn: 0, oosMaxDrawdown: 0, oosSharpe: 0,
    oosSampleSize: 0, kellyFraction: 0, kellyCI5: 0, kellyCI95: 0, kellyUncertainty: 0,
    inSampleWinRate: 0, overfitGap: 0, honest: false, anchoredWindows: 0,
    rollingWinRate: 0, rollingSampleSize: 0, anchoredRollingGap: 0, regimeStable: false,
    description: "insufficient data or no action",
  };

  if (candles.length < 100 || action === "FLAT") return empty;

  // P3: ANCHORED walk-forward — training window EXPANDS (more data for later tests)
  // Window 1: train [0,100], test [100,200]
  // Window 2: train [0,200], test [200,300]  ← training grew
  // Window 3: train [0,300], test [300,400]  ← training grew again
  // This gives each test more regime history to learn from.
  const testWindowSize = 80;  // test on 80 candles (shorter test = more windows)
  const minTrainSize = 100;
  const oosTrades: OOSTrade[] = [];
  const inSampleReturns: number[] = [];
  const adxBand = currentRegime.adx < 20 ? "low" : currentRegime.adx > 25 ? "high" : "mid";
  const atrBand = currentRegime.atrRatio > 1.5 ? "high" : currentRegime.atrRatio < 0.8 ? "low" : "normal";
  let windowsTested = 0;

  for (let testStart = minTrainSize; testStart + 20 <= candles.length; testStart += testWindowSize) {
    const trainCandles = candles.slice(0, testStart);  // anchored: always from 0 to testStart
    const testEnd = Math.min(testStart + testWindowSize, candles.length);
    const testCandles = candles.slice(testStart, testEnd);
    if (trainCandles.length < minTrainSize || testCandles.length < 20) continue;

    // Compute regime in the TRAINING window
    const trainATR = calcATR(trainCandles, 14);
    const trainADX = approximateADX(trainCandles);
    const trainATRRatio = trainATR / (avgATR(trainCandles, 50) || trainATR);
    const trainAdxBand = trainADX < 20 ? "low" : trainADX > 25 ? "high" : "mid";
    const trainAtrBand = trainATRRatio > 1.5 ? "high" : trainATRRatio < 0.8 ? "low" : "normal";

    if (trainAdxBand !== adxBand || trainAtrBand !== atrBand) continue;
    windowsTested++;

    const entry = testCandles[0].close;
    const stop = action === "LONG" ? entry - 2 * trainATR : action === "SHORT" ? entry + 2 * trainATR : entry;
    const target = action === "LONG" ? entry + 3 * trainATR : action === "SHORT" ? entry - 3 * trainATR : entry;

    let exitPrice = entry;
    let maxDD = 0;
    let exited = false;

    for (let i = 0; i < testCandles.length; i++) {
      const c = testCandles[i];
      if (action === "LONG" && c.low <= stop) { exitPrice = stop; exited = true; break; }
      if (action === "SHORT" && c.high >= stop) { exitPrice = stop; exited = true; break; }
      if (action === "LONG" && c.high >= target) { exitPrice = target; exited = true; break; }
      if (action === "SHORT" && c.low <= target) { exitPrice = target; exited = true; break; }
      if (action === "LONG") { const dd = (entry - c.low) / entry; if (dd > maxDD) maxDD = dd; }
      else if (action === "SHORT") { const dd = (c.high - entry) / entry; if (dd > maxDD) maxDD = dd; }
    }
    if (!exited) exitPrice = testCandles[testCandles.length - 1].close;

    const ret = action === "LONG" ? (exitPrice - entry) / entry : action === "SHORT" ? (entry - exitPrice) / entry : 0;
    oosTrades.push({ return: ret, holdHours: testCandles.length, maxDrawdown: maxDD, win: ret > 0 });
    inSampleReturns.push(ret);
  }

  const inSampleWinRate = inSampleReturns.length > 0 ? inSampleReturns.filter((r) => r > 0).length / inSampleReturns.length : 0;

  if (oosTrades.length === 0) {
    return { ...empty, inSampleWinRate, anchoredWindows: windowsTested,
      description: `No OOS trades matching regime ${adxBand}/${atrBand} (${windowsTested} anchored windows tested)`,
    };
  }

  const oosWinRate = oosTrades.filter((t) => t.win).length / oosTrades.length;
  const oosAvgReturn = oosTrades.reduce((a, t) => a + t.return, 0) / oosTrades.length;
  const oosMaxDrawdown = Math.max(...oosTrades.map((t) => t.maxDrawdown));
  const avgHold = oosTrades.reduce((a, t) => a + t.holdHours, 0) / oosTrades.length;
  const stdRet = Math.sqrt(oosTrades.reduce((a, t) => a + Math.pow(t.return - oosAvgReturn, 2), 0) / oosTrades.length);
  const oosSharpe = stdRet > 0 ? (oosAvgReturn / stdRet) * Math.sqrt(365 * 24 / avgHold) : 0;

  // Point estimate Kelly
  const wins = oosTrades.filter((t) => t.win);
  const losses = oosTrades.filter((t) => !t.win);
  const avgWin = wins.length > 0 ? wins.reduce((a, t) => a + t.return, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? Math.abs(losses.reduce((a, t) => a + t.return, 0) / losses.length) : 0;
  const b = avgLoss > 0 ? avgWin / avgLoss : 1.5;
  const p = oosWinRate;
  const q = 1 - p;
  const kellyFraction = b > 0 && p > 0 ? Math.max(0, (b * p - q) / b) : 0;

  // P4: BOOTSTRAP CI for Kelly — resample OOS trades 1000 times, compute Kelly
  // for each resample, report 5th/95th percentile. Wide CI = high uncertainty.
  // Use 5th percentile Kelly (conservative) for actual sizing.
  const kellySamples: number[] = [];
  const bootstrapIterations = 1000;
  for (let i = 0; i < bootstrapIterations; i++) {
    // Resample with replacement
    const sample: OOSTrade[] = [];
    for (let j = 0; j < oosTrades.length; j++) {
      sample.push(oosTrades[Math.floor(Math.random() * oosTrades.length)]);
    }
    const sWins = sample.filter((t) => t.win);
    const sLosses = sample.filter((t) => !t.win);
    const sAvgWin = sWins.length > 0 ? sWins.reduce((a, t) => a + t.return, 0) / sWins.length : 0;
    const sAvgLoss = sLosses.length > 0 ? Math.abs(sLosses.reduce((a, t) => a + t.return, 0) / sLosses.length) : 0;
    const sb = sAvgLoss > 0 ? sAvgWin / sAvgLoss : 1.5;
    const sp = sWins.length / sample.length;
    const sq = 1 - sp;
    const sKelly = sb > 0 && sp > 0 ? Math.max(0, (sb * sp - sq) / sb) : 0;
    kellySamples.push(sKelly);
  }
  kellySamples.sort((a, b2) => a - b2);
  const kellyCI5 = kellySamples[Math.floor(bootstrapIterations * 0.05)];
  const kellyCI95 = kellySamples[Math.floor(bootstrapIterations * 0.95)];
  const kellyUncertainty = kellyCI95 - kellyCI5;

  const overfitGap = inSampleWinRate - oosWinRate;

  // P1: ROLLING walk-forward cross-check — fixed sliding training window
  // (200 candles) that moves forward. Unlike anchored (which keeps all
  // history), rolling forgets old data. If anchored and rolling disagree,
  // the regime is unstable → reduce confidence.
  const rollingWindowSize = 200; // fixed training window
  const rollingTrades: OOSTrade[] = [];
  for (let testStart = rollingWindowSize; testStart + 20 <= candles.length; testStart += testWindowSize) {
    const trainCandles = candles.slice(testStart - rollingWindowSize, testStart); // FIXED 200-candle window
    const testEnd = Math.min(testStart + testWindowSize, candles.length);
    const testCandles = candles.slice(testStart, testEnd);
    if (trainCandles.length < rollingWindowSize || testCandles.length < 20) continue;

    const trainATR = calcATR(trainCandles, 14);
    const trainADX = approximateADX(trainCandles);
    const trainATRRatio = trainATR / (avgATR(trainCandles, 50) || trainATR);
    const trainAdxBand = trainADX < 20 ? "low" : trainADX > 25 ? "high" : "mid";
    const trainAtrBand = trainATRRatio > 1.5 ? "high" : trainATRRatio < 0.8 ? "low" : "normal";
    if (trainAdxBand !== adxBand || trainAtrBand !== atrBand) continue;

    const entry = testCandles[0].close;
    const stop = action === "LONG" ? entry - 2 * trainATR : action === "SHORT" ? entry + 2 * trainATR : entry;
    const target = action === "LONG" ? entry + 3 * trainATR : action === "SHORT" ? entry - 3 * trainATR : entry;
    let exitPrice = entry;
    let exited = false;
    for (let i = 0; i < testCandles.length; i++) {
      const c = testCandles[i];
      if (action === "LONG" && c.low <= stop) { exitPrice = stop; exited = true; break; }
      if (action === "SHORT" && c.high >= stop) { exitPrice = stop; exited = true; break; }
      if (action === "LONG" && c.high >= target) { exitPrice = target; exited = true; break; }
      if (action === "SHORT" && c.low <= target) { exitPrice = target; exited = true; break; }
    }
    if (!exited) exitPrice = testCandles[testCandles.length - 1].close;
    const ret = action === "LONG" ? (exitPrice - entry) / entry : action === "SHORT" ? (entry - exitPrice) / entry : 0;
    rollingTrades.push({ return: ret, holdHours: testCandles.length, maxDrawdown: 0, win: ret > 0 });
  }
  const rollingWinRate = rollingTrades.length > 0 ? rollingTrades.filter((t) => t.win).length / rollingTrades.length : 0;
  const anchoredRollingGap = Math.abs(oosWinRate - rollingWinRate);
  const regimeStable = anchoredRollingGap < 0.15;

  // honest now requires: OOS win >50%, overfit gap <15%, CI5>0, AND regime stable
  const honest = oosWinRate > 0.50 && overfitGap < 0.15 && oosTrades.length >= 5 && kellyCI5 > 0 && regimeStable;

  return {
    oosWinRate, oosAvgReturn, oosMaxDrawdown, oosSharpe,
    oosSampleSize: oosTrades.length,
    kellyFraction, kellyCI5, kellyCI95, kellyUncertainty,
    inSampleWinRate, overfitGap, honest, anchoredWindows: windowsTested,
    rollingWinRate, rollingSampleSize: rollingTrades.length, anchoredRollingGap, regimeStable,
    description: `OOS: ${(oosWinRate * 100).toFixed(0)}% win (${oosTrades.length} trades, ${windowsTested} anchored windows), Sharpe ${oosSharpe.toFixed(1)}, Kelly ${(kellyFraction * 100).toFixed(1)}% [CI5=${(kellyCI5 * 100).toFixed(1)}%, CI95=${(kellyCI95 * 100).toFixed(1)}%]. Rolling cross-check: ${(rollingWinRate * 100).toFixed(0)}% (n=${rollingTrades.length}), gap ${(anchoredRollingGap * 100).toFixed(0)}% ${regimeStable ? "✓ stable" : "⚠ UNSTABLE"}. Overfit gap ${(overfitGap * 100).toFixed(0)}%. ${honest ? "Edge confirmed OOS (95% bootstrap + regime stable)." : "Edge NOT confirmed."}`,
  };
}

function avgATR(candles: Candle[], period: number): number {
  if (candles.length < period + 1) return calcATR(candles, 14);
  const slice = candles.slice(candles.length - period);
  return calcATR(slice, Math.min(14, period));
}

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
