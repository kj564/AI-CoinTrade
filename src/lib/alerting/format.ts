// L2 Alerting — message formatting (pure, no side effects).
//
// Builds the text payload shared across Telegram / Discord / webhook channels.
// Slack uses Block Kit (handled in slack.ts directly), but the digest text
// is reused for the fallback `text` field and for Discord/webhook.

import type { AlertSeverity } from "./types";
import type { L2Alert, L2HealthSummary } from "@/lib/trading/l2-monitor";

export function severityIcon(sev: AlertSeverity): string {
  switch (sev) {
    case "critical": return "🚨";
    case "error": return "🔴";
    case "warn": return "🟡";
    case "info": return "ℹ️";
  }
}

// Format a multi-alert digest for Telegram / Discord / webhook text body.
export function formatAlertDigest(
  alerts: L2Alert[],
  summary: L2HealthSummary,
  severity: AlertSeverity,
): string {
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

// Format a single test-alert message (used by the smoke-test endpoint).
export function formatTestAlertText(title: string, message: string, severity: AlertSeverity): string {
  return [
    `${severityIcon(severity)} *L2 Alert Delivery Test* [${severity.toUpperCase()}]`,
    "",
    `*${title}*`,
    message,
    "",
    `_Smoke test from /api/l2/alerts/test · ${new Date().toISOString()}_`,
  ].join("\n");
}
