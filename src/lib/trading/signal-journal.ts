// Signal journal + outcome tracker.
//
// This module closes the loop:
//   1. When a signal fires (action ≠ FLAT), it's recorded in SignalJournal
//   2. On each alpha engine run, open signals are checked against current price
//   3. If price hit stop → status=stopped_out, pnl recorded, circuit breaker updated
//   4. If price hit target → status=target_hit, pnl recorded, circuit breaker updated
//   5. If signal open > 48h → expired
//
// This gives the circuit breaker REAL data to work with, and enables
// portfolio-level P&L tracking via /api/signal/portfolio.

import { db } from "@/lib/db";
import { recordSignalOutcome } from "./alpha-circuit-breaker";

// Record a new signal in the journal (called when action ≠ FLAT)
export async function journalSignal(signal: {
  pair: string;
  action: string;
  entryPrice: number;
  stopLoss: number;
  takeProfit1: number;
  takeProfit2: number;
  positionSizePct: number;
  positionSizeIdr: number;
  conviction: number;
  strength: string;
  severity: string;
  fundingZScore: number;
  regimeAtSignal?: string;
  microstructureSummary?: string;
}): Promise<string | null> {
  try {
    // Don't double-record: if there's an open signal for this pair with same action, skip
    const existing = await db.signalJournal.findFirst({
      where: { pair: signal.pair, action: signal.action, status: "open" },
      orderBy: { createdAt: "desc" },
    });
    if (existing) return existing.id; // already open, don't duplicate

    const entry = await db.signalJournal.create({
      data: {
        pair: signal.pair,
        action: signal.action,
        entryPrice: signal.entryPrice,
        stopLoss: signal.stopLoss,
        takeProfit1: signal.takeProfit1,
        takeProfit2: signal.takeProfit2,
        positionSizePct: signal.positionSizePct,
        positionSizeIdr: signal.positionSizeIdr,
        conviction: signal.conviction,
        strength: signal.strength,
        severity: signal.severity,
        fundingZScore: signal.fundingZScore,
        regimeAtSignal: signal.regimeAtSignal,
        microstructureSummary: signal.microstructureSummary,
      },
    });
    return entry.id;
  } catch (e) {
    console.warn("[journal] failed to record signal:", e instanceof Error ? e.message : e);
    return null;
  }
}

// Check all open signals against current price. Close any that hit stop/target.
export async function checkOpenSignals(currentPrices: Record<string, number>): Promise<{
  checked: number;
  closed: number;
  wins: number;
  losses: number;
}> {
  const openSignals = await db.signalJournal.findMany({ where: { status: "open" } });
  let closed = 0, wins = 0, losses = 0;
  const now = Math.floor(Date.now() / 1000);

  for (const sig of openSignals) {
    const price = currentPrices[sig.pair];
    if (!price || price <= 0) continue;

    const ageHours = (now - Math.floor(sig.createdAt.getTime() / 1000)) / 3600;
    let exitPrice = 0;
    let status: "stopped_out" | "target_hit" | "expired" = "expired";
    let won = false;

    if (sig.action === "LONG") {
      if (price <= sig.stopLoss) {
        exitPrice = sig.stopLoss;
        status = "stopped_out";
        won = false;
      } else if (price >= sig.takeProfit1) {
        exitPrice = sig.takeProfit1;
        status = "target_hit";
        won = true;
      } else if (ageHours > 48) {
        exitPrice = price;
        status = "expired";
        won = price > sig.entryPrice;
      } else {
        continue; // still open
      }
    } else if (sig.action === "SHORT") {
      if (price >= sig.stopLoss) {
        exitPrice = sig.stopLoss;
        status = "stopped_out";
        won = false;
      } else if (price <= sig.takeProfit1) {
        exitPrice = sig.takeProfit1;
        status = "target_hit";
        won = true;
      } else if (ageHours > 48) {
        exitPrice = price;
        status = "expired";
        won = price < sig.entryPrice;
      } else {
        continue;
      }
    }

    // Compute PnL
    const pnlPct = sig.action === "LONG"
      ? (exitPrice - sig.entryPrice) / sig.entryPrice
      : (sig.entryPrice - exitPrice) / sig.entryPrice;
    const pnlIdr = sig.positionSizeIdr * pnlPct;

    await db.signalJournal.update({
      where: { id: sig.id },
      data: {
        status,
        exitPrice,
        exitTime: now,
        pnlIdr,
        pnlPct,
        holdHours: Math.floor(ageHours),
      },
    });

    // Update circuit breaker
    await recordSignalOutcome(sig.pair, sig.action, won);

    closed++;
    if (won) wins++;
    else losses++;
  }

  return { checked: openSignals.length, closed, wins, losses };
}

// Portfolio stats: aggregate P&L across all closed signals
export async function getPortfolioStats(): Promise<{
  totalSignals: number;
  openSignals: number;
  closedSignals: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnlIdr: number;
  avgPnlPct: number;
  avgHoldHours: number;
  bestTrade: number;
  worstTrade: number;
  sharpeRatio: number;
  byPair: { pair: string; signals: number; winRate: number; pnlIdr: number }[];
}> {
  const all = await db.signalJournal.findMany({ orderBy: { createdAt: "desc" } });
  const closed = all.filter((s) => s.status !== "open");
  const open = all.filter((s) => s.status === "open");
  const wins = closed.filter((s) => (s.pnlPct ?? 0) > 0);
  const losses = closed.filter((s) => (s.pnlPct ?? 0) <= 0);
  const totalPnl = closed.reduce((a, s) => a + (s.pnlIdr ?? 0), 0);
  const pnlPcts = closed.map((s) => s.pnlPct ?? 0);
  const avgPnl = pnlPcts.length > 0 ? pnlPcts.reduce((a, b) => a + b, 0) / pnlPcts.length : 0;
  const avgHold = closed.length > 0 ? closed.reduce((a, s) => a + (s.holdHours ?? 0), 0) / closed.length : 0;
  const stdPnl = pnlPcts.length > 1 ? Math.sqrt(pnlPcts.reduce((a, p) => a + Math.pow(p - avgPnl, 2), 0) / pnlPcts.length) : 0;
  const sharpe = stdPnl > 0 && avgHold > 0 ? (avgPnl / stdPnl) * Math.sqrt(365 * 24 / avgHold) : 0;

  // Per-pair breakdown
  const pairMap = new Map<string, { signals: number; wins: number; pnlIdr: number }>();
  for (const s of closed) {
    const e = pairMap.get(s.pair) ?? { signals: 0, wins: 0, pnlIdr: 0 };
    e.signals++;
    if ((s.pnlPct ?? 0) > 0) e.wins++;
    e.pnlIdr += s.pnlIdr ?? 0;
    pairMap.set(s.pair, e);
  }
  const byPair = Array.from(pairMap.entries()).map(([pair, e]) => ({
    pair,
    signals: e.signals,
    winRate: e.signals > 0 ? e.wins / e.signals : 0,
    pnlIdr: e.pnlIdr,
  }));

  return {
    totalSignals: all.length,
    openSignals: open.length,
    closedSignals: closed.length,
    wins: wins.length,
    losses: losses.length,
    winRate: closed.length > 0 ? wins.length / closed.length : 0,
    totalPnlIdr: totalPnl,
    avgPnlPct: avgPnl,
    avgHoldHours: avgHold,
    bestTrade: pnlPcts.length > 0 ? Math.max(...pnlPcts) : 0,
    worstTrade: pnlPcts.length > 0 ? Math.min(...pnlPcts) : 0,
    sharpeRatio: sharpe,
    byPair,
  };
}
