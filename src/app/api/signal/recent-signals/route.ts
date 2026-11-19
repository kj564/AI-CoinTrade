import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 10;

// GET /api/signal/recent-signals?limit=20
//
// Returns the most recent N signals from the journal (open + closed).
// Drives the recent signals table in the UI.
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const limit = Math.min(100, parseInt(url.searchParams.get("limit") || "20"));
    const signals = await db.signalJournal.findMany({
      orderBy: { createdAt: "desc" },
      take: limit,
    });
    const out = signals.map((s) => ({
      id: s.id,
      pair: s.pair,
      action: s.action,
      status: s.status,
      entryPrice: s.entryPrice,
      exitPrice: s.exitPrice,
      stopLoss: s.stopLoss,
      takeProfit1: s.takeProfit1,
      positionSizeIdr: s.positionSizeIdr,
      conviction: s.conviction,
      strength: s.strength,
      severity: s.severity,
      pnlIdr: s.pnlIdr,
      pnlPct: s.pnlPct,
      holdHours: s.holdHours,
      riskMultiplier: s.riskMultiplier,
      drawdownAtSignal: s.drawdownAtSignal,
      alertSent: s.alertSent,
      closeAlertSent: s.closeAlertSent,
      fundingZScore: s.fundingZScore,
      createdAt: s.createdAt,
      exitTime: s.exitTime ? new Date(s.exitTime * 1000).toISOString() : null,
    }));
    return NextResponse.json({ signals: out, count: out.length, timestamp: new Date().toISOString() }, { headers: { "Cache-Control": "no-store, max-age=0" } });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "recent-signals failed" }, { status: 500 });
  }
}
