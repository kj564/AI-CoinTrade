import { NextRequest, NextResponse } from "next/server";
import { fetchAndStoreL2WithRetry, getL2SnapshotCount, getLatestL2Snapshot } from "@/lib/trading/l2-storage";
import {
  recordL2Attempt,
  recordCollectionCycle,
  isCircuitOpen,
  getL2Health,
  getNewErrorAlerts,
  persistL2Health,
  hydrateL2MonitorFromDB,
} from "@/lib/trading/l2-monitor";
import { sendL2ExternalAlerts } from "@/lib/trading/l2-alerts";
import { loadCandles } from "@/lib/trading/candles";

export const runtime = "nodejs";
export const maxDuration = 30;

// ── Rate limiting (priority #4) ──
// Simple in-memory sliding-window rate limiter. Prevents abuse of the collect
// endpoint (each call hits INDODAX 5× + writes DB). Allows a burst of 3 calls
// per 60s per source IP, then rejects with 429.
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_CALLS = 3;
const rateBuckets = new Map<string, { count: number; windowStart: number }>();

function checkRateLimit(source: string): { allowed: boolean; retryAfterSec: number } {
  const now = Date.now();
  const bucket = rateBuckets.get(source);
  if (!bucket || now - bucket.windowStart > RATE_WINDOW_MS) {
    rateBuckets.set(source, { count: 1, windowStart: now });
    return { allowed: true, retryAfterSec: 0 };
  }
  bucket.count++;
  if (bucket.count > RATE_MAX_CALLS) {
    const retryAfterSec = Math.ceil((RATE_WINDOW_MS - (now - bucket.windowStart)) / 1000);
    return { allowed: false, retryAfterSec: Math.max(1, retryAfterSec) };
  }
  return { allowed: true, retryAfterSec: 0 };
}

// Clean stale buckets periodically (lazy GC on each call)
function gcRateBuckets() {
  const now = Date.now();
  for (const [src, b] of rateBuckets) {
    if (now - b.windowStart > RATE_WINDOW_MS * 2) rateBuckets.delete(src);
  }
}

// POST /api/l2/collect
// body: { pair?: string } — if pair omitted, collects for all default pairs
// Fetches current L2 order book from INDODAX and stores to database for historical backtest calibration.
// Uses exponential-backoff retry (3 attempts), records every attempt to the health
// monitor, persists state to DB, and fires external alerts on new incidents.
// Rate-limited (3 calls/60s/source) and circuit-breaker protected.
export async function POST(req: NextRequest) {
  try {
    // Rate limit check
    const source = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
    gcRateBuckets();
    const rl = checkRateLimit(source);
    if (!rl.allowed) {
      return NextResponse.json(
        {
          error: "Rate limited",
          detail: `Max ${RATE_MAX_CALLS} collection calls per ${RATE_WINDOW_MS / 1000}s from this source.`,
          retryAfterSec: rl.retryAfterSec,
        },
        { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } },
      );
    }

    // Circuit breaker check (priority #5) — skip collection if open
    // (unless force=1 is passed for manual override)
    const url = new URL(req.url);
    const force = url.searchParams.get("force") === "1";
    const circuitOpen = isCircuitOpen();
    if (circuitOpen && !force) {
      const health = getL2Health();
      return NextResponse.json(
        {
          success: false,
          circuitOpen: true,
          error: "Circuit breaker is open — collection skipped to prevent cascade failure",
          circuitBreaker: health.circuitBreaker,
          detail: `Trips: ${health.circuitBreaker.trips}. Cooldown until ${health.circuitBreaker.openUntil ? new Date(health.circuitBreaker.openUntil * 1000).toISOString() : "n/a"}. Pass ?force=1 to override.`,
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
      error?: string;
      errors?: string[];
      attempts?: number;
      retriesUsed?: number;
      durationMs?: number;
      snapshotCount?: number;
      latestAge?: number;
    }[] = [];

    for (const p of pairs) {
      try {
        const candles = await loadCandles(p, "1h", 100);
        const avgVol = candles.length > 0 ? candles.reduce((a, c) => a + c.volume, 0) / candles.length : 1000;

        const result = await fetchAndStoreL2WithRetry(p, avgVol);

        // Fetch count/age once (used both for the API result and the monitor record)
        const count = await getL2SnapshotCount(p);
        const latest = await getLatestL2Snapshot(p);

        // Record every attempt to the monitor (success or failure) with full context
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

    // Update circuit breaker based on this cycle's results
    const okCount = results.filter((r) => r.success).length;
    recordCollectionCycle(okCount, pairs.length);

    // Persist monitor state to DB (best-effort, survives hot-reload)
    await persistL2Health();

    // Fire external alerts on NEW error-level incidents (Telegram + webhook)
    const health = getL2Health();
    const newAlerts = getNewErrorAlerts();
    if (newAlerts.length > 0) {
      // Fire-and-forget — don't block the response on external delivery
      sendL2ExternalAlerts(newAlerts, health).catch((e) => {
        console.warn("[l2/collect] external alert delivery failed:", e instanceof Error ? e.message : e);
      });
    }

    return NextResponse.json({
      success: true,
      results,
      summary: { total: results.length, ok: okCount, failed: results.length - okCount },
      circuitBreaker: health.circuitBreaker,
      alertsSent: newAlerts.length,
      timestamp: new Date().toISOString(),
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "L2 collection failed" }, { status: 500 });
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
