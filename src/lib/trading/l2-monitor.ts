// L2 Collector Health Monitor (in-process + DB-persisted)
// Tracks per-pair collection success/failure over time so scheduler failures are
// detectable, per-pair errors are surfaced, and stale/outage alerts can be derived.
//
// This round (production hardening):
//  - Aggregate state is persisted to DB (L2CollectorHealth) so the monitor
//    survives hot-reloads / restarts. In-memory remains the fast-path; DB is
//    hydrated on startup and flushed after each collection cycle. The in-memory
//    write always succeeds (circular-dependency safe); DB flush is best-effort.
//  - Circuit breaker: if N consecutive collection cycles have 0 successes,
//    the circuit opens and collection is skipped for a cooldown (with exponential
//    backoff). Prevents cascade failure when INDODAX API is down.
//  - Alert dedup: tracks which error-level alert signatures have already been
//    notified externally so Telegram/webhook alerts fire only on NEW incidents.

import { db } from "@/lib/db";

export type L2HealthStatus = "healthy" | "degraded" | "down";

export interface PairHealth {
  pair: string;
  lastSuccessAt: number | null;       // unix sec
  lastFailureAt: number | null;       // unix sec
  lastError: string | null;
  lastErrorAt: number | null;
  consecutiveFailures: number;
  totalAttempts: number;
  totalSuccesses: number;
  totalFailures: number;
  lastSnapshotCount: number;
  lastAgeSec: number | null;
  lastRetriesUsed: number;
  // Rolling history (last 20 attempts) for diagnostics — NOT persisted (transient)
  history: L2AttemptRecord[];
}

export interface L2AttemptRecord {
  ts: number;          // unix sec
  success: boolean;
  error?: string;
  ageSec?: number;
  retriesUsed: number;
  durationMs: number;
}

export interface CircuitBreakerState {
  open: boolean;
  openedAt: number | null;        // unix sec
  openUntil: number | null;       // unix sec — when half-open probe allowed
  trips: number;                  // total times circuit has opened
  consecutiveBadCycles: number;   // cycles with 0 successes
  currentCooldownSec: number;     // current cooldown (doubles on re-trip, capped)
}

export interface L2HealthSummary {
  status: L2HealthStatus;
  generatedAt: number;        // unix sec
  pairs: PairHealth[];
  totalAttempts: number;
  totalSuccesses: number;
  totalFailures: number;
  successRate: number;        // 0..1
  alerts: L2Alert[];
  schedulerRunning: boolean;
  lastSchedulerTickAt: number | null;
  circuitBreaker: CircuitBreakerState;
  pairCircuitBreakers: Record<string, PairCircuitBreakerState>;  // per-pair CB (#4)
  persistedAt: number | null;  // unix sec of last successful DB flush
}

export type AlertSeverity = "info" | "warn" | "error" | "critical";

export interface L2Alert {
  level: "warn" | "error";
  severity: AlertSeverity;     // derived severity for channel routing (#7)
  pair: string;
  code: "stale" | "consecutive_failures" | "outage" | "never_collected" | "circuit_open" | "circuit_open_pair" | "scheduler_dead" | "rate_limited";
  message: string;
  detail?: string;
  runbook?: string;   // runbook anchor reference for troubleshooting
}

// Per-pair circuit breaker state (priority #4 — granular cascade protection)
export interface PairCircuitBreakerState {
  open: boolean;
  openedAt: number | null;       // unix sec
  openUntil: number | null;      // unix sec — when half-open probe allowed
  trips: number;
  currentCooldownSec: number;
}

const HISTORY_LIMIT = 20;
const OUTAGE_THRESHOLD = 3;       // consecutiveFailures >= 3 → down
const DEGRADED_THRESHOLD = 1;     // consecutiveFailures >= 1 → degraded
const STALE_MULTIPLIER = 2;       // lastSuccess age > 2× candle duration → stale

// Circuit breaker config
const CB_BAD_CYCLE_THRESHOLD = 3;       // 3 consecutive 0-success cycles → open
const CB_BASE_COOLDOWN_SEC = 300;       // 5 min initial cooldown
const CB_MAX_COOLDOWN_SEC = 1800;       // cap at 30 min
const CB_HALF_OPEN_SUCCESS_THRESHOLD = 1; // need >=1 success in half-open cycle to close

