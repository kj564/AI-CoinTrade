import { NextRequest, NextResponse } from "next/server";
import { compareStrategies, gridSearch, walkForward, getDeflatedSharpeInfo, computeCSCV, type BacktestConfig } from "@/lib/trading/backtest";
import { loadCandles, type Timeframe } from "@/lib/trading/candles";
import { fetchLastNDays } from "@/lib/trading/ccxt-provider";

export const runtime = "nodejs";
export const maxDuration = 60;

// POST /api/backtest/compare
// body: { pair, timeframe, initialCapital, stopLossPct, takeProfitPct, gridSearch?: strategy }
// Runs all 7 strategies + buy&hold benchmark, ranks them. Grid search + walk-forward for selected.
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { pair, initialCapital, stopLossPct, takeProfitPct } = body;
    const tf = (body.timeframe || "1h") as Timeframe;
    if (!pair) return NextResponse.json({ error: "pair required" }, { status: 400 });

    let candles = await loadCandles(pair, tf, 3000);
    if (candles.length < 50) {
      const days = tf === "1h" ? 90 : tf === "1d" ? 365 : 90;
      await fetchLastNDays(pair, tf, days);
      candles = await loadCandles(pair, tf, 3000);
    }
    if (candles.length < 10) return NextResponse.json({ error: `Not enough data (${candles.length} ${tf} candles)` }, { status: 400 });

    const btCandles = candles.map(c => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }));
    const config: Omit<BacktestConfig, "strategy"> = {
      initialCapital: initialCapital || 1000000, pair,
      stopLossPct: stopLossPct || 0.03, takeProfitPct: takeProfitPct || 0.05,
      params: { timeframe: tf }, feeRate: 0.003,
    };

    const comparison = compareStrategies(btCandles, config);
    const deflatedSharpeInfo = getDeflatedSharpeInfo(comparison);
    // CSCV: Combinatorial Symmetric Cross-Validation for proper PBO
    const cscv = computeCSCV(btCandles, config, 8);

    let grid: any = null;
    if (body.gridSearch) grid = gridSearch(btCandles, body.gridSearch, config).slice(0, 10);

    // walk-forward for the selected strategy (4 segments)
    let wf: any = null;
    if (body.gridSearch) {
      try { wf = walkForward(btCandles, body.gridSearch, config, 4); } catch { wf = null; }
    }

    // buy & hold benchmark info
    const first = btCandles[0]?.close || 0, last = btCandles[btCandles.length - 1]?.close || 0;
    const buyHoldPct = first > 0 ? ((last - first) / first) * 100 : 0;

    return NextResponse.json({
      success: true,
      dataSource: { timeframe: tf, candleCount: candles.length, windowDays: Math.round((candles[candles.length - 1]?.time - candles[0]?.time) / 86400) },
      buyHold: { pct: buyHoldPct, netProfit: (initialCapital || 1000000) * buyHoldPct / 100, from: first, to: last },
      comparison,
      gridSearch: grid,
      walkForward: wf,
      deflatedSharpe: deflatedSharpeInfo,
      cscv,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Compare failed" }, { status: 500 });
  }
}
