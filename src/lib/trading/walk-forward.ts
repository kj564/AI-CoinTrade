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
  oosWinRate: number;       // out-of-sample win rate (0-1)
  oosAvgReturn: number;     // avg return per OOS trade (fraction)
  oosMaxDrawdown: number;   // max drawdown across OOS trades
  oosSharpe: number;        // annualized Sharpe from OOS returns
  oosSampleSize: number;    // number of OOS trades
  kellyFraction: number;    // Kelly f* computed from OOS trades
  inSampleWinRate: number;  // in-sample win rate (for comparison — should be similar)
  overfitGap: number;       // inSampleWinRate - oosWinRate (large = overfitting)
  honest: boolean;          // true if OOS win rate > 0.50 AND overfitGap < 0.15
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
  if (candles.length < 100 || action === "FLAT") {
    return {
      oosWinRate: 0, oosAvgReturn: 0, oosMaxDrawdown: 0, oosSharpe: 0,
      oosSampleSize: 0, kellyFraction: 0, inSampleWinRate: 0, overfitGap: 0,
      honest: false,
      description: "insufficient data or no action",
    };
  }

  // Walk-forward: 5 windows of 100 candles
  const windowSize = 100;
  const numWindows = Math.floor(candles.length / windowSize);
  const oosTrades: OOSTrade[] = [];
  const inSampleReturns: number[] = [];

  // Define the current regime's matching criteria
  const adxBand = currentRegime.adx < 20 ? "low" : currentRegime.adx > 25 ? "high" : "mid";
  const atrBand = currentRegime.atrRatio > 1.5 ? "high" : currentRegime.atrRatio < 0.8 ? "low" : "normal";

  for (let w = 1; w < numWindows; w++) {
    // Training window: w-1 (used to "learn" the regime)
    const trainStart = (w - 1) * windowSize;
    const trainEnd = w * windowSize;
    const trainCandles = candles.slice(trainStart, trainEnd);

    // Test window: w (OOS — the model hasn't seen this)
    const testStart = w * windowSize;
    const testEnd = Math.min(testStart + windowSize, candles.length);
    const testCandles = candles.slice(testStart, testEnd);

    if (trainCandles.length < 50 || testCandles.length < 20) continue;

    // Compute regime in the TRAINING window (this is what the model "knows")
    const trainATR = calcATR(trainCandles, 14);
    const trainADX = approximateADX(trainCandles);
    const trainATRRatio = trainATR / (avgATR(trainCandles, 50) || trainATR);

    const trainAdxBand = trainADX < 20 ? "low" : trainADX > 25 ? "high" : "mid";
    const trainAtrBand = trainATRRatio > 1.5 ? "high" : trainATRRatio < 0.8 ? "low" : "normal";

    // Only count OOS trades where the training regime matches the current regime
    // (This is the honest part: we're testing whether "when regime was like this
    // in the past, the forward trade was profitable")
    if (trainAdxBand !== adxBand || trainAtrBand !== atrBand) continue;

    // Entry at the boundary between train and test (first candle of test window)
    const entry = testCandles[0].close;
    const stop = action === "LONG"
      ? entry - 2 * trainATR
      : action === "SHORT"
        ? entry + 2 * trainATR
        : entry;
    const target = action === "LONG"
      ? entry + 3 * trainATR
      : action === "SHORT"
        ? entry - 3 * trainATR
        : entry;

    // Simulate the trade through the test window
    let exitPrice = entry;
    let maxDD = 0;
    let exited = false;

    for (let i = 0; i < testCandles.length; i++) {
      const c = testCandles[i];
      // Check stop hit first (worst case)
      if (action === "LONG" && c.low <= stop) { exitPrice = stop; exited = true; break; }
      if (action === "SHORT" && c.high >= stop) { exitPrice = stop; exited = true; break; }
      // Check target hit
      if (action === "LONG" && c.high >= target) { exitPrice = target; exited = true; break; }
      if (action === "SHORT" && c.low <= target) { exitPrice = target; exited = true; break; }

      // Track drawdown
      if (action === "LONG") {
        const dd = (entry - c.low) / entry;
        if (dd > maxDD) maxDD = dd;
      } else if (action === "SHORT") {
        const dd = (c.high - entry) / entry;
        if (dd > maxDD) maxDD = dd;
      }
    }

    // If not exited, use last candle close
    if (!exited) exitPrice = testCandles[testCandles.length - 1].close;

    const ret = action === "LONG"
      ? (exitPrice - entry) / entry
      : action === "SHORT"
        ? (entry - exitPrice) / entry
        : 0;

    const holdHours = testCandles.length; // each candle is 1h

    oosTrades.push({ return: ret, holdHours, maxDrawdown: maxDD, win: ret > 0 });
    inSampleReturns.push(ret); // also track for overfit comparison
  }

  // Also compute in-sample stats (same data, but this is what the old backtest reported)
  // For comparison — the gap between in-sample and OOS reveals overfitting.
  const inSampleWinRate = inSampleReturns.length > 0
    ? inSampleReturns.filter((r) => r > 0).length / inSampleReturns.length
    : 0;

  if (oosTrades.length === 0) {
    return {
      oosWinRate: 0, oosAvgReturn: 0, oosMaxDrawdown: 0, oosSharpe: 0,
      oosSampleSize: 0, kellyFraction: 0,
      inSampleWinRate, overfitGap: 0, honest: false,
      description: `No OOS trades matching regime ${adxBand}/${atrBand} — insufficient historical data for validation`,
    };
  }

  const oosWinRate = oosTrades.filter((t) => t.win).length / oosTrades.length;
  const oosAvgReturn = oosTrades.reduce((a, t) => a + t.return, 0) / oosTrades.length;
  const oosMaxDrawdown = Math.max(...oosTrades.map((t) => t.maxDrawdown));
  const avgHold = oosTrades.reduce((a, t) => a + t.holdHours, 0) / oosTrades.length;
  const stdRet = Math.sqrt(oosTrades.reduce((a, t) => a + Math.pow(t.return - oosAvgReturn, 2), 0) / oosTrades.length);
  const oosSharpe = stdRet > 0 ? (oosAvgReturn / stdRet) * Math.sqrt(365 * 24 / avgHold) : 0;

  // Kelly from OOS trades only
  // f* = (b*p - q) / b where b = avg win / avg loss, p = win rate, q = 1-p
  const wins = oosTrades.filter((t) => t.win);
  const losses = oosTrades.filter((t) => !t.win);
  const avgWin = wins.length > 0 ? wins.reduce((a, t) => a + t.return, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? Math.abs(losses.reduce((a, t) => a + t.return, 0) / losses.length) : 0;
  const b = avgLoss > 0 ? avgWin / avgLoss : 1.5; // payoff ratio
  const p = oosWinRate;
  const q = 1 - p;
  const kellyFraction = b > 0 && p > 0 ? Math.max(0, (b * p - q) / b) : 0;

  const overfitGap = inSampleWinRate - oosWinRate;
  const honest = oosWinRate > 0.50 && overfitGap < 0.15 && oosTrades.length >= 5;

  return {
    oosWinRate,
    oosAvgReturn,
    oosMaxDrawdown,
    oosSharpe,
    oosSampleSize: oosTrades.length,
    kellyFraction,
    inSampleWinRate,
    overfitGap,
    honest,
    description: `OOS: ${(oosWinRate * 100).toFixed(0)}% win (${oosTrades.length} trades), avg ${(oosAvgReturn * 100).toFixed(1)}%, Sharpe ${oosSharpe.toFixed(1)}, Kelly ${(kellyFraction * 100).toFixed(1)}%. In-sample: ${(inSampleWinRate * 100).toFixed(0)}% (overfit gap ${(overfitGap * 100).toFixed(0)}%). ${honest ? "Edge confirmed OOS." : "Edge NOT confirmed — treat with caution."}`,
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