// Per-pair circuit breaker config (priority #4)
const PAIR_CB_THRESHOLD = 3;            // 3 consecutive failures → open pair CB
const PAIR_CB_BASE_COOLDOWN_SEC = 60;   // 1 min initial cooldown (per-pair, shorter than global)
const PAIR_CB_MAX_COOLDOWN_SEC = 600;   // cap at 10 min

// Runbook anchors — map alert codes to in-app runbook section references.
const RUNBOOK: Record<string, string> = {
  stale: "#runbook-stale",
  consecutive_failures: "#runbook-consecutive-failures",
  outage: "#runbook-outage",
  never_collected: "#runbook-never-collected",
  circuit_open: "#runbook-circuit-open",
  circuit_open_pair: "#runbook-circuit-open-pair",
  scheduler_dead: "#runbook-scheduler-dead",
  rate_limited: "#runbook-rate-limited",
};

// Pairs tracked — must match the scheduler's L2_PAIRS
const TRACKED_PAIRS = ["btc_idr", "eth_idr", "sol_idr", "bnb_idr", "xrp_idr"];
const SCHEDULER_KEY = "__scheduler__";

interface MonitorState {
  pairs: Map<string, PairHealth>;
  schedulerRunning: boolean;
  lastSchedulerTickAt: number | null;
  circuit: CircuitBreakerState;
  pairCircuits: Map<string, PairCircuitBreakerState>;  // per-pair CB (#4)
  lastNotifiedAlerts: Set<string>;   // dedup keys for external alerting
  persistedAt: number | null;
  hydrated: boolean;
}

const globalForMonitor = globalThis as unknown as { __l2Monitor?: MonitorState };

function freshCircuit(): CircuitBreakerState {
  return {
    open: false,
    openedAt: null,
    openUntil: null,
    trips: 0,
    consecutiveBadCycles: 0,
    currentCooldownSec: CB_BASE_COOLDOWN_SEC,
  };
}

function getState(): MonitorState {
  if (!globalForMonitor.__l2Monitor) {
    const pairs = new Map<string, PairHealth>();
    for (const p of TRACKED_PAIRS) {
      pairs.set(p, {
        pair: p,
        lastSuccessAt: null,
        lastFailureAt: null,
        lastError: null,
        lastErrorAt: null,
        consecutiveFailures: 0,
        totalAttempts: 0,
        totalSuccesses: 0,
        totalFailures: 0,
        lastSnapshotCount: 0,
        lastAgeSec: null,
        lastRetriesUsed: 0,
        history: [],
      });
    }
    globalForMonitor.__l2Monitor = {
      pairs,
      schedulerRunning: false,
      lastSchedulerTickAt: null,
      circuit: freshCircuit(),
      lastNotifiedAlerts: new Set(),
      persistedAt: null,
      hydrated: false,
    };
  }
  // Hot-reload safety: if a stale global singleton from an older code shape
  // persists (missing new fields), migrate it in-place so we never read undefined.
  const s = globalForMonitor.__l2Monitor;
  if (!s.circuit) s.circuit = freshCircuit();
  if (!s.lastNotifiedAlerts) s.lastNotifiedAlerts = new Set();
  if (s.persistedAt === undefined) s.persistedAt = null;
  if (s.hydrated === undefined) s.hydrated = false;
  return s;
}

// ── In-memory recording (always succeeds — fast path) ──

