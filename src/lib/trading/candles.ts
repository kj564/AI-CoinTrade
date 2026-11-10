// Real OHLCV candle pipeline — fetches trades from INDODAX, aggregates into
// candles, stores in SQLite, and provides loaders for research/backtest/bot.

import { db } from "@/lib/db";
import { getTrades, type RawTrade } from "@/lib/indodax";

export interface Candle {
  time: number; open: number; high: number; low: number; close: number; volume: number;
}

export type Timeframe = "1m" | "5m" | "15m" | "1h" | "1d";

export const TF_SECONDS: Record<Timeframe, number> = {
  "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "1d": 86400,
};

export function aggregateTrades(trades: RawTrade[], tfSec: number): Candle[] {
  if (trades.length === 0) return [];
  const sorted = [...trades].sort((a, b) => parseInt(a.date) - parseInt(b.date));
  const buckets = new Map<number, Candle>();
  for (const t of sorted) {
    const price = parseFloat(t.price);
    const amount = parseFloat(t.amount);
    const ts = parseInt(t.date);
    if (!isFinite(price) || !isFinite(amount)) continue;
    const bucket = Math.floor(ts / tfSec) * tfSec;
    const existing = buckets.get(bucket);
    if (!existing) buckets.set(bucket, { time: bucket, open: price, high: price, low: price, close: price, volume: amount });
    else { existing.high = Math.max(existing.high, price); existing.low = Math.min(existing.low, price); existing.close = price; existing.volume += amount; }
  }
  return Array.from(buckets.values()).sort((a, b) => a.time - b.time);
}

export async function backfillCandles(pair: string, tf: Timeframe = "1m") {
  const trades = await getTrades(pair);
  if (trades.length === 0) return { fetched: 0, stored: 0, upserted: 0 };
  const candles = aggregateTrades(trades, TF_SECONDS[tf]);
  let upserted = 0;
  for (const c of candles) {
    await db.candle.upsert({
      where: { pair_timeframe_time: { pair, timeframe: tf, time: c.time } },
      create: { pair, timeframe: tf, time: c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume },
      update: { open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume },
    });
    upserted++;
  }
  return { fetched: trades.length, stored: candles.length, upserted };
}

export async function loadCandles(pair: string, tf: Timeframe = "1m", limit = 200): Promise<Candle[]> {
  const rows = await db.candle.findMany({ where: { pair, timeframe: tf }, orderBy: { time: "asc" }, take: limit });
  return rows.slice(-limit).map(r => ({ time: r.time, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume }));
}

export async function ensureCandles(pair: string, tf: Timeframe = "1m", minCount = 30) {
  let candles = await loadCandles(pair, tf, 300);
  if (candles.length >= minCount) return { candles, source: "db" as const, count: candles.length };
  await backfillCandles(pair, tf);
  candles = await loadCandles(pair, tf, 300);
  return { candles, source: (candles.length >= minCount ? "fetched" : "mixed") as "fetched" | "mixed", count: candles.length };
}

export function resample(candles: Candle[], targetTfSec: number): Candle[] {
  if (candles.length === 0) return [];
  const buckets = new Map<number, Candle>();
  for (const c of candles) {
    const bucket = Math.floor(c.time / targetTfSec) * targetTfSec;
    const ex = buckets.get(bucket);
    if (!ex) buckets.set(bucket, { time: bucket, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume });
    else { ex.high = Math.max(ex.high, c.high); ex.low = Math.min(ex.low, c.low); ex.close = c.close; ex.volume += c.volume; }
  }
  return Array.from(buckets.values()).sort((a, b) => a.time - b.time);
}

export function candlesToArrays(candles: Candle[]) {
  return { closes: candles.map(c => c.close), highs: candles.map(c => c.high), lows: candles.map(c => c.low), volumes: candles.map(c => c.volume), times: candles.map(c => c.time) };
}
