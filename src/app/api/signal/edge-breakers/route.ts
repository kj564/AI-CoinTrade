import { NextResponse } from "next/server";
import { getAllEdgeCircuitBreakers } from "@/lib/trading/edge-circuit-breaker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 10;

// GET /api/signal/edge-breakers
//
// Returns all per-edge circuit breakers (pair × edgeSource) that have either
// signals recorded or are currently open. Finer granularity than per-pair CB.
export async function GET() {
  try {
    const breakers = await getAllEdgeCircuitBreakers();
    return NextResponse.json({ breakers, count: breakers.length, timestamp: new Date().toISOString() }, { headers: { "Cache-Control": "no-store, max-age=0" } });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "edge-breakers failed" }, { status: 500 });
  }
}
