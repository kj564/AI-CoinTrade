// In-process bot scheduler — starts a 60s interval that calls botTick().
// Also collects L2 order book snapshots periodically for historical backtest calibration.

import { botTick } from "./bot";
import { fetchAndStoreL2 } from "./l2-storage";
import { loadCandles } from "./candles";

const globalForBot = globalThis as unknown as { __botSchedulerStarted?: boolean };

export function ensureBotScheduler(): { started: boolean; running: boolean } {
  if (globalForBot.__botSchedulerStarted) return { started: false, running: true };
  globalForBot.__botSchedulerStarted = true;
  console.log("[bot-scheduler] starting 60s interval (in-process)");

  // L2 collection pairs — collect for all trading pairs
  const L2_PAIRS = ["btc_idr", "eth_idr", "sol_idr", "bnb_idr", "xrp_idr"];
  let l2TickCounter = 0;

  const run = async () => {
    try {
      const r = await botTick();
      if (r.enabled) console.log(`[bot-scheduler] ${r.pair} ${r.mode} · ${r.action} · sig=${r.signal} ${r.strength}% · ${r.candleCount} candles`);
    } catch (e) { console.error("[bot-scheduler] tick error:", e instanceof Error ? e.message : e); }

    // L2 snapshot collection — every 60 ticks (≈1 hour), aligned to candle close
    l2TickCounter++;
    if (l2TickCounter >= 60) {
      l2TickCounter = 0;
      for (const pair of L2_PAIRS) {
        try {
          // Get avg candle volume for calibration
          const candles = await loadCandles(pair, "1h", 100);
          const avgVol = candles.length > 0 ? candles.reduce((a, c) => a + c.volume, 0) / candles.length : 1000;
          const l2 = await fetchAndStoreL2(pair, avgVol);
          if (l2) {
            console.log(`[l2-collector] ${pair}: stored snapshot — ${l2.bidLevels} bid / ${l2.askLevels} ask levels, spread ${l2.realSpreadPct.toFixed(4)}%`);
          }
        } catch (e) {
          console.error(`[l2-collector] ${pair}: failed —`, e instanceof Error ? e.message : e);
        }
      }
    }
  };
  setTimeout(run, 3000);
  setInterval(run, 60_000);
  return { started: true, running: true };
}
