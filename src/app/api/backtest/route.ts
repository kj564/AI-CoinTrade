import { NextRequest, NextResponse } from "next/server";
import { getTicker, getDepth } from "@/lib/indodax";
import { runBacktest, assessRisk, optimizePositions, generateReport, buildL2Snapshot, walkTheBook, type BacktestConfig } from "@/lib/trading/backtest";
import { loadCandles, type Timeframe } from "@/lib/trading/candles";
import { fetchLastNDays } from "@/lib/trading/ccxt-provider";
import { fetchAndStoreL2, getHistoricalL2Snapshot, getLatestL2Snapshot } from "@/lib/trading/l2-storage";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { pair, strategy, initialCapital, stopLossPct, takeProfitPct, params } = body;
    if (!pair) return NextResponse.json({ error: "pair required" }, { status: 400 });

    const tf = (params?.timeframe || "1h") as Timeframe;
    const feeRate = params?.feeRate ?? 0.003; // INDODAX taker 0.3%

    // Load real historical candles from DB
    let candles = await loadCandles(pair, tf, 3000);

    // If not enough, backfill from INDODAX via direct fetch (tradingview endpoint)
    if (candles.length < 50) {
      const days = tf === "1h" ? 90 : tf === "1m" ? 2 : tf === "1d" ? 365 : 90;
      await fetchLastNDays(pair, tf, days);
      candles = await loadCandles(pair, tf, 3000);
    }

    if (candles.length < 10) {
      return NextResponse.json({ error: `Not enough real candle data (${candles.length} ${tf} candles).` }, { status: 400 });
    }

    const source = candles.length >= 50 ? "historical" : "recent";
    const btInput = candles.map(c => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }));
    const avgVol = btInput.reduce((a, c) => a + c.volume, 0) / Math.max(1, btInput.length);

    // P1 (this round): Fetch real L2 order book depth for microstructure calibration
    // In-memory only — DB storage causes OOM in sandbox
    const depthPair = pair.includes("_") ? pair.replace("_", "") : pair;
    const depth = await getDepth(depthPair);
    let l2Snapshot = null;
    if (depth) {
      l2Snapshot = buildL2Snapshot(pair, depth, 0.001, avgVol);
    }

    // Staleness check (in-memory: always fresh since we just fetched)
    const l2Staleness = l2Snapshot ? { ageSec: 0, timestamp: Math.floor(Date.now() / 1000), isStale: false } : null;

    const config: BacktestConfig = {
      strategy: strategy || "sma_cross",
      initialCapital: initialCapital || 10000000,
      pair,
      stopLossPct: stopLossPct || 0.03,
      takeProfitPct: takeProfitPct || 0.05,
      params: params || {},
      feeRate,
      l2Snapshot,
    };
    const result = runBacktest(btInput, config);
    const risk = assessRisk(result, config.strategy);
    const firstEntry = result.trades[0]?.entryPrice || parseFloat((await getTicker(pair))?.last || "0");
    // Compute actual R = avgWin/avgLoss for correct Kelly Criterion
    const actualR = result.avgLoss > 0 ? result.avgWin / result.avgLoss : result.avgWin > 0 ? 999 : 1;
    const positions = optimizePositions(config.initialCapital, firstEntry, firstEntry * 0.97, result.winRate / 100, actualR, 0);
    const report = generateReport(pair, config, result, risk, positions);

    // P6: Walk-the-book analysis for market orders (taker cost with real order book)
    let walkBookAnalysis = null;
    if (l2Snapshot) {
      // Simulate a market buy of 0.01 BTC (typical retail order)
      const orderSize = 0.01;
      walkBookAnalysis = {
        buy: walkTheBook("buy", orderSize, l2Snapshot),
        sell: walkTheBook("sell", orderSize, l2Snapshot),
        orderSize,
      };
    }

    return NextResponse.json({
      success: true, result, risk, positions, report, config,
      dataSource: { source, timeframe: tf, candleCount: candles.length, windowDays: Math.round((candles[candles.length - 1]?.time - candles[0]?.time) / 86400), feeRate },
      l2Staleness: l2Staleness ? { ageSec: l2Staleness.ageSec, timestamp: l2Staleness.timestamp, isStale: l2Staleness.ageSec > 3600 } : null,
      walkBookAnalysis,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Backtest failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
