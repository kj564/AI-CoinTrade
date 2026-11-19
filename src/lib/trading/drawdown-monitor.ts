// Portfolio-level drawdown monitor + dynamic risk scaler (anti-martingale)
// + recovery ramp (anti-V-shape) + weekly loss pause.
//
// Capital protection layers (3-tier defense):
//
//   LAYER 1 — Drawdown tier (instantaneous)
//     Drawdown %      Multiplier    Label
//     <  0%           1.00x         in_profit
//      0% → -3%       1.00x         neutral
//     -3% → -5%       0.75x         cautious
//     -5% → -8%       0.50x         half_size
//     -8% → -10%      0.25x         quarter_size
//     < -10%          0.00x         halted (HALT)
//
//   LAYER 2 — Recovery ramp (anti-V-shape, persisted in PortfolioRiskState)
//     When halt triggers → record haltedAt, suppress ALL new positions.
//     When drawdown recovers above -8% → record recoveryStartedAt.
//     Multiplier ramps over 7 days:
//       Day 0-1 (probe):    cap at 0.25x
//       Day 1-3 (cautious): cap at 0.50x
//       Day 3-7 (steady):   cap at 0.75x
//       Day 7+  (full):     cap at 1.00x (resume normal)
//     The ramp cap takes the MIN vs the drawdown multiplier — so if drawdown
//     re-worsens during recovery, the smaller of (drawdown mult, ramp cap) wins.
//
//   LAYER 3 — Weekly loss pause (persisted in PortfolioRiskState)
//     If rolling 7-day realized P&L < -3% of capital → pause ALL new positions
//     until next Monday 00:00 Jakarta time. Prevents revenge trading + tilt.
//     Auto-recovers on Monday (no manual intervention needed).
//
// Final effective multiplier = min(drawdown_mult, ramp_cap).
// If weekly loss pause active OR halted → multiplier = 0.00x.

import { db } from "@/lib/db";

export const DRAWDOWN_TIERS = [
  { maxDrawdownPct: 0,    multiplier: 1.00, label: "in_profit" },
  { maxDrawdownPct: -3,   multiplier: 1.00, label: "neutral" },
  { maxDrawdownPct: -5,   multiplier: 0.75, label: "cautious" },
  { maxDrawdownPct: -8,   multiplier: 0.50, label: "half_size" },
  { maxDrawdownPct: -10,  multiplier: 0.25, label: "quarter_size" },
  { maxDrawdownPct: -100, multiplier: 0.00, label: "halted" },
] as const;

export const DRAWDOWN_HALT_PCT = -10;
export const DRAWDOWN_RECOVERY_PCT = -8;
export const DRAWDOWN_ALERT_THRESHOLD_PCT = -5;
export const DRAWDOWN_ALERT_COOLDOWN_SEC = 3600;

// Daily loss pause — tighter than weekly. Prevents tilt-driven overtrading
// within a single session. If 24h rolling P&L <= -1.5% of capital, pause
// new positions until next midnight Jakarta.
export const DAILY_LOSS_THRESHOLD_PCT = -1.5;

// Recovery ramp stages (in seconds since recoveryStartedAt).
const RAMP_STAGES = [
  { maxAgeSec: 86400,  multiplier: 0.25, stage: 1, label: "probe" },     // 0-24h
  { maxAgeSec: 259200, multiplier: 0.50, stage: 2, label: "cautious" },  // 24-72h
  { maxAgeSec: 604800, multiplier: 0.75, stage: 3, label: "steady" },    // 72-168h
  { maxAgeSec: Infinity, multiplier: 1.00, stage: 4, label: "full" },    // >168h
] as const;

export const WEEKLY_LOSS_THRESHOLD_PCT = -3.0; // -3% of capital in 7 days → pause

export interface DrawdownState {
  cumulativePnlIdr: number;
  cumulativePnlPct: number;
  peakPnlIdr: number;
  troughPnlIdr: number;
  currentDrawdownPct: number;
  isHalted: boolean;
  // Final effective multiplier (after drawdown tier + recovery ramp + weekly pause)
  riskMultiplier: number;
  // Drawdown-only multiplier (before ramp/pause) — for UI transparency
  drawdownMultiplier: number;
  rampMultiplierCap: number;
  rampStage: number;          // 0=none, 1=probe, 2=cautious, 3=steady, 4=full
  rampStageLabel: string;     // none | probe | cautious | steady | full
  rampAgeHours: number;       // hours since recoveryStartedAt
  riskTierLabel: string;
  closedSignals: number;
  alertThresholdPct: number;
  recoveryThresholdPct: number;
  // Weekly loss pause
  weeklyLossPct: number;
  weeklyLossPauseActive: boolean;
  weeklyPauseExpiresAt: number | null;
  weeklyLossStartedAt: number | null;
  // Daily loss pause (tighter than weekly — prevents intra-day tilt)
  dailyLossPct: number;
  dailyLossPauseActive: boolean;
  dailyPauseExpiresAt: number | null;
  dailyLossStartedAt: number | null;
  // Halt/recovery metadata
  haltedAt: number | null;
  recoveryStartedAt: number | null;
  computedAt: string;
}

