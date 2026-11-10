import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getOpenPositions, getClosedPositions } from "@/lib/trading/positions";
import { ensureBotScheduler } from "@/lib/trading/bot-scheduler";

export const runtime = "nodejs";

export async function GET(req: Request) {
  ensureBotScheduler();
  const url = new URL(req.url);
  const pair = url.searchParams.get("pair") || undefined;
  const cfg = await db.botConfig.findUnique({ where: { id: "singleton" } });
  const open = await getOpenPositions(pair);
  const closed = await getClosedPositions(pair, 30);
  const logs = await db.botLog.findMany({ where: pair ? { pair } : {}, orderBy: { ts: "desc" }, take: 50 });
  const realizedPnl = closed.reduce((a, p) => a + (p.pnl || 0), 0);
  const totalCost = open.reduce((a, p) => a + p.amountIdr, 0);
  return NextResponse.json({
    config: cfg ? { ...cfg, secretKey: cfg.secretKey ? "••••••••" : null } : null,
    open: open.map(p => ({ id: p.id, pair: p.pair, entryPrice: p.entryPrice, amount: p.amount, amountIdr: p.amountIdr, stopLoss: p.stopLoss, takeProfit: p.takeProfit, strategy: p.strategy, signalScore: p.signalScore, mode: p.mode, openedAt: p.openedAt })),
    closed: closed.map(p => ({ id: p.id, pair: p.pair, entryPrice: p.entryPrice, exitPrice: p.exitPrice, pnl: p.pnl, pnlPct: p.pnlPct, mode: p.mode, openedAt: p.openedAt, closedAt: p.closedAt })),
    logs: logs.map(l => ({ ts: l.ts, level: l.level, message: l.message, pair: l.pair })),
    summary: { openCount: open.length, closedCount: closed.length, realizedPnl, totalCost, capital: cfg?.capitalIdr || 0 },
  });
}
