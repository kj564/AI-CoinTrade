// L2 External Alerting — multi-channel incident notification.
// Channels (all optional, configured via env / bot config):
//   - Telegram (reuses BotConfig.telegramToken/ChatId)
//   - Slack (Block Kit formatting via L2_ALERT_SLACK_WEBHOOK_URL)
//   - Discord (via L2_ALERT_DISCORD_WEBHOOK_URL)
//   - Email/SMTP (via L2_ALERT_SMTP_* env vars, uses nodemailer)
//   - Generic webhook (L2_ALERT_WEBHOOK_URL, Slack-compatible JSON)
//
// Severity-based routing (priority #7):
//   critical → all configured channels (immediate)
//   error    → Telegram + Slack + Email (immediate)
//   warn     → Slack + Discord (digest, no email)
//   info     → log only (no external delivery)
//
// Dedup is handled upstream by l2-monitor.getNewErrorAlerts() — this module
// only fires on NEW error-level incidents. Recovery notifications fire on
// status transitions down→healthy.

import { db } from "@/lib/db";
import { sendTelegram } from "@/lib/telegram";
import type { L2Alert, L2HealthSummary } from "./l2-monitor";

// Guarded require for optional native deps (nodemailer). Uses globalThis.require
// when available (CJS), falls back gracefully in ESM contexts.
function guardedRequire(name: string): any {
  const req: any = typeof globalThis !== "undefined" && (globalThis as any).require
    ? (globalThis as any).require
    : typeof require !== "undefined" ? require : null;
  if (!req) throw new Error(`require unavailable — cannot load ${name}`);
  return req(name);
}

export type AlertSeverity = "info" | "warn" | "error" | "critical";

export interface AlertChannelConfig {
  telegram: boolean;
  slack: boolean;
  discord: boolean;
  email: boolean;
  webhook: boolean;
}

// Inspect env vars + bot config to determine which channels are configured.
export function getConfiguredChannels(cfg?: { telegramToken?: string | null; telegramChatId?: string | null } | null): AlertChannelConfig {
  return {
    telegram: !!(cfg?.telegramToken && cfg?.telegramChatId),
    slack: !!process.env.L2_ALERT_SLACK_WEBHOOK_URL,
    discord: !!process.env.L2_ALERT_DISCORD_WEBHOOK_URL,
    email: !!(process.env.L2_ALERT_SMTP_HOST && process.env.L2_ALERT_EMAIL_TO),
    webhook: !!process.env.L2_ALERT_WEBHOOK_URL,
  };
}

// Map an alert's level + code to a severity.
export function alertSeverity(a: L2Alert): AlertSeverity {
  // Circuit open + scheduler dead = critical (system not collecting at all)
  if (a.code === "circuit_open" || a.code === "scheduler_dead") return "critical";
  // Outage (3+ consecutive failures) = error
  if (a.level === "error") return "error";
  // Stale / consecutive_failures / never_collected = warn
  return "warn";
}

// Which channels should receive an alert of this severity?
function channelsForSeverity(sev: AlertSeverity, configured: AlertChannelConfig): AlertChannelConfig {
  switch (sev) {
    case "critical":
      return { ...configured }; // all configured channels
    case "error":
      return { telegram: configured.telegram, slack: configured.slack, discord: false, email: configured.email, webhook: configured.webhook };
    case "warn":
      return { telegram: false, slack: configured.slack, discord: configured.discord, email: false, webhook: configured.webhook };
    case "info":
    default:
      return { telegram: false, slack: false, discord: false, email: false, webhook: false };
  }
}

interface AlertDeliveryResult {
  telegram: boolean | null;
  slack: boolean | null;
  discord: boolean | null;
  email: boolean | null;
  webhook: boolean | null;
  alertCount: number;
  severity: AlertSeverity;
}

