import { NextRequest, NextResponse } from "next/server";
import { getL2Health, hydrateL2MonitorFromDB } from "@/lib/trading/l2-monitor";
import { formatPrometheusMetrics } from "@/lib/trading/l2-metrics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/l2/metrics — Prometheus text exposition format endpoint.
// Scrape with Prometheus / Grafana Agent to observe L2 collector health:
//   l2_collector_status, l2_circuit_open, l2_attempts_total{pair}, etc.
export async function GET(_req: NextRequest) {
  try {
    await hydrateL2MonitorFromDB();
    const summary = getL2Health();
    const text = formatPrometheusMetrics(summary);
    return new NextResponse(text, {
      headers: {
        "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
        "Cache-Control": "no-store, max-age=0",
      },
    });
  } catch (e) {
    return new NextResponse(
      `# error\n# ${e instanceof Error ? e.message : "failed to render metrics"}\n`,
      { status: 500, headers: { "Content-Type": "text/plain" } },
    );
  }
}
