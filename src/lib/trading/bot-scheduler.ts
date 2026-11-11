// In-process bot scheduler — starts a 60s interval that calls botTick().
// Also collects L2 order book snapshots periodically for historical backtest calibration.
//
// Production hardening:
//  - L2 collection interval: 30 ticks (≈30 min).
//  - Each pair uses fetchAndStoreL2WithRetry (exponential backoff).
//  - Every attempt recorded in the in-process L2 monitor.
//  - Circuit breaker: skips collection cycle when open (cascade-failure guard).
//  - State persisted to DB after each cycle (survives hot-reload).
//  - External alerting (Telegram + webhook) fires on NEW error-level incidents.
//  - Monitor hydrated from DB on scheduler startup.

import { botTick } from "./bot";
import { fetchAndStoreL2WithRetry, getL2SnapshotCount, getLatestL2Snapshot } from "./l2-storage";
import { loadCandles } from "./candles";
import {
  recordL2Attempt,
  recordSchedulerTick,
  recordCollectionCycle,
  isCircuitOpen,
  isPairCircuitOpen,
  getL2Health,
  getNewErrorAlerts,
  persistL2Health,
  hydrateL2MonitorFromDB,
} from "./l2-monitor";
import { sendL2ExternalAlerts, sendL2RecoveryAlert } from "./l2-alerts";

const globalForBot = globalThis as unknown as { __botSchedulerStarted?: boolean; __prevL2Status?: string };

export function ensureBotScheduler(): { started: boolean; running: boolean } {
  if (globalForBot.__botSchedulerStarted) return { started: false, running: true };
  globalForBot.__botSchedulerStarted = true;
  console.log("[bot-scheduler] starting 60s interval (in-process)");

  // L2 collection pairs — collect for all trading pairs
  const L2_PAIRS = ["btc_idr", "eth_idr", "sol_idr", "bnb_idr", "xrp_idr"];
  const L2_COLLECT_INTERVAL_TICKS = 30;
  let l2TickCounter = 0;

  // Track previous status for recovery-alert transitions
  globalForBot.__prevL2Status = "healthy";

  // Hydrate monitor from DB on startup (async, non-blocking — first cycle will await)
  hydrateL2MonitorFromDB().catch((e) => {
    console.warn("[bot-scheduler] hydrate failed on startup:", e instanceof Error ? e.message : e);
  });

  const run = async () => {
    // Record scheduler liveness for the health monitor.
    recordSchedulerTick();

    try {
      const r = await botTick();
      if (r.enabled) console.log(`[bot-scheduler] ${r.pair} ${r.mode} · ${r.action} · sig=${r.signal} ${r.strength}% · ${r.candleCount} candles`);
    } catch (e) { console.error("[bot-scheduler] tick error:", e instanceof Error ? e.message : e); }

    // L2 snapshot collection — aligned to roughly every 30 min
    l2TickCounter++;
    if (l2TickCounter >= L2_COLLECT_INTERVAL_TICKS) {
      l2TickCounter = 0;

      // Circuit breaker check — skip the whole cycle if open
      if (isCircuitOpen()) {
        const health = getL2Health();
        console.warn(
          `[l2-collector] circuit breaker OPEN — skipping collection cycle ` +
          `(trips: ${health.circuitBreaker.trips}, cooldown until ${health.circuitBreaker.openUntil ? new Date(health.circuitBreaker.openUntil * 1000).toISOString() : "n/a"})`,
        );
        // Still persist state + check for recovery/half-open transitions
        await persistL2Health();
        return;
      }

      console.log(`[l2-collector] starting collection cycle for ${L2_PAIRS.length} pairs`);
      let okCount = 0;
      let failCount = 0;

      for (const pair of L2_PAIRS) {
        // Per-pair circuit breaker (#4) — skip pairs whose circuit is open
        if (isPairCircuitOpen(pair)) {
          const health = getL2Health();
          const pcb = health.pairCircuitBreakers[pair];
          console.warn(`[l2-collector] ${pair}: per-pair circuit OPEN — skipping (trips: ${pcb?.trips ?? 0})`);
          continue;
        }
        try {
          const candles = await loadCandles(pair, "1h", 100);
          const avgVol = candles.length > 0 ? candles.reduce((a, c) => a + c.volume, 0) / candles.length : 1000;

          const result = await fetchAndStoreL2WithRetry(pair, avgVol);

          const snapCount = await getL2SnapshotCount(pair);
          const latestSnap = await getLatestL2Snapshot(pair);

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
          failCount++;
          const msg = e instanceof Error ? e.message : String(e);
          recordL2Attempt(pair, { success: false, error: msg });
          console.error(`[l2-collector] ${pair}: unexpected error —`, msg);
        }
      }

      console.log(`[l2-collector] cycle complete — ${okCount}/${L2_PAIRS.length} OK, ${failCount} failed`);

      // Update circuit breaker based on this cycle's results
      recordCollectionCycle(okCount, L2_PAIRS.length);

      // Persist monitor state to DB (survives hot-reload)
      await persistL2Health();

      // External alerting: fire on NEW error-level incidents
      const health = getL2Health();
      const newAlerts = getNewErrorAlerts();
      if (newAlerts.length > 0) {
        sendL2ExternalAlerts(newAlerts, health).catch((e) => {
          console.warn("[l2-collector] external alert delivery failed:", e instanceof Error ? e.message : e);
        });
      }

      // Recovery notification: if status transitioned from down → healthy/degraded
      const prevStatus = globalForBot.__prevL2Status ?? "healthy";
      if (prevStatus === "down" && health.status !== "down") {
        sendL2RecoveryAlert(health, prevStatus).catch(() => {});
      }
      globalForBot.__prevL2Status = health.status;
    }
  };
  setTimeout(run, 3000);
  setInterval(run, 60_000);
  return { started: true, running: true };
}
