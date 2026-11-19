import { NextRequest, NextResponse } from "next/server";
import { getDrawdownState } from "@/lib/trading/drawdown-monitor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 10;

// GET /api/signal/drawdown?capital=10000000
//
// Returns the current portfolio drawdown state + dynamic risk multiplier.
// Drives the drawdown meter + risk-scaling indicator in the UI.
export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const capital = parseFloat(url.searchParams.get("capital") || "10000000");
    const state = await getDrawdownState(capital);
    return NextResponse.json(state, { headers: { "Cache-Control": "no-store, max-age=0" } });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "drawdown failed" }, { status: 500 });
  }
}
