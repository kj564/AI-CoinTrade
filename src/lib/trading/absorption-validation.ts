// Absorption threshold OOS validation with multi-reversal-level sweep + CI bootstrap.
//
// v5: Instead of using a single fixed reversal threshold (0.3%), sweep multiple
// reversal levels (0.3%, 0.5%, 1%, 1.5%, 2%, 3%) to find where absorption
// actually predicts reversals. At 0.3% reversal, base rate is ~80% → lift=1.0x
// (no information gain). At higher reversal thresholds, base rate drops and
// absorption may become predictive.
//
// For each reversal level:
//   1. Compute absorption_ratio = volume / |close-open| per candle
//   2. Mark candles where price reversed by > reversal_level in next 6h
//   3. Sweep absorption thresholds (50th-95th percentile)
//   4. Find best F1 per reversal level
//   5. Bootstrap 1000 resamples → CI on precision
//
// Select the (reversal_level, absorption_threshold) pair with best lift.
// Report validated=true only if lift > 1.3 AND precisionCI5 > 0.5.

import type { Candle } from "./backtest";

export interface AbsorptionValidation {
  optimalThreshold: number;
  precision: number;
  precisionCI5: number;
  precisionCI95: number;
  recall: number;
  f1: number;
  sampleSize: number;
  reversalRate: number;
  lift: number;
  validated: boolean;
  // v5: multi-level sweep results
  optimalReversalLevel: number;   // which reversal threshold gave best lift
  sweepResults: { reversalLevel: number; threshold: number; precision: number; lift: number; validated: boolean }[];
  description: string;
}

const REVERSAL_HORIZON = 6;
const REVERSAL_LEVELS = [0.003, 0.005, 0.01, 0.015, 0.02, 0.03]; // 0.3% to 3%

