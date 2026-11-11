import { NextRequest, NextResponse } from "next/server";
import { fetchAndStoreL2WithRetry, getL2SnapshotCount, getLatestL2Snapshot } from "@/lib/trading/l2-storage";
import {
  recordL2Attempt,
  recordCollectionCycle,
  isCircuitOpen,
  isPairCircuitOpen,
  getL2Health,
  getNewErrorAlerts,
  persistL2Health,
  hydrateL2MonitorFromDB,
} from "@/lib/trading/l2-monitor";
import { sendL2ExternalAlerts } from "@/lib/alerting/dispatch";
import { checkCollectRateLimit, getRateLimitBackend } from "@/lib/rate-limit/factory";
import { generateTraceId } from "@/lib/alerting/trace";
import { loadCandles } from "@/lib/trading/candles";

export const runtime = "nodejs";
export const maxDuration = 30;

const RATE_WINDOW_SEC = 60;
const RATE_MAX_CALLS = 3;

// POST /api/l2/collect
// body: { pair?: string } — if pair omitted, collects for all default pairs
// Fetches current L2 order book from INDODAX and stores to database for historical backtest calibration.
// Uses exponential-backoff retry (3 attempts), records every attempt to the health
// monitor, persists state to DB, and fires multi-channel external alerts on new incidents.
// Rate-limited (3 calls/60s/source, in-memory or Redis backend) and circuit-breaker
// protected (both global and per-pair).
export async function POST(req: NextRequest) {
  const traceId = generateTraceId();
  try {
    // Rate limit check (priority #4) — pluggable backend (memory/Redis)
    const source = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
    const rl = await checkCollectRateLimit(source, RATE_MAX_CALLS, RATE_WINDOW_SEC * 1000);
    if (!rl.allowed) {
      return NextResponse.json(
        {
          error: "Rate limited",
          detail: `Max ${RATE_MAX_CALLS} collection calls per ${RATE_WINDOW_SEC}s from this source.`,
          retryAfterSec: rl.retryAfterSec,
          rateLimitBackend: getRateLimitBackend(),
          traceId,
        },
        { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } },
      );
    }

    const url = new URL(req.url);
    const force = url.searchParams.get("force") === "1";

    // Global circuit breaker check — skip entire collection if open
    const circuitOpen = isCircuitOpen();
    if (circuitOpen && !force) {
      const health = getL2Health();
      return NextResponse.json(
        {
          success: false,
          circuitOpen: true,
          error: "Global circuit breaker is open — collection skipped to prevent cascade failure",
          circuitBreaker: health.circuitBreaker,
          detail: `Trips: ${health.circuitBreaker.trips}. Cooldown until ${health.circuitBreaker.openUntil ? new Date(health.circuitBreaker.openUntil * 1000).toISOString() : "n/a"}. Pass ?force=1 to override.`,
          traceId,
        },
        { status: 503 },
      );
    }

    // Hydrate monitor from DB if not yet done (survive hot-reload)
    await hydrateL2MonitorFromDB();

    const body = await req.json().catch(() => ({}));
    const pair = body.pair;
    const pairs = pair ? [pair] : ["btc_idr", "eth_idr", "sol_idr", "bnb_idr", "xrp_idr"];

    const results: {
      pair: string;
      success: boolean;
      skipped?: boolean;
      skipReason?: string;
      error?: string;
      errors?: string[];
      attempts?: number;
      retriesUsed?: number;
      durationMs?: number;
      snapshotCount?: number;
      latestAge?: number;
    }[] = [];

    for (const p of pairs) {
      // Per-pair circuit breaker check (priority #4) — skip individual pairs whose
      // circuit is open (granular cascade protection, doesn't block other pairs)
      if (!force && isPairCircuitOpen(p)) {
        const health = getL2Health();
        const pcb = health.pairCircuitBreakers[p];
        results.push({
          pair: p,
          success: false,
          skipped: true,
          skipReason: `Per-pair circuit open (trips: ${pcb?.trips ?? 0}). Cooldown until ${pcb?.openUntil ? new Date(pcb.openUntil * 1000).toISOString() : "n/a"}.`,
        });
        continue;
      }

      try {
        const candles = await loadCandles(p, "1h", 100);
        const avgVol = candles.length > 0 ? candles.reduce((a, c) => a + c.volume, 0) / candles.length : 1000;

        const result = await fetchAndStoreL2WithRetry(p, avgVol);

        const count = await getL2SnapshotCount(p);
        const latest = await getLatestL2Snapshot(p);

        recordL2Attempt(p, {
          success: !!result.snapshot,
          error: result.snapshot ? undefined : (result.errors[result.errors.length - 1] ?? "unknown"),
          retriesUsed: result.retriesUsed,
          durationMs: result.durationMs,
          snapshotCount: count,
          ageSec: latest?.ageSec,
        });

        if (result.snapshot) {
          results.push({
            pair: p,
            success: true,
            attempts: result.attempts,
            retriesUsed: result.retriesUsed,
            durationMs: result.durationMs,
            snapshotCount: count,
            latestAge: latest?.ageSec,
          });
        } else {
          results.push({
            pair: p,
            success: false,
            errors: result.errors,
            attempts: result.attempts,
            retriesUsed: result.retriesUsed,
            durationMs: result.durationMs,
            error: result.errors[result.errors.length - 1] ?? "Failed to fetch/validate depth",
          });
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Unknown error";
        recordL2Attempt(p, { success: false, error: msg });
        results.push({ pair: p, success: false, error: msg });
      }
    }

    // Update global circuit breaker based on this cycle's results (only count non-skipped)
    const collected = results.filter((r) => !r.skipped);
    const okCount = collected.filter((r) => r.success).length;
    recordCollectionCycle(okCount, collected.length);

    // Persist monitor state to DB
    await persistL2Health();

    // Fire external alerts on NEW error-level incidents (multi-channel).
    // Awaiting the dispatch so the response includes the alert trace ID for
    // log correlation. Channel sends are parallel with 8s timeout each, so
    // the added latency is bounded.
    const health = getL2Health();
    const newAlerts = getNewErrorAlerts();
    let alertTraceId: string | undefined;
    let alertDelivery: { telegram: boolean | null; slack: boolean | null; discord: boolean | null; email: boolean | null; webhook: boolean | null } | undefined;
    if (newAlerts.length > 0) {
      try {
        const r = await sendL2ExternalAlerts(newAlerts, health);
        alertTraceId = r.traceId;
        alertDelivery = { telegram: r.telegram, slack: r.slack, discord: r.discord, email: r.email, webhook: r.webhook };
      } catch (e) {
        console.warn(`[l2/collect] [trace=${traceId}] external alert delivery failed:`, e instanceof Error ? e.message : e);
      }
    }

    const skippedCount = results.filter((r) => r.skipped).length;

    return NextResponse.json({
      success: true,
      traceId,
      results,
      summary: {
        total: results.length,
        ok: okCount,
        failed: collected.length - okCount,
        skipped: skippedCount,
      },
      circuitBreaker: health.circuitBreaker,
      pairCircuitBreakers: health.pairCircuitBreakers,
      alertsSent: newAlerts.length,
      alertTraceId,
      alertDelivery,
      rateLimitBackend: getRateLimitBackend(),
      timestamp: new Date().toISOString(),
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "L2 collection failed", traceId }, { status: 500 });
  }
}

// GET /api/l2/collect?pair=btc_idr — returns L2 storage stats
export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const pair = url.searchParams.get("pair") || "btc_idr";
    const count = await getL2SnapshotCount(pair);
    const latest = await getLatestL2Snapshot(pair);
    return NextResponse.json({
      pair,
      snapshotCount: count,
      latest: latest ? { timestamp: latest.timestamp, ageSec: latest.ageSec, isStale: latest.ageSec > 3600 } : null,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}
