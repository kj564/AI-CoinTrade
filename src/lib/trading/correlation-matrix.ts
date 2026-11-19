// Correlation-aware position sizing (concentration risk management).
//
// Problem: if you have LONG BTC and LONG ETH simultaneously, your effective
// risk is higher than the sum because BTC and ETH are highly correlated
// (historical ρ ≈ 0.85). A single market move can hit both stops.
//
// Solution: when sizing a new position, check what's already open and apply
// a "concentration penalty" that reduces size based on correlated exposure.
//
// Static correlation matrix (from 2024-2025 crypto market data, approximate):
//              BTC    ETH    SOL    BNB    XRP
//   BTC        1.00   0.85   0.72   0.78   0.65
//   ETH        0.85   1.00   0.80   0.75   0.68
//   SOL        0.72   0.80   1.00   0.65   0.70
//   BNB        0.78   0.75   0.65   1.00   0.60
//   XRP        0.65   0.68   0.70   0.60   1.00
//
// Effective exposure formula:
//   effectiveExposure = sum(open_position_size_i × |correlation(new, i)|)
//   concentrationPenalty = max(0, 1 - effectiveExposure / maxExposure)
//
// Where maxExposure = 1.0 (100% of capital in correlated positions).
// If effectiveExposure >= 1.0, concentrationPenalty = 0 (no new position).

import { db } from "@/lib/db";

// Static correlation matrix keyed by pair name.
// These are approximations from 2024-2025 daily return correlations.
// Used as fallback when dynamic computation fails (Binance API down, etc.).
// In production, dynamic-correlation.ts computes the real matrix from 30d returns.
const STATIC_CORRELATION_MATRIX: Record<string, Record<string, number>> = {
  btc_idr: { btc_idr: 1.00, eth_idr: 0.85, sol_idr: 0.72, bnb_idr: 0.78, xrp_idr: 0.65 },
  eth_idr: { btc_idr: 0.85, eth_idr: 1.00, sol_idr: 0.80, bnb_idr: 0.75, xrp_idr: 0.68 },
  sol_idr: { btc_idr: 0.72, eth_idr: 0.80, sol_idr: 1.00, bnb_idr: 0.65, xrp_idr: 0.70 },
  bnb_idr: { btc_idr: 0.78, eth_idr: 0.75, sol_idr: 0.65, bnb_idr: 1.00, xrp_idr: 0.60 },
  xrp_idr: { btc_idr: 0.65, eth_idr: 0.68, sol_idr: 0.70, bnb_idr: 0.60, xrp_idr: 1.00 },
};

export const MAX_CORRELATED_EXPOSURE = 1.0; // 100% of capital

// Synchronous accessor — returns the STATIC matrix (used by routes that can't await).
export function getCorrelation(pairA: string, pairB: string): number {
  return STATIC_CORRELATION_MATRIX[pairA]?.[pairB] ?? 0;
}

export function getCorrelationMatrix(): Record<string, Record<string, number>> {
  return STATIC_CORRELATION_MATRIX;
}

// Async accessor — returns the DYNAMIC matrix if cached, else static.
// Use this from async contexts (alpha-engine, API routes) for accurate correlations.
export async function getDynamicCorrelationMatrix(): Promise<{
  matrix: Record<string, Record<string, number>>;
  source: "dynamic" | "static_fallback";
  sampleSize: number;
  ageSec: number;
}> {
  try {
    const { computeDynamicCorrelationMatrix } = await import("./dynamic-correlation");
    const cached = await computeDynamicCorrelationMatrix();
    return {
      matrix: cached.matrix,
      source: cached.source as "dynamic" | "static_fallback",
      sampleSize: cached.sampleSize,
      ageSec: Math.floor(Date.now() / 1000) - cached.computedAt,
    };
  } catch (e) {
    console.warn("[correlation-matrix] dynamic fetch failed, using static:", e instanceof Error ? e.message : e);
    return { matrix: STATIC_CORRELATION_MATRIX, source: "static_fallback", sampleSize: 0, ageSec: 0 };
  }
}

export interface OpenPosition {
  pair: string;
  action: string;       // LONG | SHORT
  positionSizeIdr: number;
  notionalIdr: number;
}

export interface ConcentrationPenaltyResult {
  penalty: number;            // 0.0 → 1.0 (multiply position size by this)
  effectiveExposure: number;  // sum of |corr| × open_size
  openPositions: OpenPosition[];
  correlatedWith: { pair: string; corr: number; sizeIdr: number }[];
  maxExposure: number;
  reason: string;
}

