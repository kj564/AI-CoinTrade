// Binance Klines — historical OHLCV from Binance public API.
//
// INDODAX's public API only returns recent trades (~200), which aggregate
// into very few candles. Binance's klines API returns up to 1000 historical
// OHLCV candles for free, no auth needed. We use Binance klines for
// indicator calculations (ATR, RSI, ADX) — the price currency (USDT vs IDR)
// doesn't affect ratio-based indicators. For the actual entry/stop/target
// prices in IDR, we convert using the current INDODAX price.

import type { Candle } from "./backtest";

const BINANCE_API = "https://api.binance.com/api/v3";

function pairToBinanceSymbol(pair: string): string {
  const coin = pair.replace("_idr", "").toUpperCase();
  return `${coin}USDT`;
}

// Fetch historical klines from Binance. Returns candles sorted oldest→newest.
// interval: "1h", "4h", "1d", etc. limit: up to 1000.
export async function getBinanceKlines(pair: string, interval: "1h" | "4h" | "1d" = "1h", limit = 200): Promise<Candle[]> {
  const symbol = pairToBinanceSymbol(pair);
  try {
    const url = `${BINANCE_API}/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    const r = await fetch(url, { next: { revalidate: 60 } });
    if (!r.ok) return [];
    const data = await r.json();
    if (!Array.isArray(data)) return [];
    // Binance klines format: [openTime, open, high, low, close, volume, closeTime, ...]
    return data.map((k: any[]) => ({
      time: Math.floor(k[0] / 1000), // ms → sec
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: parseFloat(k[5]),
    }));
  } catch (e) {
    console.warn(`[binance] klines failed for ${pair}:`, e instanceof Error ? e.message : e);
    return [];
  }
}

// Convert Binance USDT candles to IDR candles using a reference IDR price.
// This preserves the price RELATIONSHIPS (for indicator calculation) while
// expressing prices in IDR (for actionable entry/stop/target).
export function convertKlinesToIdr(klines: Candle[], idrReferencePrice: number, usdtReferencePrice: number): Candle[] {
  if (usdtReferencePrice <= 0) return klines;
  const rate = idrReferencePrice / usdtReferencePrice;
  return klines.map((c) => ({
    time: c.time,
    open: c.open * rate,
    high: c.high * rate,
    low: c.low * rate,
    close: c.close * rate,
    volume: c.volume,
  }));
}
