import { NextRequest, NextResponse } from "next/server";
import { getDepth } from "@/lib/indodax";
import { computePain } from "@/lib/psyop/pain-engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/psyop/market?pair=btc_idr&capital=10000000
// Returns current market state + pain computation if a position is open.
export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const pair = url.searchParams.get("pair") || "btc_idr";
    const capital = parseFloat(url.searchParams.get("capital") || "10000000");
    // Optional: entry price + amount to compute unrealized P&L
    const entryPrice = url.searchParams.get("entryPrice");
    const amount = url.searchParams.get("amount");

    const depth = await getDepth(pair.replace("_idr", "idr"));
    if (!depth) {
      return NextResponse.json({ error: "Failed to fetch depth" }, { status: 502 });
    }

    const topBid = parseFloat(depth.buy[0]?.[0] ?? "0");
    const topAsk = parseFloat(depth.sell[0]?.[0] ?? "0");
    const currentPrice = (topBid + topAsk) / 2;
    const spreadPct = currentPrice > 0 ? ((topAsk - topBid) / currentPrice) * 100 : 0;

    let pain = null;
    if (entryPrice && amount) {
      const ep = parseFloat(entryPrice);
      const amt = parseFloat(amount);
      const positionValue = amt * ep;
      const currentValue = amt * currentPrice;
      const pnl = currentValue - positionValue;
      pain = computePain(pnl, capital);
    }

    return NextResponse.json({
      pair,
      currentPrice,
      topBid,
      topAsk,
      spreadPct,
      pain,
      timestamp: new Date().toISOString(),
    }, { headers: { "Cache-Control": "no-store, max-age=0" } });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "market fetch failed" }, { status: 500 });
  }
}
