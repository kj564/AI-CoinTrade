import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { computeTilt } from "@/lib/psyop/tilt-engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/psyop/profile
// Returns the aggregated behavioral profile + recent confessions + badges.
export async function GET() {
  try {
    const profile = await db.psyopProfile.upsert({ where: { id: "singleton" }, create: {}, update: {} });
    const tilt = await computeTilt();

    const recentIntentions = await db.psyopTradeIntention.findMany({
      orderBy: { createdAt: "desc" },
      take: 10,
    });

    const recentConfessions = await db.psyopConfession.findMany({
      orderBy: { createdAt: "desc" },
      take: 5,
    });

    // Compute inverted badges
    const badges: { id: string; label: string; severity: string; description: string; earned: boolean }[] = [];
    const totalDevs = profile.totalDeviations;
    const totalExecs = profile.totalExecutions;

    // Revenge Trader: deviated after loss within 15 min
    const revengeTrades = recentIntentions.filter((t) => t.exitReason === "revenge_exit");
    badges.push({
      id: "revenge_trader",
      label: "REVENGE TRADER",
      severity: "critical",
      description: "Immediately re-entered after a loss",
      earned: revengeTrades.length >= 2,
    });

    // Paper Hands: exited early (heldMinutes < plannedHoldMin * 0.3)
    const paperHands = recentIntentions.filter((t) => t.heldMinutes !== null && t.plannedHoldMin > 0 && (t.heldMinutes ?? 0) < t.plannedHoldMin * 0.3);
    badges.push({
      id: "paper_hands",
      label: "PAPER HANDS",
      severity: "warn",
      description: "Closed positions before planned hold time",
      earned: paperHands.length >= 2,
    });

    // FOMO Victim: multiple tilt_driven confessions
    const fomoConfessions = recentConfessions.filter((c) => c.hasFomo);
    badges.push({
      id: "fomo_victim",
      label: "FOMO VICTIM",
      severity: "error",
      description: "Confessions contain FOMO language",
      earned: fomoConfessions.length >= 2,
    });

    // Plan breaker
    const deviationRate = totalExecs > 0 ? totalDevs / totalExecs : 0;
    badges.push({
      id: "plan_breaker",
      label: "PLAN BREAKER",
      severity: "error",
      description: `${Math.round(deviationRate * 100)}% of trades deviated from plan`,
      earned: deviationRate > 0.3,
    });

    // Discipline (positive, but stated plainly)
    badges.push({
      id: "disciplined",
      label: "DISCIPLINED",
      severity: "info",
      description: "Plan adherence > 70%",
      earned: deviationRate < 0.3 && totalExecs >= 5,
    });

    return NextResponse.json({
      profile: {
        totalIntentions: profile.totalIntentions,
        totalExecutions: profile.totalExecutions,
        totalDeviations: profile.totalDeviations,
        currentTilt: tilt.total,
        maxTilt: profile.maxTilt,
        avgTilt: profile.avgTilt,
        planAdherenceRate: profile.planAdherenceRate,
        tiltState: tilt.state,
      },
      badges,
      recentIntentions: recentIntentions.map((t) => ({
        id: t.id,
        pair: t.pair,
        side: t.side,
        confessionClass: t.confessionClass,
        executed: t.executed,
        deviatedFromPlan: t.deviatedFromPlan,
        actualPnl: t.actualPnl,
        heldMinutes: t.heldMinutes,
        createdAt: t.createdAt,
      })),
      recentConfessions: recentConfessions.map((c) => ({
        id: c.id,
        text: c.text.slice(0, 120) + (c.text.length > 120 ? "…" : ""),
        classified: c.classified,
        wordCount: c.wordCount,
        createdAt: c.createdAt,
      })),
    }, { headers: { "Cache-Control": "no-store, max-age=0" } });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "profile failed" }, { status: 500 });
  }
}
