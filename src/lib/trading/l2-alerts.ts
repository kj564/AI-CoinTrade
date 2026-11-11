// L2 External Alerting — sends collector health incidents to Telegram + webhook.
// Reuses the existing Telegram bot config (BotConfig.telegramToken/ChatId) so
// operators get L2 outage notifications in the same channel as trade alerts.
// Also supports a generic Slack-compatible webhook via L2_ALERT_WEBHOOK_URL env.
//
// Dedup is handled upstream by l2-monitor.getNewErrorAlerts() — this module
// only fires on NEW error-level alerts (outage / circuit_open / scheduler_dead).

import { db } from "@/lib/db";
import { sendTelegram } from "@/lib/telegram";
import type { L2Alert, L2HealthSummary } from "./l2-monitor";

interface AlertDeliveryResult {
  telegram: boolean | null;   // null = not configured, true/false = sent/result
  webhook: boolean | null;
  alertCount: number;
}

// Send new error-level alerts externally. Returns delivery result.
// Safe to call when no alerts (no-op).
export async function sendL2ExternalAlerts(
  newAlerts: L2Alert[],
  summary: L2HealthSummary,
): Promise<AlertDeliveryResult> {
  if (newAlerts.length === 0) {
    return { telegram: null, webhook: null, alertCount: 0 };
  }

  const text = formatAlertDigest(newAlerts, summary);

  // Load Telegram config from bot config singleton
  let tgResult: boolean | null = null;
  try {
    const cfg = await db.botConfig.findUnique({ where: { id: "singleton" } });
    if (cfg?.telegramToken && cfg?.telegramChatId) {
      tgResult = await sendTelegram(cfg.telegramToken, cfg.telegramChatId, text);
    }
  } catch (e) {
    console.warn("[l2-alerts] Telegram delivery failed:", e instanceof Error ? e.message : e);
    tgResult = false;
  }

  // Generic webhook (Slack-compatible incoming webhook)
  let whResult: boolean | null = null;
  const webhookUrl = process.env.L2_ALERT_WEBHOOK_URL;
  if (webhookUrl) {
    whResult = await sendWebhook(webhookUrl, text, summary, newAlerts);
  }

  return { telegram: tgResult, webhook: whResult, alertCount: newAlerts.length };
}

function formatAlertDigest(alerts: L2Alert[], summary: L2HealthSummary): string {
  const lines: string[] = [];
  lines.push(`🚨 *L2 Collector Incident* — status: *${summary.status.toUpperCase()}*`);
  lines.push("");
  for (const a of alerts) {
    const icon = a.level === "error" ? "🔴" : "🟡";
    lines.push(`${icon} [${a.pair}] ${a.code.replace(/_/g, " ")}`);
    lines.push(`   ${a.message}`);
    if (a.detail) lines.push(`   detail: ${a.detail}`);
  }
  lines.push("");
  lines.push(`_${summary.totalAttempts} attempts · ${summary.totalSuccesses} ok · ${summary.totalFailures} fail · circuit ${summary.circuitBreaker.open ? "OPEN" : "closed"}_`);
  lines.push(`_See Research Lab → L2 Collector Health for runbook_`);
  return lines.join("\n");
}

// Slack-compatible incoming webhook: { text } or { blocks }. Keep simple with text.
async function sendWebhook(
  url: string,
  text: string,
  summary: L2HealthSummary,
  alerts: L2Alert[],
): Promise<boolean> {
  try {
    const payload = {
      text,
      // Structured fields for systems that parse them
      attachments: [
        {
          color: summary.status === "down" ? "danger" : "warning",
          title: `L2 Collector — ${summary.status.toUpperCase()}`,
          fields: alerts.slice(0, 5).map((a) => ({
            title: `[${a.pair}] ${a.code}`,
            value: a.message,
            short: false,
          })),
          footer: `attempts=${summary.totalAttempts} ok=${summary.totalSuccesses} fail=${summary.totalFailures} circuit=${summary.circuitBreaker.open ? "open" : "closed"}`,
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
  } catch (e) {
    console.warn("[l2-alerts] webhook delivery failed:", e instanceof Error ? e.message : e);
    return false;
  }
}

// Send a recovery notification when the circuit breaker closes or status improves.
// Called with the previous status to detect transitions down→healthy.
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
      if (cfg?.telegramToken && cfg?.telegramChatId) {
        return await sendTelegram(cfg.telegramToken, cfg.telegramChatId, text);
      }
    } catch {
      return false;
    }
  }
  return false;
}