// Record a collection attempt (success or failure) for a pair.
export function recordL2Attempt(
  pair: string,
  result: { success: boolean; error?: string; ageSec?: number; snapshotCount?: number; retriesUsed?: number; durationMs?: number },
): void {
  const state = getState();
  let h = state.pairs.get(pair);
  if (!h) {
    // auto-register unknown pairs
    h = {
      pair,
      lastSuccessAt: null,
      lastFailureAt: null,
      lastError: null,
      lastErrorAt: null,
      consecutiveFailures: 0,
      totalAttempts: 0,
      totalSuccesses: 0,
      totalFailures: 0,
      lastSnapshotCount: 0,
      lastAgeSec: null,
      lastRetriesUsed: 0,
      history: [],
    };
    state.pairs.set(pair, h);
  }

  const now = Math.floor(Date.now() / 1000);
  const record: L2AttemptRecord = {
    ts: now,
    success: result.success,
    error: result.error,
    ageSec: result.ageSec,
    retriesUsed: result.retriesUsed ?? 0,
    durationMs: result.durationMs ?? 0,
  };

  h.totalAttempts++;
  h.history.push(record);
  if (h.history.length > HISTORY_LIMIT) h.history.shift();

  if (result.success) {
    h.lastSuccessAt = now;
    h.consecutiveFailures = 0;
    h.totalSuccesses++;
    h.lastError = null;
    if (result.snapshotCount !== undefined) h.lastSnapshotCount = result.snapshotCount;
    if (result.ageSec !== undefined) h.lastAgeSec = result.ageSec;
  } else {
    h.lastFailureAt = now;
    h.lastErrorAt = now;
    h.lastError = result.error ?? "Unknown error";
    h.consecutiveFailures++;
    h.totalFailures++;
  }
  h.lastRetriesUsed = result.retriesUsed ?? 0;
}

// Mark that the scheduler ticked (so we can detect scheduler death).
export function recordSchedulerTick(): void {
  const state = getState();
  state.schedulerRunning = true;
  state.lastSchedulerTickAt = Math.floor(Date.now() / 1000);
}

// ── Circuit breaker ──

// Called after a full collection cycle completes. Updates circuit state.
// `successCount` = number of pairs that succeeded in this cycle.
export function recordCollectionCycle(successCount: number, pairCount: number): void {
  const state = getState();
  const cb = state.circuit;

  // If circuit is open, check if cooldown has elapsed → half-open
  if (cb.open) {
    const now = Math.floor(Date.now() / 1000);
    if (cb.openUntil !== null && now >= cb.openUntil) {
      // Half-open probe: this cycle was allowed. Evaluate result.
      if (successCount >= CB_HALF_OPEN_SUCCESS_THRESHOLD) {
        // Recovered — close circuit
        cb.open = false;
        cb.openedAt = null;
        cb.openUntil = null;
        cb.consecutiveBadCycles = 0;
        cb.currentCooldownSec = CB_BASE_COOLDOWN_SEC; // reset cooldown
        console.log("[l2-circuit-breaker] CLOSED — half-open probe succeeded");
      } else {
        // Still failing — re-open with backoff
        cb.currentCooldownSec = Math.min(cb.currentCooldownSec * 2, CB_MAX_COOLDOWN_SEC);
        cb.openUntil = now + cb.currentCooldownSec;
        cb.trips++;
        console.warn(`[l2-circuit-breaker] re-opened after half-open probe failed — cooldown ${cb.currentCooldownSec}s (trips: ${cb.trips})`);
      }
      return;
    }
    // Still in cooldown — ignore
    return;
  }

  // Circuit closed: track bad cycles
  if (successCount === 0 && pairCount > 0) {
    cb.consecutiveBadCycles++;
    if (cb.consecutiveBadCycles >= CB_BAD_CYCLE_THRESHOLD) {
      // Trip the circuit
      const now = Math.floor(Date.now() / 1000);
      cb.open = true;
      cb.openedAt = now;
      cb.openUntil = now + cb.currentCooldownSec;
      cb.trips++;
      console.error(`[l2-circuit-breaker] OPENED — ${cb.consecutiveBadCycles} consecutive 0-success cycles. Cooldown ${cb.currentCooldownSec}s. Collection will be skipped.`);
    }
  } else if (successCount > 0) {
    // Healthy cycle — reset bad cycle counter
    cb.consecutiveBadCycles = 0;
  }
}

// Is the circuit currently open (collection should be skipped)?
export function isCircuitOpen(): boolean {
  const state = getState();
  const cb = state.circuit;
  if (!cb.open) return false;
  const now = Math.floor(Date.now() / 1000);
  // If past openUntil, we're in half-open → allow the probe (return false so collection runs)
  if (cb.openUntil !== null && now >= cb.openUntil) return false;
  return true;
}

