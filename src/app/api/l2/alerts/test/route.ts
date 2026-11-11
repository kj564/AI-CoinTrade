import { NextRequest, NextResponse } from "next/server";
import { sendTestAlert } from "@/lib/alerting/test";
import { getConfiguredChannels } from "@/lib/alerting/channels";
import { generateTraceId } from "@/lib/alerting/trace";
import type { AlertSeverity } from "@/lib/alerting/types";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/l2/alerts/test
//
// Smoke-tests the L2 alerting pipeline end-to-end: dispatches a synthetic
// alert to the configured channels for the requested severity and returns
// per-channel delivery results (attempted / success / durationMs / error).
//
// This proves that messages actually reach Slack/Discord/Email/etc — not
// just that the channels are configured. Operators should run this after
// setting up L2_ALERT_* env vars to verify delivery.
//
// Auth: requires L2_ALERT_TEST_TOKEN env var. Send via:
//   - x-l2-test-token header, OR
//   - ?token= query param, OR
//   - Authorization: Bearer <token>
//
// Body:
//   severity: "warn" | "error" | "critical"  (default: warn)
//   title:    string                         (default: "L2 alert delivery test")
//   message:  string                         (default: standard validation message)
//   channels: optional array — override severity routing, target specific channels
//
// Rate-limited independently from /api/l2/collect (1 call / 30s / source) to
// prevent abuse while allowing legitimate testing.
const TEST_RATE_MAX = 2;
const TEST_RATE_WINDOW_MS = 60_000;
const testBuckets = new Map<string, { count: number; windowStart: number }>();

function checkTestRateLimit(source: string): { allowed: boolean; retryAfterSec: number } {
  const now = Date.now();
  const bk = `${source}:${Math.floor(now / TEST_RATE_WINDOW_MS)}`;
  let bucket = testBuckets.get(bk);
  if (!bucket) {
    bucket = { count: 0, windowStart: now };
    testBuckets.set(bk, bucket);
  }
  bucket.count++;
  if (bucket.count > TEST_RATE_MAX) {
    const retryAfterSec = Math.ceil((TEST_RATE_WINDOW_MS - (now - bucket.windowStart)) / 1000);
    return { allowed: false, retryAfterSec: Math.max(1, retryAfterSec) };
  }
  if (testBuckets.size > 200) {
    for (const [k, b] of testBuckets) {
      if (now - b.windowStart > TEST_RATE_WINDOW_MS * 2) testBuckets.delete(k);
    }
  }
  return { allowed: true, retryAfterSec: 0 };
}

function authorize(req: NextRequest): boolean {
  const expected = process.env.L2_ALERT_TEST_TOKEN;
  if (!expected) return false; // no token configured = endpoint disabled
  const headerToken = req.headers.get("x-l2-test-token");
  const bearerToken = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  const url = new URL(req.url);
  const queryToken = url.searchParams.get("token");
  const provided = headerToken || bearerToken || queryToken;
  return !!provided && provided === expected;
}

export async function POST(req: NextRequest) {
  const requestTraceId = generateTraceId();

  // Auth gate
  if (!authorize(req)) {
    return NextResponse.json(
      {
        error: "Unauthorized",
        detail: "Set L2_ALERT_TEST_TOKEN env var and pass it via x-l2-test-token header, ?token= query, or Authorization: Bearer.",
        traceId: requestTraceId,
      },
      { status: 401 },
    );
  }

  // Independent rate limit (don't consume the collect endpoint's budget)
  const source = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  const rl = checkTestRateLimit(source);
  if (!rl.allowed) {
    return NextResponse.json(
      {
        error: "Rate limited",
        detail: `Max ${TEST_RATE_MAX} alert test calls per ${TEST_RATE_WINDOW_MS / 1000}s from this source.`,
        retryAfterSec: rl.retryAfterSec,
        traceId: requestTraceId,
      },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } },
    );
  }

  try {
    const body = await req.json().catch(() => ({}));
    const severity = (["warn", "error", "critical"].includes(body.severity) ? body.severity : "warn") as AlertSeverity;
    const title = typeof body.title === "string" && body.title.trim() ? body.title.slice(0, 120) : "L2 alert delivery test";
    const message = typeof body.message === "string" && body.message.trim()
      ? body.message.slice(0, 500)
      : `Validating alert routing for severity=${severity}. This is a smoke test from /api/l2/alerts/test. If you received this, the channel is working end-to-end.`;
    const channelsOverride = Array.isArray(body.channels)
      ? body.channels.filter((c: unknown) => typeof c === "string" && ["telegram", "slack", "discord", "email", "webhook"].includes(c as string)) as ("telegram" | "slack" | "discord" | "email" | "webhook")[]
      : undefined;

    // Pre-flight: which channels are configured? (so the response shows the
    // full picture even if severity routing skips some)
    let configuredSnapshot = null;
    try {
      const cfg = await db.botConfig.findUnique({ where: { id: "singleton" } });
      configuredSnapshot = getConfiguredChannels(cfg);
    } catch { /* ignore */ }

    const result = await sendTestAlert(severity, title, message, channelsOverride);

    return NextResponse.json(
      {
        ...result,
        configuredChannels: configuredSnapshot ?? result.configuredChannels,
        rateLimit: { max: TEST_RATE_MAX, windowSec: TEST_RATE_WINDOW_MS / 1000, source },
      },
      { status: 200, headers: { "Cache-Control": "no-store, max-age=0" } },
    );
  } catch (e) {
    return NextResponse.json(
      {
        error: e instanceof Error ? e.message : "Alert test failed",
        traceId: requestTraceId,
      },
      { status: 500 },
    );
  }
}

// GET /api/l2/alerts/test — returns endpoint metadata + auth requirement
// (so operators can discover how to use it without reading source).
export async function GET(req: NextRequest) {
  const tokenConfigured = !!process.env.L2_ALERT_TEST_TOKEN;
  let configuredChannels = null;
  try {
    const cfg = await db.botConfig.findUnique({ where: { id: "singleton" } });
    configuredChannels = getConfiguredChannels(cfg);
  } catch { /* ignore */ }

  return NextResponse.json({
    endpoint: "POST /api/l2/alerts/test",
    description: "Smoke-test L2 alerting delivery end-to-end. Dispatches a synthetic alert to configured channels.",
    auth: {
      required: true,
      method: "x-l2-test-token header OR ?token= query OR Authorization: Bearer",
      tokenConfigured,
      hint: tokenConfigured ? "Token is set — pass it in the request." : "Set L2_ALERT_TEST_TOKEN env var to enable.",
    },
    rateLimit: { max: TEST_RATE_MAX, windowSec: TEST_RATE_WINDOW_MS / 1000 },
    body: {
      severity: "warn | error | critical (default: warn)",
      title: "string (default: 'L2 alert delivery test')",
      message: "string (default: standard validation message)",
      channels: "optional array: ['telegram','slack','discord','email','webhook'] — override severity routing",
    },
    configuredChannels,
    severityRouting: {
      critical: "all configured channels",
      error: "telegram + slack + email + webhook",
      warn: "slack + discord + webhook",
      info: "log only (no external delivery)",
    },
  });
}
