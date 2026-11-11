// L2 Prometheus metrics exporter — renders the collector health state in
// Prometheus text exposition format for scraping by Prometheus / Grafana Agent.
// Exposed at GET /api/l2/metrics.

import type { L2HealthSummary } from "./l2-monitor";

// Prometheus text exposition format:
//   # HELP <name> <description>
//   # TYPE <name> counter|gauge
//   <name>{labels...} <value>
//
// Metrics exposed:
//   l2_collector_status              gauge   1=healthy 2=degraded 3=down (aggregate)
//   l2_collector_scheduler_running   gauge   1/0
//   l2_collector_scheduler_liveness  gauge   seconds since last scheduler tick
//   l2_circuit_open                  gauge   1/0
//   l2_circuit_trips_total           counter total circuit trips
//   l2_attempts_total{pair}          counter total collection attempts per pair
//   l2_successes_total{pair}         counter total successes per pair
//   l2_failures_total{pair}          counter total failures per pair
//   l2_consecutive_failures{pair}    gauge   current consecutive failures per pair
//   l2_last_success_age_seconds{pair} gauge  seconds since last success per pair
//   l2_last_retries{pair}            gauge   retries used in last attempt
//   l2_snapshot_count{pair}          gauge   stored snapshot count per pair
//   l2_active_alerts                 gauge   total active alerts
//   l2_persisted_at_timestamp        gauge   unix sec of last DB persist

function escapeLabelValue(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function metric(name: string, labels: Record<string, string | number>, value: number): string {
  const labelStr = Object.entries(labels)
    .map(([k, v]) => `${k}="${escapeLabelValue(String(v))}"`)
    .join(",");
  return labelStr ? `${name}{${labelStr}} ${value}` : `${name} ${value}`;
}

export function formatPrometheusMetrics(summary: L2HealthSummary): string {
  const lines: string[] = [];
  const statusVal = summary.status === "healthy" ? 1 : summary.status === "degraded" ? 2 : 3;

  lines.push("# HELP l2_collector_status Aggregate collector status: 1=healthy 2=degraded 3=down");
  lines.push("# TYPE l2_collector_status gauge");
  lines.push(metric("l2_collector_status", {}, statusVal));

  lines.push("# HELP l2_collector_scheduler_running Whether the in-process scheduler is running (1/0)");
  lines.push("# TYPE l2_collector_scheduler_running gauge");
  lines.push(metric("l2_collector_scheduler_running", {}, summary.schedulerRunning ? 1 : 0));

  lines.push("# HELP l2_collector_scheduler_liveness_seconds Seconds since last scheduler tick (higher = worse)");
  lines.push("# TYPE l2_collector_scheduler_liveness_seconds gauge");
  const liveness = summary.lastSchedulerTickAt
    ? Math.max(0, summary.generatedAt - summary.lastSchedulerTickAt)
    : -1;
  lines.push(metric("l2_collector_scheduler_liveness_seconds", {}, liveness));

  lines.push("# HELP l2_circuit_open Whether the circuit breaker is open (1/0)");
  lines.push("# TYPE l2_circuit_open gauge");
  lines.push(metric("l2_circuit_open", {}, summary.circuitBreaker.open ? 1 : 0));

  lines.push("# HELP l2_circuit_trips_total Total number of times the circuit breaker has opened");
  lines.push("# TYPE l2_circuit_trips_total counter");
  lines.push(metric("l2_circuit_trips_total", {}, summary.circuitBreaker.trips));

  lines.push("# HELP l2_attempts_total Total L2 collection attempts per pair");
  lines.push("# TYPE l2_attempts_total counter");
  for (const p of summary.pairs) {
    lines.push(metric("l2_attempts_total", { pair: p.pair }, p.totalAttempts));
  }

  lines.push("# HELP l2_successes_total Total successful L2 collections per pair");
  lines.push("# TYPE l2_successes_total counter");
  for (const p of summary.pairs) {
    lines.push(metric("l2_successes_total", { pair: p.pair }, p.totalSuccesses));
  }

  lines.push("# HELP l2_failures_total Total failed L2 collections per pair");
  lines.push("# TYPE l2_failures_total counter");
  for (const p of summary.pairs) {
    lines.push(metric("l2_failures_total", { pair: p.pair }, p.totalFailures));
  }

  lines.push("# HELP l2_consecutive_failures Current consecutive failures per pair");
  lines.push("# TYPE l2_consecutive_failures gauge");
  for (const p of summary.pairs) {
    lines.push(metric("l2_consecutive_failures", { pair: p.pair }, p.consecutiveFailures));
  }

  lines.push("# HELP l2_last_success_age_seconds Seconds since last successful collection per pair");
  lines.push("# TYPE l2_last_success_age_seconds gauge");
  for (const p of summary.pairs) {
    const age = p.lastSuccessAt ? Math.max(0, summary.generatedAt - p.lastSuccessAt) : -1;
    lines.push(metric("l2_last_success_age_seconds", { pair: p.pair }, age));
  }

  lines.push("# HELP l2_last_retries Retries used in the last attempt per pair");
  lines.push("# TYPE l2_last_retries gauge");
  for (const p of summary.pairs) {
    lines.push(metric("l2_last_retries", { pair: p.pair }, p.lastRetriesUsed));
  }

  lines.push("# HELP l2_snapshot_count Stored L2 snapshot count per pair");
  lines.push("# TYPE l2_snapshot_count gauge");
  for (const p of summary.pairs) {
    lines.push(metric("l2_snapshot_count", { pair: p.pair }, p.lastSnapshotCount));
  }

  lines.push("# HELP l2_active_alerts Total number of active alerts");
  lines.push("# TYPE l2_active_alerts gauge");
  lines.push(metric("l2_active_alerts", {}, summary.alerts.length));

  lines.push("# HELP l2_alerts_by_severity Active alerts by severity level");
  lines.push("# TYPE l2_alerts_by_severity gauge");
  for (const sev of ["info", "warn", "error", "critical"] as const) {
    const count = summary.alerts.filter((a: any) => a.severity === sev).length;
    lines.push(metric("l2_alerts_by_severity", { severity: sev }, count));
  }

  // Per-pair circuit breaker metrics (priority #4)
  lines.push("# HELP l2_pair_circuit_open Whether a per-pair circuit breaker is open (1/0)");
  lines.push("# TYPE l2_pair_circuit_open gauge");
  for (const [pair, pcb] of Object.entries(summary.pairCircuitBreakers || {})) {
    const cb = pcb as any;
    lines.push(metric("l2_pair_circuit_open", { pair }, cb.open ? 1 : 0));
  }

  lines.push("# HELP l2_pair_circuit_trips_total Total trips for each per-pair circuit breaker");
  lines.push("# TYPE l2_pair_circuit_trips_total counter");
  for (const [pair, pcb] of Object.entries(summary.pairCircuitBreakers || {})) {
    const cb = pcb as any;
    lines.push(metric("l2_pair_circuit_trips_total", { pair }, cb.trips));
  }

  lines.push("# HELP l2_persisted_at_timestamp Unix timestamp of last successful DB persist (0=never)");
  lines.push("# TYPE l2_persisted_at_timestamp gauge");
  lines.push(metric("l2_persisted_at_timestamp", {}, summary.persistedAt ?? 0));

  return lines.join("\n") + "\n";
}
