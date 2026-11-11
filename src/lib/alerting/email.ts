// L2 Alerting — Email delivery via SMTP (nodemailer).
//
// Server-only. nodemailer is loaded via dynamic `import()` so it is only
// pulled into the runtime when email delivery is actually invoked — routes
// that merely import the type/config modules never pay the bundle cost.
//
// This replaces the previous `guardedRequire("nodemailer")` pattern which
// relied on `globalThis.require` (CJS compat shim). The dynamic import is
// ESM-native, Turbopack-safe, and works in production builds.
//
// Env:
//   L2_ALERT_SMTP_HOST (required)
//   L2_ALERT_SMTP_PORT (default 587)
//   L2_ALERT_SMTP_USER / L2_ALERT_SMTP_PASS (optional — omit for no-auth relay)
//   L2_ALERT_EMAIL_TO   (required, comma-separated for multiple recipients)
//   L2_ALERT_EMAIL_FROM (default: SMTP user or l2-alerts@localhost)

import type { AlertSeverity } from "./types";
import type { L2Alert, L2HealthSummary } from "@/lib/trading/l2-monitor";
import { recordDeliverySuccess, recordDeliveryFailure } from "./delivery-tracker";

interface SmtpEnv {
  host: string;
  port: number;
  user?: string;
  pass?: string;
  from: string;
  to: string;
}

function readSmtpEnv(): SmtpEnv | null {
  const host = process.env.L2_ALERT_SMTP_HOST;
  const to = process.env.L2_ALERT_EMAIL_TO;
  if (!host || !to) return null;
  const port = parseInt(process.env.L2_ALERT_SMTP_PORT || "587", 10);
  const user = process.env.L2_ALERT_SMTP_USER;
  const pass = process.env.L2_ALERT_SMTP_PASS;
  const from = process.env.L2_ALERT_EMAIL_FROM || user || "l2-alerts@localhost";
  return { host, port, user, pass, from, to };
}

// Lazy-load nodemailer via dynamic import (Turbopack-safe, ESM-native).
// The module is cached by the runtime after the first load.
async function loadNodemailer(): Promise<any> {
  const mod = await import("nodemailer");
  return mod.default ?? mod;
}

// Send a multi-alert email digest.
export async function sendEmail(
  alerts: L2Alert[],
  summary: L2HealthSummary,
  severity: AlertSeverity,
  traceId?: string,
): Promise<boolean> {
  const env = readSmtpEnv();
  if (!env) return false;
  try {
    const nodemailer = await loadNodemailer();
    const transporter = nodemailer.createTransport({
      host: env.host,
      port: env.port,
      secure: env.port === 465,
      auth: env.user && env.pass ? { user: env.user, pass: env.pass } : undefined,
    });

    const subject = `[${severity.toUpperCase()}] L2 Collector ${summary.status.toUpperCase()} — ${alerts.length} alert(s)${traceId ? ` [trace=${traceId}]` : ""}`;
    const body = [
      `L2 Collector Health Incident`,
      `Severity: ${severity.toUpperCase()}`,
      `Status: ${summary.status}`,
      `Trace ID: ${traceId ?? "n/a"}`,
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

    await transporter.sendMail({ from: env.from, to: env.to, subject, text: body });
    recordDeliverySuccess("email");
    return true;
  } catch (e) {
    recordDeliveryFailure("email");
    console.warn(`[l2-alerts] [trace=${traceId ?? "n/a"}] Email SMTP failed:`, e instanceof Error ? e.message : e);
    return false;
  }
}

// Send a single test-message email (used by /api/l2/alerts/test).
export async function sendEmailTest(
  title: string,
  message: string,
  severity: AlertSeverity,
  traceId: string,
): Promise<boolean> {
  const env = readSmtpEnv();
  if (!env) return false;
  try {
    const nodemailer = await loadNodemailer();
    const transporter = nodemailer.createTransport({
      host: env.host,
      port: env.port,
      secure: env.port === 465,
      auth: env.user && env.pass ? { user: env.user, pass: env.pass } : undefined,
    });

    const subject = `[${severity.toUpperCase()}] L2 Alert Delivery Test [trace=${traceId}]`;
    const body = [
      `L2 Alert Delivery Smoke Test`,
      ``,
      `Severity: ${severity.toUpperCase()}`,
      `Trace ID: ${traceId}`,
      `Timestamp: ${new Date().toISOString()}`,
      ``,
      `Title: ${title}`,
      ``,
      `Message:`,
      message,
      ``,
      `If you received this email, the L2 alerting email channel is working end-to-end.`,
      `Source: POST /api/l2/alerts/test`,
    ].join("\n");

    await transporter.sendMail({ from: env.from, to: env.to, subject, text: body });
    recordDeliverySuccess("email");
    return true;
  } catch (e) {
    recordDeliveryFailure("email");
    console.warn(`[l2-alerts] [trace=${traceId}] Email test failed:`, e instanceof Error ? e.message : e);
    return false;
  }
}
