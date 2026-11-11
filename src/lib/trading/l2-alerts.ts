// L2 Alerting — backward-compat re-export shim.
//
// The alerting implementation has been split into focused modules under
// src/lib/alerting/* for cleaner module boundaries (Turbopack-friendly):
//   - types.ts           shared interfaces
//   - channels.ts        pure channel config + severity routing (no native deps)
//   - format.ts          message formatting
//   - trace.ts           trace ID generation
//   - delivery-tracker.ts per-channel success/failure counters
//   - slack/discord/webhook.ts  fetch-based channel delivery
//   - email.ts           nodemailer (dynamic import)
//   - dispatch.ts        multi-channel orchestrator (imports db + telegram)
//   - test.ts            smoke-test helper
//
// This file re-exports the public API so existing imports
// (`import { ... } from "@/lib/trading/l2-alerts"`) continue to work.
// New code should import directly from the focused modules.

export type {
  AlertSeverity,
  AlertChannelConfig,
  AlertDeliveryResult,
  AlertTestDeliveryResult,
  ChannelDeliveryDetail,
} from "@/lib/alerting/types";

export {
  getConfiguredChannels,
  alertSeverity,
  channelsForSeverity,
  listActiveChannels,
} from "@/lib/alerting/channels";

export { severityIcon, formatAlertDigest, formatTestAlertText } from "@/lib/alerting/format";
export { generateTraceId } from "@/lib/alerting/trace";
export {
  recordDeliverySuccess,
  recordDeliveryFailure,
  getDeliverySnapshot,
  DELIVERY_CHANNELS,
} from "@/lib/alerting/delivery-tracker";
export { sendL2ExternalAlerts, sendL2RecoveryAlert } from "@/lib/alerting/dispatch";
export { sendTestAlert } from "@/lib/alerting/test";
