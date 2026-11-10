// ML Direction Predictor — simple logistic regression that predicts
// next-hour price direction (up/down probability) based on technical features.
// Inspired by: arXiv 2306.08157 (Bayesian Networks for crypto prediction)
// + arXiv 2504.19309 (CNN-Transformer for time series)
// Practical approach: logistic regression with gradient descent, no GPU needed.

import type { Candle } from "./candles";
import { calcATR } from "./backtest";

interface Features {
  rsi: number;          // RSI(14) / 100, normalized 0-1
  macdHist: number;     // MACD histogram, normalized
  smaRatio: number;     // SMA10 / SMA20 (>1 = uptrend)
  stoch: number;        // Stochastic %K / 100
  obvSlope: number;     // OBV slope (normalized)
  volRatio: number;     // Volume ratio / 3 (normalized)
  atrPct: number;       // ATR as % of price (volatility)
  priceMomentum: number; // (close - close[-5]) / close[-5] (5-bar momentum)
}

export interface MLPrediction {
  probability: number;    // 0-1, probability of price going UP next hour
  probabilityPct: number; // as percentage
  direction: "up" | "down" | "neutral";
  confidence: number;     // 0-100
  features: Features;     // current features used for prediction
  modelAccuracy: number;  // training accuracy (0-100)
  trainingSamples: number;
  brierScore: number;     // P5: Brier score (lower = better calibrated, 0=perfect, 0.25=random)
  calibration: { bin: string; predicted: number; observed: number; count: number; ciLo: number; ciHi: number }[]; // reliability curve with Wilson CI
  calibrationPerRegime: Record<string, { bin: string; predicted: number; observed: number; count: number; ciLo: number; ciHi: number }[]>; // per-regime calibration with CI
  featureImportance: { name: string; weight: number; absWeight: number; rank: number; zScore: number; pValue: number; adjustedPValue: number; significant: boolean; ciLo: number; ciHi: number; bootstrapCILo: number; bootstrapCIHi: number; oddsRatio: number; orCILo: number; orCIHi: number; effectSize: number }[]; // P2: feature importance with BH-adjusted p-values + Wald CI
  ablation: { feature: string; dropped: number; accuracyDelta: number; description: string }[]; // P3: feature ablation
  description: string;
}

const FEATURE_NAMES = ["RSI", "MACD Hist", "SMA Ratio", "Stochastic", "OBV Slope", "Vol Ratio", "ATR %", "Momentum"];

// Wilson score confidence interval for binomial proportion
function wilsonCI(observed: number, n: number, z = 1.96): { lo: number; hi: number } {
  if (n === 0) return { lo: 0, hi: 1 };
  const p = observed;
  const denom = 1 + z * z / n;
  const center = (p + z * z / (2 * n)) / denom;
  const spread = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denom;
  return { lo: Math.max(0, center - spread), hi: Math.min(1, center + spread) };
}

