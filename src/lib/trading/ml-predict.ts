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
  featureImportance: { name: string; weight: number; absWeight: number; rank: number; zScore: number; pValue: number; adjustedPValue: number; significant: boolean; ciLo: number; ciHi: number; bootstrapCILo: number; bootstrapCIHi: number; oddsRatio: number; orCILo: number; orCIHi: number; effectSize: number; probDiff: number; probDiffPct: number; pBase: number }[]; // P2: feature importance with BH-adjusted p-values + Wald CI
  ablation: { feature: string; dropped: number; accuracyDelta: number; description: string; bsCILo: number; bsCIHi: number; significant: boolean }[]; // P3: feature ablation
  aucROC: number;     // P1: Area Under ROC Curve (0.5 = random, 1.0 = perfect)
  aucPR: number;      // P1: Area Under Precision-Recall Curve
  permutationImportance: { feature: string; importance: number; ciLo: number; ciHi: number; significant: boolean }[]; // P2: model-agnostic importance
  // P5: MDI (Mean Decrease Impurity via decision tree) + MDA (= permutation importance, aliased)
  mdiImportance: { feature: string; importance: number; rank: number; interpretation: string }[];
  mdaImportance: { feature: string; importance: number; ciLo: number; ciHi: number; significant: boolean; rank: number }[];
  featureSelection: { feature: string; waldSig: boolean; permSig: boolean; mdiRank: number; mdaRank: number; waldRank: number; combinedScore: number; verdict: "useful" | "borderline" | "noise"; recommendation: string }[];
  lrStat: number;       // P3: Likelihood Ratio test statistic
  lrDF: number;         // P3: degrees of freedom
  lrPValue: number;     // P3: p-value for LR test (model as a whole)
  tripleBarrier: { upBarrier: number; downBarrier: number; maxBars: number; labels: number[]; upCount: number; downCount: number; timeoutCount: number; upPct: number; downPct: number; timeoutPct: number } | null; // P4: triple-barrier labels
  // P6: Dynamic triple-barrier — barriers scaled by rolling ATR (volatility-adaptive)
  dynamicTripleBarrier: { kUp: number; kDown: number; maxBars: number; labels: number[]; upCount: number; downCount: number; timeoutCount: number; upPct: number; downPct: number; timeoutPct: number; avgUpBarrierPct: number; avgDownBarrierPct: number; description: string } | null;
  // P7: Return attribution sample weighting — combine uniqueness with |return| magnitude
  returnAttribution: { avgUniqueness: number; avgReturnAbs: number; avgCombinedWeight: number; minWeight: number; maxWeight: number; description: string };
  metaModel: { accuracy: number; brierScore: number; aucROC: number; precision: number; recall: number; f1Score: number; prAUC: number; optimalThreshold: number; precisionAtThreshold: number; recallAtThreshold: number; f1AtThreshold: number; avgUniqueness: number; samples: number; barrierHitRate: number; description: string; oosThreshold: number; oosF1: number; oosPrecision: number; oosRecall: number; oosF1AtTrainThreshold: number; oosPrecisionAtTrainThreshold: number; oosRecallAtTrainThreshold: number; calibrationPerRegime: Record<string, any[]>; isotonicBrier: number; plattBrier: number; isotonicOosF1: number; plattOosF1: number; isotonicThreshold: number; plattThreshold: number; nestedCVF1: number; nestedCVResults: any[]; aucROCLift: number; prAUCLift: number; aucEffectSize: number; prEffectSize: number; f1EffectSize: number; calibratedCalibrationPerRegime: Record<string, any[]>; dynamicBarrierMetaModel?: any } | null; // P1: meta-labeling model
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

// Isotonic regression calibration — fixes miscalibration from class weighting
// Maps raw probabilities to calibrated probabilities using monotonic fitting
function isotonicCalibrate(rawProbs: number[], labels: number[]): (p: number) => number {
  // Sort by raw probability
  const sorted = rawProbs.map((p, i) => ({ p, label: labels[i] })).sort((a, b) => a.p - b.p);
  // Pool Adjacent Violators (PAVA) algorithm
  const blocks: { value: number; weight: number }[] = [];
  for (const { p, label } of sorted) {
    blocks.push({ value: label, weight: 1 });
    // Merge blocks while violating monotonicity
    while (blocks.length >= 2 && blocks[blocks.length - 2].value > blocks[blocks.length - 1].value) {
      const right = blocks.pop()!;
      const left = blocks.pop()!;
      const totalW = left.weight + right.weight;
      blocks.push({ value: (left.value * left.weight + right.value * right.weight) / totalW, weight: totalW });
    }
  }
  // Build lookup: for each block, store the calibrated probability and the raw range
  const lookup: { rawLo: number; rawHi: number; calibrated: number }[] = [];
  let idx = 0;
  for (const block of blocks) {
    const blockSize = block.weight;
    const rawLo = sorted[idx]?.p ?? 0;
    const rawHi = sorted[idx + blockSize - 1]?.p ?? 1;
    lookup.push({ rawLo, rawHi, calibrated: block.value });
    idx += blockSize;
  }
  // Return interpolation function
  return (p: number) => {
    if (p <= lookup[0].rawLo) return lookup[0].calibrated;
    for (let i = 0; i < lookup.length; i++) {
      if (p >= lookup[i].rawLo && p <= lookup[i].rawHi) return lookup[i].calibrated;
      if (i < lookup.length - 1 && p > lookup[i].rawHi && p < lookup[i + 1].rawLo) {
        // Interpolate between blocks
        const t = (p - lookup[i].rawHi) / (lookup[i + 1].rawLo - lookup[i].rawHi);
        return lookup[i].calibrated * (1 - t) + lookup[i + 1].calibrated * t;
      }
    }
    return lookup[lookup.length - 1].calibrated;
  };
}

// Platt scaling — logistic regression on (raw_prob, label) to calibrate
function plattCalibrate(rawProbs: number[], labels: number[]): (p: number) => number {
  // Fit: P(y=1 | raw) = sigmoid(a * raw + b)
  let a = 0, b = 0;
  const lr = 0.01;
  for (let iter = 0; iter < 200; iter++) {
    let gradA = 0, gradB = 0;
    for (let i = 0; i < rawProbs.length; i++) {
      const z = a * rawProbs[i] + b;
      const pred = sigmoid(z);
      const err = pred - labels[i];
      gradA += err * rawProbs[i];
      gradB += err;
    }
    a -= lr * gradA / rawProbs.length;
    b -= lr * gradB / rawProbs.length;
  }
  return (p: number) => sigmoid(a * p + b);
}

