// Per-edge circuit breaker — finer granularity than per-pair.
//
// Tracks consecutive losses for a specific (pair × edge_source) combination.
// E.g., BTC funding_contrarian can trip independently of BTC trend_follow.
// This catches edge-specific degradation that the per-pair CB would miss.
//
// Edge sources (from alpha-engine):
//   - funding_contrarian (extreme funding → fade)
//   - trend_follow (ADX > 25 → ride trend)
//   - mean_revert (ADX < 20 → fade extremes)
//   - absorption_reversal (microstructure absorption detected)
//
// Same exponential cooldown as per-pair CB: 1h → 2h → 4h → 8h (capped).

import { db } from "@/lib/db";
import { wilsonCI, bootstrapWinRateCI } from "./alpha-circuit-breaker";

const EDGE_CB_THRESHOLD = 3;          // consecutive losses to trip
const EDGE_CB_BASE_COOLDOWN_SEC = 3600;
const EDGE_CB_MAX_COOLDOWN_SEC = 28800;

// Per-edge recovery ramp stages (mirrors portfolio ramp).
// When an edge CB trips and then recovers (half-open probe wins), the edge's
// risk multiplier ramps back up over 7 days to prevent immediate full-size resumption.
const EDGE_RAMP_STAGES = [
  { maxAgeSec: 86400,  multiplier: 0.25, stage: 1, label: "probe" },     // 0-24h
  { maxAgeSec: 259200, multiplier: 0.50, stage: 2, label: "cautious" },  // 24-72h
  { maxAgeSec: 604800, multiplier: 0.75, stage: 3, label: "steady" },    // 72-168h
  { maxAgeSec: Infinity, multiplier: 1.00, stage: 4, label: "full" },    // >168h
] as const;

export interface EdgeCircuitBreakerState {
  pair: string;
  edgeSource: string;
  open: boolean;
  consecutiveLosses: number;
  totalSignals: number;
  totalWins: number;
  totalLosses: number;
  winRate: number;
  winRateCI5: number;
  winRateCI95: number;
  winRateBootstrapCI5: number;
  winRateBootstrapCI95: number;
  openUntil: number | null;
  trips: number;
  cooldownSec: number;
  lastSignalOutcome: string | null;
  // Per-edge recovery ramp state
  edgeRecoveryStartedAt: number | null;
  edgeRecoveryStage: number;
  edgeRecoveryStageLabel: string;
  edgeRecoveryMultiplierCap: number;
  edgeRecoveryAgeHours: number;
}

export async function getEdgeCircuitBreaker(pair: string, edgeSource: string): Promise<EdgeCircuitBreakerState> {
  const now = Math.floor(Date.now() / 1000);
  const row = await db.alphaEdgeCircuitBreaker.upsert({
    where: { pair_edgeSource: { pair, edgeSource } },
    create: { pair, edgeSource },
    update: {},
  });

  const winRate = row.totalSignals > 0 ? row.totalWins / row.totalSignals : 0;
  const [ci5, ci95] = wilsonCI(row.totalWins, row.totalSignals);
  const [bootCI5, bootCI95] = row.totalSignals >= 5
    ? bootstrapWinRateCI(row.totalWins, row.totalSignals)
    : [0, 0];
  const open = row.circuitOpen && (row.circuitOpenUntil ?? 0) > now;

  // Compute ramp stage from persisted state
  let edgeRecoveryStage = 0;
  let edgeRecoveryStageLabel = "none";
  let edgeRecoveryMultiplierCap = 1.0;
  let edgeRecoveryAgeHours = 0;
  if (row.edgeRecoveryStartedAt) {
    const rampAgeSec = now - row.edgeRecoveryStartedAt;
    edgeRecoveryAgeHours = rampAgeSec / 3600;
    const stage = EDGE_RAMP_STAGES.find((s) => rampAgeSec <= s.maxAgeSec) ?? EDGE_RAMP_STAGES[EDGE_RAMP_STAGES.length - 1];
    edgeRecoveryStage = stage.stage;
    edgeRecoveryMultiplierCap = stage.multiplier;
    edgeRecoveryStageLabel = stage.label;
  }

  return {
    pair,
    edgeSource,
    open,
    consecutiveLosses: row.consecutiveLosses,
    totalSignals: row.totalSignals,
    totalWins: row.totalWins,
    totalLosses: row.totalLosses,
    winRate,
    winRateCI5: ci5,
    winRateCI95: ci95,
    winRateBootstrapCI5: bootCI5,
    winRateBootstrapCI95: bootCI95,
    openUntil: row.circuitOpenUntil,
    trips: row.circuitTrips,
    cooldownSec: row.circuitOpenUntil ? row.circuitOpenUntil - now : 0,
    lastSignalOutcome: row.lastSignalOutcome,
    edgeRecoveryStartedAt: row.edgeRecoveryStartedAt,
    edgeRecoveryStage,
    edgeRecoveryStageLabel,
    edgeRecoveryMultiplierCap,
    edgeRecoveryAgeHours,
  };
}

