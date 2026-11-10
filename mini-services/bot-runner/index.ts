// Bot runner — standalone scheduler that ticks the Next.js bot engine.
// Every TICK_INTERVAL_SEC it POSTs to /api/bot/tick (via the gateway with XTransformPort).
// The tick endpoint handles: backfill candles (always) + evaluate/trade (if enabled).

const PORT = 3031; // not actually opened — this service only makes outbound calls
const NEXT_API = "http://localhost:3000";
const TICK_INTERVAL_SEC = 60; // tick every minute

async function tick(): Promise<void> {
  const t0 = Date.now();
  try {
    const r = await fetch(`${NEXT_API}/api/bot/tick`, { method: "POST" });
    const d = await r.json();
    if (d.error) {
      console.log(`[${new Date().toISOString()}] tick ERROR: ${d.error} (${Date.now() - t0}ms)`);
    } else {
      const tag = d.enabled ? `ENABLED ${d.action}` : `disabled (${d.action})`;
      const trades = d.openedThisTick ? " [OPENED]" : d.closedThisTick > 0 ? ` [closed ${d.closedThisTick}]` : "";
      console.log(`[${new Date().toISOString()}] ${d.pair} ${d.mode} · ${tag}${trades} · sig=${d.signal} ${d.strength}% · ${d.candleCount} candles (${Date.now() - t0}ms)`);
      for (const l of d.logs || []) {
        const icon = l.level === "trade" ? "💵" : l.level === "error" ? "✗" : l.level === "warn" ? "⚠" : "›";
        console.log(`    ${icon} ${l.message}`);
      }
    }
  } catch (e) {
    console.log(`[${new Date().toISOString()}] tick FAILED: ${e instanceof Error ? e.message : e} (${Date.now() - t0}ms)`);
  }
}

console.log(`🤖 Bot runner started — ticking ${NEXT_API}/api/bot/tick every ${TICK_INTERVAL_SEC}s`);

// initial tick immediately
tick();
// then on interval
setInterval(tick, TICK_INTERVAL_SEC * 1000);

// keep process alive
setInterval(() => {}, 1 << 30);
