// Absorption threshold OOS validation with confidence interval.
//
// P2: Instead of using a fixed or percentile-based absorption threshold,
// this module backtests absorption signals against historical OHLCV data
// to find the threshold that actually predicts reversals, with bootstrap CI.
//
// Method:
//   1. For each historical candle, compute absorption_ratio = volume / |close-open|
//      (high volume + small body = absorption)
//   2. Check if price reversed in the next N hours (direction opposite to body)
//   3. Sweep thresholds from 50th to 95th percentile of the ratio distribution
//   4. For each threshold, compute (precision, recall) of reversal prediction
//   5. Select the threshold with best F1 score
//   6. Bootstrap 1000 resamples → CI on the optimal threshold's precision
//
// The output is an OOS-validated threshold + CI. If the CI is wide, the
// threshold is uncertain → the signal should be treated with caution.

import type { Candle } from "./backtest";

export interface AbsorptionValidation {
  optimalThreshold: number;      // best F1 threshold (volume / |body|)
  precision: number;             // P(reversal | absorption detected) at optimal threshold
  precisionCI5: number;          // 5th percentile bootstrap precision
  precisionCI95: number;         // 95th percentile
  recall: number;                // P(absorption detected | reversal happened)
  f1: number;                    // harmonic mean of precision + recall
  sampleSize: number;            // how many historical candles analyzed
  reversalRate: number;          // base rate of reversals (for comparison)
  lift: number;                  // precision / reversalRate (1 = no better than random)
  validated: boolean;            // true if lift > 1.3 AND precisionCI5 > 0.5
  description: string;
}

const REVERSAL_HORIZON = 6; // check next 6 1h candles for reversal
const REVERSAL_THRESHOLD = 0.003; // 0.3% price move = "reversal"

export function validateAbsorptionThreshold(candles: Candle[]): AbsorptionValidation | null {
  if (candles.length < 100) return null;

  // 1. Compute absorption ratio per candle + whether reversal followed
  interface Sample { ratio: number; reversed: boolean; bodyDir: "up" | "down" }
  const samples: Sample[] = [];

  for (let i = 20; i < candles.length - REVERSAL_HORIZON; i++) {
    const c = candles[i];
    const body = Math.abs(c.close - c.open);
    if (body === 0 || c.volume === 0) continue;
    const ratio = c.volume / body;
    const bodyDir = c.close > c.open ? "up" : "down";

    // Check if next REVERSAL_HORIZON candles reversed (moved >0.3% against body direction)
    let maxAdverse = 0;
    for (let j = 1; j <= REVERSAL_HORIZON; j++) {
      const future = candles[i + j];
      if (bodyDir === "up") {
        const adverse = (c.close - future.low) / c.close;
        if (adverse > maxAdverse) maxAdverse = adverse;
      } else {
        const adverse = (future.high - c.close) / c.close;
        if (adverse > maxAdverse) maxAdverse = adverse;
      }
    }
    const reversed = maxAdverse > REVERSAL_THRESHOLD;
    samples.push({ ratio, reversed, bodyDir });
  }

  if (samples.length < 30) return null;

  // 2. Compute ratio distribution percentiles for threshold sweep
  const allRatios = samples.map((s) => s.ratio).sort((a, b) => a - b);
  const percentile = (p: number) => allRatios[Math.floor(allRatios.length * p / 100)];

  // 3. Sweep thresholds: 50th, 60th, 70th, 80th, 90th, 95th percentile
  const thresholdPercentiles = [50, 60, 70, 80, 90, 95];
  let bestF1 = 0;
  let bestThreshold = 0;
  let bestPrecision = 0;
  let bestRecall = 0;

  const reversalCount = samples.filter((s) => s.reversed).length;
  const reversalRate = reversalCount / samples.length;

  for (const tp of thresholdPercentiles) {
    const threshold = percentile(tp);
    const detected = samples.filter((s) => s.ratio > threshold);
    if (detected.length === 0) continue;
    const truePositives = detected.filter((s) => s.reversed).length;
    const precision = truePositives / detected.length;
    const recall = reversalCount > 0 ? truePositives / reversalCount : 0;
    const f1 = precision + recall > 0 ? 2 * precision * recall / (precision + recall) : 0;
    if (f1 > bestF1) {
      bestF1 = f1;
      bestThreshold = threshold;
      bestPrecision = precision;
      bestRecall = recall;
    }
  }

  // 4. Bootstrap CI on precision at optimal threshold
  const detectedAtOptimal = samples.filter((s) => s.ratio > bestThreshold);
  const bootstrapIterations = 1000;
  const precisionSamples: number[] = [];
  for (let i = 0; i < bootstrapIterations; i++) {
    // Resample detected set with replacement
    const resampled: boolean[] = [];
    for (let j = 0; j < detectedAtOptimal.length; j++) {
      resampled.push(detectedAtOptimal[Math.floor(Math.random() * detectedAtOptimal.length)].reversed);
    }
    const tp = resampled.filter(Boolean).length;
    precisionSamples.push(tp / resampled.length);
  }
  precisionSamples.sort((a, b) => a - b);
  const precisionCI5 = precisionSamples[Math.floor(bootstrapIterations * 0.05)];
  const precisionCI95 = precisionSamples[Math.floor(bootstrapIterations * 0.95)];

  const lift = reversalRate > 0 ? bestPrecision / reversalRate : 0;
  const validated = lift > 1.3 && precisionCI5 > 0.5;

  return {
    optimalThreshold: bestThreshold,
    precision: bestPrecision,
    precisionCI5,
    precisionCI95,
    recall: bestRecall,
    f1: bestF1,
    sampleSize: samples.length,
    reversalRate,
    lift,
    validated,
    description: `Absorption OOS: threshold=${bestThreshold.toFixed(0)} (vol/body), precision=${(bestPrecision * 100).toFixed(0)}% [CI5=${(precisionCI5 * 100).toFixed(0)}%, CI95=${(precisionCI95 * 100).toFixed(0)}%], recall=${(bestRecall * 100).toFixed(0)}%, F1=${bestF1.toFixed(2)}, lift=${lift.toFixed(2)}x (base rate ${(reversalRate * 100).toFixed(0)}%). ${validated ? "✓ Validated OOS." : "⚠ Not validated (lift<1.3 or CI5<50%)."}`,
  };
}
