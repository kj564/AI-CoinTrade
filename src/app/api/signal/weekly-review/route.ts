import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getPortfolioStats } from "@/lib/trading/signal-journal";
import { getDrawdownState } from "@/lib/trading/drawdown-monitor";
import { wilsonCI } from "@/lib/trading/alpha-circuit-breaker";
import { replaySignals } from "@/lib/trading/replay";
import { dispatchSignalEvent, formatDeviationMessage } from "@/lib/trading/signal-alerts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// GET /api/signal/weekly-review
//
// Auto-generates the weekly review with:
//   1. Portfolio stats (current paper trading P&L)
//   2. Replay stats (21-day backtest expectation per pair)
//   3. Circuit breaker states (with Wilson CI)
//   4. Drawdown state (current + tier)
//   5. Paper vs replay deviation detection (>15% → alert)
//   6. Natural-language recommendations
//
// Persists to WeeklyReview table. Returns the latest snapshot.
export async function GET() {
  try {
    // Compute week start (Monday of current week, Jakarta time)
    const now = new Date();
    const day = now.getDay(); // 0=Sun, 1=Mon
    const diff = (day === 0 ? -6 : 1 - day);
    const monday = new Date(now);
    monday.setDate(now.getDate() + diff);
    const weekStart = monday.toISOString().slice(0, 10);

    // 1. Portfolio stats
    const portfolio = await getPortfolioStats();

    // 2. Drawdown state
    const drawdown = await getDrawdownState(10_000_000);

    // 3. Circuit breakers
    const pairs = ["btc_idr", "eth_idr", "sol_idr", "bnb_idr", "xrp_idr"];
    const cbRows = await Promise.all(
      pairs.map((p) =>
        db.alphaCircuitBreaker.upsert({ where: { pair: p }, create: { pair: p }, update: {} }),
      ),
    );
    const circuitBreakers = cbRows.map((r) => {
      const winRate = r.totalSignals > 0 ? r.totalWins / r.totalSignals : 0;
      const [ci5, ci95] = wilsonCI(r.totalWins, r.totalSignals);
      return {
        pair: r.pair,
        open: r.circuitOpen,
        consecutiveLosses: r.consecutiveLosses,
        totalSignals: r.totalSignals,
        winRate,
        winRateCI5: ci5,
        winRateCI95: ci95,
        trips: r.circuitTrips,
      };
    });

    // 4. Replay stats — run replay inline (60s budget). Fail gracefully.
    let replayStats: any[] = [];
    try {
      const replayResults = await Promise.all(pairs.map((p) => replaySignals(p).catch(() => null)));
      replayStats = replayResults
        .filter((r): r is NonNullable<typeof r> => r !== null)
        .map((r) => ({
          pair: r.pair,
          totalSignals: r.totalSignals,
          winRate: r.winRate,
          avgPnlPct: r.avgPnlPct,
          totalPnlPct: r.totalPnlPct,
          sharpeRatio: r.sharpeRatio,
          maxDrawdownPct: r.maxDrawdownPct,
          description: r.description,
        }));
    } catch (e) {
      console.warn("[weekly-review] replay failed:", e instanceof Error ? e.message : e);
    }

    // 5. Paper-vs-replay deviation detection
    const deviations: { pair: string; replayWinRate: number; paperWinRate: number; deviationPct: number; replayPnlPct: number; paperPnlPct: number }[] = [];
    for (const replay of replayStats) {
      const paper = portfolio.byPair.find((p) => p.pair === replay.pair);
      if (!paper || paper.signals === 0) continue; // no paper trades yet — skip
      // Win rate deviation (absolute %)
      const winRateDev = Math.abs(paper.winRate - replay.winRate) * 100;
      // PnL deviation (per-signal avg) — paper avg pnl pct vs replay avg pnl pct
      // paper has pnlIdr sum, not avg pnl pct — approximate via portfolio.avgPnlPct
      const paperAvgPnl = portfolio.avgPnlPct;
      const replayAvgPnl = replay.avgPnlPct;
      const pnlDev = Math.abs(paperAvgPnl - replayAvgPnl) * 100;
      const devPct = Math.max(winRateDev, pnlDev);
      if (devPct > 15) {
        deviations.push({
          pair: replay.pair,
          replayWinRate: replay.winRate,
          paperWinRate: paper.winRate,
          deviationPct: devPct,
          replayPnlPct: replay.avgPnlPct,
          paperPnlPct: paperAvgPnl,
        });
        // Fire deviation alert (1/day dedup)
        try {
          await dispatchSignalEvent({
            type: "paper_vs_replay_deviation",
            severity: "warn",
            pair: replay.pair,
            message: formatDeviationMessage(replay.pair, replay.avgPnlPct, paperAvgPnl, devPct),
            metadata: { replayWinRate: replay.winRate, paperWinRate: paper.winRate, deviationPct: devPct },
          });
        } catch { /* ignore */ }
      }
    }

    // 6. Generate natural-language recommendations
    const recommendations: string[] = [];

    if (portfolio.closedSignals === 0) {
      recommendations.push("Paper trading is still collecting data — no closed signals yet. Continue running hourly checks. Need ≥30 closed signals before drawing conclusions.");
    }

    if (drawdown.isHalted) {
      recommendations.push(`PORTFOLIO HALT ACTIVE: drawdown ${drawdown.currentDrawdownPct.toFixed(2)}%. No new positions should be opened. Investigate root cause before resuming.`);
    } else if (drawdown.riskMultiplier < 1.0) {
      recommendations.push(`Drawdown scaling active: multiplier ${drawdown.riskMultiplier.toFixed(2)}x (drawdown ${drawdown.currentDrawdownPct.toFixed(2)}%). Position sizes are reduced to protect capital. Will auto-recover when P&L improves.`);
    }

    for (const cb of circuitBreakers) {
      if (cb.open) {
        recommendations.push(`${cb.pair.toUpperCase()} circuit breaker OPEN: ${cb.consecutiveLosses} consecutive losses, ${cb.trips} trips. Pair suppressed until cooldown + half-open probe succeeds.`);
      } else if (cb.totalSignals >= 5 && cb.winRate < 0.40) {
        recommendations.push(`${cb.pair.toUpperCase()} paper win rate ${(cb.winRate * 100).toFixed(0)}% (n=${cb.totalSignals}, CI5 ${(cb.winRateCI5 * 100).toFixed(0)}%). Below 40%. Consider disabling until edge recovers.`);
      } else if (cb.totalSignals >= 5 && cb.winRateCI5 > 0.50) {
        recommendations.push(`${cb.pair.toUpperCase()} paper win rate ${(cb.winRate * 100).toFixed(0)}% (n=${cb.totalSignals}, CI5 ${(cb.winRateCI5 * 100).toFixed(0)}%). Edge confirmed out-of-sample. Consider promoting to live.`);
      }
    }

    for (const dev of deviations) {
      recommendations.push(`${dev.pair.toUpperCase()} paper-vs-replay deviation ${dev.deviationPct.toFixed(1)}%. Replay expected ${(dev.replayWinRate * 100).toFixed(0)}% win, paper shows ${(dev.paperWinRate * 100).toFixed(0)}%. Edge may have degraded — investigate.`);
    }

    // Per-pair replay verdict
    for (const r of replayStats) {
      if (r.totalPnlPct > 0.20 && r.winRate > 0.60) {
        recommendations.push(`${r.pair.toUpperCase()} replay: +${(r.totalPnlPct * 100).toFixed(1)}% net, ${(r.winRate * 100).toFixed(0)}% win. Edge candidate — keep enabled.`);
      } else if (r.totalPnlPct < -0.05) {
        recommendations.push(`${r.pair.toUpperCase()} replay: ${(r.totalPnlPct * 100).toFixed(1)}% net. Cost kills edge. Keep NONAKTIF SEMENTARA.`);
      }
    }

    if (recommendations.length === 0) {
      recommendations.push("No specific recommendations. System operating within parameters. Continue monitoring.");
    }

    const reviewData = {
      weekStart,
      portfolioStats: {
        totalSignals: portfolio.totalSignals,
        openSignals: portfolio.openSignals,
        closedSignals: portfolio.closedSignals,
        wins: portfolio.wins,
        losses: portfolio.losses,
        winRate: portfolio.winRate,
        totalPnlIdr: portfolio.totalPnlIdr,
        avgPnlPct: portfolio.avgPnlPct,
        avgHoldHours: portfolio.avgHoldHours,
        sharpeRatio: portfolio.sharpeRatio,
        bestTrade: portfolio.bestTrade,
        worstTrade: portfolio.worstTrade,
        byPair: portfolio.byPair,
      },
      replayStats,
      circuitBreakers,
      drawdownState: {
        currentDrawdownPct: drawdown.currentDrawdownPct,
        cumulativePnlIdr: drawdown.cumulativePnlIdr,
        peakPnlIdr: drawdown.peakPnlIdr,
        troughPnlIdr: drawdown.troughPnlIdr,
        riskMultiplier: drawdown.riskMultiplier,
        riskTierLabel: drawdown.riskTierLabel,
        isHalted: drawdown.isHalted,
      },
      deviations,
      recommendations,
    };

    // Persist to DB (upsert by weekStart)
    const saved = await db.weeklyReview.upsert({
      where: { weekStart },
      create: {
        weekStart,
        portfolioStats: JSON.stringify(reviewData.portfolioStats),
        replayStats: JSON.stringify(replayStats),
        circuitBreakers: JSON.stringify(circuitBreakers),
        drawdownState: JSON.stringify(reviewData.drawdownState),
        recommendations: recommendations.join("\n"),
      },
      update: {
        portfolioStats: JSON.stringify(reviewData.portfolioStats),
        replayStats: JSON.stringify(replayStats),
        circuitBreakers: JSON.stringify(circuitBreakers),
        drawdownState: JSON.stringify(reviewData.drawdownState),
        recommendations: recommendations.join("\n"),
      },
    });

    return NextResponse.json({
      ...reviewData,
      id: saved.id,
      savedAt: saved.createdAt,
      timestamp: new Date().toISOString(),
    }, { headers: { "Cache-Control": "no-store, max-age=0" } });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "weekly-review failed" }, { status: 500 });
  }
}
