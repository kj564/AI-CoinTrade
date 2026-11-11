// In-process bot scheduler — starts a 60s interval that calls botTick().
// Also collects L2 order book snapshots periodically for historical backtest calibration.
//
// This round (infra hardening):
//  - L2 collection interval reduced from 60 → 30 ticks (≈30 min) for higher
//    collection frequency (evaluator priority #6).
//  - Each pair uses fetchAndStoreL2WithRetry (exponential backoff) so transient
//    INDODAX API failures self-heal (priority #2).
//  - Every attempt is recorded in the in-process L2 monitor so failures are
//    detectable via /api/l2/health (priorities #1, #3, #4).
//  - Per-pair errors are logged with structured context for debugging (#3).

import { botTick } from "./bot";
import { fetchAndStoreL2WithRetry, getL2SnapshotCount, getLatestL2Snapshot } from "./l2-storage";
import { loadCandles } from "./candles";
import { recordL2Attempt, recordSchedulerTick } from "./l2-monitor";

const globalForBot = globalThis as unknown as { __botSchedulerStarted?: boolean };

export function ensureBotScheduler(): { started: boolean; running: boolean } {
  if (globalForBot.__botSchedulerStarted) return { started: false, running: true };
  globalForBot.__botSchedulerStarted = true;
  console.log("[bot-scheduler] starting 60s interval (in-process)");

  // L2 collection pairs — collect for all trading pairs
  const L2_PAIRS = ["btc_idr", "eth_idr", "sol_idr", "bnb_idr", "xrp_idr"];
  // Collect every 30 ticks (≈30 min) instead of 60 — higher frequency for
  // finer-grained historical calibration + redundancy against single-tick failure.
  const L2_COLLECT_INTERVAL_TICKS = 30;
  let l2TickCounter = 0;

  const run = async () => {
    // Record scheduler liveness for the health monitor (priority #1).
    recordSchedulerTick();

    try {
      const r = await botTick();
      if (r.enabled) console.log(`[bot-scheduler] ${r.pair} ${r.mode} · ${r.action} · sig=${r.signal} ${r.strength}% · ${r.candleCount} candles`);
    } catch (e) { console.error("[bot-scheduler] tick error:", e instanceof Error ? e.message : e); }

    // L2 snapshot collection — aligned to roughly every 30 min
    l2TickCounter++;
    if (l2TickCounter >= L2_COLLECT_INTERVAL_TICKS) {
      l2TickCounter = 0;
      console.log(`[l2-collector] starting collection cycle for ${L2_PAIRS.length} pairs`);
      let okCount = 0;
      let failCount = 0;

      for (const pair of L2_PAIRS) {
        try {
          // Get avg candle volume for calibration
          const candles = await loadCandles(pair, "1h", 100);
          const avgVol = candles.length > 0 ? candles.reduce((a, c) => a + c.volume, 0) / candles.length : 1000;

          // Retry-enabled fetch with exponential backoff (priority #2)
          const result = await fetchAndStoreL2WithRetry(pair, avgVol);

          // Fetch count/age for the monitor record (cheap DB queries)
          const snapCount = await getL2SnapshotCount(pair);
          const latestSnap = await getLatestL2Snapshot(pair);

          // Record to in-process monitor (priorities #1, #3) with full context
          recordL2Attempt(pair, {
            success: !!result.snapshot,
            error: result.snapshot ? undefined : (result.errors[result.errors.length - 1] ?? "unknown"),
            retriesUsed: result.retriesUsed,
            durationMs: result.durationMs,
            snapshotCount: snapCount,
            ageSec: latestSnap?.ageSec,
          });

          if (result.snapshot) {
            okCount++;
            const l2 = result.snapshot;
            console.log(
              `[l2-collector] ${pair}: OK — ${l2.bidLevels} bid / ${l2.askLevels} ask levels, spread ${l2.realSpreadPct.toFixed(4)}%` +
              (result.retriesUsed > 0 ? `, recovered after ${result.retriesUsed} retry(ies)` : "") +
              `, ${result.durationMs}ms`,
            );
          } else {
            failCount++;
            console.error(
              `[l2-collector] ${pair}: FAILED after ${result.attempts} attempt(s) — ` +
              result.errors.join("; "),
            );
          }
        } catch (e) {
          // Should be unreachable (retry wrapper catches), but guard anyway
          failCount++;
          const msg = e instanceof Error ? e.message : String(e);
          recordL2Attempt(pair, { success: false, error: msg });
          console.error(`[l2-collector] ${pair}: unexpected error —`, msg);
        }
      }

      console.log(`[l2-collector] cycle complete — ${okCount}/${L2_PAIRS.length} OK, ${failCount} failed`);
    }
  };
  setTimeout(run, 3000);
  setInterval(run, 60_000);
  return { started: true, running: true };
}
