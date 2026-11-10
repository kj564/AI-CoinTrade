// Market Regime Detection — classifies current market as Trending / Ranging / Volatile
// Based on: ADX (trend strength), ATR ratio (volatility), Bollinger Band width, daily SMA trend
// Inspired by: arXiv 2610.27751 (Gaussian HMM regime detection) + arXiv 2606.06190 (multi-scale)
// Practical implementation: rule-based regime detection using indicators we already compute

import { calcATR, type Candle } from "./backtest";

export type Regime = "bullish_trending" | "bearish_trending" | "ranging" | "volatile";

export interface RegimeInfo {
  regime: Regime;
  label: string;          // human-readable
  adx: number;            // trend strength (0-100)
  atrRatio: number;       // current ATR / 50-period avg ATR (>1.5 = volatile)
  bbWidth: number;        // Bollinger band width as % of price
  dailyTrend: "bullish" | "bearish" | "neutral";
  confidence: number;     // 0-100, how confident we are in the regime classification
  favoredStrategy: string; // which strategy type works best in this regime
  description: string;
}

export function detectRegime(candles1h: Candle[], candles1d: Candle[]): RegimeInfo {
  const n = candles1h.length;
  const closes = candles1h.map(c => c.close);
  const highs = candles1h.map(c => c.high);
  const lows = candles1h.map(c => c.low);

  // ADX (trend strength) — reuse from backtest engine
  // We need the ADX array, but calcATR only returns the final value.
  // Simple ADX approximation using directional movement
  const period = 14;
  let adx = 0;
  if (n > period * 3) {
    const tr: number[] = new Array(n).fill(0);
    const plusDM: number[] = new Array(n).fill(0);
    const minusDM: number[] = new Array(n).fill(0);
    for (let i = 1; i < n; i++) {
      const up = highs[i] - highs[i - 1];
      const dn = lows[i - 1] - lows[i];
      tr[i] = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
      plusDM[i] = up > dn && up > 0 ? up : 0;
      minusDM[i] = dn > up && dn > 0 ? dn : 0;
    }
    let trS = 0, pS = 0, mS = 0;
    for (let i = 1; i <= period; i++) { trS += tr[i]; pS += plusDM[i]; mS += minusDM[i]; }
    const dx: number[] = new Array(n).fill(0);
    for (let i = period + 1; i < n; i++) {
      trS = trS - trS / period + tr[i];
      pS = pS - pS / period + plusDM[i];
      mS = mS - mS / period + minusDM[i];
      const pDI = trS > 0 ? 100 * pS / trS : 0;
      const mDI = trS > 0 ? 100 * mS / trS : 0;
      dx[i] = (pDI + mDI) > 0 ? 100 * Math.abs(pDI - mDI) / (pDI + mDI) : 0;
    }
    let adxSum = 0;
    for (let i = period + 1; i <= period * 2 && i < n; i++) adxSum += dx[i];
    adx = adxSum / period;
    for (let i = period * 2 + 1; i < n; i++) adx = (adx * (period - 1) + dx[i]) / period;
  }

  // ATR ratio: current ATR vs 50-period average ATR
  const atr = calcATR(candles1h, 14);
  const atrHist: number[] = [];
  for (let i = 14; i < n; i++) {
    const slice = candles1h.slice(Math.max(0, i - 14), i + 1);
    atrHist.push(calcATR(slice, 14));
  }
  const avgAtr = atrHist.length > 0 ? atrHist.slice(-50).reduce((a, b) => a + b, 0) / Math.min(50, atrHist.length) : atr;
  const atrRatio = avgAtr > 0 ? atr / avgAtr : 1;

  // Bollinger Band width (volatility proxy)
  const slice = closes.slice(-20);
  const sma20 = slice.reduce((a, b) => a + b, 0) / 20;
  const variance = slice.reduce((a, b) => a + (b - sma20) ** 2, 0) / 20;
  const std = Math.sqrt(variance);
  const bbWidth = sma20 > 0 ? (4 * std / sma20) * 100 : 0; // (upper-lower)/mid * 100

  // Daily trend (macro)
  let dailyTrend: "bullish" | "bearish" | "neutral" = "neutral";
  if (candles1d.length >= 20) {
    const dCloses = candles1d.map(c => c.close);
    const dsma10 = dCloses.slice(-10).reduce((a, b) => a + b, 0) / 10;
    const dsma20 = dCloses.slice(-20).reduce((a, b) => a + b, 0) / 20;
    dailyTrend = dsma10 > dsma20 ? "bullish" : dsma10 < dsma20 ? "bearish" : "neutral";
  }

  // Classify regime
  let regime: Regime;
  let confidence: number;
  let favoredStrategy: string;
  let description: string;

  if (atrRatio > 1.5 || bbWidth > 8) {
    // High volatility regime — stay out
    regime = "volatile";
    confidence = Math.min(100, (atrRatio - 1) * 50 + (bbWidth - 5) * 10);
    favoredStrategy = "none — stay out";
    description = "Market volatile — high ATR ratio + wide Bollinger bands. Risk tinggi, sebaiknya wait sampai volatilitas turun.";
  } else if (adx > 25) {
    // Strong trend
    if (dailyTrend === "bullish") {
      regime = "bullish_trending";
      confidence = Math.min(100, adx);
      favoredStrategy = "trend-following (SMA Cross, MACD, Donchian)";
      description = "Market trending bullish — ADX strong + daily SMA bullish. Favor trend-following BUY signals.";
    } else if (dailyTrend === "bearish") {
      regime = "bearish_trending";
      confidence = Math.min(100, adx);
      favoredStrategy = "trend-following (avoid longs / wait)";
      description = "Market trending bearish — ADX strong + daily SMA bearish. Avoid BUY signals (counter-trend).";
    } else {
      regime = dailyTrend === "bullish" ? "bullish_trending" : "bearish_trending";
      confidence = adx;
      favoredStrategy = "trend-following";
      description = "Market trending — ADX strong. Favor trend-following strategies.";
    }
  } else if (adx < 20) {
    // Ranging / sideways
    regime = "ranging";
    confidence = Math.min(100, (20 - adx) * 5);
    favoredStrategy = "mean-reversion (RSI Reversal, Bollinger, Stochastic)";
    description = "Market ranging/sideways — ADX low. Favor mean-reversion strategies (buy oversold, sell overbought).";
  } else {
    // Transition zone (ADX 20-25)
    regime = dailyTrend === "bullish" ? "bullish_trending" : dailyTrend === "bearish" ? "bearish_trending" : "ranging";
    confidence = 40;
    favoredStrategy = "mixed — use daily trend as guide";
    description = "Market in transition — ADX moderate. Use daily trend as primary guide.";
  }

  const labels: Record<Regime, string> = {
    bullish_trending: "Bullish Trending",
    bearish_trending: "Bearish Trending",
    ranging: "Ranging/Sideways",
    volatile: "Volatile",
  };

  return { regime, label: labels[regime], adx, atrRatio, bbWidth, dailyTrend, confidence, favoredStrategy, description };
}
