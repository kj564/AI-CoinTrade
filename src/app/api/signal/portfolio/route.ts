import { NextResponse } from "next/server";
import { getPortfolioStats, checkOpenSignals } from "@/lib/trading/signal-journal";
import { getDrawdownState } from "@/lib/trading/drawdown-monitor";
import { getRecentAlertEvents } from "@/lib/trading/signal-alerts";
import { getTicker } from "@/lib/indodax";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

// GET /api/signal/portfolio
// Returns portfolio-level P&L stats from the signal journal.
// Also checks open signals against current prices (closes any that hit stop/target).
// Includes drawdown state + recent alert events for the dashboard.
export async function GET() {
  try {
    // Fetch current prices for all pairs (to check open signals)
    const pairs = ["btc_idr", "eth_idr", "sol_idr", "bnb_idr", "xrp_idr"];
    const prices: Record<string, number> = {};
    for (const pair of pairs) {
      const ticker = await getTicker(pair);
      if (ticker?.last) prices[pair] = ticker.last;
    }

    // Check open signals against current prices (fires signal_closed + drawdown alerts)
    const checkResult = await checkOpenSignals(prices);

    // Get portfolio stats + drawdown state + recent alerts in parallel
    const [stats, drawdown, recentAlerts] = await Promise.all([
      getPortfolioStats(),
      getDrawdownState(10_000_000),
      getRecentAlertEvents(10),
    ]);

    return NextResponse.json({
      ...stats,
      signalCheck: checkResult,
      currentPrices: prices,
      drawdown,
      recentAlerts,
      timestamp: new Date().toISOString(),
    }, { headers: { "Cache-Control": "no-store, max-age=0" } });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "portfolio failed" }, { status: 500 });
  }
}
