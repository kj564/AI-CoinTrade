import { NextResponse } from "next/server";
import { getSummaries, getTicker, getDepth, pairToDepthFormat, POPULAR_PAIRS } from "@/lib/indodax";
import { getMarketSentiment, generateStrategy } from "@/lib/trading/research";
import { ensureCandles, candlesToArrays } from "@/lib/trading/candles";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function GET(req: Request) {
  const url = new URL(req.url);
  const pair = url.searchParams.get("pair");
  const withDepth = url.searchParams.get("depth") === "1";
  const withSentiment = url.searchParams.get("sentiment") === "1";
  const withResearch = url.searchParams.get("research") === "1";

  if (pair) {
    const ticker = await getTicker(pair);
    if (!ticker) return NextResponse.json({ error: "Pair not found" }, { status: 404 });
    let depth = null;
    if (withDepth) depth = await getDepth(pairToDepthFormat(pair));
    let sentiment = null;
    if (withSentiment) sentiment = await getMarketSentiment();
    let research = null;
    if (withResearch) {
      // REAL candles from INDODAX trades (stored in DB)
      const { candles, source, count } = await ensureCandles(pair, "1m", 30);
      if (candles.length >= 5) {
        const { closes, highs, lows, volumes } = candlesToArrays(candles);
        research = await generateStrategy(pair, closes, highs, lows, volumes);
        (research as any).__data = { source, candleCount: count, timeframe: "1m", firstTime: candles[0]?.time, lastTime: candles[candles.length - 1]?.time };
      } else {
        research = { pair, signal: "HOLD", bias: "neutral", strength: 0, entry: parseFloat(ticker.last), stopLoss: 0, takeProfit: 0, positionSize: "0%", timeframe: "1m", indicators: { currentPrice: parseFloat(ticker.last), sma10: null, sma20: null, ema12: null, ema26: null, rsi14: 50, bb: null, macd: null, stochasticK: 50, volume24h: 0 }, sentiment: { score: 0, label: "Neutral" }, signals: ["Insufficient candle data"], narrative: "Waiting for more candle data.", riskWarning: "Not enough data.", __data: { source: "empty", candleCount: count } };
      }
    }
    return NextResponse.json({ pair, ticker, depth, sentiment, research });
  }

  const tickers = await getSummaries();
  if (!tickers) return NextResponse.json({ error: "Failed to fetch INDODAX" }, { status: 502 });
  const popular = POPULAR_PAIRS.map((p) => ({ pair: p, ticker: tickers[p] })).filter((x) => x.ticker);
  let sentiment = null;
  if (withSentiment) sentiment = await getMarketSentiment();
  return NextResponse.json({ tickers: popular, allTickers: Object.keys(tickers).filter(p => p.includes("_idr")), sentiment });
}
