import { NextRequest, NextResponse } from "next/server";
import { classifyConfession } from "@/lib/psyop/confession";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/psyop/confess
// Body: { text: string, pair?: string, side?: string, plannedEntry?, plannedStop?, plannedTarget? }
//
// Classifies the confession, stores it, and returns the verdict.
// If the confession is classified as tilt_driven and the user's tilt is
// already high, the system returns executeDenied: true.
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const text = (body.text ?? "").toString().trim();
    if (!text) {
      return NextResponse.json({ error: "Confession text is required." }, { status: 400 });
    }

    const result = classifyConfession(text);

    // Store the confession
    const confession = await db.psyopConfession.create({
      data: {
        text,
        wordCount: result.wordCount,
        classified: result.classification,
        hasFomo: result.signals.hasFomo,
        hasRevenge: result.signals.hasRevenge,
        hasLossAversion: result.signals.hasLossAversion,
        hasOverconfidence: result.signals.hasOverconfidence,
        tiltScore: result.tiltContribution,
      },
    });

    // If tilt_driven, block execution
    const executeDenied = result.classification === "tilt_driven";

    return NextResponse.json({
      confessionId: confession.id,
      classification: result.classification,
      wordCount: result.wordCount,
      signals: result.signals,
      tiltContribution: result.tiltContribution,
      verdict: result.verdict,
      executeDenied,
      denialReason: executeDenied
        ? "Your confession was classified as tilt-driven. The system is refusing to let you execute. You can: (a) re-write the confession with specific strategy/risk references, (b) step away for 10 minutes, (c) override with full acknowledgment."
        : null,
    }, { headers: { "Cache-Control": "no-store, max-age=0" } });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "confession failed" }, { status: 500 });
  }
}
