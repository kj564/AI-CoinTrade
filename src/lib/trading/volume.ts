// Volume-weighted signal indicators — VWAP, OBV, Volume Ratio
// Volume confirms price moves. Breakout + high volume = strong.
// Breakout + low volume = false signal, filter out.
// Uses: technicalindicators package concepts, implemented directly for reliability.

import type { Candle } from "./candles";

// VWAP (Volume-Weighted Average Price) — rolling, N-period
// Price above VWAP = bullish (buyers in control)
// Price below VWAP = bearish (sellers in control)
export function calcVWAP(candles: Candle[], period = 24): { vwap: number; upperBand: number; lowerBand: number } | null {
  if (candles.length < period) return null;
  const slice = candles.slice(-period);
  let sumPV = 0, sumV = 0;
  for (const c of slice) {
    const typical = (c.high + c.low + c.close) / 3;
    sumPV += typical * c.volume;
    sumV += c.volume;
  }
  if (sumV === 0) return null;
  const vwap = sumPV / sumV;
  // VWAP bands (1 standard deviation)
  let sumSq = 0;
  for (const c of slice) {
    const typical = (c.high + c.low + c.close) / 3;
    sumSq += (typical - vwap) ** 2 * c.volume;
  }
  const std = Math.sqrt(sumSq / sumV);
  return { vwap, upperBand: vwap + std, lowerBand: vwap - std };
}

// OBV (On-Balance Volume) — cumulative volume that adds on up-days, subtracts on down-days
// Rising OBV = accumulation (smart money buying)
// Falling OBV = distribution (smart money selling)
// OBV divergence with price = reversal signal
export function calcOBV(candles: Candle[]): { obv: number; obvSlope: number; trend: "accumulation" | "distribution" | "neutral" } {
  if (candles.length < 2) return { obv: 0, obvSlope: 0, trend: "neutral" };
  let obv = 0;
  const obvHistory: number[] = [0];
  for (let i = 1; i < candles.length; i++) {
    if (candles[i].close > candles[i - 1].close) obv += candles[i].volume;
    else if (candles[i].close < candles[i - 1].close) obv -= candles[i].volume;
    obvHistory.push(obv);
  }
  // OBV slope (last 10 periods)
  const recent = obvHistory.slice(-10);
  const slope = recent.length > 1 ? (recent[recent.length - 1] - recent[0]) / recent.length : 0;
  const trend: "accumulation" | "distribution" | "neutral" = slope > 0 ? "accumulation" : slope < 0 ? "distribution" : "neutral";
  return { obv, obvSlope: slope, trend };
}

// Volume Ratio — current volume / average volume (20-period)
// > 1.5 = high conviction move (institutional activity)
// < 0.5 = low conviction (likely false signal)
export function calcVolumeRatio(candles: Candle[], period = 20): { ratio: number; current: number; average: number; conviction: "high" | "normal" | "low" } {
  if (candles.length < period) return { ratio: 1, current: 0, average: 0, conviction: "normal" };
  const recent = candles.slice(-period - 1);
  const currentVol = recent[recent.length - 1].volume;
  const avgVol = recent.slice(0, period).reduce((a, c) => a + c.volume, 0) / period;
  const ratio = avgVol > 0 ? currentVol / avgVol : 1;
  const conviction: "high" | "normal" | "low" = ratio > 1.5 ? "high" : ratio < 0.5 ? "low" : "normal";
  return { ratio, current: currentVol, average: avgVol, conviction };
}

// Volume-confirmed breakout check
// A breakout is confirmed if volume is above average (conviction > normal)
export function isVolumeConfirmed(candles: Candle[]): { confirmed: boolean; ratio: number; conviction: string } {
  const vol = calcVolumeRatio(candles, 20);
  return { confirmed: vol.conviction !== "low", ratio: vol.ratio, conviction: vol.conviction };
}

// Price vs VWAP signal
export function vwapSignal(candles: Candle[]): { position: "above" | "below" | "at"; strength: number } | null {
  const vwap = calcVWAP(candles, 24);
  if (!vwap) return null;
  const price = candles[candles.length - 1].close;
  const position: "above" | "below" | "at" = price > vwap.vwap * 1.001 ? "above" : price < vwap.vwap * 0.999 ? "below" : "at";
  // Strength: how far above/below VWAP (as % of VWAP)
  const strength = vwap.vwap > 0 ? Math.abs(price - vwap.vwap) / vwap.vwap * 100 : 0;
  return { position, strength };
}