// Compute features for a candle at index i
function computeFeatures(candles: Candle[], i: number): Features | null {
  if (i < 20 || i >= candles.length) return null;
  const closes = candles.slice(Math.max(0, i - 30), i + 1).map(c => c.close);
  const highs = candles.slice(Math.max(0, i - 30), i + 1).map(c => c.high);
  const lows = candles.slice(Math.max(0, i - 30), i + 1).map(c => c.low);
  const vols = candles.slice(Math.max(0, i - 30), i + 1).map(c => c.volume);

  // RSI(14)
  let gains = 0, losses = 0;
  for (let j = 1; j <= 14 && j < closes.length; j++) {
    const d = closes[j] - closes[j - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  const rsi = losses === 0 ? 100 : gains === 0 ? 0 : 100 - 100 / (1 + gains / losses);

  // SMA10 / SMA20
  const sma10 = closes.slice(-10).reduce((a, b) => a + b, 0) / 10;
  const sma20 = closes.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const smaRatio = sma20 > 0 ? sma10 / sma20 : 1;

  // Stochastic %K
  const hh = Math.max(...highs.slice(-14));
  const ll = Math.min(...lows.slice(-14));
  const stoch = hh === ll ? 50 : 100 * (closes[closes.length - 1] - ll) / (hh - ll);

  // MACD histogram (simplified)
  const ema = (data: number[], period: number) => {
    const k = 2 / (period + 1);
    let e = data[0];
    for (let j = 1; j < data.length; j++) e = data[j] * k + e * (1 - k);
    return e;
  };
  const ema12 = ema(closes, 12);
  const ema26 = ema(closes, 26);
  const macdLine = ema12 - ema26;
  const macdHist = macdLine; // simplified (no signal line)

  // OBV slope
  let obv = 0;
  for (let j = 1; j < closes.length; j++) {
    if (closes[j] > closes[j - 1]) obv += vols[j] || 0;
    else if (closes[j] < closes[j - 1]) obv -= vols[j] || 0;
  }
  const obvSlope = obv / (closes[closes.length - 1] * Math.max(1, vols.reduce((a, b) => a + b, 0)));

  // Volume ratio
  const volAvg = vols.slice(-20).reduce((a, b) => a + b, 0) / Math.min(20, vols.length);
  const volRatio = volAvg > 0 ? vols[vols.length - 1] / volAvg : 1;

  // ATR %
  const atr = calcATR(candles.slice(Math.max(0, i - 30), i + 1), 14);
  const atrPct = closes[closes.length - 1] > 0 ? atr / closes[closes.length - 1] : 0;

  // 5-bar momentum
  const mom = closes.length > 5 ? (closes[closes.length - 1] - closes[closes.length - 6]) / closes[closes.length - 6] : 0;

  return {
    rsi: rsi / 100,
    macdHist: macdHist / closes[closes.length - 1], // normalize by price
    smaRatio,
    stoch: stoch / 100,
    obvSlope,
    volRatio: Math.min(volRatio / 3, 1),
    atrPct,
    priceMomentum: mom,
  };
}

// Sigmoid
function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

// Train logistic regression with STANDARDIZED features + p-values
function trainLogisticRegression(
  features: number[][],
  labels: number[],
  learningRate = 0.01,
  iterations = 200
): { weights: number[]; bias: number; accuracy: number; brierScore: number; calibration: any[]; calibrationPerRegime: Record<string, any[]>; featureImportance: any[]; stdDevs: number[]; pValues: number[]; zScores: number[] } {
  const n = features.length;
  const d = features[0]?.length || 0;

  // P1: Standardize features (z-score) — coefficients only comparable if standardized
  const means: number[] = new Array(d).fill(0);
  const stdDevs: number[] = new Array(d).fill(1);
  for (let j = 0; j < d; j++) {
    for (let i = 0; i < n; i++) means[j] += features[i][j];
    means[j] /= n;
    let variance = 0;
    for (let i = 0; i < n; i++) variance += (features[i][j] - means[j]) ** 2;
    variance /= n;
    stdDevs[j] = Math.sqrt(variance) || 1;
  }
  const standardized: number[][] = features.map(row => row.map((v, j) => (v - means[j]) / stdDevs[j]));

  const weights = new Array(d).fill(0);
  let bias = 0;

  for (let iter = 0; iter < iterations; iter++) {
    const grad = new Array(d).fill(0);
    let gradBias = 0;
    for (let i = 0; i < n; i++) {
      const z = bias + standardized[i].reduce((a, w, j) => a + w * weights[j], 0);
      const pred = sigmoid(z);
      const err = pred - labels[i];
      for (let j = 0; j < d; j++) grad[j] += err * standardized[i][j];
      gradBias += err;
    }
    for (let j = 0; j < d; j++) weights[j] -= learningRate * grad[j] / n;
    bias -= learningRate * gradBias / n;
  }

  // Compute training accuracy + Brier score (P5: calibration metric)
  let correct = 0;
  let brierSum = 0;
  for (let i = 0; i < n; i++) {
    const z = bias + standardized[i].reduce((a, w, j) => a + w * weights[j], 0);
    const pred = sigmoid(z);
    const predLabel = pred > 0.5 ? 1 : 0;
    if (predLabel === labels[i]) correct++;
    brierSum += (pred - labels[i]) ** 2;
  }
  const accuracy = n > 0 ? (correct / n) * 100 : 0;
  const brierScore = n > 0 ? brierSum / n : 0.25; // 0=perfect, 0.25=random guessing

  // P3: Calibration plot / reliability curve
  // Bin predictions into deciles, compute observed frequency per bin
  const bins = Array.from({ length: 10 }, (_, i) => ({ lo: i / 10, hi: (i + 1) / 10, preds: [] as number[], labels: [] as number[] }));
  // Per-regime calibration: classify each sample by regime, compute separate calibration
  const regimeBins: Record<string, { lo: number; hi: number; preds: number[]; labels: number[] }[]> = {
    trending: Array.from({ length: 10 }, (_, i) => ({ lo: i / 10, hi: (i + 1) / 10, preds: [], labels: [] })),
    ranging: Array.from({ length: 10 }, (_, i) => ({ lo: i / 10, hi: (i + 1) / 10, preds: [], labels: [] })),
    volatile: Array.from({ length: 10 }, (_, i) => ({ lo: i / 10, hi: (i + 1) / 10, preds: [], labels: [] })),
  };
  for (let i = 0; i < n; i++) {
    const z = bias + standardized[i].reduce((a, w, j) => a + w * weights[j], 0);
    const pred = sigmoid(z);
    const binIdx = Math.min(9, Math.floor(pred * 10));
    bins[binIdx].preds.push(pred);
    bins[binIdx].labels.push(labels[i]);
    // Classify regime based on features
    const feat = features[i]; // [rsi, macdHist, smaRatio, stoch, obvSlope, volRatio, atrPct, momentum]
    const smaRatio = feat[2], atrPct = feat[6];
    const regime = atrPct > 0.02 ? "volatile" : (smaRatio > 1.005 || smaRatio < 0.995) ? "trending" : "ranging";
    regimeBins[regime][binIdx].preds.push(pred);
    regimeBins[regime][binIdx].labels.push(labels[i]);
  }
  const calibration = bins.map((b) => {
    const ci = wilsonCI(b.labels.length > 0 ? b.labels.reduce((a, x) => a + x, 0) / b.labels.length : 0, b.preds.length);
    return {
      bin: `${(b.lo * 100).toFixed(0)}-${(b.hi * 100).toFixed(0)}%`,
      predicted: b.preds.length > 0 ? b.preds.reduce((a, x) => a + x, 0) / b.preds.length : 0,
      observed: b.labels.length > 0 ? b.labels.reduce((a, x) => a + x, 0) / b.labels.length : 0,
      count: b.preds.length,
      ciLo: ci.lo, ciHi: ci.hi,
    };
  });
  const calibrationPerRegime: Record<string, any[]> = {};
  for (const [regime, rb] of Object.entries(regimeBins)) {
    calibrationPerRegime[regime] = rb.map((b) => {
      const ci = wilsonCI(b.labels.length > 0 ? b.labels.reduce((a, x) => a + x, 0) / b.labels.length : 0, b.preds.length);
      return {
        bin: `${(b.lo * 100).toFixed(0)}-${(b.hi * 100).toFixed(0)}%`,
        predicted: b.preds.length > 0 ? b.preds.reduce((a, x) => a + x, 0) / b.preds.length : 0,
        observed: b.labels.length > 0 ? b.labels.reduce((a, x) => a + x, 0) / b.labels.length : 0,
        count: b.preds.length,
        ciLo: ci.lo, ciHi: ci.hi,
      };
    });
  }

  // P2: Feature importance on STANDARDIZED coefficients (now comparable)
  // P2: Wald test for p-values — z = weight / SE, p = 2 * (1 - Φ(|z|))
  // SE ≈ 1 / sqrt(n * p(1-p)) for logistic regression (approximation)
  const pHat = labels.reduce((a, b) => a + b, 0) / n; // base rate
  const seApprox = Math.sqrt(1 / (n * pHat * (1 - pHat)));
  const zScores: number[] = weights.map(w => Math.abs(seApprox) > 0 ? w / seApprox : 0);
  // Approximate p-value from z-score (two-tailed, normal approximation)
  const rawPValues: number[] = zScores.map(z => {
    const absZ = Math.abs(z);
    const p = 1 - 0.5 * (1 + Math.tanh(0.7978 * absZ * (1 + 0.044715 * absZ * absZ)));
    return Math.max(0, Math.min(1, 2 * p));
  });

  // P1: Multiple-testing correction — Benjamini-Hochberg FDR
  // Controls False Discovery Rate (expected proportion of false positives among rejected)
  // Sort p-values, apply BH adjustment: p_adj = p * d / rank
  const sortedIndices = rawPValues.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p);
  const nFeatures = rawPValues.length;
  const adjustedP: number[] = new Array(nFeatures).fill(0);
  let prevAdj = 1;
  for (let k = nFeatures - 1; k >= 0; k--) {
    const { p, i } = sortedIndices[k];
    const adj = Math.min(prevAdj, p * nFeatures / (k + 1));
    adjustedP[i] = Math.min(1, adj);
    prevAdj = adj;
  }

  // P2: Confidence interval per coefficient (Wald CI: w ± 1.96 × SE)
  const ci95: { lo: number; hi: number }[] = weights.map(w => ({
    lo: w - 1.96 * seApprox,
    hi: w + 1.96 * seApprox,
  }));

  // P3: Feature ablation — drop each feature, measure accuracy delta
  const baselineAccuracy = accuracy;
  const ablation: { feature: string; dropped: number; accuracyDelta: number; description: string }[] = [];
  for (let dropIdx = 0; dropIdx < d; dropIdx++) {
    // Retrain without feature dropIdx
    const reducedFeatures = standardized.map(row => row.filter((_, j) => j !== dropIdx));
    const reducedWeights = new Array(d - 1).fill(0);
    let reducedBias = 0;
    for (let iter = 0; iter < iterations; iter++) {
      const grad = new Array(d - 1).fill(0);
      let gradBias = 0;
      for (let i = 0; i < n; i++) {
        const z = reducedBias + reducedFeatures[i].reduce((a, w, j) => a + w * reducedWeights[j], 0);
        const pred = sigmoid(z);
        const err = pred - labels[i];
        for (let j = 0; j < d - 1; j++) grad[j] += err * reducedFeatures[i][j];
        gradBias += err;
      }
      for (let j = 0; j < d - 1; j++) reducedWeights[j] -= learningRate * grad[j] / n;
      reducedBias -= learningRate * gradBias / n;
    }
    let reducedCorrect = 0;
    for (let i = 0; i < n; i++) {
      const z = reducedBias + reducedFeatures[i].reduce((a, w, j) => a + w * reducedWeights[j], 0);
      if ((sigmoid(z) > 0.5 ? 1 : 0) === labels[i]) reducedCorrect++;
    }
    const reducedAcc = n > 0 ? (reducedCorrect / n) * 100 : 0;
    const delta = baselineAccuracy - reducedAcc;
    ablation.push({
      feature: FEATURE_NAMES[dropIdx] || `Feature ${dropIdx}`,
      dropped: dropIdx,
      accuracyDelta: delta,
      description: delta > 0.5 ? `Menghapus ${FEATURE_NAMES[dropIdx]} menurunkan akurasi ${delta.toFixed(2)}% → fitur membantu` : delta < -0.5 ? `Menghapus ${FEATURE_NAMES[dropIdx]} menaikkan akurasi ${Math.abs(delta).toFixed(2)}% → fitur merugikan` : `Menghapus ${FEATURE_NAMES[dropIdx]} tidak mengubah akurasi → fitur tidak berpengaruh`,
    });
  }
  ablation.sort((a, b) => b.accuracyDelta - a.accuracyDelta);

  // P2: Bootstrap CI for coefficients (1000 resamples, percentile method)
  // More robust than Wald CI for small samples or non-normal distributions
  const nBootstrap = 200; // reduced from 1000 for performance
  const bootstrapWeights: number[][] = [];
  for (let b = 0; b < nBootstrap; b++) {
    // Resample with replacement
    const sampleIdx: number[] = [];
    for (let i = 0; i < n; i++) sampleIdx.push(Math.floor(Math.random() * n));
    const bsFeatures = sampleIdx.map(i => standardized[i]);
    const bsLabels = sampleIdx.map(i => labels[i]);
    // Quick train (50 iterations for speed)
    const bsWeights = new Array(d).fill(0);
    let bsBias = 0;
    for (let iter = 0; iter < 50; iter++) {
      const grad = new Array(d).fill(0);
      let gradB = 0;
      for (let i = 0; i < n; i++) {
        const z = bsBias + bsFeatures[i].reduce((a, w, j) => a + w * bsWeights[j], 0);
        const pred = sigmoid(z);
        const err = pred - bsLabels[i];
        for (let j = 0; j < d; j++) grad[j] += err * bsFeatures[i][j];
        gradB += err;
      }
      for (let j = 0; j < d; j++) bsWeights[j] -= learningRate * grad[j] / n;
      bsBias -= learningRate * gradB / n;
    }
    bootstrapWeights.push(bsWeights);
  }
  // Percentile CI: 2.5th and 97.5th percentiles
  const bootstrapCI: { lo: number; hi: number }[] = weights.map((_, j) => {
    const sorted = bootstrapWeights.map(bw => bw[j]).sort((a, b) => a - b);
    const loIdx = Math.floor(nBootstrap * 0.025);
    const hiIdx = Math.floor(nBootstrap * 0.975);
    return { lo: sorted[loIdx] || 0, hi: sorted[hiIdx] || 0 };
  });

  const featureImportance = weights.map((w, i) => {
    const oddsRatio = Math.exp(w); // exp(w) = odds ratio for 1-SD increase in standardized feature
    const orCI = { lo: Math.exp(ci95[i].lo), hi: Math.exp(ci95[i].hi) };
    return {
      name: FEATURE_NAMES[i] || `Feature ${i}`, weight: w, absWeight: Math.abs(w), rank: 0,
      zScore: zScores[i], pValue: rawPValues[i], adjustedPValue: adjustedP[i], significant: adjustedP[i] < 0.05,
      ciLo: ci95[i].lo, ciHi: ci95[i].hi,
      bootstrapCILo: bootstrapCI[i].lo, bootstrapCIHi: bootstrapCI[i].hi,
      oddsRatio, orCILo: orCI.lo, orCIHi: orCI.hi,
      effectSize: Math.abs(oddsRatio - 1), // |OR - 1| = effect size (0 = no effect, >0.5 = large)
    };
  })
    .sort((a, b) => b.absWeight - a.absWeight)
    .map((f, i) => ({ ...f, rank: i + 1 }));

  return { weights, bias, accuracy, brierScore, calibration, calibrationPerRegime, featureImportance, ablation, stdDevs, pValues: rawPValues, adjustedPValues: adjustedP, zScores };
}

export function predictDirection(candles: Candle[]): MLPrediction | null {
  if (candles.length < 50) return null;

  // Build training dataset
  const featureList: number[][] = [];
  const labels: number[] = [];

  for (let i = 30; i < candles.length - 1; i++) {
    const f = computeFeatures(candles, i);
    if (!f) continue;
    // Label: 1 if next candle close > current close
    const label = candles[i + 1].close > candles[i].close ? 1 : 0;
    featureList.push([f.rsi, f.macdHist, f.smaRatio, f.stoch, f.obvSlope, f.volRatio, f.atrPct, f.priceMomentum]);
    labels.push(label);
  }

  if (featureList.length < 20) return null;

  // Train
  const model = trainLogisticRegression(featureList, labels, 0.01, 200);

  // Predict on current (last) candle
  const currentFeatures = computeFeatures(candles, candles.length - 1);
  if (!currentFeatures) return null;

  const currentFeatureVec = [
    currentFeatures.rsi, currentFeatures.macdHist, currentFeatures.smaRatio,
    currentFeatures.stoch, currentFeatures.obvSlope, currentFeatures.volRatio,
    currentFeatures.atrPct, currentFeatures.priceMomentum,
  ];
  const z = model.bias + currentFeatureVec.reduce((a, w, j) => a + w * model.weights[j], 0);
  const probability = sigmoid(z);
  const probabilityPct = probability * 100;

  const direction: "up" | "down" | "neutral" = probabilityPct > 55 ? "up" : probabilityPct < 45 ? "down" : "neutral";
  const confidence = Math.abs(probabilityPct - 50) * 2; // 0 at 50%, 100 at 0% or 100%

  let description = "";
  if (direction === "up") description = `ML model memprediksi harga naik jam depan dengan ${probabilityPct.toFixed(0)}% probability. Model accuracy: ${model.accuracy.toFixed(0)}% pada ${featureList.length} sampel training.`;
  else if (direction === "down") description = `ML model memprediksi harga turun jam depan dengan ${(100 - probabilityPct).toFixed(0)}% probability. Model accuracy: ${model.accuracy.toFixed(0)}% pada ${featureList.length} sampel training.`;
  else description = `ML model uncertain (${probabilityPct.toFixed(0)}% up). Tidak ada sinyal kuat. Model accuracy: ${model.accuracy.toFixed(0)}%.`;

  return {
    probability, probabilityPct, direction, confidence,
    features: currentFeatures,
    modelAccuracy: model.accuracy,
    brierScore: model.brierScore,
    calibration: model.calibration,
    calibrationPerRegime: model.calibrationPerRegime,
    featureImportance: model.featureImportance,
    ablation: model.ablation,
    trainingSamples: featureList.length,
    description,
  };
}
