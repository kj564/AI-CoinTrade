// Signal-event alerting — Telegram + Slack + DB log for portfolio-level events.
//
// Five event types, all persisted to PortfolioAlertEvent for audit:
//   1. signal_fired     — new actionable signal journaled (LONG/SHORT)
//   2. signal_closed    — open signal hit stop/target (win/loss reported)
//   3. circuit_tripped  — per-pair CB crossed 3 consecutive losses
//   4. drawdown_breach  — portfolio drawdown crossed alert threshold
//   5. paper_vs_replay_deviation — actual P&L deviates >15% from replay expectation
//
// De-duplication:
//   - signal_fired: per-pair (only one open signal per pair, so natural dedup)
//   - signal_closed: per-signal-id (one close per signal)
//   - circuit_tripped: per-pair + cooldown (1h between re-trip alerts)
//   - drawdown_breach: 1h cooldown between alerts of same severity
//
// Channel routing (severity-based):
//   CRITICAL (drawdown <-10%, circuit tripped) → all configured channels
//   ERROR    (signal closed loss, drawdown <-5%) → telegram + slack
//   WARN     (signal fired, drawdown breach) → telegram + slack
//   INFO     (signal closed win, recovery) → log only, no push

import { db } from "@/lib/db";
import { sendTelegram } from "@/lib/telegram";

export type SignalEventType =
  | "signal_fired"
  | "signal_closed"
  | "circuit_tripped"
  | "drawdown_breach"
  | "paper_vs_replay_deviation"
  | "recovery";

export type SignalEventSeverity = "info" | "warn" | "error" | "critical";

export interface SignalEvent {
  type: SignalEventType;
  severity: SignalEventSeverity;
  pair?: string;
  message: string;
  metadata?: Record<string, any>;
}

const CHANNEL_COOLDOWN_SEC: Record<SignalEventType, number> = {
  signal_fired: 0,                // natural dedup via journal
  signal_closed: 0,               // one per signal id
  circuit_tripped: 3600,          // 1h between same-pair trip alerts
  drawdown_breach: 3600,          // 1h between breach alerts
  paper_vs_replay_deviation: 86400, // daily (weekly review picks it up)
  recovery: 3600,
};

