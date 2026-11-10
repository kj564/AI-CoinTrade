// Bot engine — one tick of the autonomous trading loop.

import { db } from "@/lib/db";
import { getTicker, type IndodaxConfig } from "@/lib/indodax";
import { ensureCandles, loadCandles, candlesToArrays } from "@/lib/trading/candles";
import { generateStrategy } from "@/lib/trading/research";
import { calcATR } from "@/lib/trading/backtest";
import { getOpenPositions, checkExit, closePosition, openPosition } from "@/lib/trading/positions";
import { sendTelegram, formatOpenMessage, formatCloseMessage } from "@/lib/telegram";

export interface BotTickResult {
  ts: string; enabled: boolean; pair: string; mode: string; action: string;
  signal: string; bias: string; strength: number; price: number;
  candleCount: number; openCount: number; closedThisTick: number; openedThisTick: boolean;
  atr: number;
  logs: { level: string; message: string }[];
}

async function log(level: string, message: string, pair?: string, meta?: any) {
  await db.botLog.create({ data: { level, message, pair, meta: meta ? JSON.stringify(meta) : null } });
}

export async function botTick(): Promise<BotTickResult> {
  const cfg = await db.botConfig.findUnique({ where: { id: "singleton" } });
  const now = new Date().toISOString();
  const logs: { level: string; message: string }[] = [];

  if (!cfg) return { ts: now, enabled: false, pair: "-", mode: "-", action: "no config", signal: "HOLD", bias: "neutral", strength: 0, price: 0, candleCount: 0, openCount: 0, closedThisTick: 0, openedThisTick: false, logs };

  if (!cfg.enabled) {
    try {
      const { count } = await ensureCandles(cfg.pair, "1m", 30);
      return { ts: now, enabled: false, pair: cfg.pair, mode: cfg.mode, action: `disabled (accruing: ${count} candles)`, signal: "HOLD", bias: "neutral", strength: 0, price: 0, candleCount: count, openCount: 0, closedThisTick: 0, openedThisTick: false, logs: [{ level: "info", message: `Disabled — accrued ${count} 1m candles` }] };
    } catch { return { ts: now, enabled: false, pair: cfg.pair, mode: cfg.mode, action: "disabled", signal: "HOLD", bias: "neutral", strength: 0, price: 0, candleCount: 0, openCount: 0, closedThisTick: 0, openedThisTick: false, logs }; }
  }

  const pair = cfg.pair, mode = cfg.mode;
  const indodaxCfg: IndodaxConfig | undefined = mode === "live" && cfg.apiKey && cfg.secretKey ? { apiKey: cfg.apiKey, secretKey: cfg.secretKey } : undefined;

  // Use 1h candles for signal generation (649 available = 27 days context)
  // Falls back to 1m if 1h not available
  let candles1h = await loadCandles(pair, "1h", 300);
  let tfUsed = "1h";
  if (candles1h.length < 30) {
    // backfill 1h if not enough
    const { candles: m1, count } = await ensureCandles(pair, "1m", 30);
    candles1h = m1; tfUsed = "1m";
    if (candles1h.length < 10) {
      const msg = `Insufficient candles (${candles1h.length}) for ${pair}`;
      logs.push({ level: "warn", message: msg }); await log("warn", msg, pair, { count: candles1h.length });
      return { ts: now, enabled: true, pair, mode, action: "backfilling", signal: "HOLD", bias: "neutral", strength: 0, price: 0, candleCount: candles1h.length, openCount: 0, closedThisTick: 0, openedThisTick: false, atr: 0, logs };
    }
  }

  const { closes, highs, lows, volumes } = candlesToArrays(candles1h);
  const strat = await generateStrategy(pair, closes, highs, lows, volumes);
  const currentPrice = strat.indicators.currentPrice;

  // Multi-timeframe confirmation: check daily trend (1d SMA10 vs SMA20)
  const candles1d = await loadCandles(pair, "1d", 50);
  let dailyTrend: "bullish" | "bearish" | "neutral" = "neutral";
  if (candles1d.length >= 20) {
    const dCloses = candles1d.map(c => c.close);
    const sma10 = dCloses.slice(-10).reduce((a, b) => a + b, 0) / 10;
    const sma20 = dCloses.slice(-20).reduce((a, b) => a + b, 0) / 20;
    dailyTrend = sma10 > sma20 ? "bullish" : sma10 < sma20 ? "bearish" : "neutral";
  }
  // Filter: only BUY if daily trend is bullish (multi-timeframe confirmation)
  const filteredSignal = strat.signal === "BUY" && dailyTrend === "bearish" ? "HOLD" : strat.signal;
  if (strat.signal === "BUY" && filteredSignal === "HOLD") {
    logs.push({ level: "info", message: `BUY signal filtered — daily trend bearish (MTF confirmation)` });
  }

  logs.push({ level: "info", message: `Signal ${filteredSignal} (${strat.bias} ${strat.strength}%) @ ${currentPrice.toFixed(0)} · ${candles1h.length} ${tfUsed} candles · daily ${dailyTrend}` });

  const openPositions = await getOpenPositions(pair);
  let closedThisTick = 0;
  for (const pos of openPositions) {
    const exit = checkExit({ entryPrice: pos.entryPrice, stopLoss: pos.stopLoss, takeProfit: pos.takeProfit, side: pos.side }, currentPrice, filteredSignal);
    if (exit.shouldExit) {
      const res = await closePosition(pos.id, exit.exitPrice, exit.reason, mode, indodaxCfg);
      if (res.ok) { closedThisTick++; const pnl = (exit.exitPrice - pos.entryPrice) * pos.amount; const pnlPct = (pnl / (pos.entryPrice * pos.amount)) * 100; const msg = `Closed ${pair} (${exit.reason}) @ ${exit.exitPrice.toFixed(0)} · PnL ${pnl >= 0 ? "+" : ""}${pnl.toFixed(0)}`; logs.push({ level: "trade", message: msg }); await log("trade", msg, pair, { reason: exit.reason, exitPrice: exit.exitPrice, pnl });
        // Telegram notification
        if (cfg.telegramToken && cfg.telegramChatId) { sendTelegram(cfg.telegramToken, cfg.telegramChatId, formatCloseMessage({ mode, pair, reason: exit.reason, exitPrice: exit.exitPrice, entryPrice: pos.entryPrice, pnl, pnlPct })).catch(() => {}); }
      }
      else { const msg = `Close failed: ${res.error}`; logs.push({ level: "error", message: msg }); await log("error", msg, pair, { error: res.error }); }
    }
  }

  // ATR on 1h candles for volatility-adaptive position sizing
  const atr = calcATR(candles1h.map(c => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume })), 14);

  let openedThisTick = false;
  const remainingOpen = await getOpenPositions(pair);
  if (filteredSignal === "BUY" && remainingOpen.length === 0) {
    const riskAmount = cfg.capitalIdr * (cfg.riskPct / 100);
    // ATR-based stops: SL = 1.5×ATR below entry, TP = 3×ATR above (1:2 risk:reward)
    const stopLoss = atr > 0 ? currentPrice - atr * 1.5 : currentPrice * (1 - cfg.stopLossPct / 100);
    const takeProfit = atr > 0 ? currentPrice + atr * 3 : currentPrice * (1 + cfg.takeProfitPct / 100);
    const stopDist = Math.abs(currentPrice - stopLoss);
    const coinAmount = stopDist > 0 ? riskAmount / stopDist : riskAmount / currentPrice;
    const positionIdr = coinAmount * currentPrice;
    const res = await openPosition(pair, currentPrice, positionIdr, stopLoss, takeProfit, cfg.strategy, strat.strength, mode, indodaxCfg);
    if (res.ok) { openedThisTick = true; const msg = `Opened ${mode.toUpperCase()} ${pair} LONG @ ${currentPrice.toFixed(0)} · ${positionIdr.toFixed(0)} IDR · SL ${stopLoss.toFixed(0)} (ATR ${atr.toFixed(0)}) · TP ${takeProfit.toFixed(0)} · daily ${dailyTrend}`; logs.push({ level: "trade", message: msg }); await log("trade", msg, pair, { entryPrice: currentPrice, positionIdr, stopLoss, takeProfit, atr, dailyTrend, orderId: res.orderId });
      // Telegram notification
      if (cfg.telegramToken && cfg.telegramChatId) { sendTelegram(cfg.telegramToken, cfg.telegramChatId, formatOpenMessage({ mode, pair, entryPrice: currentPrice, positionIdr, stopLoss, takeProfit, atr, strategy: cfg.strategy, dailyTrend })).catch(() => {}); }
    }
    else { const msg = `Open failed: ${res.error}`; logs.push({ level: "error", message: msg }); await log("error", msg, pair, { error: res.error }); }
  } else if (filteredSignal !== "BUY") logs.push({ level: "info", message: `No entry — signal ${filteredSignal}` });
  else if (remainingOpen.length > 0) logs.push({ level: "info", message: `No entry — ${remainingOpen.length} position(s) open` });

  await log("info", `Tick complete: ${filteredSignal} · ${candles1h.length} ${tfUsed} · ATR ${atr.toFixed(0)} · daily ${dailyTrend} · ${closedThisTick} closed · ${openedThisTick ? "1 opened" : "0 opened"}`, pair);
  return { ts: now, enabled: true, pair, mode, action: openedThisTick ? "opened" : closedThisTick > 0 ? "closed" : "monitoring", signal: filteredSignal, bias: strat.bias, strength: strat.strength, price: currentPrice, candleCount: candles1h.length, openCount: remainingOpen.length, closedThisTick, openedThisTick, atr, logs };
}