// Send new error-level alerts externally across all configured channels per severity routing.
export async function sendL2ExternalAlerts(
  newAlerts: L2Alert[],
  summary: L2HealthSummary,
): Promise<AlertDeliveryResult> {
  if (newAlerts.length === 0) {
    return { telegram: null, slack: null, discord: null, email: null, webhook: null, alertCount: 0, severity: "info" };
  }

  // Determine the highest severity among the new alerts
  const severityOrder: AlertSeverity[] = ["info", "warn", "error", "critical"];
  const topSeverity = newAlerts.reduce<AlertSeverity>(
    (max, a) => {
      const s = alertSeverity(a);
      return severityOrder.indexOf(s) > severityOrder.indexOf(max) ? s : max;
    },
    "info" as AlertSeverity,
  );

  // Load bot config for Telegram credentials
  let botCfg: { telegramToken?: string | null; telegramChatId?: string | null } | null = null;
  try {
    botCfg = await db.botConfig.findUnique({ where: { id: "singleton" } });
  } catch { /* ignore */ }

  const configured = getConfiguredChannels(botCfg);
  const channels = channelsForSeverity(topSeverity, configured);

  const text = formatAlertDigest(newAlerts, summary, topSeverity);

  // Dispatch to each configured channel (parallel, independent failures)
  const tasks: Promise<void>[] = [];
  let tgResult: boolean | null = null;
  let slackResult: boolean | null = null;
  let discordResult: boolean | null = null;
  let emailResult: boolean | null = null;
  let whResult: boolean | null = null;

  if (channels.telegram && botCfg?.telegramToken && botCfg?.telegramChatId) {
    tasks.push(
      sendTelegram(botCfg.telegramToken, botCfg.telegramChatId, text)
        .then((r) => { tgResult = r; })
        .catch((e) => { console.warn("[l2-alerts] Telegram failed:", e instanceof Error ? e.message : e); tgResult = false; }),
    );
  }
  if (channels.slack) {
    tasks.push(
      sendSlack(newAlerts, summary, topSeverity)
        .then((r) => { slackResult = r; })
        .catch((e) => { console.warn("[l2-alerts] Slack failed:", e instanceof Error ? e.message : e); slackResult = false; }),
    );
  }
  if (channels.discord) {
    tasks.push(
      sendDiscord(text)
        .then((r) => { discordResult = r; })
        .catch((e) => { console.warn("[l2-alerts] Discord failed:", e instanceof Error ? e.message : e); discordResult = false; }),
    );
  }
  if (channels.email) {
    tasks.push(
      sendEmail(newAlerts, summary, topSeverity)
        .then((r) => { emailResult = r; })
        .catch((e) => { console.warn("[l2-alerts] Email failed:", e instanceof Error ? e.message : e); emailResult = false; }),
    );
  }
  if (channels.webhook) {
    tasks.push(
      sendWebhook(process.env.L2_ALERT_WEBHOOK_URL!, text, summary, newAlerts, topSeverity)
        .then((r) => { whResult = r; })
        .catch((e) => { console.warn("[l2-alerts] Webhook failed:", e instanceof Error ? e.message : e); whResult = false; }),
    );
  }

  await Promise.allSettled(tasks);

  return {
    telegram: tgResult,
    slack: slackResult,
    discord: discordResult,
    email: emailResult,
    webhook: whResult,
    alertCount: newAlerts.length,
    severity: topSeverity,
  };
}

function severityIcon(sev: AlertSeverity): string {
  switch (sev) {
    case "critical": return "🚨";
    case "error": return "🔴";
    case "warn": return "🟡";
    case "info": return "ℹ️";
  }
}

function formatAlertDigest(alerts: L2Alert[], summary: L2HealthSummary, severity: AlertSeverity): string {
  const lines: string[] = [];
  lines.push(`${severityIcon(severity)} *L2 Collector Incident* [${severity.toUpperCase()}] — status: *${summary.status.toUpperCase()}*`);
  lines.push("");
  for (const a of alerts) {
    const icon = a.level === "error" ? "🔴" : "🟡";
    lines.push(`${icon} [${a.pair}] ${a.code.replace(/_/g, " ")}`);
    lines.push(`   ${a.message}`);
    if (a.detail) lines.push(`   detail: ${a.detail}`);
  }
  lines.push("");
  lines.push(`_${summary.totalAttempts} attempts · ${summary.totalSuccesses} ok · ${summary.totalFailures} fail · circuit ${summary.circuitBreaker.open ? "OPEN" : "closed"}_`);
  lines.push(`_See Research Lab → L2 Collector Health → Runbook_`);
  return lines.join("\n");
}

// ── Slack (Block Kit) ──
async function sendSlack(alerts: L2Alert[], summary: L2HealthSummary, severity: AlertSeverity): Promise<boolean> {
  const url = process.env.L2_ALERT_SLACK_WEBHOOK_URL;
  if (!url) return false;
  const colorMap: Record<AlertSeverity, string> = { critical: "#dc2626", error: "#ef4444", warn: "#f59e0b", info: "#3b82f6" };
  try {
    const payload = {
      text: `${severityIcon(severity)} L2 Collector Incident [${severity.toUpperCase()}]`,
      attachments: [
        {
          color: colorMap[severity],
          title: `L2 Collector — ${summary.status.toUpperCase()} (${severity})`,
          fields: alerts.slice(0, 8).map((a) => ({
            title: `[${a.pair}] ${a.code}`,
            value: a.message,
            short: false,
          })),
          footer: `attempts=${summary.totalAttempts} ok=${summary.totalSuccesses} fail=${summary.totalFailures} circuit=${summary.circuitBreaker.open ? "OPEN" : "closed"} scheduler=${summary.schedulerRunning ? "UP" : "DOWN"}`,
          ts: Math.floor(Date.now() / 1000),
        },
      ],
    };
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8000),
    });
    return r.ok;
  } catch {
    return false;
  }
}