// Weighted logistic regression for meta-labeling (uniqueness-weighted + class balancing)
function trainWeightedLogisticRegression(
  features: number[][], labels: number[], weights: number[],
  learningRate = 0.01, iterations = 200
): { weights: number[]; bias: number; accuracy: number; brierScore: number; precision: number; recall: number; f1Score: number; prAUC: number; optimalThreshold: number; precisionAtThreshold: number; recallAtThreshold: number; f1AtThreshold: number } {
  const n = features.length;
  const d = features[0]?.length || 0;

  // P1: Class balancing — up-sample minority class (barrier hits)
  // Instead of SMOTE, use cost-sensitive weighting: minority class gets higher weight
  const posCount = labels.filter(l => l === 1).length;
  const negCount = n - posCount;
  const posWeight = negCount / Math.max(1, posCount); // up-weight minority
  const classWeights = labels.map(l => (l === 1 ? posWeight : 1));
  // Combine class weight with uniqueness weight
  const combinedWeights = weights.map((w, i) => w * classWeights[i]);

  // Standardize (weighted)
  const means: number[] = new Array(d).fill(0);
  const stdDevs: number[] = new Array(d).fill(1);
  const totalW = combinedWeights.reduce((a, x) => a + x, 0) || 1;
  for (let j = 0; j < d; j++) {
    let wsum = 0;
    for (let i = 0; i < n; i++) wsum += features[i][j] * combinedWeights[i];
    means[j] = wsum / totalW;
    let wvar = 0;
    for (let i = 0; i < n; i++) wvar += combinedWeights[i] * (features[i][j] - means[j]) ** 2;
    wvar /= totalW;
    stdDevs[j] = Math.sqrt(wvar) || 1;
  }
  const standardized = features.map(row => row.map((v, j) => (v - means[j]) / stdDevs[j]));

  const w = new Array(d).fill(0);
  let b = 0;
  for (let iter = 0; iter < iterations; iter++) {
    const grad = new Array(d).fill(0);
    let gradB = 0;
    for (let i = 0; i < n; i++) {
      const z = b + standardized[i].reduce((a, x, j) => a + x * w[j], 0);
      const pred = sigmoid(z);
      const err = (pred - labels[i]) * combinedWeights[i];
      for (let j = 0; j < d; j++) grad[j] += err * standardized[i][j];
      gradB += err;
    }
    for (let j = 0; j < d; j++) w[j] -= learningRate * grad[j] / totalW;
    b -= learningRate * gradB / totalW;
  }

  // Compute predictions for threshold optimization
  const predProbs: { prob: number; label: number }[] = [];
  for (let i = 0; i < n; i++) {
    const z = b + standardized[i].reduce((a, x, j) => a + x * w[j], 0);
    predProbs.push({ prob: sigmoid(z), label: labels[i] });
  }
  predProbs.sort((a, b2) => a.prob - b2.prob);

  // P2: Threshold optimization — find threshold that maximizes F1
  let bestThreshold = 0.5, bestF1 = 0, bestPrecision = 0, bestRecall = 0;
  for (let t = 0.05; t <= 0.95; t += 0.05) {
    let tp = 0, fp = 0, fn = 0;
    for (const p of predProbs) {
      const pred = p.prob >= t ? 1 : 0;
      if (pred === 1 && p.label === 1) tp++;
      if (pred === 1 && p.label === 0) fp++;
      if (pred === 0 && p.label === 1) fn++;
    }
    const prec = (tp + fp) > 0 ? tp / (tp + fp) : 0;
    const rec = (tp + fn) > 0 ? tp / (tp + fn) : 0;
    const f1 = (prec + rec) > 0 ? 2 * prec * rec / (prec + rec) : 0;
    if (f1 > bestF1) { bestF1 = f1; bestThreshold = t; bestPrecision = prec; bestRecall = rec; }
  }

  // P3: PR-AUC for meta-model
  let prevPrec = posCount > 0 ? posCount / n : 0.5, prevRec = 0, prAUC = 0;
  let tp2 = 0;
  for (let i = predProbs.length - 1; i >= 0; i--) {
    if (predProbs[i].label === 1) tp2++;
    const rank = predProbs.length - i;
    const prec = tp2 / rank;
    const rec = posCount > 0 ? tp2 / posCount : 0;
    prAUC += (rec - prevRec) * (prec + prevPrec) / 2;
    prevPrec = prec; prevRec = rec;
  }
  prAUC = Math.max(0, Math.min(1, prAUC));

  // Default threshold (0.5) metrics
  let correct = 0, brierSum = 0, tpDef = 0, fpDef = 0, fnDef = 0;
  for (let i = 0; i < n; i++) {
    const z = b + standardized[i].reduce((a, x, j) => a + x * w[j], 0);
    const pred = sigmoid(z);
    const predLabel = pred > 0.5 ? 1 : 0;
    if (predLabel === labels[i]) correct++;
    brierSum += (pred - labels[i]) ** 2;
    if (predLabel === 1 && labels[i] === 1) tpDef++;
    if (predLabel === 1 && labels[i] === 0) fpDef++;
    if (predLabel === 0 && labels[i] === 1) fnDef++;
  }
  const precDef = (tpDef + fpDef) > 0 ? tpDef / (tpDef + fpDef) : 0;
  const recDef = (tpDef + fnDef) > 0 ? tpDef / (tpDef + fnDef) : 0;
  const f1Def = (precDef + recDef) > 0 ? 2 * precDef * recDef / (precDef + recDef) : 0;

  return {
    weights: w, bias: b,
    accuracy: n > 0 ? (correct / n) * 100 : 0,
    brierScore: n > 0 ? brierSum / n : 0.25,
    precision: precDef, recall: recDef, f1Score: f1Def, prAUC,
    optimalThreshold: bestThreshold, precisionAtThreshold: bestPrecision, recallAtThreshold: bestRecall, f1AtThreshold: bestF1,
  };
}