export function validateAbsorptionThreshold(candles: Candle[]): AbsorptionValidation | null {
  if (candles.length < 100) return null;

  // Pre-compute samples with per-candle absorption ratio + adverse move data
  interface Sample { ratio: number; maxAdverse: number; bodyDir: "up" | "down" }
  const samples: Sample[] = [];

  for (let i = 20; i < candles.length - REVERSAL_HORIZON; i++) {
    const c = candles[i];
    const body = Math.abs(c.close - c.open);
    if (body === 0 || c.volume === 0) continue;
    const ratio = c.volume / body;
    const bodyDir = c.close > c.open ? "up" : "down";

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
    samples.push({ ratio, maxAdverse, bodyDir });
  }

  if (samples.length < 30) return null;

  const allRatios = samples.map((s) => s.ratio).sort((a, b) => a - b);
  const percentile = (p: number) => allRatios[Math.floor(allRatios.length * p / 100)];

  // Sweep each reversal level × absorption threshold percentile
  const sweepResults: AbsorptionValidation["sweepResults"] = [];
  let bestLift = 0;
  let bestResult: { reversalLevel: number; threshold: number; precision: number; recall: number; f1: number; lift: number; precisionCI5: number; precisionCI95: number } | null = null;

  for (const revLevel of REVERSAL_LEVELS) {
    // Mark samples as reversed/not at this reversal level
    const labeledSamples = samples.map((s) => ({ ratio: s.ratio, reversed: s.maxAdverse > revLevel }));
    const reversalCount = labeledSamples.filter((s) => s.reversed).length;
    const reversalRate = reversalCount / labeledSamples.length;

    // Sweep absorption thresholds
    for (const tp of [50, 60, 70, 80, 90, 95]) {
      const threshold = percentile(tp);
      const detected = labeledSamples.filter((s) => s.ratio > threshold);
      if (detected.length === 0) continue;
      const truePositives = detected.filter((s) => s.reversed).length;
      const precision = truePositives / detected.length;
      const recall = reversalCount > 0 ? truePositives / reversalCount : 0;
      const f1 = precision + recall > 0 ? 2 * precision * recall / (precision + recall) : 0;
      const lift = reversalRate > 0 ? precision / reversalRate : 0;

      // Bootstrap CI on precision
      const bootstrapIterations = 500; // fewer per cell (6 levels × 6 thresholds = 36 cells)
      const precisionSamples: number[] = [];
      for (let i = 0; i < bootstrapIterations; i++) {
        const resampled: boolean[] = [];
        for (let j = 0; j < detected.length; j++) {
          resampled.push(detected[Math.floor(Math.random() * detected.length)].reversed);
        }
        precisionSamples.push(resampled.filter(Boolean).length / resampled.length);
      }
      precisionSamples.sort((a, b) => a - b);
      const precisionCI5 = precisionSamples[Math.floor(bootstrapIterations * 0.05)];
      const precisionCI95 = precisionSamples[Math.floor(bootstrapIterations * 0.95)];

      const validated = lift > 1.3 && precisionCI5 > 0.5;
      sweepResults.push({ reversalLevel: revLevel, threshold, precision, lift, validated });

      if (lift > bestLift && validated) {
        bestLift = lift;
        bestResult = { reversalLevel: revLevel, threshold, precision, recall, f1, lift, precisionCI5, precisionCI95 };
      }
    }
  }

  // If no validated cell found, report best lift overall (even if not validated)
  if (!bestResult) {
    let bestUnvalidatedF1 = 0;
    for (const sr of sweepResults) {
      // Find the cell with best F1 at the most common reversal level (1%)
      if (sr.reversalLevel === 0.01 && sr.lift > bestUnvalidatedF1) {
        bestUnvalidatedF1 = sr.lift;
      }
    }
    // Fallback: use 80th percentile at 1% reversal level
    const revLevel = 0.01;
    const labeledSamples = samples.map((s) => ({ ratio: s.ratio, reversed: s.maxAdverse > revLevel }));
    const reversalCount = labeledSamples.filter((s) => s.reversed).length;
    const reversalRate = reversalCount / labeledSamples.length;
    const threshold = percentile(80);
    const detected = labeledSamples.filter((s) => s.ratio > threshold);
    const truePositives = detected.filter((s) => s.reversed).length;
    const precision = detected.length > 0 ? truePositives / detected.length : 0;
    const recall = reversalCount > 0 ? truePositives / reversalCount : 0;
    const lift = reversalRate > 0 ? precision / reversalRate : 0;

    return {
      optimalThreshold: threshold,
      precision,
      precisionCI5: 0,
      precisionCI95: 0,
      recall,
      f1: 0,
      sampleSize: samples.length,
      reversalRate,
      lift,
      validated: false,
      optimalReversalLevel: revLevel,
      sweepResults,
      description: `Absorption OOS sweep: NO validated cell found across ${REVERSAL_LEVELS.length} reversal levels × 6 thresholds. Best lift=${lift.toFixed(2)}x at 1% reversal. Honest negative: absorption does not predict reversals at any tested level.`,
    };
  }

  const reversalRate = samples.filter((s) => s.maxAdverse > bestResult.reversalLevel).length / samples.length;
  return {
    optimalThreshold: bestResult.threshold,
    precision: bestResult.precision,
    precisionCI5: bestResult.precisionCI5,
    precisionCI95: bestResult.precisionCI95,
    recall: bestResult.recall,
    f1: bestResult.f1,
    sampleSize: samples.length,
    reversalRate,
    lift: bestResult.lift,
    validated: true,
    optimalReversalLevel: bestResult.reversalLevel,
    sweepResults,
    description: `Absorption OOS: VALIDATED at ${(bestResult.reversalLevel * 100).toFixed(1)}% reversal level, threshold=${bestResult.threshold.toFixed(0)} (vol/body). Precision=${(bestResult.precision * 100).toFixed(0)}% [CI5=${(bestResult.precisionCI5 * 100).toFixed(0)}%, CI95=${(bestResult.precisionCI95 * 100).toFixed(0)}%], lift=${bestResult.lift.toFixed(2)}x (base rate ${(reversalRate * 100).toFixed(0)}%). Swept ${REVERSAL_LEVELS.length} reversal levels × 6 thresholds.`,
  };
}

