// In-process bot scheduler — starts a 60s interval that calls botTick().

import { botTick } from "./bot";

const globalForBot = globalThis as unknown as { __botSchedulerStarted?: boolean };

export function ensureBotScheduler(): { started: boolean; running: boolean } {
  if (globalForBot.__botSchedulerStarted) return { started: false, running: true };
  globalForBot.__botSchedulerStarted = true;
  console.log("[bot-scheduler] starting 60s interval (in-process)");
  const run = async () => {
    try { const r = await botTick(); if (r.enabled) console.log(`[bot-scheduler] ${r.pair} ${r.mode} · ${r.action} · sig=${r.signal} ${r.strength}% · ${r.candleCount} candles`); }
    catch (e) { console.error("[bot-scheduler] tick error:", e instanceof Error ? e.message : e); }
  };
  setTimeout(run, 3000);
  setInterval(run, 60_000);
  return { started: true, running: true };
}
