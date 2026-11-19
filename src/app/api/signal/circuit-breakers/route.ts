import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { wilsonCI, bootstrapWinRateCI } from "@/lib/trading/alpha-circuit-breaker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 10;

// GET /api/signal/circuit-breakers
//
// Returns per-pair circuit breaker state with Wilson 95% CI + Bootstrap 95% CI
// on win rate. The Wilson is parametric (fast, conservative); the bootstrap is
// non-parametric (slower, more honest under skew/serial correlation).
export async function GET() {
  try {
    const pairs = ["btc_idr", "eth_idr", "sol_idr", "bnb_idr", "xrp_idr"];
    const rows = await Promise.all(
      pairs.map((p) =>
        db.alphaCircuitBreaker.upsert({
          where: { pair: p },
          create: { pair: p },
          update: {},
        }),
      ),
    );

    const now = Math.floor(Date.now() / 1000);
    const out = rows.map((r) => {
      const winRate = r.totalSignals > 0 ? r.totalWins / r.totalSignals : 0;
      const [wilsonCI5, wilsonCI95] = wilsonCI(r.totalWins, r.totalSignals);
      // Bootstrap only meaningful when n >= 5 (otherwise CI is degenerate)
      const [bootCI5, bootCI95] = r.totalSignals >= 5
        ? bootstrapWinRateCI(r.totalWins, r.totalSignals)
        : [0, 0];
      const open = r.circuitOpen && (r.circuitOpenUntil ?? 0) > now;
      return {
        pair: r.pair,
        open,
        consecutiveLosses: r.consecutiveLosses,
        totalSignals: r.totalSignals,
        totalWins: r.totalWins,
        totalLosses: r.totalLosses,
        winRate,
        // Wilson (parametric)
        winRateCI5: wilsonCI5,
        winRateCI95: wilsonCI95,
        ciWidth: wilsonCI95 - wilsonCI5,
        // Bootstrap (non-parametric, 1000 resamples)
        winRateBootstrapCI5: bootCI5,
        winRateBootstrapCI95: bootCI95,
        bootstrapCIWidth: bootCI95 - bootCI5,
        ciSampleAdequate: r.totalSignals >= 20,
        trips: r.circuitTrips,
        cooldownSec: r.circuitOpenUntil ? r.circuitOpenUntil - now : 0,
        lastSignalAt: r.lastSignalAt,
        lastSignalAction: r.lastSignalAction,
        lastSignalOutcome: r.lastSignalOutcome,
        updatedAt: r.updatedAt,
      };
    });

    return NextResponse.json({ breakers: out, timestamp: new Date().toISOString() }, { headers: { "Cache-Control": "no-store, max-age=0" } });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "circuit-breakers failed" }, { status: 500 });
  }
}