// Dispatch a signal event: persist to DB + push to channels per severity.
// Returns the alert event id (or null on failure).
export async function dispatchSignalEvent(event: SignalEvent): Promise<string | null> {
  // De-dup check: look for a recent alert of the same type+pair within cooldown
  const cooldownSec = CHANNEL_COOLDOWN_SEC[event.type] ?? 0;
  if (cooldownSec > 0) {
    const sinceTs = new Date(Date.now() - cooldownSec * 1000);
    const recent = await db.portfolioAlertEvent.findFirst({
      where: {
        type: event.type,
        pair: event.pair ?? null,
        createdAt: { gt: sinceTs },
      },
    });
    if (recent) {
      // Silently skip (already alerted within cooldown)
      return recent.id;
    }
  }

  // Persist the event
  const entry = await db.portfolioAlertEvent.create({
    data: {
      type: event.type,
      severity: event.severity,
      pair: event.pair ?? null,
      message: event.message,
      metadataJson: JSON.stringify(event.metadata ?? {}),
      delivered: false,
    },
  }).catch((e) => {
    console.warn("[signal-alerts] failed to persist event:", e instanceof Error ? e.message : e);
    return null;
  });
  if (!entry) return null;

  // Route to channels per severity
  const channels: string[] = [];
  const shouldPush = event.severity === "critical" || event.severity === "error" || event.severity === "warn";

  if (shouldPush) {
    // Telegram (always for pushed events)
    const tgConfig = await db.botConfig.findUnique({ where: { id: "singleton" } }).catch(() => null);
    if (tgConfig?.telegramToken && tgConfig?.telegramChatId) {
      try {
        const ok = await sendTelegram(tgConfig.telegramToken, tgConfig.telegramChatId, event.message);
        if (ok) channels.push("telegram");
      } catch (e) {
        console.warn("[signal-alerts] telegram failed:", e instanceof Error ? e.message : e);
      }
    }

    // Slack (CRITICAL + ERROR only)
    const slackUrl = process.env.L2_ALERT_SLACK_WEBHOOK_URL;
    if (slackUrl && (event.severity === "critical" || event.severity === "error")) {
      try {
        const r = await fetch(slackUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text: `[${event.severity.toUpperCase()}] ${event.type.replace(/_/g, " ")}`,
            attachments: [{
              color: event.severity === "critical" ? "#dc2626" : "#ef4444",
              title: event.pair ? `${event.pair.toUpperCase()} — ${event.type}` : event.type,
              text: event.message.slice(0, 800),
            }],
          }),
          signal: AbortSignal.timeout(8000),
        });
        if (r.ok) channels.push("slack");
      } catch { /* ignore */ }
    }

    // Discord (CRITICAL only)
    const discordUrl = process.env.L2_ALERT_DISCORD_WEBHOOK_URL;
    if (discordUrl && event.severity === "critical") {
      try {
        const r = await fetch(discordUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: event.message.slice(0, 2000) }),
          signal: AbortSignal.timeout(8000),
        });
        if (r.ok) channels.push("discord");
      } catch { /* ignore */ }
    }

    // Email (CRITICAL + ERROR) — uses nodemailer via dynamic import
    if ((event.severity === "critical" || event.severity === "error")
        && process.env.L2_ALERT_SMTP_HOST && process.env.L2_ALERT_EMAIL_TO) {
      try {
        const { sendEmailTest } = await import("@/lib/alerting/email");
        const subject = `[${event.severity.toUpperCase()}] ${event.type.replace(/_/g, " ").toUpperCase()}${event.pair ? ` · ${event.pair.toUpperCase()}` : ""}`;
        await sendEmailTest(subject, event.message, event.severity as any, `signal-${event.type}-${Date.now()}`);
        channels.push("email");
      } catch (e) {
        console.warn("[signal-alerts] email failed:", e instanceof Error ? e.message : e);
      }
    }

    // SMS (CRITICAL only) — Twilio-compatible API
    // Env: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER, SMS_ALERT_TO
    if (event.severity === "critical"
        && process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN
        && process.env.TWILIO_FROM_NUMBER && process.env.SMS_ALERT_TO) {
      try {
        const sid = process.env.TWILIO_ACCOUNT_SID;
        const token = process.env.TWILIO_AUTH_TOKEN;
        const from = process.env.TWILIO_FROM_NUMBER;
        const to = process.env.SMS_ALERT_TO;
        // Truncate message to 160 chars for SMS (Twilio segments longer)
        const smsBody = `[${event.severity.toUpperCase()}] ${event.type.replace(/_/g, " ").toUpperCase()}${event.pair ? ` ${event.pair.toUpperCase()}` : ""}: ${event.message.split("\n\n")[0].slice(0, 100)}`;
        const authHeader = "Basic " + Buffer.from(`${sid}:${token}`).toString("base64");
        const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "Authorization": authHeader,
          },
          body: new URLSearchParams({ From: from, To: to, Body: smsBody }).toString(),
          signal: AbortSignal.timeout(8000),
        });
        if (r.ok) channels.push("sms");
        else console.warn("[signal-alerts] SMS failed:", await r.text());
      } catch (e) {
        console.warn("[signal-alerts] SMS dispatch failed:", e instanceof Error ? e.message : e);
      }
    }

    // Pushover (CRITICAL + ERROR) — push notification service
    // Env: PUSHOVER_APP_TOKEN, PUSHOVER_USER_KEY
    // Redundant to Telegram/Slack/SMS — works on iOS/Android via Pushover app
    if ((event.severity === "critical" || event.severity === "error")
        && process.env.PUSHOVER_APP_TOKEN && process.env.PUSHOVER_USER_KEY) {
      try {
        const token = process.env.PUSHOVER_APP_TOKEN;
        const user = process.env.PUSHOVER_USER_KEY;
        const title = `[${event.severity.toUpperCase()}] ${event.type.replace(/_/g, " ").toUpperCase()}${event.pair ? ` · ${event.pair.toUpperCase()}` : ""}`;
        // Pushover allows 1024 chars in message, 250 in title
        const message = event.message.slice(0, 1024);
        const priority = event.severity === "critical" ? 1 : 0; // 1 = high priority, 0 = normal
        const r = await fetch("https://api.pushover.net/1/messages.json", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            token, user, title: title.slice(0, 250), message,
            priority: String(priority),
          }).toString(),
          signal: AbortSignal.timeout(8000),
        });
        if (r.ok) channels.push("pushover");
        else console.warn("[signal-alerts] Pushover failed:", await r.text());
      } catch (e) {
        console.warn("[signal-alerts] Pushover dispatch failed:", e instanceof Error ? e.message : e);
      }
    }
  }

  // Mark delivered + record channels
  await db.portfolioAlertEvent.update({
    where: { id: entry.id },
    data: { delivered: channels.length > 0, channels: JSON.stringify(channels) },
  }).catch(() => {});

  return entry.id;
}

// ── Convenience formatters ──

export function formatSignalFiredMessage(s: {
  pair: string; action: string; entry: number; stopLoss: number;
  takeProfit1: number; takeProfit2: number; positionSizeIdr: number;
  riskMultiplier: number; drawdownPct: number; conviction: number;
  rationale?: string[];
}): string {
  const action_emoji = s.action === "LONG" ? "🟢" : "🔴";
  const lines = [
    `${action_emoji} [WARN] SIGNAL FIRED: ${s.action} ${s.pair.toUpperCase()}`,
    "",
    `Entry: Rp ${s.entry.toLocaleString("id-ID", { maximumFractionDigits: 0 })}`,
    `Stop: Rp ${s.stopLoss.toLocaleString("id-ID", { maximumFractionDigits: 0 })}`,
    `TP1: Rp ${s.takeProfit1.toLocaleString("id-ID", { maximumFractionDigits: 0 })}`,
    `TP2: Rp ${s.takeProfit2.toLocaleString("id-ID", { maximumFractionDigits: 0 })}`,
    `Size: Rp ${s.positionSizeIdr.toLocaleString("id-ID", { maximumFractionDigits: 0 })}`,
    `Conviction: ${s.conviction}/100`,
    "",
    `Risk multiplier: ${s.riskMultiplier.toFixed(2)}x (drawdown ${s.drawdownPct.toFixed(1)}%)`,
    `_${new Date().toISOString()}_`,
  ];
  if (s.rationale && s.rationale.length > 0) {
    lines.push("", `Reason: ${s.rationale.slice(0, 2).join(" · ")}`);
  }
  return lines.join("\n");
}

