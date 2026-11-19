import { NextResponse } from "next/server";
import { getRecentAlertEvents } from "@/lib/trading/signal-alerts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 10;

// GET /api/signal/alerts?limit=20
//
// Returns the recent portfolio-level alert events (signal_fired, signal_closed,
// circuit_tripped, drawdown_breach, paper_vs_replay_deviation, recovery).
// Drives the alert feed in the UI.
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const limit = Math.min(50, parseInt(url.searchParams.get("limit") || "20"));
    const events = await getRecentAlertEvents(limit);
    return NextResponse.json({ events, count: events.length, timestamp: new Date().toISOString() }, { headers: { "Cache-Control": "no-store, max-age=0" } });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "alerts failed" }, { status: 500 });
  }
}
