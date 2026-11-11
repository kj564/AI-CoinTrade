import { NextRequest, NextResponse } from "next/server";
import { getL2Health, type L2HealthSummary } from "@/lib/trading/l2-monitor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/l2/health — returns the in-process L2 collector health summary.
// Exposes per-pair collection stats (last success age, consecutive failures,
// success rate, recent history) plus derived alerts (stale / outage / degraded)
// and scheduler liveness. Used by the dashboard monitoring card.
export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    // Optional staleness threshold override (default = 1h candle duration)
    const thresholdParam = url.searchParams.get("threshold");
    const threshold = thresholdParam ? parseInt(thresholdParam, 10) : 3600;
    const safeThreshold = Number.isFinite(threshold) && threshold > 0 ? threshold : 3600;

    const summary: L2HealthSummary = getL2Health(safeThreshold);

    return NextResponse.json(summary, {
      headers: { "Cache-Control": "no-store, max-age=0" },
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to read L2 health" },
      { status: 500 },
    );
  }
}
