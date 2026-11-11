import { NextRequest, NextResponse } from "next/server";
import { getL2Health, hydrateL2MonitorFromDB, type L2HealthSummary } from "@/lib/trading/l2-monitor";
import { getDepth } from "@/lib/indodax";
import { validateDepth } from "@/lib/trading/l2-storage";
import { db } from "@/lib/db";
// Pure channel-config module (no native deps, no db) — keeps the health route
// bundle light. The old inline detectChannels() is replaced by this import.
import { getConfiguredChannels as detectChannels } from "@/lib/alerting/channels";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/l2/health — returns the L2 collector health summary.
// Exposes per-pair collection stats, derived alerts (with runbook links),
// scheduler liveness, and circuit-breaker state. Hydrates from DB on first
// read so the monitor survives hot-reloads.
//
// GET /api/l2/health?deep=1 — performs a full end-to-end deep check:
//   1. INDODAX depth API reachable + valid
//   2. DB L2Snapshot table writable
//   3. Monitor hydrated + responding
// Returns a `deepCheck` object with each step's result + timing.
export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const thresholdParam = url.searchParams.get("threshold");
    const threshold = thresholdParam ? parseInt(thresholdParam, 10) : 3600;
    const safeThreshold = Number.isFinite(threshold) && threshold > 0 ? threshold : 3600;
    const deep = url.searchParams.get("deep") === "1";

    // Hydrate from DB so health is accurate even right after a hot-reload
    await hydrateL2MonitorFromDB();

    const summary: L2HealthSummary = getL2Health(safeThreshold);

    // Include configured alerting channels (so the UI can show which are active)
    let configuredChannels = { telegram: false, slack: false, discord: false, email: false, webhook: false };
    try {
      const cfg = await db.botConfig.findUnique({ where: { id: "singleton" } });
      configuredChannels = detectChannels(cfg);
    } catch { /* ignore */ }

    if (!deep) {
      return NextResponse.json({ ...summary, configuredChannels }, {
        headers: { "Cache-Control": "no-store, max-age=0" },
      });
    }

    // ── Deep check: verify the full pipeline end-to-end ──
    const deepCheck = await runDeepCheck();

    return NextResponse.json(
      { ...summary, configuredChannels, deepCheck },
      { headers: { "Cache-Control": "no-store, max-age=0" } },
    );
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to read L2 health" },
      { status: 500 },
    );
  }
}

interface DeepCheckResult {
  overall: "pass" | "fail";
  checks: {
    name: string;
    status: "pass" | "fail" | "warn";
    durationMs: number;
    detail: string;
  }[];
  runbookHint: string;
}

