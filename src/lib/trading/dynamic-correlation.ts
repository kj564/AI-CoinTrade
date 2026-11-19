// Dynamic correlation matrix computed from rolling 30-day returns.
//
// The static matrix in correlation-matrix.ts is a reasonable fallback, but
// correlations drift over time (BTC/ETH was 0.95 in 2022, ~0.80 in 2024).
// This module fetches actual 1h candles for each pair, computes daily returns,
// then Pearson correlation between each pair's return series.
//
// Caching: the computed matrix is cached in-memory for 1 hour. The first
// call after cache expiry triggers a recompute (fetches 30d × 5 pairs = 150
// API calls to Binance, ~5-10 seconds). Subsequent calls within the hour
// return the cached matrix.
//
// Fallback: if Binance fetch fails for any pair, the static matrix from
// correlation-matrix.ts is used for that pair.

import { getBinanceKlinesWithMeta } from "./binance-klines";
import { getCorrelationMatrix as getStaticMatrix } from "./correlation-matrix";

const PAIRS = ["btc_idr", "eth_idr", "sol_idr", "bnb_idr", "xrp_idr"];
const CACHE_TTL_SEC = 3600; // 1 hour
const ROLLING_WINDOW_DAYS = 30;

interface CachedMatrix {
  matrix: Record<string, Record<string, number>>;
  computedAt: number; // unix sec
  source: "dynamic" | "static_fallback";
  sampleSize: number;
  pairsUsed: string[];
  shrinkageIntensity: number;  // Ledoit-Wolf δ* (0 = no shrinkage, 1 = full shrink to identity)
  rawMatrix: Record<string, Record<string, number>> | null;  // unshrunk for comparison
}

let cached: CachedMatrix | null = null;

// Compute daily returns from 1h candles.
// Resample 1h → 1d (take last close of each UTC day), then compute log returns.
function computeDailyReturns(candles1h: { time: number; close: number }[]): number[] {
  if (candles1h.length === 0) return [];
  // Group by UTC day, take last close
  const dayMap = new Map<number, number>();
  for (const c of candles1h) {
    const dayBucket = Math.floor(c.time / 86400) * 86400;
    dayMap.set(dayBucket, c.close); // last write wins = last hour of the day
  }
  const dailyCloses = Array.from(dayMap.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([, close]) => close);
  // Compute log returns
  const returns: number[] = [];
  for (let i = 1; i < dailyCloses.length; i++) {
    if (dailyCloses[i - 1] > 0) {
      returns.push(Math.log(dailyCloses[i] / dailyCloses[i - 1]));
    }
  }
  return returns;
}

// ── LEDOIT-WOLF SHRINKAGE ESTIMATOR ──
// Shrinks the sample correlation matrix toward the identity matrix (diagonal=1,
// off-diagonal=0 = "independence"). This reduces noise when the sample size is
// small relative to the number of assets (n < 5×p).
//
// Formula (Ledoit & Wolf 2004, "Honey, I Shrunk the Sample Covariance Matrix"):
//   Σ* = δ* × F + (1 - δ*) × S
//   where S = sample correlation matrix, F = identity target
//   δ* = (π̂ - ρ̂) / (γ̂ - ρ̂) clamped to [0, 1]
//     π̂ = sum of variances of √n × s_ij (noise in S entries)
//     ρ̂ = sum of covariances between √n × s_ij and √n × f_ij (= 0 for identity target)
//     γ̂ = sum of squared differences between S and F = Σ(s_ij² - 2s_ij + 1) for off-diag
//
// Returns { shrunkMatrix, shrinkageIntensity }.
function ledoitWolfShrinkage(
  rawMatrix: Record<string, Record<string, number>>,
  pairs: string[],
  n: number, // sample size (number of daily returns)
): { shrunkMatrix: Record<string, Record<string, number>>; shrinkageIntensity: number } {
  const p = pairs.length;
  if (p === 0 || n === 0) return { shrunkMatrix: rawMatrix, shrinkageIntensity: 0 };

  // For identity target:
  // γ̂ = Σ_ij (s_ij - f_ij)² where f_ii=1, f_ij=0 (i≠j)
  //    = Σ_i (s_ii - 1)² + Σ_{i≠j} s_ij²
  //    = 0 + Σ_{i≠j} s_ij²  (since s_ii = 1 for correlation matrix)
  let gamma = 0;
  for (const a of pairs) {
    for (const b of pairs) {
      if (a === b) continue;
      const s = rawMatrix[a]?.[b] ?? 0;
      gamma += s * s;
    }
  }

  // π̂ = Σ_ij variance of √n × s_ij. For Pearson correlation, the asymptotic
  // variance of s_ij is approximately (1 - s_ij²)² / n. So variance of √n × s_ij
  // is (1 - s_ij²)². Sum over all i≤j entries (i<j for off-diagonal, diagonal is 0).
  let pi = 0;
  for (const a of pairs) {
    for (const b of pairs) {
      if (a >= b) continue; // upper triangle only (i < j)
      const s = rawMatrix[a]?.[b] ?? 0;
      pi += Math.pow(1 - s * s, 2);
    }
  }
  pi *= 2; // symmetric — count both (i,j) and (j,i)

  // ρ̂ = 0 for identity target (F has no off-diagonal structure to covary with S)
  const rho = 0;

  // δ* = (π̂ - ρ̂) / (γ̂ - ρ̂) / n, clamped to [0, 1]
  // Note: π̂ and γ̂ are already normalized per-entry; divide by n for the ratio.
  let delta = (pi - rho) / (n * (gamma - rho));
  delta = Math.max(0, Math.min(1, delta));

  // Apply shrinkage: Σ* = δ × I + (1 - δ) × S
  const shrunkMatrix: Record<string, Record<string, number>> = {};
  for (const a of pairs) {
    shrunkMatrix[a] = {};
    for (const b of pairs) {
      if (a === b) {
        shrunkMatrix[a][b] = 1.0; // diagonal is always 1
      } else {
        const s = rawMatrix[a]?.[b] ?? 0;
        shrunkMatrix[a][b] = delta * 0 + (1 - delta) * s; // shrink toward 0 (independence)
      }
    }
  }

  return { shrunkMatrix, shrinkageIntensity: delta };
}

