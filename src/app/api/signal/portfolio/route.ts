import { NextResponse } from "next/server";
import { getPortfolioStats, checkOpenSignals } from "@/lib/trading/signal-journal";
import { getTicker } from "@/lib/indodax";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

// GET /api/signal/portfolio
// Returns portfolio-level P&L stats from the signal journal.
// Also checks open signals against current prices (closes any that hit stop/target).
export async function GET() {
  try {
    // Fetch current prices for all pairs (to check open signals)
    const pairs = ["btc_idr", "eth_idr", "sol_idr", "bnb_idr", "xrp_idr"];
    const prices: Record<string, number> = {};
    for (const pair of pairs) {
      const ticker = await getTicker(pair);
      if (ticker?.last) prices[pair] = ticker.last;
    }

    // Check open signals against current prices
    const checkResult = await checkOpenSignals(prices);

    // Get portfolio stats
    const stats = await getPortfolioStats();

    return NextResponse.json({
      ...stats,
      signalCheck: checkResult,
      currentPrices: prices,
      timestamp: new Date().toISOString(),
    }, { headers: { "Cache-Control": "no-store, max-age=0" } });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "portfolio failed" }, { status: 500 });
  }
}