// Compute concentration penalty for a new position in `newPair`.
// Reads open positions from SignalJournal.
// Uses DYNAMIC correlation matrix (from 30d rolling returns) if available,
// falls back to static matrix on failure.
// Returns penalty (0.0 = block, 1.0 = no penalty) + diagnostics.
export async function computeConcentrationPenalty(
  newPair: string,
  newAction: string,
  capitalIdr: number,
): Promise<ConcentrationPenaltyResult> {
  // Fetch open positions from journal
  const openSignals = await db.signalJournal.findMany({
    where: { status: "open" },
  });

  const openPositions: OpenPosition[] = openSignals.map((s) => ({
    pair: s.pair,
    action: s.action,
    positionSizeIdr: s.positionSizeIdr,
    notionalIdr: s.positionSizeIdr, // approximate (actual notional may differ)
  }));

  if (openPositions.length === 0) {
    return {
      penalty: 1.0,
      effectiveExposure: 0,
      openPositions: [],
      correlatedWith: [],
      maxExposure: MAX_CORRELATED_EXPOSURE,
      reason: "no open positions — no concentration penalty",
    };
  }

  // Use dynamic correlation matrix (falls back to static on failure)
  const { matrix: dynamicMatrix, source } = await getDynamicCorrelationMatrix();

  // Compute effective exposure: sum of |correlation(new, open_i)| × (open_size / capital)
  // Only count positions in the SAME direction (LONG+LONG or SHORT+SHORT add risk;
  // LONG+SHORT are hedging, so they reduce effective exposure).
  let effectiveExposure = 0;
  const correlatedWith: { pair: string; corr: number; sizeIdr: number }[] = [];

  for (const op of openPositions) {
    const corr = dynamicMatrix[newPair]?.[op.pair] ?? getCorrelation(newPair, op.pair);
    const sizeFraction = op.positionSizeIdr / capitalIdr;
    // Same direction → add exposure. Opposite direction → subtract (hedge).
    const sameDirection = (op.action === newAction);
    const signedCorr = sameDirection ? Math.abs(corr) : -Math.abs(corr);
    effectiveExposure += signedCorr * sizeFraction;
    if (Math.abs(corr) > 0.5) {
      correlatedWith.push({ pair: op.pair, corr, sizeIdr: op.positionSizeIdr });
    }
  }

  // Clamp exposure to >= 0 (can't go negative — that would mean perfect hedge)
  effectiveExposure = Math.max(0, effectiveExposure);

  // Penalty = how much room is left before hitting maxExposure
  // If effectiveExposure = 0.5 and maxExposure = 1.0, penalty = 0.5 (halve new size)
  // If effectiveExposure >= 1.0, penalty = 0 (block new position)
  const roomLeft = Math.max(0, MAX_CORRELATED_EXPOSURE - effectiveExposure);
  // Scale room by how correlated the new pair is with existing positions
  // (if new pair has 0 correlation, no penalty even if exposure is high)
  const maxCorrWithOpen = correlatedWith.length > 0
    ? Math.max(...correlatedWith.map((c) => Math.abs(c.corr)))
    : 0;
  const penalty = maxCorrWithOpen > 0
    ? Math.min(1.0, roomLeft / Math.max(maxCorrWithOpen, 0.1))
    : 1.0;

  const matrixSource = source === "dynamic" ? "dynamic (30d rolling)" : "static fallback";
  const reason = effectiveExposure >= MAX_CORRELATED_EXPOSURE
    ? `BLOCKED: effective exposure ${effectiveExposure.toFixed(2)} >= max ${MAX_CORRELATED_EXPOSURE} [${matrixSource}]. New ${newPair} position would over-concentrate correlated risk.`
    : effectiveExposure > 0.3
      ? `REDUCED: effective exposure ${effectiveExposure.toFixed(2)} (max corr ${maxCorrWithOpen.toFixed(2)} with open positions, ${matrixSource}). Penalty ${penalty.toFixed(2)}x.`
      : `OK: effective exposure ${effectiveExposure.toFixed(2)} (low, ${matrixSource}). No penalty.`;

  return {
    penalty: Math.max(0, Math.min(1, penalty)),
    effectiveExposure,
    openPositions,
    correlatedWith,
    maxExposure: MAX_CORRELATED_EXPOSURE,
    reason,
  };
}
