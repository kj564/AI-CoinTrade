// PSYOP//TERMINAL — Tilt Index Engine
//
// The tilt score (0-100) measures how emotionally compromised the trader is.
// It's computed from their RECENT behavioral patterns, not market data:
//
//   1. Trade frequency surge     — rapid-fire intentions = escalating urgency
//   2. Loss streak pressure      — consecutive losses compress decision quality
//   3. Plan deviation rate       — abandoning plans = loss of discipline
//   4. Session fatigue           — long sessions degrade judgment (sleep dep curve)
//   5. Confession quality decay  — shorter/tilt-laden confessions = rationalization
//   6. Revenge window            — time since last loss < 10min = revenge zone
//
// Above 70: the UI enters "FRICTION MODE" — execute button shrinks, moves,
// requires extra confirmation. Above 85: "LOCKDOWN" — execute is blocked,
// only "step away" timer is available.

import { db } from "@/lib/db";

export interface TiltBreakdown {
  total: number; // 0-100
  factors: {
    tradeFrequency: number;     // 0-25 — rapid-fire intentions in last 30min
    lossStreak: number;         // 0-25 — consecutive recent losses
    planDeviation: number;      // 0-20 — deviation rate in last 10 intentions
    sessionFatigue: number;     // 0-15 — minutes in current session (sigmoid)
    confessionDecay: number;    // 0-10 — avg confession quality trend
    revengeWindow: number;      // 0-5 — active if last loss < 10min ago
  };
  state: "calm" | "elevated" | "tilted" | "friction" | "lockdown";
  recommendation: string;
}

// Sigmoid for session fatigue — degrades slowly then rapidly after 2h.
function fatigueScore(minutesInSession: number): number {
  if (minutesInSession <= 0) return 0;
  // Sweet spot: 0-90min = minimal fatigue. 90-180min = rising. >180 = steep.
  if (minutesInSession <= 90) return (minutesInSession / 90) * 3; // 0-3
  if (minutesInSession <= 180) return 3 + ((minutesInSession - 90) / 90) * 7; // 3-10
  if (minutesInSession <= 360) return 10 + ((minutesInSession - 180) / 180) * 5; // 10-15
  return 15;
}

export async function computeTilt(): Promise<TiltBreakdown> {
  const now = Math.floor(Date.now() / 1000);

  // Get profile (or default)
  const profile = await db.psyopProfile.upsert({
    where: { id: "singleton" },
    create: {},
    update: {},
  });

  // 1. Trade frequency: count intentions in last 30min
  const recentIntentions = await db.psyopTradeIntention.count({
    where: {
      createdAt: { gte: new Date((now - 1800) * 1000) },
    },
  });
  // 0 intentions = 0. 1-2 = calm. 3-4 = elevated. 5+ = rapid-fire.
  const tradeFrequency = Math.min(25, recentIntentions * 6);

  // 2. Loss streak: find recent executed trades, count consecutive losses
  const recentExecuted = await db.psyopTradeIntention.findMany({
    where: { executed: true, actualPnl: { not: null } },
    orderBy: { executedAt: "desc" },
    take: 10,
  });
  let lossStreak = 0;
  for (const t of recentExecuted) {
    if ((t.actualPnl ?? 0) < 0) lossStreak++;
    else break;
  }
  const lossStreakScore = Math.min(25, lossStreak * 8);

  // 3. Plan deviation rate (last 10 intentions)
  const last10Intentions = await db.psyopTradeIntention.findMany({
    orderBy: { createdAt: "desc" },
    take: 10,
  });
  const deviations = last10Intentions.filter((t) => t.deviatedFromPlan).length;
  const deviationRate = last10Intentions.length > 0 ? deviations / last10Intentions.length : 0;
  const planDeviation = Math.round(deviationRate * 20);

  // 4. Session fatigue
  const sessionStart = profile.currentSessionStart ?? now;
  const minutesInSession = Math.floor((now - sessionStart) / 60);
  const sessionFatigue = Math.round(fatigueScore(minutesInSession));

  // 5. Confession quality decay — compare last 3 confessions' word counts to prior 7
  const recentConfessions = await db.psyopConfession.findMany({
    orderBy: { createdAt: "desc" },
    take: 10,
  });
  let confessionDecay = 0;
  if (recentConfessions.length >= 3) {
    const last3 = recentConfessions.slice(0, 3);
    const prior = recentConfessions.slice(3);
    const avgLast3 = last3.reduce((a, c) => a + c.wordCount, 0) / Math.max(1, last3.length);
    const avgPrior = prior.length > 0 ? prior.reduce((a, c) => a + c.wordCount, 0) / prior.length : avgLast3;
    // If recent confessions are SHORTER than prior, quality is decaying = tilt rising
    if (avgPrior > 0 && avgLast3 < avgPrior * 0.7) {
      confessionDecay = Math.min(10, Math.round((1 - avgLast3 / avgPrior) * 10));
    }
  }

  // 6. Revenge window: was the last executed trade a loss, < 10min ago?
  let revengeWindow = 0;
  if (recentExecuted.length > 0) {
    const lastTrade = recentExecuted[0];
    const lastTradeTs = lastTrade.executedAt ? Math.floor(lastTrade.executedAt.getTime() / 1000) : 0;
    const minsSinceLastTrade = (now - lastTradeTs) / 60;
    if ((lastTrade.actualPnl ?? 0) < 0 && minsSinceLastTrade < 10) {
      revengeWindow = 5;
    }
  }

  const factors = {
    tradeFrequency,
    lossStreak: lossStreakScore,
    planDeviation,
    sessionFatigue,
    confessionDecay,
    revengeWindow,
  };

  const total = Math.min(100, Object.values(factors).reduce((a, b) => a + b, 0));

  let state: TiltBreakdown["state"] = "calm";
  let recommendation = "";
  if (total >= 85) {
    state = "lockdown";
    recommendation = "LOCKDOWN. You are statistically certain to lose money right now. Step away for 15 minutes. The execute button is disabled.";
  } else if (total >= 70) {
    state = "friction";
    recommendation = "FRICTION MODE. Your behavioral fingerprint says this is tilt-driven. The execute button will fight you. Re-read your last 3 confessions before proceeding.";
  } else if (total >= 45) {
    state = "tilted";
    recommendation = "Elevated tilt detected. You're entering the zone where 78% of trades deviate from plan. Slow down.";
  } else if (total >= 25) {
    state = "elevated";
    recommendation = "Slightly elevated. Stay aware of your breathing. Don't trade faster than you can think.";
  } else {
    recommendation = "Calm. Your discipline metrics are within normal range. This is when your best decisions happen.";
  }

  // Update profile current tilt
  await db.psyopProfile.update({
    where: { id: "singleton" },
    data: {
      currentTilt: total,
      maxTilt: Math.max(profile.maxTilt, total),
    },
  }).catch(() => {});

  return { total, factors, state, recommendation };
}