export function getCircuitBreaker(): CircuitBreakerState {
  return { ...getState().circuit };
}

// ── Alert derivation ──

function deriveAlerts(h: PairHealth, stalenessThresholdSec: number): L2Alert[] {
  const alerts: L2Alert[] = [];
  const now = Math.floor(Date.now() / 1000);

  if (h.totalAttempts === 0) {
    alerts.push({
      level: "warn",
      pair: h.pair,
      code: "never_collected",
      message: `No L2 snapshot collected yet for ${h.pair}`,
      runbook: RUNBOOK.never_collected,
    });
    return alerts;
  }

  // Outage: too many consecutive failures
  if (h.consecutiveFailures >= OUTAGE_THRESHOLD) {
    alerts.push({
      level: "error",
      pair: h.pair,
      code: "outage",
      message: `${h.pair}: ${h.consecutiveFailures} consecutive collection failures — collector appears down`,
      detail: h.lastError ?? undefined,
      runbook: RUNBOOK.outage,
    });
  } else if (h.consecutiveFailures >= DEGRADED_THRESHOLD) {
    alerts.push({
      level: "warn",
      pair: h.pair,
      code: "consecutive_failures",
      message: `${h.pair}: ${h.consecutiveFailures} recent failure(s) — last error: ${h.lastError ?? "unknown"}`,
      runbook: RUNBOOK.consecutive_failures,
    });
  }

  // Stale: last successful snapshot is older than threshold
  if (h.lastSuccessAt !== null) {
    const age = now - h.lastSuccessAt;
    if (age > stalenessThresholdSec * STALE_MULTIPLIER) {
      alerts.push({
        level: h.consecutiveFailures > 0 ? "error" : "warn",
        pair: h.pair,
        code: "stale",
        message: `${h.pair}: last snapshot ${formatAge(age)} old (threshold ${formatAge(stalenessThresholdSec * STALE_MULTIPLIER)})`,
        runbook: RUNBOOK.stale,
      });
    }
  } else if (h.totalAttempts > 0) {
    // attempts made but never succeeded
    alerts.push({
      level: "error",
      pair: h.pair,
      code: "outage",
      message: `${h.pair}: ${h.totalAttempts} attempts, 0 successes — collector failing`,
      detail: h.lastError ?? undefined,
      runbook: RUNBOOK.outage,
    });
  }

  return alerts;
}

function formatAge(sec: number): string {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return `${h}h${m > 0 ? `${m}m` : ""}`;
}

// Get full health summary. stalenessThresholdSec defaults to 1h candle duration.
export function getL2Health(stalenessThresholdSec = 3600): L2HealthSummary {
  const state = getState();
  const pairs = Array.from(state.pairs.values());

  let totalAttempts = 0;
  let totalSuccesses = 0;
  let totalFailures = 0;
  let worstStatus: L2HealthStatus = "healthy";
  const allAlerts: L2Alert[] = [];

  for (const p of pairs) {
    totalAttempts += p.totalAttempts;
    totalSuccesses += p.totalSuccesses;
    totalFailures += p.totalFailures;

    const alerts = deriveAlerts(p, stalenessThresholdSec);
    allAlerts.push(...alerts);

    // Determine pair-level status
    const hasError = alerts.some((a) => a.level === "error");
    const hasWarn = alerts.some((a) => a.level === "warn");
    if (hasError) worstStatus = "down";
    else if (hasWarn && worstStatus !== "down") worstStatus = "degraded";
  }

  // Scheduler liveness: if no tick in last 5 min, scheduler is presumed dead
  if (state.lastSchedulerTickAt !== null) {
    const tickAge = Math.floor(Date.now() / 1000) - state.lastSchedulerTickAt;
    if (tickAge > 300) {
      allAlerts.push({
        level: "error",
        pair: "*",
        code: "scheduler_dead",
        message: `Scheduler: no tick in ${formatAge(tickAge)} — in-process collector appears dead`,
        runbook: RUNBOOK.scheduler_dead,
      });
      worstStatus = "down";
    }
  } else if (!state.schedulerRunning) {
    allAlerts.push({
      level: "warn",
      pair: "*",
      code: "scheduler_dead",
      message: "Scheduler: not started yet — in-process collector not running",
      runbook: RUNBOOK.scheduler_dead,
    });
    if (worstStatus === "healthy") worstStatus = "degraded";
  }

  // Circuit breaker alert
  const cb = state.circuit;
  if (cb.open) {
    const now = Math.floor(Date.now() / 1000);
    const inCooldown = cb.openUntil !== null && now < cb.openUntil;
    allAlerts.push({
      level: "error",
      pair: "*",
      code: "circuit_open",
      message: inCooldown
        ? `Circuit breaker OPEN — collection skipped for ${formatAge((cb.openUntil ?? 0) - now)} (trips: ${cb.trips})`
        : `Circuit breaker half-open — probe cycle allowed`,
      runbook: RUNBOOK.circuit_open,
    });
    if (worstStatus !== "down") worstStatus = "down";
  }

  const successRate = totalAttempts > 0 ? totalSuccesses / totalAttempts : 0;

  return {
    status: worstStatus,
    generatedAt: Math.floor(Date.now() / 1000),
    pairs,
    totalAttempts,
    totalSuccesses,
    totalFailures,
    successRate,
    alerts: allAlerts,
    schedulerRunning: state.schedulerRunning,
    lastSchedulerTickAt: state.lastSchedulerTickAt,
    circuitBreaker: { ...cb },
    persistedAt: state.persistedAt,
  };
}

