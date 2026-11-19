import { NextRequest, NextResponse } from "next/server";
import { computeTilt } from "@/lib/psyop/tilt-engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/psyop/tilt
// Returns the real-time tilt score + breakdown.
export async function GET() {
  try {
    const tilt = await computeTilt();
    return NextResponse.json(tilt, { headers: { "Cache-Control": "no-store, max-age=0" } });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "tilt compute failed" }, { status: 500 });
  }
}