// Compute next Monday 00:00 Jakarta time (Asia/Jakarta = UTC+7).
function nextMondayMidnightJakarta(): number {
  const now = new Date();
  // Jakarta is UTC+7. Compute current Jakarta wall-clock time.
  const jakartaOffsetMs = 7 * 3600 * 1000;
  const jakartaNow = new Date(now.getTime() + jakartaOffsetMs);
  // Find next Monday in Jakarta local time.
  const day = jakartaNow.getUTCDay(); // 0=Sun, 1=Mon
  const daysUntilMonday = (day === 0 ? 1 : 8 - day);
  const mondayJakarta = new Date(jakartaNow);
  mondayJakarta.setUTCDate(jakartaNow.getUTCDate() + daysUntilMonday);
  mondayJakarta.setUTCHours(0, 0, 0, 0);
  // Convert back to unix sec (Jakarta time → UTC by subtracting offset).
  return Math.floor(mondayJakarta.getTime() / 1000) - 7 * 3600;
}

// Compute next midnight Jakarta time (00:00 next day, Asia/Jakarta = UTC+7).
function nextMidnightJakarta(): number {
  const now = new Date();
  const jakartaOffsetMs = 7 * 3600 * 1000;
  const jakartaNow = new Date(now.getTime() + jakartaOffsetMs);
  // Next midnight in Jakarta = tomorrow 00:00 Jakarta.
  const tomorrowJakarta = new Date(jakartaNow);
  tomorrowJakarta.setUTCDate(jakartaNow.getUTCDate() + 1);
  tomorrowJakarta.setUTCHours(0, 0, 0, 0);
  return Math.floor(tomorrowJakarta.getTime() / 1000) - 7 * 3600;
}

