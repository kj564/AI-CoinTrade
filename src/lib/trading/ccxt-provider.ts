// Historical OHLCV fetcher — fetches real candles from INDODAX's
// tradingview/history_v2 endpoint (the same one powering their web charts).
// Uses direct fetch (no CCXT dependency) to avoid bundler issues.
// Gives us days/weeks/months of real candle data for meaningful backtests.

import { db } from "@/lib/db";
import { TF_SECONDS, type Timeframe, type Candle } from "./candles";

// INDODAX pair format: "btc_idr" → symbol "btcidr" (NO underscore for tradingview)
function pairToTvSymbol(pair: string): string {
  return pair.replace("_", "");
}

// INDODAX tradingview tf param mapping
const TV_TF: Record<Timeframe, string> = {
  "1m": "1", "5m": "5", "15m": "15", "1h": "60", "1d": "1D",
};

interface TvCandle {
  Time: number; Open: number; High: number; Low: number; Close: number; Volume: string;
}

const TV_ENDPOINT = "https://indodax.com/tradingview/history_v2";

export interface FetchResult {
  fetched: number;
  stored: number;
  pair: string;
  timeframe: Timeframe;
  from: number;
  to: number;
}

// Fetch historical candles from INDODAX tradingview endpoint and store in DB.
export async function fetchHistoricalCandles(
  pair: string,
  timeframe: Timeframe = "1h",
  fromMs: number,
  toMs: number = Date.now()
): Promise<FetchResult> {
  const symbol = pairToTvSymbol(pair);
  const tfStr = TV_TF[timeframe] || "60";
  const tfSec = TF_SECONDS[timeframe] || 3600;
  const fromSec = Math.floor(fromMs / 1000);
  const toSec = Math.floor(toMs / 1000);
  let allCandles: TvCandle[] = [];

  let chunkFrom = fromSec;
  while (chunkFrom < toSec) {
    try {
      const url = `${TV_ENDPOINT}?symbol=${symbol}&tf=${tfStr}&from=${chunkFrom}&to=${toSec}`;
      const r = await fetch(url, { next: { revalidate: 0 } });
      if (!r.ok) break;
      const data = await r.json();
      if (!Array.isArray(data) || data.length === 0) break;
      allCandles = allCandles.concat(data as TvCandle[]);
      const lastTime = (data as TvCandle[])[data.length - 1].Time;
      if (lastTime <= chunkFrom) break;
      chunkFrom = lastTime + tfSec;
      if (data.length < 1000) break;
    } catch (e) {
      console.error(`[tv-fetch] error: ${e instanceof Error ? e.message : e}`);
      break;
    }
  }

  const seen = new Set<number>();
  const candles = allCandles
    .filter((c) => { if (seen.has(c.Time)) return false; seen.add(c.Time); return true; })
    .sort((a, b) => a.Time - b.Time);

  let stored = 0;
  for (const c of candles) {
    const bucket = Math.floor(c.Time / tfSec) * tfSec;
    try {
      await db.candle.upsert({
        where: { pair_timeframe_time: { pair, timeframe, time: bucket } },
        create: { pair, timeframe, time: bucket, open: c.Open, high: c.High, low: c.Low, close: c.Close, volume: parseFloat(c.Volume) || 0 },
        update: { open: c.Open, high: c.High, low: c.Low, close: c.Close, volume: parseFloat(c.Volume) || 0 },
      });
      stored++;
    } catch { /* skip */ }
  }

  return { fetched: candles.length, stored, pair, timeframe, from: fromMs, to: toMs };
}

export async function fetchLastNDays(pair: string, timeframe: Timeframe, days: number): Promise<FetchResult> {
  const fromMs = Date.now() - days * 86400 * 1000;
  return fetchHistoricalCandles(pair, timeframe, fromMs);
}

export { pairToTvSymbol as pairToSymbol };
export type { Candle };