// Record an outcome for a specific (pair × edgeSource) CB.
export async function recordEdgeSignalOutcome(
  pair: string,
  edgeSource: string,
  won: boolean,
): Promise<void> {
  const row = await db.alphaEdgeCircuitBreaker.upsert({
    where: { pair_edgeSource: { pair, edgeSource } },
    create: { pair, edgeSource },
    update: {},
  });

  const now = Math.floor(Date.now() / 1000);
  const newConsecutiveLosses = won ? 0 : row.consecutiveLosses + 1;
  const newTotal = row.totalSignals + 1;
  const newWins = row.totalWins + (won ? 1 : 0);

  let circuitOpen = row.circuitOpen;
  let circuitOpenUntil = row.circuitOpenUntil;
  let circuitTrips = row.circuitTrips;
  let trippedThisCall = false;
  let trippedCooldownSec = 0;

  // Per-edge recovery ramp state
  let edgeRecoveryStartedAt = row.edgeRecoveryStartedAt;
  let edgeRecoveryStage = row.edgeRecoveryStage;
  let edgeRecoveryMultiplierCap = row.edgeRecoveryMultiplierCap;

  if (newConsecutiveLosses >= EDGE_CB_THRESHOLD && !circuitOpen) {
    circuitOpen = true;
    circuitTrips = row.circuitTrips + 1;
    const cooldownSec = Math.min(
      EDGE_CB_BASE_COOLDOWN_SEC * Math.pow(2, circuitTrips - 1),
      EDGE_CB_MAX_COOLDOWN_SEC,
    );
    circuitOpenUntil = now + Math.floor(cooldownSec);
    trippedThisCall = true;
    trippedCooldownSec = cooldownSec;
    // Reset ramp when tripped
    edgeRecoveryStartedAt = null;
    edgeRecoveryStage = 0;
    edgeRecoveryMultiplierCap = 1.0;
  }

  // If circuit was open and this signal won → close the circuit + START RAMP
  if (row.circuitOpen && won) {
    circuitOpen = false;
    circuitOpenUntil = null;
    // Start recovery ramp
    edgeRecoveryStartedAt = now;
    edgeRecoveryStage = 1;
    edgeRecoveryMultiplierCap = 0.25;
  }

  // Check if ramp should advance (based on age)
  if (edgeRecoveryStartedAt && !circuitOpen) {
    const rampAgeSec = now - edgeRecoveryStartedAt;
    const stage = EDGE_RAMP_STAGES.find((s) => rampAgeSec <= s.maxAgeSec) ?? EDGE_RAMP_STAGES[EDGE_RAMP_STAGES.length - 1];
    edgeRecoveryStage = stage.stage;
    edgeRecoveryMultiplierCap = stage.multiplier;
    // If ramp completed (stage 4), clear recovery markers
    if (edgeRecoveryStage === 4) {
      edgeRecoveryStartedAt = null;
      edgeRecoveryStage = 0;
      edgeRecoveryMultiplierCap = 1.0;
    }
  }

  await db.alphaEdgeCircuitBreaker.update({
    where: { id: row.id },
    data: {
      consecutiveLosses: newConsecutiveLosses,
      totalSignals: newTotal,
      totalWins: newWins,
      totalLosses: row.totalLosses + (won ? 0 : 1),
      circuitOpen,
      circuitOpenUntil,
      circuitTrips,
      lastSignalAt: now,
      lastSignalOutcome: won ? "win" : "loss",
      edgeRecoveryStartedAt,
      edgeRecoveryStage,
      edgeRecoveryMultiplierCap,
    },
  });

  if (trippedThisCall) {
    try {
      const { dispatchSignalEvent } = await import("./signal-alerts");
      await dispatchSignalEvent({
        type: "circuit_tripped",
        severity: "critical",
        pair,
        message: `🚨 [CRITICAL] EDGE CIRCUIT TRIPPED: ${pair.toUpperCase()} · ${edgeSource}\n\n${newConsecutiveLosses} consecutive losses on this edge.\nTotal trips: ${circuitTrips}.\nCooldown: ${Math.floor(trippedCooldownSec / 60)} minutes.\nThis edge may have degraded — investigate before resuming.\n\n_${new Date().toISOString()}_`,
        metadata: { layer: "edge_cb", pair, edgeSource, consecutiveLosses: newConsecutiveLosses, trips: circuitTrips, cooldownSec: trippedCooldownSec },
      });
    } catch { /* ignore */ }
  }
}

// Get all edge CBs for a pair (or all pairs).
export async function getAllEdgeCircuitBreakers(): Promise<EdgeCircuitBreakerState[]> {
  const pairs = ["btc_idr", "eth_idr", "sol_idr", "bnb_idr", "xrp_idr"];
  const edgeSources = ["funding_contrarian", "trend_follow", "mean_revert", "absorption_reversal"];
  const result: EdgeCircuitBreakerState[] = [];
  for (const pair of pairs) {
    for (const edge of edgeSources) {
      try {
        const state = await getEdgeCircuitBreaker(pair, edge);
        if (state.totalSignals > 0 || state.open) {
          result.push(state);
        }
      } catch { /* ignore */ }
    }
  }
  return result;
}
