import { NextRequest, NextResponse } from "next/server";
import { fetchAndStoreL2WithRetry, getL2SnapshotCount, getLatestL2Snapshot } from "@/lib/trading/l2-storage";
import { recordL2Attempt } from "@/lib/trading/l2-monitor";
import { loadCandles } from "@/lib/trading/candles";

export const runtime = "nodejs";
export const maxDuration = 30;

// POST /api/l2/collect
// body: { pair?: string } — if pair omitted, collects for all default pairs
// Fetches current L2 order book from INDODAX and stores to database for historical backtest calibration.
// Uses exponential-backoff retry (3 attempts) and records every attempt to the
// in-process health monitor.
export async function POST(req: NextRequest) {
  try {
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

    const okCount = results.filter((r) => r.success).length;
    return NextResponse.json({
      success: true,
      results,
      summary: { total: results.length, ok: okCount, failed: results.length - okCount },
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
