// Alpha signal circuit breaker — per-pair consecutive loss tracking.
//
// P7: If a pair generates 3 consecutive OOS-validated losing signals, the
// circuit trips and suppresses signals for that pair for a cooldown period
// (exponential: 1h → 2h → 4h → 8h, capped at 8h).
//
// This prevents the system from repeatedly generating losing signals for a
// pair whose edge has degraded. The circuit auto-resets after cooldown with
// a half-open probe (one signal allowed; if it wins, circuit closes; if it
// loses, circuit re-opens with longer cooldown).

import { db } from "@/lib/db";

const CB_THRESHOLD = 3;          // consecutive losses to trip
const CB_BASE_COOLDOWN_SEC = 3600; // 1 hour
const CB_MAX_COOLDOWN_SEC = 28800;  // 8 hours

export interface CircuitBreakerState {
  pair: string;
  open: boolean;
  consecutiveLosses: number;
  totalSignals: number;
  winRate: number;
  openUntil: number | null;     // unix sec
  trips: number;
  cooldownSec: number;
}

export async function getCircuitBreaker(pair: string): Promise<CircuitBreakerState> {
  const now = Math.floor(Date.now() / 1000);
  const row = await db.alphaCircuitBreaker.upsert({
    where: { pair },
    create: { pair },
    update: {},
  });

  // Check if cooldown has expired → half-open probe
  const open = row.circuitOpen && (row.circuitOpenUntil ?? 0) > now;
  return {
    pair,
    open,
    consecutiveLosses: row.consecutiveLosses,
    totalSignals: row.totalSignals,
    winRate: row.totalSignals > 0 ? row.totalWins / row.totalSignals : 0,
    openUntil: row.circuitOpenUntil,
    trips: row.circuitTrips,
    cooldownSec: row.circuitOpenUntil ? row.circuitOpenUntil - now : 0,
  };
}

// Record a signal outcome (win/loss). Called when a signal's OOS result is known.
export async function recordSignalOutcome(pair: string, action: string, won: boolean): Promise<void> {
  const row = await db.alphaCircuitBreaker.upsert({
    where: { pair },
    create: { pair },
    update: {},
  });

  const now = Math.floor(Date.now() / 1000);
  const newConsecutiveLosses = won ? 0 : row.consecutiveLosses + 1;
  const newTotal = row.totalSignals + 1;
  const newWins = row.totalWins + (won ? 1 : 0);
  const newLosses = row.totalLosses + (won ? 0 : 1);

  // Trip the circuit if threshold reached
  let circuitOpen = row.circuitOpen;
  let circuitOpenedAt = row.circuitOpenedAt;
  let circuitOpenUntil = row.circuitOpenUntil;
  let circuitTrips = row.circuitTrips;

  if (newConsecutiveLosses >= CB_THRESHOLD && !circuitOpen) {
    circuitOpen = true;
    circuitOpenedAt = now;
    circuitTrips = row.circuitTrips + 1;
    // Exponential cooldown: base * 2^(trips-1), capped
    const cooldownSec = Math.min(CB_BASE_COOLDOWN_SEC * Math.pow(2, circuitTrips - 1), CB_MAX_COOLDOWN_SEC);
    circuitOpenUntil = now + Math.floor(cooldownSec);
    console.warn(`[alpha-cb] CIRCUIT TRIPPED for ${pair}: ${newConsecutiveLosses} consecutive losses. Cooldown ${cooldownSec}s. Trips: ${circuitTrips}`);
  }

  // If circuit was open and this signal won → close the circuit (half-open success)
  if (row.circuitOpen && won) {
    circuitOpen = false;
    circuitOpenedAt = null;
    circuitOpenUntil = null;
    console.log(`[alpha-cb] CIRCUIT CLOSED for ${pair}: half-open probe succeeded`);
  }

  await db.alphaCircuitBreaker.update({
    where: { pair },
    data: {
      consecutiveLosses: newConsecutiveLosses,
      totalSignals: newTotal,
      totalWins: newWins,
      totalLosses: newLosses,
      circuitOpen,
      circuitOpenedAt,
      circuitOpenUntil,
      circuitTrips,
      lastSignalAt: now,
      lastSignalAction: action,
      lastSignalOutcome: won ? "win" : "loss",
    },
  });
}

// Reset a pair's circuit breaker (manual override).
export async function resetCircuitBreaker(pair: string): Promise<void> {
  await db.alphaCircuitBreaker.update({
    where: { pair },
    data: {
      consecutiveLosses: 0,
      circuitOpen: false,
      circuitOpenedAt: null,
      circuitOpenUntil: null,
    },
  }).catch(() => {});
}