// Pearson correlation between two return series (aligned by index).
function pearsonCorrelation(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 5) return 0; // need at least 5 overlapping data points
  const aSlice = a.slice(a.length - n);
  const bSlice = b.slice(b.length - n);
  const meanA = aSlice.reduce((x, y) => x + y, 0) / n;
  const meanB = bSlice.reduce((x, y) => x + y, 0) / n;
  let num = 0, denA = 0, denB = 0;
  for (let i = 0; i < n; i++) {
    const da = aSlice[i] - meanA;
    const db = bSlice[i] - meanB;
    num += da * db;
    denA += da * da;
    denB += db * db;
  }
  const den = Math.sqrt(denA * denB);
  if (den === 0) return 0;
  return Math.max(-1, Math.min(1, num / den));
}

// Fetch 30d of 1h candles for all pairs and compute correlation matrix.
// Returns the dynamic matrix + metadata. Falls back to static on failure.
export async function computeDynamicCorrelationMatrix(): Promise<CachedMatrix> {
  const nowSec = Math.floor(Date.now() / 1000);
  if (cached && (nowSec - cached.computedAt) < CACHE_TTL_SEC) {
    return cached;
  }

  // Fetch 30d of 1h candles for each pair (30 * 24 = 720 candles)
  const candleCount = ROLLING_WINDOW_DAYS * 24;
  const returnsByPair = new Map<string, number[]>();
  const pairsUsed: string[] = [];

  await Promise.all(PAIRS.map(async (pair) => {
    try {
      const result = await getBinanceKlinesWithMeta(pair, "1h", candleCount);
      if (result.candles.length >= 100) {
        const returns = computeDailyReturns(result.candles.map((c) => ({ time: c.time, close: c.close })));
        if (returns.length >= 5) {
          returnsByPair.set(pair, returns);
          pairsUsed.push(pair);
        }
      }
    } catch (e) {
      console.warn(`[dynamic-corr] fetch failed for ${pair}:`, e instanceof Error ? e.message : e);
    }
  }));

  // If we got fewer than 3 pairs, fall back to static
  if (pairsUsed.length < 3) {
    console.warn(`[dynamic-corr] only ${pairsUsed.length} pairs fetched, falling back to static matrix`);
    const staticMatrix = getStaticMatrix();
    cached = {
      matrix: staticMatrix,
      computedAt: nowSec,
      source: "static_fallback",
      sampleSize: 0,
      pairsUsed: [],
    };
    return cached;
  }

  // Build dynamic matrix — use computed correlations for pairs we have data for,
  // fall back to static for any missing pair.
  const staticMatrix = getStaticMatrix();
  const rawMatrix: Record<string, Record<string, number>> = {};

  for (const pairA of PAIRS) {
    rawMatrix[pairA] = {};
    for (const pairB of PAIRS) {
      if (pairA === pairB) {
        rawMatrix[pairA][pairB] = 1.0;
      } else if (returnsByPair.has(pairA) && returnsByPair.has(pairB)) {
        rawMatrix[pairA][pairB] = pearsonCorrelation(returnsByPair.get(pairA)!, returnsByPair.get(pairB)!);
      } else {
        // Fall back to static for pairs missing dynamic data
        rawMatrix[pairA][pairB] = staticMatrix[pairA]?.[pairB] ?? 0;
      }
    }
  }

  // Apply Ledoit-Wolf shrinkage toward identity matrix to reduce noise.
  // Shrinkage is most impactful when n (sample size) is small relative to p² (pairs²).
  // With n=29 and p=5, shrinkage intensity is typically 0.05-0.15.
  const sampleN = returnsByPair.get(PAIRS[0])?.length ?? 0;
  const { shrunkMatrix: matrix, shrinkageIntensity } = ledoitWolfShrinkage(rawMatrix, PAIRS, sampleN);

  cached = {
    matrix,
    computedAt: nowSec,
    source: "dynamic",
    sampleSize: sampleN,
    pairsUsed,
    shrinkageIntensity,
    rawMatrix,
  };
  console.log(`[dynamic-corr] computed matrix from ${pairsUsed.length} pairs, ${sampleN} daily returns each, shrinkage δ*=${shrinkageIntensity.toFixed(3)}`);
  return cached;
}

// Convenience: get the correlation between two pairs (dynamic + shrunk if cached, static otherwise).
export async function getDynamicCorrelation(pairA: string, pairB: string): Promise<number> {
  const { matrix } = await computeDynamicCorrelationMatrix();
  return matrix[pairA]?.[pairB] ?? 0;
}

// Get cache status for UI / debugging.
export function getCorrelationCacheStatus(): {
  cached: boolean; ageSec: number; source: string; sampleSize: number;
  shrinkageIntensity: number;
} {
  if (!cached) return { cached: false, ageSec: 0, source: "none", sampleSize: 0, shrinkageIntensity: 0 };
  return {
    cached: true,
    ageSec: Math.floor(Date.now() / 1000) - cached.computedAt,
    source: cached.source,
    sampleSize: cached.sampleSize,
    shrinkageIntensity: cached.shrinkageIntensity,
  };
}