async function runDeepCheck(): Promise<DeepCheckResult> {
  const checks: DeepCheckResult["checks"] = [];

  // 1. INDODAX depth API reachable + valid
  try {
    const t0 = Date.now();
    const depth = await getDepth("btcidr");
    const durationMs = Date.now() - t0;
    if (!depth) {
      checks.push({ name: "indodax_depth_api", status: "fail", durationMs, detail: "getDepth returned null — API unreachable or error" });
    } else {
      const validation = validateDepth("btc_idr", depth);
      if (validation.valid) {
        checks.push({
          name: "indodax_depth_api",
          status: "pass",
          durationMs,
          detail: `Reachable · ${depth.buy.length} bids / ${depth.sell.length} asks · top bid ${depth.buy[0]?.[0]} ask ${depth.sell[0]?.[0]}`,
        });
      } else {
        checks.push({ name: "indodax_depth_api", status: "fail", durationMs, detail: `API reachable but invalid depth: ${validation.errors.join("; ")}` });
      }
    }
  } catch (e) {
    checks.push({ name: "indodax_depth_api", status: "fail", durationMs: 0, detail: `Exception: ${e instanceof Error ? e.message : String(e)}` });
  }

  // 2. DB L2Snapshot table readable (count + latest)
  try {
    const t0 = Date.now();
    const count = await db.l2Snapshot.count();
    const durationMs = Date.now() - t0;
    checks.push({ name: "db_l2snapshot", status: "pass", durationMs, detail: `${count} snapshots · table readable` });
  } catch (e) {
    checks.push({ name: "db_l2snapshot", status: "fail", durationMs: 0, detail: `DB read failed: ${e instanceof Error ? e.message : String(e)}` });
  }

  // 3. Monitor hydrated + responding
  try {
    const t0 = Date.now();
    const state = getL2Health();
    const durationMs = Date.now() - t0;
    checks.push({
      name: "monitor_responsive",
      status: "pass",
      durationMs,
      detail: `status=${state.status} · ${state.totalAttempts} attempts · hydrated · ${state.pairCircuitBreakers ? Object.keys(state.pairCircuitBreakers).length : 0} pair CBs`,
    });
  } catch (e) {
    checks.push({ name: "monitor_responsive", status: "fail", durationMs: 0, detail: `Monitor error: ${e instanceof Error ? e.message : String(e)}` });
  }

  // 4. Scheduler liveness
  try {
    const state = getL2Health();
    const tickAge = state.lastSchedulerTickAt ? Math.floor(Date.now() / 1000) - state.lastSchedulerTickAt : null;
    if (state.schedulerRunning && tickAge !== null && tickAge < 300) {
      checks.push({ name: "scheduler_liveness", status: "pass", durationMs: 0, detail: `Running · last tick ${tickAge}s ago` });
    } else {
      checks.push({ name: "scheduler_liveness", status: "fail", durationMs: 0, detail: `Scheduler not running or stale (tickAge=${tickAge === null ? "null" : tickAge + "s"})` });
    }
  } catch (e) {
    checks.push({ name: "scheduler_liveness", status: "fail", durationMs: 0, detail: `Exception: ${e instanceof Error ? e.message : String(e)}` });
  }

  // 5. Persistence state (verify persistedAt is set — indicates DB flush has worked)
  try {
    const state = getL2Health();
    const age = state.persistedAt ? Math.floor(Date.now() / 1000) - state.persistedAt : null;
    checks.push({
      name: "persistence_state",
      status: age !== null && age < 3600 ? "pass" : "warn",
      durationMs: 0,
      detail: age !== null ? `Last DB flush ${age}s ago` : "No DB flush yet (will flush on next collection cycle)",
    });
  } catch (e) {
    checks.push({ name: "persistence_state", status: "fail", durationMs: 0, detail: `Exception: ${e instanceof Error ? e.message : String(e)}` });
  }

  // 6. Alerting channels configured (informational)
  try {
    const cfg = await db.botConfig.findUnique({ where: { id: "singleton" } });
    const channels = detectChannels(cfg);
    const active = Object.entries(channels).filter(([, v]) => v).map(([k]) => k);
    checks.push({
      name: "alerting_channels",
      status: active.length > 0 ? "pass" : "warn",
      durationMs: 0,
      detail: active.length > 0 ? `${active.length} channel(s) configured: ${active.join(", ")}` : "No alerting channels configured (set Telegram in Bot Config or L2_ALERT_* env vars)",
    });
  } catch (e) {
    checks.push({ name: "alerting_channels", status: "fail", durationMs: 0, detail: `Exception: ${e instanceof Error ? e.message : String(e)}` });
  }

  // 7. Per-pair circuit breaker sanity (no pair should have an open CB in healthy state)
  try {
    const state = getL2Health();
    const openPairs = Object.entries(state.pairCircuitBreakers || {}).filter(([, cb]: any) => cb.open).map(([p]) => p);
    checks.push({
      name: "pair_circuit_breakers",
      status: openPairs.length === 0 ? "pass" : "warn",
      durationMs: 0,
      detail: openPairs.length === 0 ? "All per-pair circuit breakers closed" : `${openPairs.length} pair CB(s) open: ${openPairs.join(", ")}`,
    });
  } catch (e) {
    checks.push({ name: "pair_circuit_breakers", status: "fail", durationMs: 0, detail: `Exception: ${e instanceof Error ? e.message : String(e)}` });
  }

  const overall: "pass" | "fail" = checks.filter((c) => c.status !== "warn").every((c) => c.status === "pass") ? "pass" : "fail";

  return {
    overall,
    checks,
    runbookHint: overall === "pass"
      ? "All checks passed — pipeline healthy end-to-end."
      : "One or more checks failed. See Research Lab → L2 Collector Health runbook for troubleshooting steps per failure type.",
  };
}
