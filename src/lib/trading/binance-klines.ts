// Binance Klines — historical OHLCV from Binance public API + staleness detection.
//
// INDODAX's public API only returns recent trades (~200), which aggregate
// into very few candles. Binance's klines API returns up to 1000 historical
// OHLCV candles for free, no auth needed. We use Binance klines for
// indicator calculations (ATR, RSI, ADX) — the price currency (USDT vs IDR)
// doesn't affect ratio-based indicators. For the actual entry/stop/target
// prices in IDR, we convert using the current INDODAX price.

import type { Candle } from "./backtest";

const BINANCE_API = "https://api.binance.com/api/v3";
// P6: Dynamic staleness threshold per pair — high-liquidity pairs (BTC, ETH)
// update more frequently and can afford tighter thresholds. Low-liquidity
// pairs (XRP, SOL) may have gaps, so allow more slack.
const STALE_THRESHOLDS: Record<string, number> = {
  btc_idr: 3900,   // 65 min (BTC: high liquidity, frequent updates)
  eth_idr: 3900,   // 65 min
  sol_idr: 5400,   // 90 min (medium liquidity)
  bnb_idr: 5400,   // 90 min
  xrp_idr: 7200,   // 120 min (lower liquidity, may have gaps)
};
const DEFAULT_STALE_THRESHOLD_SEC = 5400; // 90 min fallback

function getStaleThreshold(pair: string): number {
  return STALE_THRESHOLDS[pair] ?? DEFAULT_STALE_THRESHOLD_SEC;
}

function pairToBinanceSymbol(pair: string): string {
  const coin = pair.replace("_idr", "").toUpperCase();
  return `${coin}USDT`;
}

export interface KlinesResult {
  candles: Candle[];
  stale: boolean;          // true if latest candle is older than STALE_THRESHOLD_SEC
  latestCandleTime: number; // unix sec of latest candle
  ageSec: number;          // seconds since latest candle
  source: "binance" | "fallback" | "none";
}

// Fetch historical klines from Binance with pair-specific staleness check.
export async function getBinanceKlinesWithMeta(pair: string, interval: "1h" | "4h" | "1d" = "1h", limit = 200): Promise<KlinesResult> {
  const symbol = pairToBinanceSymbol(pair);
  const threshold = getStaleThreshold(pair);
  try {
    const url = `${BINANCE_API}/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    const r = await fetch(url, { next: { revalidate: 60 } });
    if (!r.ok) return { candles: [], stale: true, latestCandleTime: 0, ageSec: Infinity, source: "none" };
    const data = await r.json();
    if (!Array.isArray(data) || data.length === 0) return { candles: [], stale: true, latestCandleTime: 0, ageSec: Infinity, source: "none" };

    const candles: Candle[] = data.map((k: any[]) => ({
      time: Math.floor(k[0] / 1000),
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: parseFloat(k[5]),
    }));

    const now = Math.floor(Date.now() / 1000);
    const latestTime = candles[candles.length - 1].time;
    const ageSec = now - latestTime;
    const stale = ageSec > threshold;

    return { candles, stale, latestCandleTime: latestTime, ageSec, source: "binance" };
  } catch (e) {
    console.warn(`[binance] klines failed for ${pair}:`, e instanceof Error ? e.message : e);
    return { candles: [], stale: true, latestCandleTime: 0, ageSec: Infinity, source: "none" };
  }
}

// Backward-compat: returns just the candles array (for callers that don't need staleness).
export async function getBinanceKlines(pair: string, interval: "1h" | "4h" | "1d" = "1h", limit = 200): Promise<Candle[]> {
  const result = await getBinanceKlinesWithMeta(pair, interval, limit);
  return result.candles;
}

// Convert Binance USDT candles to IDR candles using a reference IDR price.
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

