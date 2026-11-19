import { NextResponse } from "next/server";
import { getTailRiskMetrics } from "@/lib/trading/var-es";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 10;

// GET /api/signal/tail-risk
//
// Returns Value at Risk (VaR) + Expected Shortfall (ES) at 95% and 99%
// confidence levels, computed from the closed SignalJournal P&L distribution.
// Includes bootstrap CI for VaR 95% (1000 resamples).
export async function GET() {
  try {
    const metrics = await getTailRiskMetrics();
    return NextResponse.json(metrics, { headers: { "Cache-Control": "no-store, max-age=0" } });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "tail-risk failed" }, { status: 500 });
  }
}
