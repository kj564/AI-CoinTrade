// L2 Alerting — trace ID generation for end-to-end observability.
//
// Every collect cycle and every alert dispatch gets a short trace ID so
// logs and responses can be correlated across the pipeline:
//   collect route → l2-monitor → l2-alerts dispatch → channel delivery
//
// The ID is a 12-char hex string (48 bits of entropy) — short enough for
// logs, unique enough for correlation within a single dispatch.

export function generateTraceId(): string {
  // crypto.randomUUID is available in Node 19+ and all modern runtimes.
  // Strip dashes and take the first 12 hex chars for a compact ID.
  try {
    const uuid = (globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2));
    return uuid.replace(/-/g, "").slice(0, 12).toLowerCase();
  } catch {
    return Math.random().toString(36).slice(2, 14).toLowerCase();
  }
}
