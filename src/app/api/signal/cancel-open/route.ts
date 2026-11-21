import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

// POST /api/signal/cancel-open
//
// Cancels all open signals by marking them as "manual_close" with pnlIdr=0.
// Used to clean up erroneous signals that were journaled before the hard gates
// were added to the alpha engine.
//
// Body (optional): { pair?: "btc_idr" } — if pair specified, only cancel that pair.
// If no pair, cancel ALL open signals.
//
// This does NOT delete the signals — it marks them as closed so they stop
// appearing in "open signals" and stop being checked against current prices.
// The circuit breaker is NOT updated (no win/loss recorded) since these
// signals were erroneous, not genuine outcomes.

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const pair = body?.pair;
    const now = Math.floor(Date.now() / 1000);

    const where = pair ? { status: "open", pair } : { status: "open" };
    const openSignals = await db.signalJournal.findMany({ where });

    if (openSignals.length === 0) {
      return NextResponse.json({
        cancelled: 0,
        message: "No open signals to cancel.",
        timestamp: new Date().toISOString(),
      });
    }

    // Mark all as manual_close with pnlIdr=0, pnlPct=0
    const result = await db.signalJournal.updateMany({
      where,
      data: {
        status: "manual_close",
        exitPrice: 0,
        exitTime: now,
        pnlIdr: 0,
        pnlPct: 0,
        holdHours: 0,
        closeAlertSent: true, // suppress close alerts for these
      },
    });

    return NextResponse.json({
      cancelled: result.count,
      pairs: pair ? [pair] : [...new Set(openSignals.map((s) => s.pair))],
      message: `${result.count} open signal(s) cancelled (marked manual_close, pnl=0). Circuit breaker NOT updated (erroneous signals, not genuine outcomes).`,
      timestamp: new Date().toISOString(),
    }, { headers: { "Cache-Control": "no-store, max-age=0" } });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "cancel-open failed" }, { status: 500 });
  }
}