// AUC-ROC computation
function computeAUC(features: number[][], labels: number[], weights: number[], bias: number): number {
  const preds: { prob: number; label: number }[] = [];
  for (let i = 0; i < features.length; i++) {
    const z = bias + features[i].reduce((a, w, j) => a + w * weights[j], 0);
    preds.push({ prob: sigmoid(z), label: labels[i] });
  }
  preds.sort((a, b) => b.prob - a.prob);
  const totalPos = preds.filter(p => p.label === 1).length;
  const totalNeg = preds.length - totalPos;
  if (totalPos === 0 || totalNeg === 0) return 0.5;
  let tp = 0, fp = 0, prevTPR = 0, prevFPR = 0, auc = 0;
  for (const p of preds) {
    if (p.label === 1) tp++; else fp++;
    const tpr = tp / totalPos, fpr = fp / totalNeg;
    auc += (fpr - prevFPR) * (tpr + prevTPR) / 2;
    prevTPR = tpr; prevFPR = fpr;
  }
  return auc;
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

// P5: MDI (Mean Decrease Impurity) via small CART decision tree
// Trains a depth-limited binary tree using Gini impurity. At each split,
// records the impurity decrease attributed to the splitting feature.
// Final importance per feature = sum of impurity decreases weighted by node size.
// This is model-agnostic and complementary to logistic regression coefficients.
interface CARTNode {
  isLeaf: boolean;
  prediction: number;       // for leaf: P(y=1)
  splitFeature?: number;    // for internal: which feature splits
  splitThreshold?: number;
  impurityDecrease?: number; // Gini decrease attributed to splitFeature at this node
  samples?: number;
  left?: CARTNode;
  right?: CARTNode;
}

function giniImpurity(labels: number[]): number {
  if (labels.length === 0) return 0;
  const p1 = labels.filter(l => l === 1).length / labels.length;
  const p0 = 1 - p1;
  return 1 - p1 * p1 - p0 * p0;
}

function buildCART(
  features: number[][], labels: number[], sampleIdx: number[],
  depth: number, maxDepth: number, mdiAccumulator: number[], minSamplesSplit: number
): CARTNode {
  const localLabels = sampleIdx.map(i => labels[i]);
  const p1 = localLabels.filter(l => l === 1).length / Math.max(1, localLabels.length);
  const nodeImpurity = giniImpurity(localLabels);
  const n = sampleIdx.length;

  // Leaf conditions: max depth reached, pure node, too few samples
  if (depth >= maxDepth || n < minSamplesSplit || nodeImpurity === 0) {
    return { isLeaf: true, prediction: p1 };
  }

  const d = features[0]?.length || 0;
  let bestFeature = -1, bestThreshold = 0, bestGain = -1;
  let bestLeftIdx: number[] = [], bestRightIdx: number[] = [];

  // For each feature, try a few candidate thresholds (quantile-based)
  for (let f = 0; f < d; f++) {
    const values = sampleIdx.map(i => features[i][f]).sort((a, b) => a - b);
    // Try 5 candidate split points (20/40/60/80th percentiles + median)
    const percentiles = [0.2, 0.4, 0.5, 0.6, 0.8];
    for (const pct of percentiles) {
      const threshold = values[Math.floor(values.length * pct)];
      const leftIdx: number[] = [];
      const rightIdx: number[] = [];
      for (const i of sampleIdx) {
        if (features[i][f] <= threshold) leftIdx.push(i);
        else rightIdx.push(i);
      }
      if (leftIdx.length < 2 || rightIdx.length < 2) continue;
      const leftLabels = leftIdx.map(i => labels[i]);
      const rightLabels = rightIdx.map(i => labels[i]);
      const leftGini = giniImpurity(leftLabels);
      const rightGini = giniImpurity(rightLabels);
      const weightedChildGini = (leftIdx.length * leftGini + rightIdx.length * rightGini) / n;
      const gain = nodeImpurity - weightedChildGini;
      if (gain > bestGain) {
        bestGain = gain;
        bestFeature = f;
        bestThreshold = threshold;
        bestLeftIdx = leftIdx;
        bestRightIdx = rightIdx;
      }
    }
  }

  // No improving split → leaf
  if (bestFeature < 0 || bestGain <= 0) {
    return { isLeaf: true, prediction: p1 };
  }

  // Record MDI: impurity decrease weighted by fraction of samples reaching this node
  mdiAccumulator[bestFeature] += bestGain * n;

  return {
    isLeaf: false,
    prediction: p1,
    splitFeature: bestFeature,
    splitThreshold: bestThreshold,
    impurityDecrease: bestGain,
    samples: n,
    left: buildCART(features, labels, bestLeftIdx, depth + 1, maxDepth, mdiAccumulator, minSamplesSplit),
    right: buildCART(features, labels, bestRightIdx, depth + 1, maxDepth, mdiAccumulator, minSamplesSplit),
  };
}

// Compute MDI feature importance by training an ensemble of small CART trees on bootstrap samples.
// Returns importance per feature (sum of weighted Gini decreases across all trees), normalized to sum to 1.
function computeMDI(features: number[][], labels: number[], nTrees = 20, maxDepth = 4): { feature: string; importance: number; rank: number; interpretation: string }[] {
  const d = features[0]?.length || 0;
  const n = features.length;
  const accumulators: number[] = new Array(d).fill(0);

  for (let t = 0; t < nTrees; t++) {
    // Bootstrap sample
    const sampleIdx: number[] = [];
    for (let i = 0; i < n; i++) sampleIdx.push(Math.floor(Math.random() * n));
    const mdiThisTree: number[] = new Array(d).fill(0);
    buildCART(features, labels, sampleIdx, 0, maxDepth, mdiThisTree, 4);
    for (let f = 0; f < d; f++) accumulators[f] += mdiThisTree[f];
  }

  // Normalize
  const total = accumulators.reduce((a, b) => a + b, 0) || 1;
  const normalized = accumulators.map(v => v / total);
  const result = normalized.map((imp, f) => ({
    feature: FEATURE_NAMES[f] || `Feature ${f}`,
    importance: imp,
    rank: 0,
    interpretation: imp > 0.25 ? "dominant splitter" : imp > 0.15 ? "important splitter" : imp > 0.05 ? "minor splitter" : "rarely splits",
  }));
  result.sort((a, b) => b.importance - a.importance);
  result.forEach((r, i) => r.rank = i + 1);
  return result;
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
  // P2: Bootstrap CI for ablation — is Δ statistically significant?
  const baselineAccuracy = accuracy;
  const ablation: { feature: string; dropped: number; accuracyDelta: number; description: string; bsCILo: number; bsCIHi: number; significant: boolean }[] = [];
  const nBsAblation = 50; // bootstrap iterations for ablation CI
  for (let dropIdx = 0; dropIdx < d; dropIdx++) {
    const reducedFeatures = standardized.map(row => row.filter((_, j) => j !== dropIdx));
    // Full ablation (200 iterations)
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

    // Bootstrap CI for delta: resample, compute delta each time
    const bootstrapDeltas: number[] = [];
    for (let b = 0; b < nBsAblation; b++) {
      const sampleIdx: number[] = [];
      for (let i = 0; i < n; i++) sampleIdx.push(Math.floor(Math.random() * n));
      // Baseline accuracy on bootstrap sample
      let bsBaseCorrect = 0;
      for (const i of sampleIdx) {
        const z = bias + standardized[i].reduce((a, w, j) => a + w * weights[j], 0);
        if ((sigmoid(z) > 0.5 ? 1 : 0) === labels[i]) bsBaseCorrect++;
      }
      const bsBaseAcc = (bsBaseCorrect / n) * 100;
      // Reduced accuracy on bootstrap sample
      let bsReducedCorrect = 0;
      for (const i of sampleIdx) {
        const z = reducedBias + reducedFeatures[i].reduce((a, w, j) => a + w * reducedWeights[j], 0);
        if ((sigmoid(z) > 0.5 ? 1 : 0) === labels[i]) bsReducedCorrect++;
      }
      const bsReducedAcc = (bsReducedCorrect / n) * 100;
      bootstrapDeltas.push(bsBaseAcc - bsReducedAcc);
    }
    bootstrapDeltas.sort((a, b) => a - b);
    const bsCILo = bootstrapDeltas[Math.floor(nBsAblation * 0.025)] || 0;
    const bsCIHi = bootstrapDeltas[Math.floor(nBsAblation * 0.975)] || 0;
    // Significant if CI excludes 0 (both positive or both negative)
    const sig = (bsCILo > 0 && bsCIHi > 0) || (bsCILo < 0 && bsCIHi < 0);

    ablation.push({
      feature: FEATURE_NAMES[dropIdx] || `Feature ${dropIdx}`,
      dropped: dropIdx,
      accuracyDelta: delta,
      bsCILo, bsCIHi, significant: sig,
      description: delta > 0.5 ? `Menghapus menurunkan akurasi ${delta.toFixed(2)}% [CI ${bsCILo.toFixed(2)}, ${bsCIHi.toFixed(2)}]` : delta < -0.5 ? `Menghapus menaikkan akurasi ${Math.abs(delta).toFixed(2)}% [CI ${bsCILo.toFixed(2)}, ${bsCIHi.toFixed(2)}]` : `Tidak mengubah akurasi Δ=${delta.toFixed(2)}% [CI ${bsCILo.toFixed(2)}, ${bsCIHi.toFixed(2)}]`,
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

  // P3: Likelihood Ratio Test — full model vs null (intercept-only) model
  // LR = -2 * (logLik_null - logLik_full) ~ chi-squared(df = d)
  // Tests whether the model as a whole has ANY predictive power
  const logLikFull = (() => {
    let ll = 0;
    for (let i = 0; i < n; i++) {
      const z = bias + standardized[i].reduce((a, w, j) => a + w * weights[j], 0);
      const p = sigmoid(z);
      ll += labels[i] * Math.log(p + 1e-10) + (1 - labels[i]) * Math.log(1 - p + 1e-10);
    }
    return ll;
  })();
  const nullProb = labels.reduce((a, b) => a + b, 0) / n; // base rate
  const logLikNull = (() => {
    let ll = 0;
    for (let i = 0; i < n; i++) {
      ll += labels[i] * Math.log(nullProb + 1e-10) + (1 - labels[i]) * Math.log(1 - nullProb + 1e-10);
    }
    return ll;
  })();
  const lrStat = -2 * (logLikNull - logLikFull);
  const lrDF = d; // degrees of freedom = number of features
  // Chi-squared survival function (1 - CDF) approximation
  // For large DF, use Wilson-Hilferty approximation
  const lrPValue = (() => {
    if (lrStat <= 0) return 1;
    const h = 2 / (9 * lrDF);
    const z = (Math.pow(lrStat / lrDF, 1/3) - (1 - h)) / Math.sqrt(h);
    // P(X > lrStat) = P(Z > z) = 1 - Φ(z)
    const p = 0.5 * (1 + Math.tanh(0.7978 * z * (1 + 0.044715 * z * z)));
    return Math.max(0, Math.min(1, 1 - p));
  })();

  // P1: AUC-ROC + PR-AUC — threshold-independent discrimination metrics
  // AUC = area under ROC curve (0.5 = random, 1.0 = perfect)
  // PR-AUC = area under precision-recall curve (base rate = random)
  const predProbs: { prob: number; label: number }[] = [];
  for (let i = 0; i < n; i++) {
    const z = bias + standardized[i].reduce((a, w, j) => a + w * weights[j], 0);
    predProbs.push({ prob: sigmoid(z), label: labels[i] });
  }
  predProbs.sort((a, b) => b.prob - a.prob);
  // ROC AUC via trapezoidal rule
  let tp = 0, fp = 0, prevTPR = 0, prevFPR = 0, aucROC = 0;
  const totalPos = predProbs.filter(p => p.label === 1).length;
  const totalNeg = n - totalPos;
  for (const p of predProbs) {
    if (p.label === 1) tp++; else fp++;
    const tpr = totalPos > 0 ? tp / totalPos : 0;
    const fpr = totalNeg > 0 ? fp / totalNeg : 0;
    aucROC += (fpr - prevFPR) * (tpr + prevTPR) / 2;
    prevTPR = tpr; prevFPR = fpr;
  }
  // PR-AUC via trapezoidal rule
  let prevPrecision = totalPos > 0 ? totalPos / n : 0.5;
  let prevRecall = 0, aucPR = 0;
  tp = 0;
  for (const p of predProbs) {
    if (p.label === 1) tp++;
    const precision = (tp) / (tp + (predProbs.indexOf(p) + 1 - tp));
    const recall = totalPos > 0 ? tp / totalPos : 0;
    aucPR += (recall - prevRecall) * (precision + prevPrecision) / 2;
    prevPrecision = precision; prevRecall = recall;
  }
  aucPR = Math.max(0, Math.min(1, aucPR));

  // P2: Permutation importance with bootstrap CI
  // Shuffle each feature, measure accuracy drop. Model-agnostic, more robust than coefficients.
  const nPerm = 50;
  const permutationImportance: { feature: string; importance: number; ciLo: number; ciHi: number; significant: boolean }[] = [];
  for (let permIdx = 0; permIdx < d; permIdx++) {
    const deltas: number[] = [];
    for (let p = 0; p < nPerm; p++) {
      // Shuffle feature permIdx
      const shuffled = standardized.map((row, i) => {
        const newRow = [...row];
        const swapWith = Math.floor(Math.random() * n);
        newRow[permIdx] = standardized[swapWith][permIdx];
        return newRow;
      });
      // Compute accuracy with shuffled feature
      let permCorrect = 0;
      for (let i = 0; i < n; i++) {
        const z = bias + shuffled[i].reduce((a, w, j) => a + w * weights[j], 0);
        if ((sigmoid(z) > 0.5 ? 1 : 0) === labels[i]) permCorrect++;
      }
      const permAcc = (permCorrect / n) * 100;
      deltas.push(baselineAccuracy - permAcc);
    }
    deltas.sort((a, b) => a - b);
    const mean = deltas.reduce((a, b) => a + b, 0) / nPerm;
    const ciLo = deltas[Math.floor(nPerm * 0.025)] || 0;
    const ciHi = deltas[Math.floor(nPerm * 0.975)] || 0;
    const sig = ciLo > 0; // significant if CI excludes 0 from below (dropping feature hurts)
    permutationImportance.push({
      feature: FEATURE_NAMES[permIdx] || `Feature ${permIdx}`,
      importance: mean,
      ciLo, ciHi, significant: sig,
    });
  }
  permutationImportance.sort((a, b) => b.importance - a.importance);

  // P1: Probability difference effect size — how much does P(up) change
  // when a feature increases by 1 SD? More interpretable than OR.
  // P_base = sigmoid(bias + sum(w_j * 0)) = sigmoid(bias) (all features at mean, z-score=0)
  // P_plus1SD_j = sigmoid(bias + w_j) (feature j at +1 SD, others at mean)
  // ΔP_j = P_plus1SD_j - P_base
  const pBase = sigmoid(bias);
  const probDiff: { feature: string; deltaP: number; pBase: number; pPlus1SD: number }[] = [];
  for (let j = 0; j < d; j++) {
    const pPlus1SD = sigmoid(bias + weights[j]);
    probDiff.push({
      feature: FEATURE_NAMES[j] || `Feature ${j}`,
      deltaP: pPlus1SD - pBase,
      pBase,
      pPlus1SD,
    });
  }

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
      probDiff: probDiff[i].deltaP, // ΔP = change in P(up) per 1-SD increase
      probDiffPct: probDiff[i].deltaP * 100, // as percentage points
      pBase: pBase,
    };
  })
    .sort((a, b) => b.absWeight - a.absWeight)
    .map((f, i) => ({ ...f, rank: i + 1 }));

  return { weights, bias, accuracy, brierScore, calibration, calibrationPerRegime, featureImportance, ablation, permutationImportance, aucROC, aucPR, lrStat, lrDF, lrPValue, logLikFull, logLikNull, stdDevs, pValues: rawPValues, adjustedPValues: adjustedP, zScores };
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

  // P1: Meta-labeling (Lopez de Prado) — secondary model on triple-barrier output
  // Primary model (above) predicts direction. Meta-model predicts whether to ACT on it.
  // Train on triple-barrier labels: only trade when meta-model says "high probability of profit"
  // For each sample, compute uniqueness weight = 1 / (number of overlapping windows)
  // and use it to weight the training
  const tbUpBarrier = 0.02, tbDownBarrier = 0.02, tbMaxBars = 6;
  const tbMetaLabels: number[] = []; // 1 if barrier hit (profit or loss), 0 if timeout
  const tbMetaOutcomes: number[] = []; // +1 if up barrier, -1 if down barrier
  const uniqueness: number[] = []; // sample uniqueness weight
  let overlapCount = 0;
  for (let i = 30; i < candles.length - tbMaxBars; i++) {
    const entryPrice = candles[i].close;
    let hit = 0, outcome = 0;
    for (let j = 1; j <= tbMaxBars; j++) {
      const ret = (candles[i + j].close - entryPrice) / entryPrice;
      if (ret >= tbUpBarrier) { hit = 1; outcome = 1; break; }
      if (ret <= -tbDownBarrier) { hit = 1; outcome = -1; break; }
    }
    tbMetaLabels.push(hit);
    tbMetaOutcomes.push(outcome);
    // Uniqueness: count how many other windows overlap this one
    let overlaps = 0;
    for (let k = Math.max(30, i - tbMaxBars); k < Math.min(candles.length - tbMaxBars, i + tbMaxBars); k++) {
      if (k !== i) overlaps++;
    }
    uniqueness.push(overlaps > 0 ? 1 / (1 + overlaps) : 1);
    overlapCount += overlaps;
  }
  // This is the "should I trade?" model — higher precision than direction model
  const metaLabels = tbMetaLabels;
  const metaFeatures: number[][] = [];
  for (let i = 30; i < candles.length - tbMaxBars; i++) {
    const f = computeFeatures(candles, i);
    if (f) metaFeatures.push([f.rsi, f.macdHist, f.smaRatio, f.stoch, f.obvSlope, f.volRatio, f.atrPct, f.priceMomentum]);
  }
  // Weighted logistic regression for meta-model (using uniqueness weights)
  const metaResult = trainWeightedLogisticRegression(metaFeatures, metaLabels, uniqueness, 0.01, 200);
  const metaAUC = computeAUC(metaFeatures, metaLabels, metaResult.weights, metaResult.bias);

  // P1: Out-of-sample threshold validation with calibration
  // Split 70/30, train model + calibration on train, validate on test
  const splitIdx = Math.floor(metaFeatures.length * 0.7);
  const trainFeatures = metaFeatures.slice(0, splitIdx);
  const trainLabels = metaLabels.slice(0, splitIdx);
  const trainWeights = uniqueness.slice(0, splitIdx);
  const testFeatures = metaFeatures.slice(splitIdx);
  const testLabels = metaLabels.slice(splitIdx);
  // Train meta-model on train split
  const trainMeta = trainWeightedLogisticRegression(trainFeatures, trainLabels, trainWeights, 0.01, 200);
  // Get raw predictions on train set for calibration fitting
  const trainRawProbs: number[] = [];
  for (let i = 0; i < trainFeatures.length; i++) {
    const z = trainMeta.bias + trainFeatures[i].reduce((a, w, j) => a + w * trainMeta.weights[j], 0);
    trainRawProbs.push(sigmoid(z));
  }
  // Fit calibration methods on train data
  const isotonicFn = isotonicCalibrate(trainRawProbs, trainLabels);
  const plattFn = plattCalibrate(trainRawProbs, trainLabels);
  // Apply calibration to test set
  const testPredsRaw: { prob: number; label: number }[] = [];
  const testPredsIsotonic: { prob: number; label: number }[] = [];
  const testPredsPlatt: { prob: number; label: number }[] = [];
  for (let i = 0; i < testFeatures.length; i++) {
    const z = trainMeta.bias + testFeatures[i].reduce((a, w, j) => a + w * trainMeta.weights[j], 0);
    const rawProb = sigmoid(z);
    testPredsRaw.push({ prob: rawProb, label: testLabels[i] });
    testPredsIsotonic.push({ prob: isotonicFn(rawProb), label: testLabels[i] });
    testPredsPlatt.push({ prob: plattFn(rawProb), label: testLabels[i] });
  }
  // Find optimal threshold for each calibration method on test set
  function findOptimalThreshold(preds: { prob: number; label: number }[]): { threshold: number; f1: number; prec: number; rec: number } {
    let bestT = 0.5, bestF1 = 0, bestP = 0, bestR = 0;
    for (let t = 0.05; t <= 0.95; t += 0.05) {
      let tp = 0, fp = 0, fn = 0;
      for (const p of preds) {
        const pred = p.prob >= t ? 1 : 0;
        if (pred === 1 && p.label === 1) tp++;
        if (pred === 1 && p.label === 0) fp++;
        if (pred === 0 && p.label === 1) fn++;
      }
      const prec = (tp + fp) > 0 ? tp / (tp + fp) : 0;
      const rec = (tp + fn) > 0 ? tp / (tp + fn) : 0;
      const f1 = (prec + rec) > 0 ? 2 * prec * rec / (prec + rec) : 0;
      if (f1 > bestF1) { bestF1 = f1; bestT = t; bestP = prec; bestR = rec; }
    }
    return { threshold: bestT, f1: bestF1, prec: bestP, rec: bestR };
  }
  const oosRaw = findOptimalThreshold(testPredsRaw);
  const oosIsotonic = findOptimalThreshold(testPredsIsotonic);
  const oosPlatt = findOptimalThreshold(testPredsPlatt);
  // Apply TRAIN threshold to TEST set (true OOS)
  let oosTP = 0, oosFP = 0, oosFN = 0;
  for (const p of testPredsRaw) {
    const pred = p.prob >= trainMeta.optimalThreshold ? 1 : 0;
    if (pred === 1 && p.label === 1) oosTP++;
    if (pred === 1 && p.label === 0) oosFP++;
    if (pred === 0 && p.label === 1) oosFN++;
  }
  const oosPrecAtTrainThreshold = (oosTP + oosFP) > 0 ? oosTP / (oosTP + oosFP) : 0;
  const oosRecAtTrainThreshold = (oosTP + oosFN) > 0 ? oosTP / (oosTP + oosFN) : 0;
  const oosF1AtTrainThreshold = (oosPrecAtTrainThreshold + oosRecAtTrainThreshold) > 0 ? 2 * oosPrecAtTrainThreshold * oosRecAtTrainThreshold / (oosPrecAtTrainThreshold + oosRecAtTrainThreshold) : 0;
  // Compute Brier score for calibrated predictions (isotonic vs raw)
  let brierRaw = 0, brierIsotonic = 0, brierPlatt = 0;
  for (let i = 0; i < testPredsRaw.length; i++) {
    brierRaw += (testPredsRaw[i].prob - testLabels[i]) ** 2;
    brierIsotonic += (testPredsIsotonic[i].prob - testLabels[i]) ** 2;
    brierPlatt += (testPredsPlatt[i].prob - testLabels[i]) ** 2;
  }
  brierRaw /= testPredsRaw.length;
  brierIsotonic /= testPredsIsotonic.length;
  brierPlatt /= testPredsPlatt.length;

  // P2: Nested CV for threshold optimization (3-fold outer, inner = train threshold)
  const nFolds = 3;
  const foldSize = Math.floor(metaFeatures.length / nFolds);
  const nestedResults: { fold: number; innerThreshold: number; outerF1: number; outerPrec: number; outerRec: number }[] = [];
  for (let fold = 0; fold < nFolds; fold++) {
    const outerStart = fold * foldSize;
    const outerEnd = fold === nFolds - 1 ? metaFeatures.length : (fold + 1) * foldSize;
    const outerFeatures = metaFeatures.slice(outerStart, outerEnd);
    const outerLabels = metaLabels.slice(outerStart, outerEnd);
    const innerFeatures = [...metaFeatures.slice(0, outerStart), ...metaFeatures.slice(outerEnd)];
    const innerLabels = [...metaLabels.slice(0, outerStart), ...metaLabels.slice(outerEnd)];
    const innerWeights = [...uniqueness.slice(0, outerStart), ...uniqueness.slice(outerEnd)];
    // Train on inner, find threshold on inner
    const innerModel = trainWeightedLogisticRegression(innerFeatures, innerLabels, innerWeights, 0.01, 200);
    // Apply inner threshold to outer
    let tp = 0, fp = 0, fn = 0;
    for (let i = 0; i < outerFeatures.length; i++) {
      const z = innerModel.bias + outerFeatures[i].reduce((a, w, j) => a + w * innerModel.weights[j], 0);
      const pred = sigmoid(z) >= innerModel.optimalThreshold ? 1 : 0;
      if (pred === 1 && outerLabels[i] === 1) tp++;
      if (pred === 1 && outerLabels[i] === 0) fp++;
      if (pred === 0 && outerLabels[i] === 1) fn++;
    }
    const prec = (tp + fp) > 0 ? tp / (tp + fp) : 0;
    const rec = (tp + fn) > 0 ? tp / (tp + fn) : 0;
    const f1 = (prec + rec) > 0 ? 2 * prec * rec / (prec + rec) : 0;
    nestedResults.push({ fold: fold + 1, innerThreshold: innerModel.optimalThreshold, outerF1: f1, outerPrec: prec, outerRec: rec });
  }
  const nestedAvgF1 = nestedResults.reduce((a, b) => a + b.outerF1, 0) / nFolds;

  // P2: Calibration plot per regime with CI for ISOTONIC-calibrated predictions
  const calibratedRegimeBins: Record<string, { lo: number; hi: number; preds: number[]; labels: number[] }[]> = {
    trending: Array.from({ length: 10 }, (_, i) => ({ lo: i / 10, hi: (i + 1) / 10, preds: [], labels: [] })),
    ranging: Array.from({ length: 10 }, (_, i) => ({ lo: i / 10, hi: (i + 1) / 10, preds: [], labels: [] })),
    volatile: Array.from({ length: 10 }, (_, i) => ({ lo: i / 10, hi: (i + 1) / 10, preds: [], labels: [] })),
  };
  for (let i = 0; i < metaFeatures.length; i++) {
    const z = metaResult.bias + metaFeatures[i].reduce((a, w, j) => a + w * metaResult.weights[j], 0);
    const rawProb = sigmoid(z);
    const calibProb = isotonicFn(rawProb);
    const binIdx = Math.min(9, Math.floor(calibProb * 10));
    const feat = metaFeatures[i];
    const smaRatio = feat[2], atrPct = feat[6];
    const regime = atrPct > 0.02 ? "volatile" : (smaRatio > 1.005 || smaRatio < 0.995) ? "trending" : "ranging";
    calibratedRegimeBins[regime][binIdx].preds.push(calibProb);
    calibratedRegimeBins[regime][binIdx].labels.push(metaLabels[i]);
  }
  const calibratedCalibrationPerRegime: Record<string, any[]> = {};
  for (const [regime, rb] of Object.entries(calibratedRegimeBins)) {
    calibratedCalibrationPerRegime[regime] = rb.map((b) => {
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

  // P2: Calibration plot per regime for meta-model
  const metaRegimeBins: Record<string, { lo: number; hi: number; preds: number[]; labels: number[] }[]> = {
    trending: Array.from({ length: 10 }, (_, i) => ({ lo: i / 10, hi: (i + 1) / 10, preds: [], labels: [] })),
    ranging: Array.from({ length: 10 }, (_, i) => ({ lo: i / 10, hi: (i + 1) / 10, preds: [], labels: [] })),
    volatile: Array.from({ length: 10 }, (_, i) => ({ lo: i / 10, hi: (i + 1) / 10, preds: [], labels: [] })),
  };
  for (let i = 0; i < metaFeatures.length; i++) {
    const z = metaResult.bias + metaFeatures[i].reduce((a, w, j) => a + w * metaResult.weights[j], 0);
    const pred = sigmoid(z);
    const binIdx = Math.min(9, Math.floor(pred * 10));
    const feat = metaFeatures[i];
    const smaRatio = feat[2], atrPct = feat[6];
    const regime = atrPct > 0.02 ? "volatile" : (smaRatio > 1.005 || smaRatio < 0.995) ? "trending" : "ranging";
    metaRegimeBins[regime][binIdx].preds.push(pred);
    metaRegimeBins[regime][binIdx].labels.push(metaLabels[i]);
  }
  const metaCalibrationPerRegime: Record<string, any[]> = {};
  for (const [regime, rb] of Object.entries(metaRegimeBins)) {
    metaCalibrationPerRegime[regime] = rb.map((b) => {
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
  // Triple-barrier stats
  const tbTotal = tbMetaLabels.length;
  const tbUp = tbMetaOutcomes.filter(o => o === 1).length;
  const tbDown = tbMetaOutcomes.filter(o => o === -1).length;
  const tbTimeout = tbMetaLabels.filter(l => l === 0).length;
  // P1: Effect size based on AUC/PR-AUC lift over base rate
  const barrierHitRate = tbTotal > 0 ? (tbUp + tbDown) / tbTotal : 0.043;
  const aucROCLift = metaAUC - 0.5;
  const prAUCLift = metaResult.prAUC - barrierHitRate;
  const aucEffectSize = aucROCLift / 0.5;
  const prEffectSize = prAUCLift / Math.max(0.001, 1 - barrierHitRate);
  const randomF1 = 2 * barrierHitRate * 0.5 / (barrierHitRate + 0.5);
  const f1EffectSize = (nestedAvgF1 - randomF1) / Math.max(0.001, 1 - randomF1);
  const tripleBarrier = {
    upBarrier: tbUpBarrier, downBarrier: tbDownBarrier, maxBars: tbMaxBars,
    labels: tbMetaLabels,
    upCount: tbUp, downCount: tbDown, timeoutCount: tbTimeout,
    upPct: tbTotal > 0 ? (tbUp / tbTotal) * 100 : 0,
    downPct: tbTotal > 0 ? (tbDown / tbTotal) * 100 : 0,
    timeoutPct: tbTotal > 0 ? (tbTimeout / tbTotal) * 100 : 0,
  };

  // P6: Dynamic triple-barrier — barriers scaled by rolling ATR (volatility-adaptive)
  // Fixed 2% barrier is unrealistic: in low-vol periods it's too wide (mostly timeout),
  // in high-vol periods it's too tight (stops out too easily).
  // Dynamic: barrier = k × ATR(14) / price, so it adapts to current volatility regime.
  const tbDynKUp = 2.0;     // up barrier = 2× ATR
  const tbDynKDown = 2.0;   // down barrier = 2× ATR (symmetric)
  const tbDynMaxBars = tbMaxBars;
  const tbDynLabels: number[] = [];
  const tbDynOutcomes: number[] = [];
  const tbDynBarrierPcts: number[] = [];
  for (let i = 30; i < candles.length - tbDynMaxBars; i++) {
    const entryPrice = candles[i].close;
    // Rolling ATR(14) at entry time (using prior 30 bars)
    const atrAtEntry = calcATR(candles.slice(Math.max(0, i - 30), i + 1).map(c => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume })), 14);
    const upBarrierPct = atrAtEntry > 0 && entryPrice > 0 ? (tbDynKUp * atrAtEntry) / entryPrice : tbUpBarrier;
    const downBarrierPct = atrAtEntry > 0 && entryPrice > 0 ? (tbDynKDown * atrAtEntry) / entryPrice : tbDownBarrier;
    tbDynBarrierPcts.push(upBarrierPct);
    let hit = 0, outcome = 0;
    for (let j = 1; j <= tbDynMaxBars; j++) {
      const ret = (candles[i + j].close - entryPrice) / entryPrice;
      if (ret >= upBarrierPct) { hit = 1; outcome = 1; break; }
      if (ret <= -downBarrierPct) { hit = 1; outcome = -1; break; }
    }
    tbDynLabels.push(hit);
    tbDynOutcomes.push(outcome);
  }
  const tbDynTotal = tbDynLabels.length;
  const tbDynUp = tbDynOutcomes.filter(o => o === 1).length;
  const tbDynDown = tbDynOutcomes.filter(o => o === -1).length;
  const tbDynTimeout = tbDynLabels.filter(l => l === 0).length;
  const tbDynAvgBarrierPct = tbDynBarrierPcts.length > 0 ? tbDynBarrierPcts.reduce((a, b) => a + b, 0) / tbDynBarrierPcts.length : 0;
  const dynamicTripleBarrier = {
    kUp: tbDynKUp, kDown: tbDynKDown, maxBars: tbDynMaxBars,
    labels: tbDynLabels,
    upCount: tbDynUp, downCount: tbDynDown, timeoutCount: tbDynTimeout,
    upPct: tbDynTotal > 0 ? (tbDynUp / tbDynTotal) * 100 : 0,
    downPct: tbDynTotal > 0 ? (tbDynDown / tbDynTotal) * 100 : 0,
    timeoutPct: tbDynTotal > 0 ? (tbDynTimeout / tbDynTotal) * 100 : 0,
    avgUpBarrierPct: tbDynAvgBarrierPct,
    avgDownBarrierPct: tbDynAvgBarrierPct, // symmetric
    description: `Dynamic ±${tbDynKUp}×ATR(14) barriers, max ${tbDynMaxBars}h. Avg barrier ${(tbDynAvgBarrierPct * 100).toFixed(2)}% (vs fixed ${tbUpBarrier * 100}%). Timeout ${tbDynTotal > 0 ? ((tbDynTimeout / tbDynTotal) * 100).toFixed(1) : "0"}%.`,
  };

  // P7: Return attribution sample weighting
  // Uniqueness weighting alone treats all barrier-hitting samples equally.
  // Return attribution up-weights samples with BIG absolute returns (more info per sample).
  // Combined weight = uniqueness × (|return at exit| / mean(|return at exit|))
  const tbExitReturns: number[] = [];
  for (let i = 30; i < candles.length - tbMaxBars; i++) {
    const entryPrice = candles[i].close;
    let exitRet = 0;
    for (let j = 1; j <= tbMaxBars; j++) {
      const ret = (candles[i + j].close - entryPrice) / entryPrice;
      if (ret >= tbUpBarrier || ret <= -tbDownBarrier) { exitRet = ret; break; }
      if (j === tbMaxBars) exitRet = ret; // timeout: final-bar return
    }
    tbExitReturns.push(Math.abs(exitRet));
  }
  const meanAbsReturn = tbExitReturns.length > 0 ? tbExitReturns.reduce((a, b) => a + b, 0) / tbExitReturns.length : 1;
  const returnAttributionWeights = uniqueness.map((u, i) => u * (tbExitReturns[i] / Math.max(0.0001, meanAbsReturn)));
  // Train an alternative meta-model using return-attribution weights (vs uniqueness-only)
  const raMetaResult = trainWeightedLogisticRegression(metaFeatures, metaLabels, returnAttributionWeights, 0.01, 200);
  const raMetaAUC = computeAUC(metaFeatures, metaLabels, raMetaResult.weights, raMetaResult.bias);
  const returnAttribution = {
    avgUniqueness: uniqueness.reduce((a, b) => a + b, 0) / Math.max(1, uniqueness.length),
    avgReturnAbs: meanAbsReturn,
    avgCombinedWeight: returnAttributionWeights.reduce((a, b) => a + b, 0) / Math.max(1, returnAttributionWeights.length),
    minWeight: returnAttributionWeights.length > 0 ? Math.min(...returnAttributionWeights) : 0,
    maxWeight: returnAttributionWeights.length > 0 ? Math.max(...returnAttributionWeights) : 0,
    description: `weight = uniqueness × (|return| / mean(|return|)). Mean |return at exit|=${(meanAbsReturn * 100).toFixed(2)}%. Combined weight range [${returnAttributionWeights.length > 0 ? Math.min(...returnAttributionWeights).toFixed(3) : "0"}, ${returnAttributionWeights.length > 0 ? Math.max(...returnAttributionWeights).toFixed(3) : "0"}]. RA-weighted meta-model AUC ${raMetaAUC.toFixed(3)} vs uniqueness-only ${metaAUC.toFixed(3)}.`,
  };

  // P5: MDI (Mean Decrease Impurity) via CART ensemble + MDA (permutation importance alias)
  const mdiImportance = computeMDI(featureList, labels, 20, 4);
  // MDA = permutation importance (same algorithm), add rank
  const mdaImportance = model.permutationImportance
    .slice().sort((a, b) => b.importance - a.importance)
    .map((p, i) => ({ ...p, rank: i + 1 }));
  // P5: Combined feature selection — 3 independent methods must agree
  const featureSelection = FEATURE_NAMES.map((name, f) => {
    const wald = model.featureImportance.find(fi => fi.name === name);
    const perm = mdaImportance.find(p => p.feature === name);
    const mdi = mdiImportance.find(m => m.feature === name);
    const waldSig = wald?.significant ?? false;
    const permSig = perm?.significant ?? false;
    const waldRank = wald?.rank ?? 0;
    const mdiRank = mdi?.rank ?? 0;
    const mdaRank = perm?.rank ?? 0;
    // Combined score: average rank across 3 methods (lower = more important)
    const combinedScore = (waldRank + mdiRank + mdaRank) / 3;
    const sigCount = (waldSig ? 1 : 0) + (permSig ? 1 : 0);
    const verdict: "useful" | "borderline" | "noise" = sigCount >= 2 ? "useful" : sigCount === 1 ? "borderline" : "noise";
    const recommendation = verdict === "useful" ? "keep" : verdict === "borderline" ? "monitor" : "drop — no signal across 3 independent methods";
    return { feature: name, waldSig, permSig, mdiRank, mdaRank, waldRank, combinedScore, verdict, recommendation };
  }).sort((a, b) => a.combinedScore - b.combinedScore);

  const metaModel = {
    accuracy: metaResult.accuracy,
    brierScore: metaResult.brierScore,
    aucROC: metaAUC,
    precision: metaResult.precision,
    recall: metaResult.recall,
    f1Score: metaResult.f1Score,
    prAUC: metaResult.prAUC,
    optimalThreshold: metaResult.optimalThreshold,
    precisionAtThreshold: metaResult.precisionAtThreshold,
    recallAtThreshold: metaResult.recallAtThreshold,
    f1AtThreshold: metaResult.f1AtThreshold,
    avgUniqueness: uniqueness.reduce((a, b) => a + b, 0) / Math.max(1, uniqueness.length),
    samples: tbTotal,
    barrierHitRate: tbTotal > 0 ? (tbUp + tbDown) / tbTotal : 0,
    oosThreshold: oosRaw.threshold,
    oosF1: oosRaw.f1,
    oosPrecision: oosRaw.prec,
    oosRecall: oosRaw.rec,
    oosF1AtTrainThreshold,
    oosPrecisionAtTrainThreshold: oosPrecAtTrainThreshold,
    oosRecallAtTrainThreshold: oosRecAtTrainThreshold,
    calibrationPerRegime: metaCalibrationPerRegime,
    isotonicBrier: brierIsotonic,
    plattBrier: brierPlatt,
    isotonicOosF1: oosIsotonic.f1,
    plattOosF1: oosPlatt.f1,
    isotonicThreshold: oosIsotonic.threshold,
    plattThreshold: oosPlatt.threshold,
    nestedCVF1: nestedAvgF1,
    nestedCVResults: nestedResults,
    aucROCLift,
    prAUCLift,
    aucEffectSize,
    prEffectSize,
    f1EffectSize,
    calibratedCalibrationPerRegime,
    dynamicBarrierMetaModel: {
      accuracy: raMetaResult.accuracy,
      brierScore: raMetaResult.brierScore,
      aucROC: raMetaAUC,
      f1Score: raMetaResult.f1Score,
      prAUC: raMetaResult.prAUC,
      optimalThreshold: raMetaResult.optimalThreshold,
      description: `Meta-model trained with return-attribution weights (uniqueness × |return|). AUC ${raMetaAUC.toFixed(3)} vs uniqueness-only ${metaAUC.toFixed(3)}. F1 ${raMetaResult.f1Score.toFixed(2)} vs ${metaResult.f1Score.toFixed(2)}.`,
    },
    description: oosF1AtTrainThreshold > 0.3 ? `Meta-model OOS F1=${oosF1AtTrainThreshold.toFixed(2)} (train threshold ${trainMeta.optimalThreshold.toFixed(2)} → test)` : nestedAvgF1 > 0.15 ? `Meta-model weak OOS (nested CV F1=${nestedAvgF1.toFixed(2)}, isotonic F1=${oosIsotonic.f1.toFixed(2)})` : `Meta-model no OOS value (nested CV F1=${nestedAvgF1.toFixed(2)}, raw F1=${oosRaw.f1.toFixed(2)})`,
  };

  return {
    probability, probabilityPct, direction, confidence,
    features: currentFeatures,
    modelAccuracy: model.accuracy,
    brierScore: model.brierScore,
    calibration: model.calibration,
    calibrationPerRegime: model.calibrationPerRegime,
    featureImportance: model.featureImportance,
    ablation: model.ablation,
    permutationImportance: model.permutationImportance,
    mdiImportance,
    mdaImportance,
    featureSelection,
    aucROC: model.aucROC,
    aucPR: model.aucPR,
    lrStat: model.lrStat,
    lrDF: model.lrDF,
    lrPValue: model.lrPValue,
    tripleBarrier,
    dynamicTripleBarrier,
    returnAttribution,
    metaModel,
    trainingSamples: featureList.length,
    description,
  };
}
