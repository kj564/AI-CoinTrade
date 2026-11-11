// L2 Collector Health Monitor (in-process)
// Tracks per-pair collection success/failure over time so scheduler failures are
// detectable (evaluator priority #1), per-pair errors are surfaced (#3), and
// stale-data / outage alerts can be derived (#4).
//
// This is an in-memory monitor (no DB persistence) because the L2 collector
// itself runs in-process inside the bot scheduler. A DB-persisted monitor would
// be circular: if the DB write fails, the monitor that records the failure would
// also fail. In-memory is the robust choice here.

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
  // Rolling history (last 20 attempts) for diagnostics
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
}

export interface L2Alert {
  level: "warn" | "error";
  pair: string;
  code: "stale" | "consecutive_failures" | "outage" | "never_collected";
  message: string;
  detail?: string;
}

const HISTORY_LIMIT = 20;
const OUTAGE_THRESHOLD = 3;       // consecutiveFailures >= 3 → down
const DEGRADED_THRESHOLD = 1;     // consecutiveFailures >= 1 → degraded
const STALE_MULTIPLIER = 2;       // lastSuccess age > 2× candle duration → stale

// Pairs tracked — must match the scheduler's L2_PAIRS
const TRACKED_PAIRS = ["btc_idr", "eth_idr", "sol_idr", "bnb_idr", "xrp_idr"];

interface MonitorState {
  pairs: Map<string, PairHealth>;
  schedulerRunning: boolean;
  lastSchedulerTickAt: number | null;
}

const globalForMonitor = globalThis as unknown as { __l2Monitor?: MonitorState };

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
    };
  }
  return globalForMonitor.__l2Monitor;
}

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

// Derive alerts for a given pair given its health + a staleness threshold (sec).
function deriveAlerts(h: PairHealth, stalenessThresholdSec: number): L2Alert[] {
  const alerts: L2Alert[] = [];
  const now = Math.floor(Date.now() / 1000);

  if (h.totalAttempts === 0) {
    alerts.push({
      level: "warn",
      pair: h.pair,
      code: "never_collected",
      message: `No L2 snapshot collected yet for ${h.pair}`,
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
    });
  } else if (h.consecutiveFailures >= DEGRADED_THRESHOLD) {
    alerts.push({
      level: "warn",
      pair: h.pair,
      code: "consecutive_failures",
      message: `${h.pair}: ${h.consecutiveFailures} recent failure(s) — last error: ${h.lastError ?? "unknown"}`,
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
        code: "outage",
        message: `Scheduler: no tick in ${formatAge(tickAge)} — in-process collector appears dead`,
      });
      worstStatus = "down";
    }
  } else if (!state.schedulerRunning) {
    allAlerts.push({
      level: "warn",
      pair: "*",
      code: "outage",
      message: "Scheduler: not started yet — in-process collector not running",
    });
    if (worstStatus === "healthy") worstStatus = "degraded";
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
  };
}

// Reset monitor state (useful for testing / admin reset).
export function resetL2Monitor(): void {
  const state = getState();
  state.pairs.clear();
  state.schedulerRunning = false;
  state.lastSchedulerTickAt = null;
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
}
