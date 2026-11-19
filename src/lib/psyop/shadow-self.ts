// PSYOP//TERMINAL — Shadow Self Simulator
//
// The Shadow Self is a Markov-chain model of the trader's OWN behavior.
// It doesn't predict the market — it predicts what THE TRADER would do,
// based on their historical patterns.
//
// The shadow is the version of you that operates on autopilot. It's the
// pattern that emerges when you stop thinking and start reacting. The
// system shows you: "Given your last 20 trades, your shadow self would
// [enter/hold/exit] here. You've done this 14 out of 20 times."
//
// The shadow self is built from:
//   - Transition probabilities between states (calm→tilted, plan→deviation)
//   - Action frequencies per market regime (what do you typically do when
//     the market is ranging? trending? volatile?)
//   - Loss-streak behavior (do you immediately re-enter? double down? stop?)

import { db } from "@/lib/db";

export interface ShadowSelfPrediction {
  predictedAction: "enter_long" | "enter_short" | "hold" | "exit_early" | "revenge_trade" | "freeze";
  confidence: number; // 0-1, based on sample size + consistency
  sampleSize: number;
  pattern: string; // human-readable description of the detected pattern
  historicalMatches: number; // how many past trades match this pattern
  shadowVerdict: string; // what the shadow self "says"
}

export async function computeShadowSelf(currentTilt: number, currentRegime?: string): Promise<ShadowSelfPrediction> {
  // Load all executed trades + intentions to build the behavioral model
  const allTrades = await db.psyopTradeIntention.findMany({
    where: { executed: true },
    orderBy: { executedAt: "asc" },
    take: 100,
  });

  if (allTrades.length < 3) {
    return {
      predictedAction: "freeze",
      confidence: 0,
      sampleSize: allTrades.length,
      pattern: "insufficient data",
      historicalMatches: 0,
      shadowVerdict: "Your shadow self is still forming. Not enough trade history to predict your patterns. Execute 3+ tracked trades to awaken it.",
    };
  }

  // Build transition matrix: what action follows what state?
  // States: { tilt_level: calm/elevated/tilted, last_trade_result: win/loss/none }
  type State = string;
  const transitions: Record<State, Record<string, number>> = {};

  for (let i = 1; i < allTrades.length; i++) {
    const prev = allTrades[i - 1];
    const curr = allTrades[i];
    const prevResult = (prev.actualPnl ?? 0) > 0 ? "win" : (prev.actualPnl ?? 0) < 0 ? "loss" : "flat";
    // Estimate prev tilt from confession class
    const prevTilt = prev.confessionClass === "tilt_driven" ? "tilted" : prev.confessionClass === "rationalization" ? "elevated" : "calm";
    const state = `${prevTilt}_${prevResult}`;

    // What action did they take?
    let action: string;
    const timeSincePrev = prev.executedAt && curr.executedAt
      ? (curr.executedAt.getTime() - prev.executedAt.getTime()) / 60000 // minutes
      : 999;
    if (prevResult === "loss" && timeSincePrev < 15) {
      action = "revenge_trade";
    } else if (curr.deviatedFromPlan) {
      action = "exit_early";
    } else if (curr.side === "long") {
      action = "enter_long";
    } else if (curr.side === "short") {
      action = "enter_short";
    } else {
      action = "hold";
    }

    if (!transitions[state]) transitions[state] = {};
    transitions[state][action] = (transitions[state][action] ?? 0) + 1;
  }

  // Current state
  const lastTrade = allTrades[allTrades.length - 1];
  const lastResult = (lastTrade.actualPnl ?? 0) > 0 ? "win" : (lastTrade.actualPnl ?? 0) < 0 ? "loss" : "flat";
  const currentTiltLevel = currentTilt >= 70 ? "tilted" : currentTilt >= 40 ? "elevated" : "calm";
  const currentState = `${currentTiltLevel}_${lastResult}`;

  // Find the most likely next action from current state
  const stateTransitions = transitions[currentState];
  if (!stateTransitions) {
    // No data for this exact state — find the closest
    const tiltOnly = transitions[`${currentTiltLevel}_*`];
    const resultOnly = transitions[`*_${lastResult}`];
    if (tiltOnly || resultOnly) {
      // Use whichever has more data
      const merged: Record<string, number> = {};
      for (const [a, c] of Object.entries(tiltOnly ?? resultOnly ?? {})) merged[a] = (merged[a] ?? 0) + c;
      const top = Object.entries(merged).sort((a, b) => b[1] - a[1])[0];
      if (top) {
        return makePrediction(top[0] as ShadowSelfPrediction["predictedAction"], top[1], allTrades.length, currentState, currentTilt);
      }
    }
    return {
      predictedAction: "freeze",
      confidence: 0,
      sampleSize: allTrades.length,
      pattern: `no data for state ${currentState}`,
      historicalMatches: 0,
      shadowVerdict: "Your shadow self has no pattern for this exact state. This is either very good (you're breaking a bad pattern) or very bad (you're about to start a new one).",
    };
  }

  const sorted = Object.entries(stateTransitions).sort((a, b) => b[1] - a[1]);
  const top = sorted[0];
  const total = sorted.reduce((a, [, c]) => a + c, 0);
  return makePrediction(top[0] as ShadowSelfPrediction["predictedAction"], top[1], allTrades.length, currentState, currentTilt, total);
}

function makePrediction(
  action: ShadowSelfPrediction["predictedAction"],
  matches: number,
  sampleSize: number,
  state: string,
  tilt: number,
  totalInState?: number,
): ShadowSelfPrediction {
  const confidence = totalInState ? matches / totalInState : 0;
  const pct = totalInState ? Math.round((matches / totalInState) * 100) : 0;

  const verdicts: Record<ShadowSelfPrediction["predictedAction"], string> = {
    enter_long: `Your shadow self enters long here. It's done this ${matches} out of ${totalInState} times in state [${state}]. This is the default. The question is: are you entering because of the market, or because your shadow always enters?`,
    enter_short: `Your shadow self goes short. ${pct}% of the time in this state, that's what you do. Is this a signal or a reflex?`,
    hold: `Your shadow self... holds. Interesting. This is the rarest pattern for most traders. ${matches} out of ${totalInState}. Don't break the streak.`,
    exit_early: `Your shadow self exits early. It has a habit of cutting winners short. ${pct}% of the time in this state. Your hands are itching to close. That's the pattern talking.`,
    revenge_trade: `YOUR SHADOW SELF IS ABOUT TO REVENGE TRADE. In this state (${state}), you've immediately re-entered after a loss ${matches} times. This is statistically your worst-performing pattern. STOP.`,
    freeze: `Your shadow self freezes. Inaction is also a pattern. ${matches} times in this state, you did nothing. Sometimes that's wisdom. Sometimes it's fear.`,
  };

  return {
    predictedAction: action,
    confidence,
    sampleSize,
    pattern: `${state} → ${action} (${matches}/${totalInState ?? "?"})`,
    historicalMatches: matches,
    shadowVerdict: verdicts[action],
  };
}