// Main entry: compute full portfolio risk state with all 3 layers.
export async function getDrawdownState(capitalIdr = 10_000_000): Promise<DrawdownState> {
  const closed = await db.signalJournal.findMany({
    where: { status: { not: "open" } },
    orderBy: { createdAt: "asc" },
  });

  const cumulativePnlIdr = closed.reduce((a, s) => a + (s.pnlIdr ?? 0), 0);
  const cumulativePnlPct = (cumulativePnlIdr / capitalIdr) * 100;

  // Peak / trough from closed-trade sequence
  let cum = 0, peak = 0, trough = 0;
  for (const s of closed) {
    cum += s.pnlIdr ?? 0;
    if (cum > peak) peak = cum;
    if (cum < trough) trough = cum;
  }

  const currentDrawdownPct = peak > cum ? ((cum - peak) / capitalIdr) * 100 : 0;

  // LAYER 1: drawdown tier multiplier
  const tier = DRAWDOWN_TIERS.find((t) => currentDrawdownPct > t.maxDrawdownPct) ?? DRAWDOWN_TIERS[DRAWDOWN_TIERS.length - 1];
  const drawdownMultiplier = tier.multiplier;
  const drawdownHalted = currentDrawdownPct <= DRAWDOWN_HALT_PCT;

  // LAYER 3: rolling 7-day P&L for weekly loss pause
  const sevenDaysAgoSec = Math.floor(Date.now() / 1000) - 7 * 86400;
  const weeklyPnlIdr = closed
    .filter((s) => s.exitTime && s.exitTime > sevenDaysAgoSec)
    .reduce((a, s) => a + (s.pnlIdr ?? 0), 0);
  const weeklyLossPct = (weeklyPnlIdr / capitalIdr) * 100;

  // LAYER 3b: rolling 24h P&L for daily loss pause (tighter than weekly)
  const oneDayAgoSec = Math.floor(Date.now() / 1000) - 86400;
  const dailyPnlIdr = closed
    .filter((s) => s.exitTime && s.exitTime > oneDayAgoSec)
    .reduce((a, s) => a + (s.pnlIdr ?? 0), 0);
  const dailyLossPct = (dailyPnlIdr / capitalIdr) * 100;

  // Load or init persisted PortfolioRiskState (singleton)
  const riskState = await db.portfolioRiskState.upsert({
    where: { id: "singleton" },
    create: { id: "singleton" },
    update: {},
  });

  const nowSec = Math.floor(Date.now() / 1000);

  // ── HALT TRANSITION ──
  let haltedAt = riskState.haltedAt;
  let haltDrawdownPct = riskState.haltDrawdownPct;
  if (drawdownHalted && !haltedAt) {
    // Halt just triggered
    haltedAt = nowSec;
    haltDrawdownPct = currentDrawdownPct;
  } else if (!drawdownHalted && haltedAt) {
    // Drawdown recovered above -10% (but maybe still below -8% — recovery ramp
    // only starts when above -8%). If above -8%, start ramp.
    // (We don't clear haltedAt here — it stays as historical record until
    //  recovery completes the full 7-day ramp.)
  }

  // ── RECOVERY RAMP ──
  let recoveryStartedAt = riskState.recoveryStartedAt;
  let recoveryStage = 0;
  let recoveryMultiplierCap = 1.0;
  let rampStageLabel = "none";
  let rampAgeHours = 0;

  const inRecoveryZone = currentDrawdownPct > DRAWDOWN_RECOVERY_PCT; // > -8%
  if (inRecoveryZone && haltedAt && !recoveryStartedAt) {
    // Recovery just started
    recoveryStartedAt = nowSec;
  }

  if (recoveryStartedAt) {
    const rampAgeSec = nowSec - recoveryStartedAt;
    rampAgeHours = rampAgeSec / 3600;
    // If drawdown re-worsens below -8% during ramp, reset recoveryStartedAt
    if (currentDrawdownPct <= DRAWDOWN_RECOVERY_PCT) {
      // Still in drawdown zone — pause ramp (don't reset, keep the clock running
      // only when above -8%). Actually: if drawdown worsens again, we should
      // RESET the ramp to restart from probe when it recovers again.
      recoveryStartedAt = nowSec; // restart the clock
      rampAgeHours = 0;
    }
    const stage = RAMP_STAGES.find((s) => rampAgeSec <= s.maxAgeSec) ?? RAMP_STAGES[RAMP_STAGES.length - 1];
    recoveryStage = stage.stage;
    recoveryMultiplierCap = stage.multiplier;
    rampStageLabel = stage.label;
    // If ramp completed (stage 4, >7 days), clear halt + recovery markers
    if (recoveryStage === 4 && currentDrawdownPct > 0) {
      haltedAt = null;
      recoveryStartedAt = null;
      haltDrawdownPct = 0;
    }
  } else if (!haltedAt) {
    // Normal operation — no ramp needed
    recoveryStage = 0;
    recoveryMultiplierCap = 1.0;
    rampStageLabel = "none";
  }

  // ── WEEKLY LOSS PAUSE ──
  let weeklyLossPauseActive = riskState.weeklyLossPauseActive;
  let weeklyLossStartedAt = riskState.weeklyLossStartedAt;
  let weeklyPauseExpiresAt = riskState.weeklyPauseExpiresAt;

  // Check expiry first
  if (weeklyLossPauseActive && weeklyPauseExpiresAt && nowSec >= weeklyPauseExpiresAt) {
    weeklyLossPauseActive = false;
    weeklyLossStartedAt = null;
    weeklyPauseExpiresAt = null;
  }

  // Check trigger
  if (!weeklyLossPauseActive && weeklyLossPct <= WEEKLY_LOSS_THRESHOLD_PCT) {
    weeklyLossPauseActive = true;
    weeklyLossStartedAt = nowSec;
    weeklyPauseExpiresAt = nextMondayMidnightJakarta();
  } else if (weeklyLossPauseActive && weeklyLossPct > 0) {
    // If P&L recovered above 0% this week, clear pause early (positive week = no tilt)
    weeklyLossPauseActive = false;
    weeklyLossStartedAt = null;
    weeklyPauseExpiresAt = null;
  }

  // ── DAILY LOSS PAUSE (tighter than weekly — prevents intra-day tilt) ──
  let dailyLossPauseActive = riskState.dailyLossPauseActive;
  let dailyLossStartedAt = riskState.dailyLossStartedAt;
  let dailyPauseExpiresAt = riskState.dailyPauseExpiresAt;

  // Check expiry first (auto-clears at next midnight Jakarta)
  if (dailyLossPauseActive && dailyPauseExpiresAt && nowSec >= dailyPauseExpiresAt) {
    dailyLossPauseActive = false;
    dailyLossStartedAt = null;
    dailyPauseExpiresAt = null;
  }

  // Check trigger (only if not already paused for a stronger reason)
  if (!dailyLossPauseActive && dailyLossPct <= DAILY_LOSS_THRESHOLD_PCT) {
    dailyLossPauseActive = true;
    dailyLossStartedAt = nowSec;
    dailyPauseExpiresAt = nextMidnightJakarta();
    // Fire alert (delayed import to avoid circular dep)
    try {
      const { dispatchSignalEvent } = await import("./signal-alerts");
      await dispatchSignalEvent({
        type: "drawdown_breach",
        severity: "error",
        message: `🛑 [ERROR] DAILY LOSS PAUSE: ${dailyLossPct.toFixed(2)}%\n\n24h rolling P&L breached -1.5% threshold.\nNew positions suppressed until next midnight WIB.\nThis prevents intra-day tilt-driven overtrading.\n\n_${new Date().toISOString()}_`,
        metadata: { layer: "daily_loss_pause", dailyLossPct, threshold: DAILY_LOSS_THRESHOLD_PCT, expiresAt: dailyPauseExpiresAt },
      });
    } catch { /* ignore */ }
  } else if (dailyLossPauseActive && dailyLossPct > 0) {
    // If P&L recovered above 0% same day, clear pause early
    dailyLossPauseActive = false;
    dailyLossStartedAt = null;
    dailyPauseExpiresAt = null;
  }

  // ── FINAL EFFECTIVE MULTIPLIER ──
  let effectiveMultiplier: number;
  const anyPauseActive = drawdownHalted || weeklyLossPauseActive || dailyLossPauseActive;
  if (anyPauseActive) {
    effectiveMultiplier = 0.0;
  } else {
    effectiveMultiplier = Math.min(drawdownMultiplier, recoveryMultiplierCap);
  }

  // Persist updated state
  await db.portfolioRiskState.update({
    where: { id: "singleton" },
    data: {
      haltedAt,
      haltDrawdownPct,
      recoveryStartedAt,
      recoveryStage,
      recoveryMultiplierCap,
      weeklyLossPauseActive,
      weeklyLossStartedAt,
      weeklyLossPct,
      weeklyPauseExpiresAt,
      dailyLossPauseActive,
      dailyLossStartedAt,
      dailyLossPct,
      dailyPauseExpiresAt,
      lastDrawdownPct: currentDrawdownPct,
      lastMultiplier: effectiveMultiplier,
      lastComputedAt: nowSec,
    },
  }).catch((e) => {
    console.warn("[drawdown-monitor] failed to persist risk state:", e instanceof Error ? e.message : e);
  });

  // Determine halt reason (priority: daily > weekly > drawdown, since daily is tightest)
  const haltReason = dailyLossPauseActive
    ? "daily_loss_pause"
    : weeklyLossPauseActive
      ? "weekly_loss_pause"
      : drawdownHalted
        ? "drawdown_halt"
        : null;

  return {
    cumulativePnlIdr,
    cumulativePnlPct,
    peakPnlIdr: peak,
    troughPnlIdr: trough,
    currentDrawdownPct,
    // isHalted = any of the 3 pause layers active (all force FLAT)
    isHalted: anyPauseActive,
    haltReason,
    riskMultiplier: effectiveMultiplier,
    drawdownMultiplier,
    rampMultiplierCap: recoveryMultiplierCap,
    rampStage: recoveryStage,
    rampStageLabel,
    rampAgeHours,
    riskTierLabel: tier.label,
    closedSignals: closed.length,
    alertThresholdPct: DRAWDOWN_ALERT_THRESHOLD_PCT,
    recoveryThresholdPct: DRAWDOWN_RECOVERY_PCT,
    weeklyLossPct,
    weeklyLossPauseActive,
    weeklyPauseExpiresAt,
    weeklyLossStartedAt,
    dailyLossPct,
    dailyLossPauseActive,
    dailyPauseExpiresAt,
    dailyLossStartedAt,
    haltedAt,
    recoveryStartedAt,
    computedAt: new Date().toISOString(),
  };
}

// Convenience: just the multiplier. Used by alpha-engine to scale risk per trade.
export async function getDynamicRiskMultiplier(capitalIdr = 10_000_000): Promise<{
  multiplier: number;
  label: string;
  isHalted: boolean;
  drawdownPct: number;
  weeklyLossPauseActive: boolean;
  dailyLossPauseActive: boolean;
  rampStage: number;
}> {
  const state = await getDrawdownState(capitalIdr);
  return {
    multiplier: state.riskMultiplier,
    label: state.riskTierLabel,
    isHalted: state.isHalted,
    drawdownPct: state.currentDrawdownPct,
    weeklyLossPauseActive: state.weeklyLossPauseActive,
    dailyLossPauseActive: state.dailyLossPauseActive,
    rampStage: state.rampStage,
  };
}

export function applyRiskMultiplier(baseRiskPct: number, multiplier: number): number {
  return Math.max(0, baseRiskPct * multiplier);
}

export function shouldHaltNewPositions(state: DrawdownState): boolean {
  return state.isHalted || state.weeklyLossPauseActive || state.dailyLossPauseActive;
}