// ── Discord ──
async function sendDiscord(text: string): Promise<boolean> {
  const url = process.env.L2_ALERT_DISCORD_WEBHOOK_URL;
  if (!url) return false;
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: text.slice(0, 2000) }),
      signal: AbortSignal.timeout(8000),
    });
    return r.ok;
  } catch {
    return false;
  }
}

// ── Email (SMTP via nodemailer) ──
async function sendEmail(alerts: L2Alert[], summary: L2HealthSummary, severity: AlertSeverity): Promise<boolean> {
  const host = process.env.L2_ALERT_SMTP_HOST;
  const to = process.env.L2_ALERT_EMAIL_TO;
  if (!host || !to) return false;
  try {
    // Lazy-load nodemailer via guarded require (Turbopack-safe)
    const nodemailer = guardedRequire("nodemailer");
    const port = parseInt(process.env.L2_ALERT_SMTP_PORT || "587", 10);
    const user = process.env.L2_ALERT_SMTP_USER;
    const pass = process.env.L2_ALERT_SMTP_PASS;
    const from = process.env.L2_ALERT_EMAIL_FROM || user || "l2-alerts@localhost";

    const transporter = nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      auth: user && pass ? { user, pass } : undefined,
    });

    const subject = `[${severity.toUpperCase()}] L2 Collector ${summary.status.toUpperCase()} — ${alerts.length} alert(s)`;
    const body = [
      `L2 Collector Health Incident`,
      `Severity: ${severity.toUpperCase()}`,
      `Status: ${summary.status}`,
      `Generated: ${new Date(summary.generatedAt * 1000).toISOString()}`,
      ``,
      `Alerts (${alerts.length}):`,
      ...alerts.map((a) => `  [${a.pair}] ${a.code} (${a.level}): ${a.message}${a.detail ? `\n    detail: ${a.detail}` : ""}`),
      ``,
      `Summary: ${summary.totalAttempts} attempts · ${summary.totalSuccesses} ok · ${summary.totalFailures} fail`,
      `Circuit breaker: ${summary.circuitBreaker.open ? "OPEN" : "closed"} (trips: ${summary.circuitBreaker.trips})`,
      `Scheduler: ${summary.schedulerRunning ? "running" : "stopped"}`,
      ``,
      `See the L2 Collector Health dashboard → Research Lab → Runbook for troubleshooting steps.`,
    ].join("\n");

    await transporter.sendMail({ from, to, subject, text: body });
    return true;
  } catch (e) {
    console.warn("[l2-alerts] Email SMTP failed:", e instanceof Error ? e.message : e);
    return false;
  }
}

// ── Generic webhook (Slack-compatible) ──
async function sendWebhook(
  url: string,
  text: string,
  summary: L2HealthSummary,
  alerts: L2Alert[],
  severity: AlertSeverity,
): Promise<boolean> {
  try {
    const colorMap: Record<AlertSeverity, string> = { critical: "danger", error: "danger", warn: "warning", info: "#3b82f6" };
    const payload = {
      text,
      attachments: [
        {
          color: colorMap[severity],
          title: `L2 Collector — ${summary.status.toUpperCase()} (${severity})`,
          fields: alerts.slice(0, 5).map((a) => ({ title: `[${a.pair}] ${a.code}`, value: a.message, short: false })),
          footer: `severity=${severity} attempts=${summary.totalAttempts} ok=${summary.totalSuccesses} fail=${summary.totalFailures} circuit=${summary.circuitBreaker.open ? "open" : "closed"}`,
          ts: Math.floor(Date.now() / 1000),
        },
      ],
    };
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8000),
    });
    return r.ok;
  } catch {
    return false;
  }
}

// Send a recovery notification when status improves (down→healthy).
export async function sendL2RecoveryAlert(summary: L2HealthSummary, previousStatus: string): Promise<boolean> {
  if (previousStatus === "down" && summary.status !== "down") {
    const text = [
      "✅ *L2 Collector Recovered*",
      "",
      `Status transitioned: ${previousStatus.toUpperCase()} → *${summary.status.toUpperCase()}*`,
      `Circuit breaker: ${summary.circuitBreaker.open ? "still open" : "closed"}`,
      `_${summary.totalAttempts} attempts · ${summary.totalSuccesses} ok · success rate ${(summary.successRate * 100).toFixed(0)}%_`,
    ].join("\n");
    try {
      const cfg = await db.botConfig.findUnique({ where: { id: "singleton" } });
      const configured = getConfiguredChannels(cfg);
      // Recovery goes to Telegram (if configured) + Slack (if configured)
      if (configured.telegram && cfg?.telegramToken && cfg?.telegramChatId) {
        return await sendTelegram(cfg.telegramToken, cfg.telegramChatId, text);
      }
      if (configured.slack) {
        await sendSlack([], summary, "info").catch(() => {});
      }
    } catch {
      return false;
    }
  }
  return false;
}
