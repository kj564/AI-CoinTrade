// L2 Alerting — pure channel configuration + severity routing.
//
// This module has NO native deps (no nodemailer, no ioredis) and NO db import.
// It is safe to import from any route handler (health, metrics) without
// pulling heavy modules into the Turbopack bundle graph.
//
// Severity-based routing (priority #7):
//   critical → all configured channels (immediate)
//   error    → Telegram + Slack + Email + webhook (immediate, no Discord)
//   warn     → Slack + Discord + webhook (digest, no email, no Telegram)
//   info     → log only (no external delivery)

import type { AlertChannelConfig, AlertSeverity } from "./types";
import type { L2Alert } from "@/lib/trading/l2-monitor";

// Inspect env vars + bot config to determine which channels are configured.
// `cfg` is optional — Telegram needs botConfig credentials; other channels
// are purely env-driven.
export function getConfiguredChannels(
  cfg?: { telegramToken?: string | null; telegramChatId?: string | null } | null,
): AlertChannelConfig {
  return {
    telegram: !!(cfg?.telegramToken && cfg?.telegramChatId),
    slack: !!process.env.L2_ALERT_SLACK_WEBHOOK_URL,
    discord: !!process.env.L2_ALERT_DISCORD_WEBHOOK_URL,
    email: !!(process.env.L2_ALERT_SMTP_HOST && process.env.L2_ALERT_EMAIL_TO),
    webhook: !!process.env.L2_ALERT_WEBHOOK_URL,
  };
}

// Map an alert's level + code to a severity.
// Circuit open + scheduler dead = critical (system not collecting at all).
// Outage (3+ consecutive failures) = error.
// Stale / consecutive_failures / never_collected = warn.
export function alertSeverity(a: L2Alert): AlertSeverity {
  if (a.code === "circuit_open" || a.code === "scheduler_dead") return "critical";
  if (a.level === "error") return "error";
  return "warn";
}

// Which channels should receive an alert of this severity?
export function channelsForSeverity(
  sev: AlertSeverity,
  configured: AlertChannelConfig,
): AlertChannelConfig {
  switch (sev) {
    case "critical":
      return { ...configured }; // all configured channels
    case "error":
      return {
        telegram: configured.telegram,
        slack: configured.slack,
        discord: false,
        email: configured.email,
        webhook: configured.webhook,
      };
    case "warn":
      return {
        telegram: false,
        slack: configured.slack,
        discord: configured.discord,
        email: false,
        webhook: configured.webhook,
      };
    case "info":
    default:
      return { telegram: false, slack: false, discord: false, email: false, webhook: false };
  }
}

// Human-readable list of active channel names (for UI / logs).
export function listActiveChannels(ch: AlertChannelConfig): string[] {
  const out: string[] = [];
  if (ch.telegram) out.push("telegram");
  if (ch.slack) out.push("slack");
  if (ch.discord) out.push("discord");
  if (ch.email) out.push("email");
  if (ch.webhook) out.push("webhook");
  return out;
}
