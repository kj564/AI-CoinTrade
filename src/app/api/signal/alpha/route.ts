import { NextRequest, NextResponse } from "next/server";
import { generateAlphaSignals } from "@/lib/trading/alpha-engine";

export const runtime = "nodejs";
export const maxDuration = 30;
export const dynamic = "force-dynamic";

// GET /api/signal/alpha?capital=10000000
//
// Returns multi-pair trading signals based on REAL edges:
//   - Funding rate contrarian (structural crypto edge)
//   - Volatility scaling (ATR-based position sizing)
//   - Regime-aware routing (trend follow vs mean revert)
//   - Fractional Kelly position sizing
//
// Each signal includes: action, entry, stop (2 ATR), targets (1.5R/3R),
// position size, regime-matched backtest stats, invalidation criteria.
export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const capital = parseFloat(url.searchParams.get("capital") || "10000000");
    const result = await generateAlphaSignals(capital);
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store, max-age=0" } });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "alpha signal failed" }, { status: 500 });
  }
}
