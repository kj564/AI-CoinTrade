import { NextRequest, NextResponse } from "next/server";
import { computeShadowSelf } from "@/lib/psyop/shadow-self";
import { computeTilt } from "@/lib/psyop/tilt-engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/psyop/shadow
// Returns the Shadow Self prediction: what the trader's behavioral pattern
// says they would do right now, based on their trade history.
export async function GET() {
  try {
    const tilt = await computeTilt();
    const shadow = await computeShadowSelf(tilt.total);
    return NextResponse.json({ ...shadow, currentTilt: tilt.total }, { headers: { "Cache-Control": "no-store, max-age=0" } });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "shadow self failed" }, { status: 500 });
  }
}
