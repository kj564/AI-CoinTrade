import { NextResponse } from "next/server";
import { getCorrelationMatrix, computeConcentrationPenalty, getDynamicCorrelationMatrix } from "@/lib/trading/correlation-matrix";
import { getCorrelationCacheStatus } from "@/lib/trading/dynamic-correlation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 10;

// GET /api/signal/correlation?pair=eth_idr&action=LONG&capital=10000000
//
// Returns the DYNAMIC correlation matrix (from 30d rolling returns, cached 1h)
// + concentration penalty for a potential new position in `pair` with `action`.
// Falls back to static matrix if dynamic computation fails.
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const pair = url.searchParams.get("pair");
    const action = (url.searchParams.get("action") || "LONG").toUpperCase();
    const capital = parseFloat(url.searchParams.get("capital") || "10000000");

    // Try dynamic matrix first (cached, falls back to static)
    const { matrix, source, sampleSize, ageSec } = await getDynamicCorrelationMatrix();
    const cacheStatus = getCorrelationCacheStatus();

    if (!pair) {
      return NextResponse.json({
        matrix,
        source,
        sampleSize,
        ageSec,
        shrinkageIntensity: cacheStatus.shrinkageIntensity,
        shrinkageMethod: "ledoit_wolf_identity",
        cacheTtlSec: 3600,
        staticMatrix: getCorrelationMatrix(),
        timestamp: new Date().toISOString(),
      });
    }

    const penalty = await computeConcentrationPenalty(pair, action, capital);
    return NextResponse.json({
      pair,
      action,
      ...penalty,
      matrix,
      source,
      sampleSize,
      ageSec,
      shrinkageIntensity: cacheStatus.shrinkageIntensity,
      cacheStatus,
      timestamp: new Date().toISOString(),
    }, { headers: { "Cache-Control": "no-store, max-age=0" } });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "correlation failed" }, { status: 500 });
  }
}