// ── Alert dedup for external notification ──
// Returns error-level alerts whose signature hasn't been notified yet.
// Marks them as notified so subsequent calls don't re-notify.
export function getNewErrorAlerts(): L2Alert[] {
  const state = getState();
  const summary = getL2Health();
  const newAlerts: L2Alert[] = [];
  for (const a of summary.alerts) {
    if (a.level !== "error") continue;
    const key = `${a.pair}:${a.code}`;
    if (!state.lastNotifiedAlerts.has(key)) {
      newAlerts.push(a);
      state.lastNotifiedAlerts.add(key);
    }
  }
  // Prune resolved alerts from the notified set so they can re-notify if they recur
  const currentErrorKeys = new Set(
    summary.alerts.filter((a) => a.level === "error").map((a) => `${a.pair}:${a.code}`),
  );
  for (const key of Array.from(state.lastNotifiedAlerts)) {
    if (!currentErrorKeys.has(key)) state.lastNotifiedAlerts.delete(key);
  }
  return newAlerts;
}

// ── DB persistence ──

// Persist current in-memory state to DB. Best-effort: failures are swallowed
// (in-memory remains authoritative). Called after each collection cycle.
export async function persistL2Health(): Promise<void> {
  const state = getState();
  try {
    const now = Math.floor(Date.now() / 1000);
    // Persist per-pair rows
    for (const h of state.pairs.values()) {
      await db.l2CollectorHealth.upsert({
        where: { key: h.pair },
        create: {
          key: h.pair,
          lastSuccessAt: h.lastSuccessAt,
          lastFailureAt: h.lastFailureAt,
          lastError: h.lastError,
          lastErrorAt: h.lastErrorAt,
          consecutiveFailures: h.consecutiveFailures,
          totalAttempts: h.totalAttempts,
          totalSuccesses: h.totalSuccesses,
          totalFailures: h.totalFailures,
          lastSnapshotCount: h.lastSnapshotCount,
          lastAgeSec: h.lastAgeSec,
          lastRetriesUsed: h.lastRetriesUsed,
        },
        update: {
          lastSuccessAt: h.lastSuccessAt,
          lastFailureAt: h.lastFailureAt,
          lastError: h.lastError,
          lastErrorAt: h.lastErrorAt,
          consecutiveFailures: h.consecutiveFailures,
          totalAttempts: h.totalAttempts,
          totalSuccesses: h.totalSuccesses,
          totalFailures: h.totalFailures,
          lastSnapshotCount: h.lastSnapshotCount,
          lastAgeSec: h.lastAgeSec,
          lastRetriesUsed: h.lastRetriesUsed,
        },
      });
    }
    // Persist scheduler + circuit-breaker state in the sentinel row
    const cb = state.circuit;
    await db.l2CollectorHealth.upsert({
      where: { key: SCHEDULER_KEY },
      create: {
        key: SCHEDULER_KEY,
        schedulerRunning: state.schedulerRunning,
        lastSchedulerTickAt: state.lastSchedulerTickAt,
        circuitOpen: cb.open,
        circuitOpenedAt: cb.openedAt,
        circuitTrips: cb.trips,
        circuitOpenUntil: cb.openUntil,
      },
      update: {
        schedulerRunning: state.schedulerRunning,
        lastSchedulerTickAt: state.lastSchedulerTickAt,
        circuitOpen: cb.open,
        circuitOpenedAt: cb.openedAt,
        circuitTrips: cb.trips,
        circuitOpenUntil: cb.openUntil,
      },
    });
    state.persistedAt = now;
  } catch (e) {
    // Swallow — in-memory is still accurate; DB flush will retry next cycle.
    console.warn("[l2-monitor] persistL2Health failed (in-memory still authoritative):", e instanceof Error ? e.message : e);
  }
}

