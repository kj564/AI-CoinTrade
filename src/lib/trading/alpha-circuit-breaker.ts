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
  // Wilson score 95% CI for win rate — honest when sample is small
  winRateCI5: number;
  winRateCI95: number;
  ciWidth: number;
  ciSampleAdequate: boolean;    // true when n >= 20 (CI width < ~0.4)
}

// Wilson score interval for a binomial proportion (win rate).
// More honest than naive p = wins/n when n is small.
// Returns [lower95, upper95].
export function wilsonCI(wins: number, n: number, z = 1.96): [number, number] {
  if (n === 0) return [0, 0];
  const p = wins / n;
  const denom = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n)) / denom;
  return [Math.max(0, center - margin), Math.min(1, center + margin)];
}

// Bootstrap CI for win rate (non-parametric, 1000 resamples with replacement).
// More honest than Wilson when the win/loss distribution is skewed or when
// there's serial correlation in signal outcomes. Returns [lower95, upper95].
const BOOTSTRAP_SAMPLES = 1000;
export function bootstrapWinRateCI(wins: number, n: number, samples = BOOTSTRAP_SAMPLES): [number, number] {
  if (n === 0) return [0, 0];
  // Build a binary outcomes array [1, 0, 1, 1, 0, ...]
  const outcomes: number[] = [];
  for (let i = 0; i < n; i++) outcomes.push(i < wins ? 1 : 0);
  const bootstrapRates: number[] = [];
  for (let s = 0; s < samples; s++) {
    let sum = 0;
    for (let i = 0; i < n; i++) {
      sum += outcomes[Math.floor(Math.random() * n)];
    }
    bootstrapRates.push(sum / n);
  }
  bootstrapRates.sort((a, b) => a - b);
  const ci5Idx = Math.floor(0.05 * samples);
  const ci95Idx = Math.floor(0.95 * samples);
  return [bootstrapRates[ci5Idx], bootstrapRates[ci95Idx]];
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
  const winRate = row.totalSignals > 0 ? row.totalWins / row.totalSignals : 0;
  const [ci5, ci95] = wilsonCI(row.totalWins, row.totalSignals);
  return {
    pair,
    open,
    consecutiveLosses: row.consecutiveLosses,
    totalSignals: row.totalSignals,
    winRate,
    openUntil: row.circuitOpenUntil,
    trips: row.circuitTrips,
    cooldownSec: row.circuitOpenUntil ? row.circuitOpenUntil - now : 0,
    winRateCI5: ci5,
    winRateCI95: ci95,
    ciWidth: ci95 - ci5,
    ciSampleAdequate: row.totalSignals >= 20,
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

  let trippedThisCall = false;
  let trippedCooldownSec = 0;
  if (newConsecutiveLosses >= CB_THRESHOLD && !circuitOpen) {
    circuitOpen = true;
    circuitOpenedAt = now;
    circuitTrips = row.circuitTrips + 1;
    // Exponential cooldown: base * 2^(trips-1), capped
    const cooldownSec = Math.min(CB_BASE_COOLDOWN_SEC * Math.pow(2, circuitTrips - 1), CB_MAX_COOLDOWN_SEC);
    circuitOpenUntil = now + Math.floor(cooldownSec);
    trippedThisCall = true;
    trippedCooldownSec = cooldownSec;
    console.warn(`[alpha-cb] CIRCUIT TRIPPED for ${pair}: ${newConsecutiveLosses} consecutive losses. Cooldown ${cooldownSec}s. Trips: ${circuitTrips}`);
  }

  // If circuit was open and this signal won → close the circuit (half-open success)
  let closedThisCall = false;
  if (row.circuitOpen && won) {
    circuitOpen = false;
    circuitOpenedAt = null;
    circuitOpenUntil = null;
    closedThisCall = true;
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

  // Fire Telegram alert on circuit trip (critical severity).
  // Delayed dynamic import to avoid circular dependency with signal-alerts.ts.
  if (trippedThisCall) {
    try {
      const { dispatchSignalEvent, formatCircuitTrippedMessage } = await import("./signal-alerts");
      await dispatchSignalEvent({
        type: "circuit_tripped",
        severity: "critical",
        pair,
        message: formatCircuitTrippedMessage(pair, newConsecutiveLosses, circuitTrips, trippedCooldownSec),
        metadata: { consecutiveLosses: newConsecutiveLosses, trips: circuitTrips, cooldownSec: trippedCooldownSec },
      });
    } catch (e) {
      console.warn("[alpha-cb] failed to dispatch circuit_tripped alert:", e instanceof Error ? e.message : e);
    }
  }
  // Fire recovery alert when circuit half-open probe succeeds
  if (closedThisCall) {
    try {
      const { dispatchSignalEvent } = await import("./signal-alerts");
      await dispatchSignalEvent({
        type: "recovery",
        severity: "info",
        pair,
        message: `✅ [INFO] CIRCUIT CLOSED: ${pair.toUpperCase()}\n\nHalf-open probe succeeded. Pair resumed.`,
        metadata: { action, outcome: "win" },
      });
    } catch { /* ignore */ }
  }
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
