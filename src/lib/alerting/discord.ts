// L2 Alerting — Discord delivery (via incoming webhook).
//
// Server-only. Uses fetch only (no native deps).
//
// Env: L2_ALERT_DISCORD_WEBHOOK_URL

import { recordDeliverySuccess, recordDeliveryFailure } from "./delivery-tracker";

// Send a plain-text Discord message (Markdown supported by Discord).
export async function sendDiscord(text: string, traceId?: string): Promise<boolean> {
  const url = process.env.L2_ALERT_DISCORD_WEBHOOK_URL;
  if (!url) return false;
  try {
    const content = traceId ? `${text}\n\n_\`trace=${traceId}\`_` : text;
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: content.slice(0, 2000) }),
      signal: AbortSignal.timeout(8000),
    });
    if (r.ok) recordDeliverySuccess("discord");
    else recordDeliveryFailure("discord");
    return r.ok;
  } catch (e) {
    recordDeliveryFailure("discord");
    console.warn(`[l2-alerts] [trace=${traceId ?? "n/a"}] Discord failed:`, e instanceof Error ? e.message : e);
    return false;
  }
}
