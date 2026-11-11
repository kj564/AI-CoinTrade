// L2 Alerting — smoke-test helper for /api/l2/alerts/test.
//
// Dispatches a single synthetic alert to verify end-to-end delivery across
// configured channels. Bypasses the l2-monitor dedup (this is a test, not
// a real incident). Per-channel timing + success/failure is captured for
// the response so operators can see exactly which channels received the
// message.

import { db } from "@/lib/db";
import { sendTelegram } from "@/lib/telegram";
import type { AlertChannelConfig, AlertSeverity, AlertTestDeliveryResult, ChannelDeliveryDetail } from "./types";
import { getConfiguredChannels, channelsForSeverity } from "./channels";
import { formatTestAlertText } from "./format";
import { generateTraceId } from "./trace";
import { recordDeliverySuccess, recordDeliveryFailure } from "./delivery-tracker";
import { sendSlackTest } from "./slack";
import { sendDiscord } from "./discord";
import { sendEmailTest } from "./email";
import { sendWebhookTest } from "./webhook";

function emptyDetail(): ChannelDeliveryDetail {
  return { attempted: false, success: null, durationMs: 0 };
}

function timed<T>(fn: () => Promise<T>): Promise<{ result: T; durationMs: number }> {
  const t0 = Date.now();
  return fn().then((result) => ({ result, durationMs: Date.now() - t0 }));
}

// Send a test alert to the configured channels for the given severity.
// If `channelsOverride` is provided, only those channels are targeted
// (regardless of severity routing) — useful for isolating a single channel.
export async function sendTestAlert(
  severity: AlertSeverity,
  title: string,
  message: string,
  channelsOverride?: ("telegram" | "slack" | "discord" | "email" | "webhook")[],
): Promise<AlertTestDeliveryResult> {
  const traceId = generateTraceId();
  const text = formatTestAlertText(title, message, severity);

  // Load bot config for Telegram credentials
  let botCfg: { telegramToken?: string | null; telegramChatId?: string | null } | null = null;
  try {
    botCfg = await db.botConfig.findUnique({ where: { id: "singleton" } });
  } catch { /* ignore */ }

  const configured = getConfiguredChannels(botCfg);
  // If override is given, route to those channels only (if configured).
  // Otherwise use the standard severity routing table.
  const routed: AlertChannelConfig = channelsOverride
    ? {
        telegram: channelsOverride.includes("telegram") && configured.telegram,
        slack: channelsOverride.includes("slack") && configured.slack,
        discord: channelsOverride.includes("discord") && configured.discord,
        email: channelsOverride.includes("email") && configured.email,
        webhook: channelsOverride.includes("webhook") && configured.webhook,
      }
    : channelsForSeverity(severity, configured);

  const delivery = {
    telegram: emptyDetail(),
    slack: emptyDetail(),
    discord: emptyDetail(),
    email: emptyDetail(),
    webhook: emptyDetail(),
  };

  const tasks: Promise<void>[] = [];

  if (routed.telegram && botCfg?.telegramToken && botCfg?.telegramChatId) {
    delivery.telegram.attempted = true;
    tasks.push(
      timed(() => sendTelegram(botCfg.telegramToken!, botCfg.telegramChatId!, text))
        .then(({ result, durationMs }) => {
          delivery.telegram = { attempted: true, success: result, durationMs };
          if (result) recordDeliverySuccess("telegram");
          else recordDeliveryFailure("telegram");
        })
        .catch((e) => {
          delivery.telegram = { attempted: true, success: false, durationMs: 0, error: e instanceof Error ? e.message : String(e) };
          recordDeliveryFailure("telegram");
        }),
    );
  }
  if (routed.slack) {
    delivery.slack.attempted = true;
    tasks.push(
      timed(() => sendSlackTest(text, severity, traceId))
        .then(({ result, durationMs }) => { delivery.slack = { attempted: true, success: result, durationMs }; })
        .catch((e) => { delivery.slack = { attempted: true, success: false, durationMs: 0, error: e instanceof Error ? e.message : String(e) }; }),
    );
  }
  if (routed.discord) {
    delivery.discord.attempted = true;
    tasks.push(
      timed(() => sendDiscord(text, traceId))
        .then(({ result, durationMs }) => { delivery.discord = { attempted: true, success: result, durationMs }; })
        .catch((e) => { delivery.discord = { attempted: true, success: false, durationMs: 0, error: e instanceof Error ? e.message : String(e) }; }),
    );
  }
  if (routed.email) {
    delivery.email.attempted = true;
    tasks.push(
      timed(() => sendEmailTest(title, message, severity, traceId))
        .then(({ result, durationMs }) => { delivery.email = { attempted: true, success: result, durationMs }; })
        .catch((e) => { delivery.email = { attempted: true, success: false, durationMs: 0, error: e instanceof Error ? e.message : String(e) }; }),
    );
  }
  if (routed.webhook) {
    delivery.webhook.attempted = true;
    const url = process.env.L2_ALERT_WEBHOOK_URL!;
    tasks.push(
      timed(() => sendWebhookTest(url, text, severity, traceId))
        .then(({ result, durationMs }) => { delivery.webhook = { attempted: true, success: result, durationMs }; })
        .catch((e) => { delivery.webhook = { attempted: true, success: false, durationMs: 0, error: e instanceof Error ? e.message : String(e) }; }),
    );
  }

  await Promise.allSettled(tasks);

  const alertCount = Object.values(delivery).filter((d) => d.attempted).length;

  return {
    traceId,
    severity,
    configuredChannels: configured,
    routedChannels: routed,
    delivery,
    alertCount,
    timestamp: new Date().toISOString(),
  };
}
