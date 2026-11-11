// L2 Alerting — multi-channel dispatch orchestrator.
//
// Routes new error-level alerts to the appropriate channels based on severity.
// Each channel is dispatched in parallel; failures are isolated (one channel
// failing does not block others). Per-channel success/failure is recorded in
// the delivery tracker for Prometheus metrics.
//
// This module is the only alerting module that imports `db` (for bot config)
// and `telegram` (for the Telegram channel). Routes that only need channel
// configuration should import from `./channels` instead.

import { db } from "@/lib/db";
import { sendTelegram } from "@/lib/telegram";
import type { L2Alert, L2HealthSummary } from "@/lib/trading/l2-monitor";
import type { AlertDeliveryResult, AlertSeverity } from "./types";
import { getConfiguredChannels, channelsForSeverity, alertSeverity } from "./channels";
import { formatAlertDigest } from "./format";
import { generateTraceId } from "./trace";
import { recordDeliverySuccess, recordDeliveryFailure } from "./delivery-tracker";
import { sendSlack } from "./slack";
import { sendDiscord } from "./discord";
import { sendEmail } from "./email";
import { sendWebhook } from "./webhook";

// Send new error-level alerts externally across all configured channels per
// severity routing. Dedup is handled upstream by l2-monitor.getNewErrorAlerts()
// — this function fires on every alert it receives.
export async function sendL2ExternalAlerts(
  newAlerts: L2Alert[],
  summary: L2HealthSummary,
): Promise<AlertDeliveryResult> {
  const traceId = generateTraceId();
  if (newAlerts.length === 0) {
    return {
      telegram: null, slack: null, discord: null, email: null, webhook: null,
      alertCount: 0, severity: "info", traceId,
    };
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

  const tasks: Promise<void>[] = [];
  let tgResult: boolean | null = null;
  let slackResult: boolean | null = null;
  let discordResult: boolean | null = null;
  let emailResult: boolean | null = null;
  let whResult: boolean | null = null;

  if (channels.telegram && botCfg?.telegramToken && botCfg?.telegramChatId) {
    tasks.push(
      sendTelegram(botCfg.telegramToken, botCfg.telegramChatId, text)
        .then((r) => { if (r) recordDeliverySuccess("telegram"); tgResult = r; })
        .catch((e) => { recordDeliveryFailure("telegram"); console.warn(`[l2-alerts] [trace=${traceId}] Telegram failed:`, e instanceof Error ? e.message : e); tgResult = false; }),
    );
  }
  if (channels.slack) {
    tasks.push(
      sendSlack(newAlerts, summary, topSeverity, traceId)
        .then((r) => { slackResult = r; })
        .catch((e) => { slackResult = false; console.warn(`[l2-alerts] [trace=${traceId}] Slack dispatch failed:`, e instanceof Error ? e.message : e); }),
    );
  }
  if (channels.discord) {
    tasks.push(
      sendDiscord(text, traceId)
        .then((r) => { discordResult = r; })
        .catch((e) => { discordResult = false; console.warn(`[l2-alerts] [trace=${traceId}] Discord dispatch failed:`, e instanceof Error ? e.message : e); }),
    );
  }
  if (channels.email) {
    tasks.push(
      sendEmail(newAlerts, summary, topSeverity, traceId)
        .then((r) => { emailResult = r; })
        .catch((e) => { emailResult = false; console.warn(`[l2-alerts] [trace=${traceId}] Email dispatch failed:`, e instanceof Error ? e.message : e); }),
    );
  }
  if (channels.webhook) {
    tasks.push(
      sendWebhook(process.env.L2_ALERT_WEBHOOK_URL!, text, summary, newAlerts, topSeverity, traceId)
        .then((r) => { whResult = r; })
        .catch((e) => { whResult = false; console.warn(`[l2-alerts] [trace=${traceId}] Webhook dispatch failed:`, e instanceof Error ? e.message : e); }),
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
    traceId,
  };
}

// Send a recovery notification when status improves (down→healthy).
export async function sendL2RecoveryAlert(summary: L2HealthSummary, previousStatus: string): Promise<boolean> {
  if (previousStatus === "down" && summary.status !== "down") {
    const traceId = generateTraceId();
    const text = [
      "✅ *L2 Collector Recovered*",
      "",
      `Status transitioned: ${previousStatus.toUpperCase()} → *${summary.status.toUpperCase()}*`,
      `Circuit breaker: ${summary.circuitBreaker.open ? "still open" : "closed"}`,
      `_${summary.totalAttempts} attempts · ${summary.totalSuccesses} ok · success rate ${(summary.successRate * 100).toFixed(0)}%_`,
      `_\`trace=${traceId}\`_`,
    ].join("\n");
    try {
      const cfg = await db.botConfig.findUnique({ where: { id: "singleton" } });
      const configured = getConfiguredChannels(cfg);
      if (configured.telegram && cfg?.telegramToken && cfg?.telegramChatId) {
        const ok = await sendTelegram(cfg.telegramToken, cfg.telegramChatId, text);
        if (ok) recordDeliverySuccess("telegram");
        else recordDeliveryFailure("telegram");
        return ok;
      }
      if (configured.slack) {
        await sendSlack([], summary, "info", traceId).catch(() => {});
      }
    } catch {
      return false;
    }
  }
  return false;
}