export function formatSignalClosedMessage(s: {
  pair: string; action: string; entryPrice: number; exitPrice: number;
  pnlIdr: number; pnlPct: number; holdHours: number; status: string;
}): string {
  const won = s.pnlIdr > 0;
  const emoji = won ? "💰" : "📉";
  const sev = won ? "INFO" : "ERROR";
  return [
    `${emoji} [${sev}] SIGNAL CLOSED: ${s.pair.toUpperCase()}`,
    "",
    `Status: ${s.status}`,
    `Entry: Rp ${s.entryPrice.toLocaleString("id-ID", { maximumFractionDigits: 0 })}`,
    `Exit: Rp ${s.exitPrice.toLocaleString("id-ID", { maximumFractionDigits: 0 })}`,
    `Hold: ${s.holdHours}h`,
    `PnL: ${won ? "+" : ""}Rp ${s.pnlIdr.toLocaleString("id-ID", { maximumFractionDigits: 0 })} (${s.pnlPct >= 0 ? "+" : ""}${(s.pnlPct * 100).toFixed(2)}%)`,
    "",
    `_${new Date().toISOString()}_`,
  ].join("\n");
}

export function formatCircuitTrippedMessage(pair: string, consecutiveLosses: number, trips: number, cooldownSec: number): string {
  const mins = Math.floor(cooldownSec / 60);
  return [
    `🚨 [CRITICAL] CIRCUIT TRIPPED: ${pair.toUpperCase()}`,
    "",
    `${consecutiveLosses} consecutive losses.`,
    `Total trips: ${trips}.`,
    `Cooldown: ${mins} minutes.`,
    `Pair is now suppressed until cooldown expires + half-open probe wins.`,
    "",
    `_${new Date().toISOString()}_`,
  ].join("\n");
}

export function formatDrawdownBreachMessage(drawdownPct: number, thresholdPct: number, cumulativePnlIdr: number, riskMultiplier: number, tierLabel: string): string {
  const sev = drawdownPct <= -10 ? "CRITICAL" : drawdownPct <= -8 ? "ERROR" : "WARN";
  const emoji = drawdownPct <= -10 ? "🛑" : drawdownPct <= -8 ? "🚨" : "⚠️";
  return [
    `${emoji} [${sev}] DRAWDOWN BREACH: ${drawdownPct.toFixed(2)}%`,
    "",
    `Alert threshold: ${thresholdPct}%`,
    `Cumulative P&L: Rp ${cumulativePnlIdr.toLocaleString("id-ID", { maximumFractionDigits: 0 })}`,
    `Risk multiplier scaled to ${riskMultiplier.toFixed(2)}x (${tierLabel})`,
    drawdownPct <= -10 ? "HALT ACTIVE: no new positions will be opened." : "Position sizes reduced to protect capital.",
    "",
    `_${new Date().toISOString()}_`,
  ].join("\n");
}

export function formatDeviationMessage(pair: string, replayPnlPct: number, paperPnlPct: number, deviationPct: number): string {
  return [
    `⚠️ [WARN] PAPER vs REPLAY DEVIATION: ${pair.toUpperCase()}`,
    "",
    `Replay (21-day backtest) P&L: ${replayPnlPct >= 0 ? "+" : ""}${(replayPnlPct * 100).toFixed(1)}%`,
    `Paper (live OOS) P&L: ${paperPnlPct >= 0 ? "+" : ""}${(paperPnlPct * 100).toFixed(1)}%`,
    `Deviation: ${deviationPct.toFixed(1)}%`,
    "",
    `Edge hypothesis may have degraded OR sample is too small.`,
    `Recommend: review pair status in next weekly review.`,
    "",
    `_${new Date().toISOString()}_`,
  ].join("\n");
}

// Get recent alert events for the dashboard feed (last N events).
export async function getRecentAlertEvents(limit = 20): Promise<{
  id: string; type: string; severity: string; pair: string | null;
  message: string; delivered: boolean; createdAt: Date;
}[]> {
  const events = await db.portfolioAlertEvent.findMany({
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  return events.map((e) => ({
    id: e.id,
    type: e.type,
    severity: e.severity,
    pair: e.pair,
    message: e.message,
    delivered: e.delivered,
    createdAt: e.createdAt,
  }));
}
