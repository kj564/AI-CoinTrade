import { NextRequest, NextResponse } from "next/server";
import { fetchAndStoreL2, getL2SnapshotCount, getLatestL2Snapshot } from "@/lib/trading/l2-storage";
import { loadCandles } from "@/lib/trading/candles";

export const runtime = "nodejs";
export const maxDuration = 30;

// POST /api/l2/collect
// body: { pair?: string } — if pair omitted, collects for all default pairs
// Fetches current L2 order book from INDODAX and stores to database for historical backtest calibration.
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const pair = body.pair;
    const pairs = pair ? [pair] : ["btc_idr", "eth_idr", "sol_idr", "bnb_idr", "xrp_idr"];

    const results: { pair: string; success: boolean; error?: string; snapshotCount?: number; latestAge?: number }[] = [];

    for (const p of pairs) {
      try {
        const candles = await loadCandles(p, "1h", 100);
        const avgVol = candles.length > 0 ? candles.reduce((a, c) => a + c.volume, 0) / candles.length : 1000;
        const l2 = await fetchAndStoreL2(p, avgVol);
        if (l2) {
          const count = await getL2SnapshotCount(p);
          const latest = await getLatestL2Snapshot(p);
          results.push({ pair: p, success: true, snapshotCount: count, latestAge: latest?.ageSec });
        } else {
          results.push({ pair: p, success: false, error: "Failed to fetch depth from INDODAX" });
        }
      } catch (e) {
        results.push({ pair: p, success: false, error: e instanceof Error ? e.message : "Unknown error" });
      }
    }

    return NextResponse.json({ success: true, results, timestamp: new Date().toISOString() });
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
