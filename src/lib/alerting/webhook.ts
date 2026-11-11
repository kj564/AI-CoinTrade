// L2 Alerting — generic webhook (Slack-compatible JSON payload).
//
// Server-only. Uses fetch only (no native deps). Useful for custom integrations
// (e.g. PagerDuty, Opsgenie, n8n, Zapier) that accept Slack-compatible JSON.
//
// Env: L2_ALERT_WEBHOOK_URL

import type { AlertSeverity } from "./types";
import type { L2Alert, L2HealthSummary } from "@/lib/trading/l2-monitor";
import { recordDeliverySuccess, recordDeliveryFailure } from "./delivery-tracker";

const COLOR_MAP: Record<AlertSeverity, string> = {
  critical: "danger",
  error: "danger",
  warn: "warning",
  info: "#3b82f6",
};

// Send a Slack-compatible payload to a generic webhook.
export async function sendWebhook(
  url: string,
  text: string,
  summary: L2HealthSummary,
  alerts: L2Alert[],
  severity: AlertSeverity,
  traceId?: string,
): Promise<boolean> {
  try {
    const payload = {
      text,
      attachments: [
        {
          color: COLOR_MAP[severity],
          title: `L2 Collector — ${summary.status.toUpperCase()} (${severity})`,
          fields: alerts.slice(0, 5).map((a) => ({ title: `[${a.pair}] ${a.code}`, value: a.message, short: false })),
          footer: `trace=${traceId ?? "n/a"} severity=${severity} attempts=${summary.totalAttempts} ok=${summary.totalSuccesses} fail=${summary.totalFailures} circuit=${summary.circuitBreaker.open ? "open" : "closed"}`,
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
    if (r.ok) recordDeliverySuccess("webhook");
    else recordDeliveryFailure("webhook");
    return r.ok;
  } catch (e) {
    recordDeliveryFailure("webhook");
    console.warn(`[l2-alerts] [trace=${traceId ?? "n/a"}] Webhook failed:`, e instanceof Error ? e.message : e);
    return false;
  }
}

// Send a test payload to a generic webhook (used by /api/l2/alerts/test).
export async function sendWebhookTest(
  url: string,
  text: string,
  severity: AlertSeverity,
  traceId: string,
): Promise<boolean> {
  try {
    const payload = {
      text,
      attachments: [
        {
          color: COLOR_MAP[severity],
          title: `L2 Alert Delivery Test [${severity.toUpperCase()}]`,
          footer: `trace=${traceId} · smoke test`,
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
    if (r.ok) recordDeliverySuccess("webhook");
    else recordDeliveryFailure("webhook");
    return r.ok;
  } catch (e) {
    recordDeliveryFailure("webhook");
    console.warn(`[l2-alerts] [trace=${traceId}] Webhook test failed:`, e instanceof Error ? e.message : e);
    return false;
  }
}
