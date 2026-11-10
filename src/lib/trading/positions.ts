// Position management — open/close/check exits for the trading bot.

import { db } from "@/lib/db";
import { placeOrder, type IndodaxConfig } from "@/lib/indodax";

export async function getOpenPositions(pair?: string) {
  return db.position.findMany({ where: { status: "open", ...(pair ? { pair } : {}) }, orderBy: { openedAt: "desc" } });
}

export async function getClosedPositions(pair?: string, limit = 50) {
  return db.position.findMany({ where: { status: "closed", ...(pair ? { pair } : {}) }, orderBy: { closedAt: "desc" }, take: limit });
}

export function checkExit(pos: { entryPrice: number; stopLoss: number; takeProfit: number; side: string }, currentPrice: number, signal: "BUY" | "SELL" | "HOLD") {
  if (currentPrice <= pos.stopLoss) return { shouldExit: true, reason: "Stop loss hit", exitPrice: pos.stopLoss };
  if (currentPrice >= pos.takeProfit) return { shouldExit: true, reason: "Take profit hit", exitPrice: pos.takeProfit };
  if (signal === "SELL") return { shouldExit: true, reason: "Signal reversed to SELL", exitPrice: currentPrice };
  return { shouldExit: false, reason: "", exitPrice: 0 };
}

export async function closePosition(posId: string, exitPrice: number, reason: string, mode: string, config?: IndodaxConfig) {
  const pos = await db.position.findUnique({ where: { id: posId } });
  if (!pos || pos.status !== "open") return { ok: false, error: "Position not open" };
  let orderId: string | undefined;
  if (mode === "live" && config) {
    try { const res = await placeOrder(config, { pair: pos.pair, type: "sell", price: Math.round(exitPrice), amount: pos.amount }); orderId = res.return?.order_id; }
    catch (e) { return { ok: false, error: e instanceof Error ? e.message : "Sell order failed" }; }
  }
  const pnl = (exitPrice - pos.entryPrice) * pos.amount;
  const pnlPct = ((exitPrice - pos.entryPrice) / pos.entryPrice) * 100;
  await db.position.update({ where: { id: posId }, data: { status: "closed", exitPrice, exitTime: new Date(), pnl, pnlPct, closedAt: new Date(), orderId: orderId ?? pos.orderId } });
  return { ok: true, orderId };
}

export async function openPosition(pair: string, entryPrice: number, amountIdr: number, stopLoss: number, takeProfit: number, strategy: string, signalScore: number, mode: string, config?: IndodaxConfig) {
  const coinAmount = amountIdr / entryPrice;
  let orderId: string | undefined;
  if (mode === "live" && config) {
    try { const res = await placeOrder(config, { pair, type: "buy", price: Math.round(entryPrice), amount: amountIdr }); orderId = res.return?.order_id; }
    catch (e) { return { ok: false, error: e instanceof Error ? e.message : "Buy order failed" }; }
  }
  const pos = await db.position.create({ data: { pair, side: "long", entryPrice, amount: coinAmount, amountIdr, stopLoss, takeProfit, strategy, signalScore, status: "open", mode, orderId } });
  return { ok: true, id: pos.id, orderId };
}
