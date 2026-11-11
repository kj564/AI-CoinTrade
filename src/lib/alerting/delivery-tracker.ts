// L2 Alerting — delivery tracking (in-process counters for Prometheus).
//
// Tracks per-channel success/failure counts so the metrics exporter can emit:
//   l2_alert_delivery_success_total{channel="slack"} 3
//   l2_alert_delivery_failed_total{channel="email"} 1
//
// These counters power the Grafana alert rule:
//   increase(l2_alert_delivery_failed_total[15m]) > 0  → critical
//
// Counters are in-process (single-instance). For multi-instance deployments,
// scrape each instance's /api/l2/metrics and aggregate in Prometheus.

interface DeliveryCounters {
  success: Record<string, number>;
  failed: Record<string, number>;
  lastDeliveryAt: Record<string, number>; // unix sec, by channel
}

const CHANNELS = ["telegram", "slack", "discord", "email", "webhook"] as const;
type ChannelName = (typeof CHANNELS)[number];

const globalForCounters = globalThis as unknown as { __l2AlertDelivery?: DeliveryCounters };

function getCounters(): DeliveryCounters {
  if (!globalForCounters.__l2AlertDelivery) {
    const fresh: DeliveryCounters = { success: {}, failed: {}, lastDeliveryAt: {} };
    for (const c of CHANNELS) {
      fresh.success[c] = 0;
      fresh.failed[c] = 0;
      fresh.lastDeliveryAt[c] = 0;
    }
    globalForCounters.__l2AlertDelivery = fresh;
  }
  return globalForCounters.__l2AlertDelivery;
}

export function recordDeliverySuccess(channel: ChannelName): void {
  const c = getCounters();
  c.success[channel] = (c.success[channel] ?? 0) + 1;
  c.lastDeliveryAt[channel] = Math.floor(Date.now() / 1000);
}

export function recordDeliveryFailure(channel: ChannelName): void {
  const c = getCounters();
  c.failed[channel] = (c.failed[channel] ?? 0) + 1;
  c.lastDeliveryAt[channel] = Math.floor(Date.now() / 1000);
}

export interface DeliverySnapshot {
  success: Record<string, number>;
  failed: Record<string, number>;
  lastDeliveryAt: Record<string, number>;
}

export function getDeliverySnapshot(): DeliverySnapshot {
  const c = getCounters();
  return {
    success: { ...c.success },
    failed: { ...c.failed },
    lastDeliveryAt: { ...c.lastDeliveryAt },
  };
}

export const DELIVERY_CHANNELS = CHANNELS;
