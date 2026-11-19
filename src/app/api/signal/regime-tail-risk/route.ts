import { NextResponse } from "next/server";
import { getRegimeConditionedTailRisk } from "@/lib/trading/var-es";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 10;

// GET /api/signal/regime-tail-risk
//
// Returns VaR/ES conditioned on the market regime at signal time. Different
// regimes have different loss distributions — trend_follow vs mean_revert may
// have very different tail characteristics.
export async function GET() {
  try {
    const result = await getRegimeConditionedTailRisk();
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store, max-age=0" } });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "regime-tail-risk failed" }, { status: 500 });
  }
}
