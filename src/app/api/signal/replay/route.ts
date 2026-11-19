import { NextResponse } from "next/server";
import { replaySignals } from "@/lib/trading/replay";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// GET /api/signal/replay
// Replays the last 500 1h candles (≈21 days) with the full signal engine
// to determine what signals WOULD have fired and their outcomes.
// Returns per-pair replay results + aggregate portfolio stats.
export async function GET() {
  try {
    const pairs = ["btc_idr", "eth_idr", "sol_idr", "bnb_idr", "xrp_idr"];
    const results = await Promise.all(pairs.map((p) => replaySignals(p)));

    // Aggregate across pairs
    const allSignals = results.flatMap((r) => r.signals);
    const totalSignals = allSignals.length;
    const wins = allSignals.filter((s) => s.won).length;
    const losses = allSignals.filter((s) => !s.won).length;
    const winRate = totalSignals > 0 ? wins / totalSignals : 0;
    const avgPnl = totalSignals > 0 ? allSignals.reduce((a, s) => a + s.pnlPct, 0) / totalSignals : 0;
    const totalPnl = allSignals.reduce((a, s) => a + s.pnlPct, 0);

    // Per-edge aggregate
    const edgeMap = new Map<string, { count: number; wins: number; pnl: number }>();
    for (const s of allSignals) {
      const e = edgeMap.get(s.edgeSource) ?? { count: 0, wins: 0, pnl: 0 };
      e.count++;
      if (s.won) e.wins++;
      e.pnl += s.pnlPct;
      edgeMap.set(s.edgeSource, e);
    }
    const byEdge = Array.from(edgeMap.entries()).map(([edge, e]) => ({
      edge, count: e.count, winRate: e.count > 0 ? e.wins / e.count : 0, pnlPct: e.pnl,
    }));

    return NextResponse.json({
      perPair: results.map((r) => ({
        pair: r.pair,
        totalSignals: r.totalSignals,
        winRate: r.winRate,
        avgPnlPct: r.avgPnlPct,
        totalPnlPct: r.totalPnlPct,
        sharpeRatio: r.sharpeRatio,
        maxDrawdownPct: r.maxDrawdownPct,
        avgHoldHours: r.avgHoldHours,
        bestTrade: r.bestTrade,
        worstTrade: r.worstTrade,
        byEdge: r.byEdge,
        description: r.description,
      })),
      aggregate: {
        totalSignals,
        wins,
        losses,
        winRate,
        avgPnlPct: avgPnl,
        totalPnlPct: totalPnl,
        byEdge,
      },
      signals: allSignals.slice(-20), // last 20 signals for inspection
      timestamp: new Date().toISOString(),
    }, { headers: { "Cache-Control": "no-store, max-age=0" } });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "replay failed" }, { status: 500 });
  }
}
