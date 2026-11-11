// L2 Alerting — shared types.
//
// These types are imported by both the pure channel-config module and the
// server-only dispatch module. Keeping them in a leaf module means routes
// that only need the types (e.g. health route reading configuredChannels)
// don't transitively load nodemailer / ioredis / db.

import type { L2Alert, L2HealthSummary } from "@/lib/trading/l2-monitor";

export type AlertSeverity = "info" | "warn" | "error" | "critical";

export interface AlertChannelConfig {
  telegram: boolean;
  slack: boolean;
  discord: boolean;
  email: boolean;
  webhook: boolean;
}

export interface ChannelDeliveryDetail {
  attempted: boolean;
  success: boolean | null;
  durationMs: number;
  error?: string;
}

export interface AlertDeliveryResult {
  telegram: boolean | null;
  slack: boolean | null;
  discord: boolean | null;
  email: boolean | null;
  webhook: boolean | null;
  alertCount: number;
  severity: AlertSeverity;
  traceId?: string;
}

export interface AlertTestDeliveryResult {
  traceId: string;
  severity: AlertSeverity;
  configuredChannels: AlertChannelConfig;
  routedChannels: AlertChannelConfig;
  delivery: {
    telegram: ChannelDeliveryDetail;
    slack: ChannelDeliveryDetail;
    discord: ChannelDeliveryDetail;
    email: ChannelDeliveryDetail;
    webhook: ChannelDeliveryDetail;
  };
  alertCount: number;
  timestamp: string;
}

// Re-export the monitor types that callers of the alerting module need.
export type { L2Alert, L2HealthSummary };