// Hydrate in-memory state from DB. Called on startup / first health read after restart.
// Only fills aggregate fields (history stays empty — it's transient diagnostics).
// Idempotent: only runs once per process (guarded by `hydrated` flag) unless force=true.
export async function hydrateL2MonitorFromDB(force = false): Promise<void> {
  const state = getState();
  if (state.hydrated && !force) return;
  try {
    const rows = await db.l2CollectorHealth.findMany();
    if (rows.length === 0) {
      state.hydrated = true;
      return;
    }
    for (const row of rows) {
      if (row.key === SCHEDULER_KEY) {
        state.schedulerRunning = row.schedulerRunning;
        state.lastSchedulerTickAt = row.lastSchedulerTickAt;
        state.circuit = {
          open: row.circuitOpen,
          openedAt: row.circuitOpenedAt,
          openUntil: row.circuitOpenUntil,
          trips: row.circuitTrips,
          consecutiveBadCycles: state.circuit.consecutiveBadCycles, // not persisted (transient)
          currentCooldownSec: state.circuit.currentCooldownSec,
        };
      } else {
        const h = state.pairs.get(row.key);
        if (h) {
          h.lastSuccessAt = row.lastSuccessAt;
          h.lastFailureAt = row.lastFailureAt;
          h.lastError = row.lastError;
          h.lastErrorAt = row.lastErrorAt;
          h.consecutiveFailures = row.consecutiveFailures;
          h.totalAttempts = row.totalAttempts;
          h.totalSuccesses = row.totalSuccesses;
          h.totalFailures = row.totalFailures;
          h.lastSnapshotCount = row.lastSnapshotCount;
          h.lastAgeSec = row.lastAgeSec;
          h.lastRetriesUsed = row.lastRetriesUsed;
        }
      }
    }
    state.hydrated = true;
    console.log("[l2-monitor] hydrated from DB —", rows.length, "rows");
  } catch (e) {
    // Swallow — fall back to fresh in-memory state
    state.hydrated = true;
    console.warn("[l2-monitor] hydrate failed (starting fresh):", e instanceof Error ? e.message : e);
  }
}

// Reset monitor state (useful for testing / admin reset). Also clears DB.
export async function resetL2Monitor(): Promise<void> {
  const state = getState();
  state.pairs.clear();
  state.schedulerRunning = false;
  state.lastSchedulerTickAt = null;
  state.circuit = freshCircuit();
  state.lastNotifiedAlerts.clear();
  state.persistedAt = null;
  state.hydrated = true;
  for (const p of TRACKED_PAIRS) {
    state.pairs.set(p, {
      pair: p,
      lastSuccessAt: null,
      lastFailureAt: null,
      lastError: null,
      lastErrorAt: null,
      consecutiveFailures: 0,
      totalAttempts: 0,
      totalSuccesses: 0,
      totalFailures: 0,
      lastSnapshotCount: 0,
      lastAgeSec: null,
      lastRetriesUsed: 0,
      history: [],
    });
  }
  try {
    await db.l2CollectorHealth.deleteMany();
  } catch { /* ignore */ }
}

export const L2_RUNBOOK_SECTIONS = RUNBOOK;
