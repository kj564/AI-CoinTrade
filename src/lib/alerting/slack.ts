// L2 Alerting — Slack delivery (Block Kit via incoming webhook).
//
// Server-only. Uses fetch only (no native deps). Marked server-only by virtue
// of being imported exclusively by route handlers and the dispatch module.
//
// Env: L2_ALERT_SLACK_WEBHOOK_URL

import type { AlertSeverity } from "./types";
import type { L2Alert, L2HealthSummary } from "@/lib/trading/l2-monitor";
import { severityIcon } from "./format";
import { recordDeliverySuccess, recordDeliveryFailure } from "./delivery-tracker";

const COLOR_MAP: Record<AlertSeverity, string> = {
  critical: "#dc2626",
  error: "#ef4444",
  warn: "#f59e0b",
  info: "#3b82f6",
};

// Send a multi-alert Slack Block Kit payload.
// Returns true if Slack accepted the message (HTTP 2xx), false otherwise.
export async function sendSlack(
  alerts: L2Alert[],
  summary: L2HealthSummary,
  severity: AlertSeverity,
  traceId?: string,
): Promise<boolean> {
  const url = process.env.L2_ALERT_SLACK_WEBHOOK_URL;
  if (!url) return false;
  try {
    const payload = {
      text: `${severityIcon(severity)} L2 Collector Incident [${severity.toUpperCase()}]${traceId ? ` (trace=${traceId})` : ""}`,
      attachments: [
        {
          color: COLOR_MAP[severity],
          title: `L2 Collector — ${summary.status.toUpperCase()} (${severity})`,
          fields: alerts.slice(0, 8).map((a) => ({
            title: `[${a.pair}] ${a.code}`,
            value: a.message,
            short: false,
          })),
          footer: `trace=${traceId ?? "n/a"} attempts=${summary.totalAttempts} ok=${summary.totalSuccesses} fail=${summary.totalFailures} circuit=${summary.circuitBreaker.open ? "OPEN" : "closed"} scheduler=${summary.schedulerRunning ? "UP" : "DOWN"}`,
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
    if (r.ok) {
      recordDeliverySuccess("slack");
    } else {
      recordDeliveryFailure("slack");
    }
    return r.ok;
  } catch (e) {
    recordDeliveryFailure("slack");
    console.warn(`[l2-alerts] [trace=${traceId ?? "n/a"}] Slack failed:`, e instanceof Error ? e.message : e);
    return false;
  }
}

// Send a single test-message Slack payload (used by /api/l2/alerts/test).
export async function sendSlackTest(
  text: string,
  severity: AlertSeverity,
  traceId: string,
): Promise<boolean> {
  const url = process.env.L2_ALERT_SLACK_WEBHOOK_URL;
  if (!url) return false;
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
    if (r.ok) recordDeliverySuccess("slack");
    else recordDeliveryFailure("slack");
    return r.ok;
  } catch (e) {
    recordDeliveryFailure("slack");
    console.warn(`[l2-alerts] [trace=${traceId}] Slack test failed:`, e instanceof Error ? e.message : e);
    return false;
  }
}
