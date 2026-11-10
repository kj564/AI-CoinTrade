// Market research — FULL TA indicators from kukapay/crypto-skills (calculate_ta.py)
// + RSS sentiment from sentiment_analyzer.py + strategy generation workflow.
// Adapted for INDODAX (public API data instead of Binance klines).

import { getSummaries, getTicker, type Ticker } from "../indodax";

// ── TA Indicators (from calculate_ta.py, exact formulas) ──

export function calcSMA(data: number[], period: number): number | null {
  if (data.length < period) return null;
  return data.slice(-period).reduce((a, b) => a + b, 0) / period;
}

export function calcEMA(data: number[], period: number): number | null {
  if (data.length < period) return null;
  const multiplier = 2 / (period + 1);
  let ema = data[0];
  for (let i = 1; i < data.length; i++) ema = (data[i] * multiplier) + (ema * (1 - multiplier));
  return ema;
}

export function calcRSI(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 50;
  const deltas: number[] = [];
  for (let i = 1; i < closes.length; i++) deltas.push(closes[i] - closes[i - 1]);
  const gains = deltas.map(d => d > 0 ? d : 0);
  const losses = deltas.map(d => d < 0 ? -d : 0);
  const avgGain = gains.slice(-period).reduce((a, b) => a + b, 0) / period;
  const avgLoss = losses.slice(-period).reduce((a, b) => a + b, 0) / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

export function calcBollingerBands(closes: number[], period = 20, stdDev = 2): { upper: number; middle: number; lower: number } | null {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  const sma = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((a, b) => a + (b - sma) ** 2, 0) / period;
  const std = Math.sqrt(variance);
  return { upper: sma + (stdDev * std), middle: sma, lower: sma - (stdDev * std) };
}

export function calcMACD(closes: number[]): { line: number; signal: number; histogram: number } | null {
  if (closes.length < 26) return null;
  const ema12 = calcEMA(closes.slice(-30), 12);
  const ema26 = calcEMA(closes.slice(-30), 26);
  if (!ema12 || !ema26) return null;
  const line = ema12 - ema26;
  // signal = EMA9 of MACD (simplified — compute from recent MACD values)
  const macdHistory: number[] = [];
  for (let i = 30; i <= closes.length; i++) {
    const e12 = calcEMA(closes.slice(0, i), 12);
    const e26 = calcEMA(closes.slice(0, i), 26);
    if (e12 && e26) macdHistory.push(e12 - e26);
  }
  const signal = calcEMA(macdHistory, Math.min(9, macdHistory.length)) ?? line;
  return { line, signal, histogram: line - signal };
}

export function calcStochastic(highs: number[], lows: number[], closes: number[], period = 14): number {
  if (highs.length < period || lows.length < period || closes.length < period) return 50;
  const highPeriod = Math.max(...highs.slice(-period));
  const lowPeriod = Math.min(...lows.slice(-period));
  if (highPeriod === lowPeriod) return 50;
  return 100 * (closes[closes.length - 1] - lowPeriod) / (highPeriod - lowPeriod);
}

// ── Full indicator set (like calculate_ta.py's calculate_indicators) ──

export interface Indicators {
  currentPrice: number;
  sma10: number | null; sma20: number | null;
  ema12: number | null; ema26: number | null;
  rsi14: number;
  bb: { upper: number; middle: number; lower: number } | null;
  macd: { line: number; signal: number; histogram: number } | null;
  stochasticK: number;
  volume24h: number;
}

export function calculateAllIndicators(
  closes: number[], highs: number[], lows: number[], volumes: number[]
): Indicators {
  return {
    currentPrice: closes[closes.length - 1] || 0,
    sma10: calcSMA(closes, 10), sma20: calcSMA(closes, 20),
    ema12: calcEMA(closes, 12), ema26: calcEMA(closes, 26),
    rsi14: calcRSI(closes, 14),
    bb: calcBollingerBands(closes, 20, 2),
    macd: calcMACD(closes),
    stochasticK: calcStochastic(highs, lows, closes, 14),
    volume24h: volumes.slice(-1)[0] || 0,
  };
}

// ── RSS Sentiment (from sentiment_analyzer.py, exact keywords + feeds) ──

const POSITIVE_KEYWORDS = ["adoption","launch","partnership","etf","rally","breakthrough","growth","approval","bullish","surge","adopts"];
const NEGATIVE_KEYWORDS = ["crash","exploit","hack","delay","liquidation","depeg","bearish","decline","setback","breach","drop"];
const RSS_FEEDS = [
  "https://www.coindesk.com/arc/outboundfeeds/rss/?outputType=xml",
  "https://cointelegraph.com/rss",
  "https://cryptopotato.com/feed/",
  "https://cryptoslate.com/feed/",
];

interface Article { title: string; description: string; sentiment: number }

function classifySentiment(text: string): number {
  const lower = text.toLowerCase();
  const pos = POSITIVE_KEYWORDS.filter(kw => lower.includes(kw)).length;
  const neg = NEGATIVE_KEYWORDS.filter(kw => lower.includes(kw)).length;
  if (pos > neg) return 1;
  if (neg > pos) return -1;
  return 0;
}

export async function getMarketSentiment(): Promise<{
  score: number; label: string; articles: number; positive: string[]; negative: string[]; neutral: number;
}> {
  const articles: Article[] = [];
  for (const feed of RSS_FEEDS) {
    try {
      const r = await fetch(feed, { next: { revalidate: 300 } });
      if (!r.ok) continue;
      const xml = await r.text();
      // parse RSS items
      const itemRegex = /<item>[\s\S]*?<\/item>/g;
      const matches = xml.match(itemRegex) || [];
      for (const itemXml of matches.slice(0, 15)) {
        const title = itemXml.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/)?.[1]?.trim() || "";
        const desc = itemXml.match(/<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/)?.[1]?.trim() || "";
        const text = title + " " + desc;
        articles.push({ title, description: desc, sentiment: classifySentiment(text) });
      }
    } catch { /* skip feed */ }
  }
  const total = articles.length;
  const score = total > 0 ? articles.reduce((a, b) => a + b.sentiment, 0) / total : 0;
  const label = score > 0.1 ? "Bullish" : score < -0.1 ? "Bearish" : "Neutral";
  return {
    score, label, articles: total,
    positive: articles.filter(a => a.sentiment === 1).map(a => a.title).slice(0, 5),
    negative: articles.filter(a => a.sentiment === -1).map(a => a.title).slice(0, 5),
    neutral: articles.filter(a => a.sentiment === 0).length,
  };
}

// ── Strategy generation (kukapay trading-strategist workflow) ──

export interface TradingStrategy {
  pair: string;
  signal: "BUY" | "SELL" | "HOLD";
  bias: "bullish" | "bearish" | "neutral";
  strength: number;
  entry: number; stopLoss: number; takeProfit: number;
  positionSize: string; // % of capital
  timeframe: string;
  indicators: Indicators;
  sentiment: { score: number; label: string };
  signals: string[];
  narrative: string;
  riskWarning: string;
}

export async function generateStrategy(pair: string, closes: number[], highs: number[], lows: number[], volumes: number[]): Promise<TradingStrategy> {
  const indicators = calculateAllIndicators(closes, highs, lows, volumes);
  const sentiment = await getMarketSentiment();
  const signals: string[] = [];
  let biasScore = 50;

  // RSI signals
  if (indicators.rsi14 < 30) { signals.push(`RSI oversold (${indicators.rsi14.toFixed(0)}) — potential buy`); biasScore += 20; }
  else if (indicators.rsi14 > 70) { signals.push(`RSI overbought (${indicators.rsi14.toFixed(0)}) — potential sell`); biasScore -= 20; }
  else if (indicators.rsi14 > 55) { signals.push(`RSI bullish (${indicators.rsi14.toFixed(0)})`); biasScore += 8; }
  else if (indicators.rsi14 < 45) { signals.push(`RSI bearish (${indicators.rsi14.toFixed(0)})`); biasScore -= 8; }

  // SMA crossover
  if (indicators.sma10 && indicators.sma20) {
    if (indicators.sma10 > indicators.sma20) { signals.push("SMA golden cross (SMA10 > SMA20)"); biasScore += 12; }
    else { signals.push("SMA death cross (SMA10 < SMA20)"); biasScore -= 12; }
  }

  // MACD
  if (indicators.macd) {
    if (indicators.macd.histogram > 0) { signals.push(`MACD bullish (histogram +${indicators.macd.histogram.toFixed(2)})`); biasScore += 10; }
    else { signals.push(`MACD bearish (histogram ${indicators.macd.histogram.toFixed(2)})`); biasScore -= 10; }
  }

  // Bollinger Bands
  if (indicators.bb) {
    if (indicators.currentPrice <= indicators.bb.lower) { signals.push("Price at/below BB lower band — oversold"); biasScore += 10; }
    else if (indicators.currentPrice >= indicators.bb.upper) { signals.push("Price at/above BB upper band — overbought"); biasScore -= 10; }
  }

  // Stochastic
  if (indicators.stochasticK < 20) { signals.push(`Stochastic oversold (%K ${indicators.stochasticK.toFixed(0)})`); biasScore += 8; }
  else if (indicators.stochasticK > 80) { signals.push(`Stochastic overbought (%K ${indicators.stochasticK.toFixed(0)})`); biasScore -= 8; }

  // Sentiment
  if (sentiment.score > 0.15) { signals.push(`News sentiment bullish (${sentiment.score.toFixed(2)})`); biasScore += 10; }
  else if (sentiment.score < -0.15) { signals.push(`News sentiment bearish (${sentiment.score.toFixed(2)})`); biasScore -= 10; }

  // Determine signal
  const signal: "BUY" | "SELL" | "HOLD" = biasScore > 62 ? "BUY" : biasScore < 38 ? "SELL" : "HOLD";
  const bias = biasScore > 55 ? "bullish" : biasScore < 45 ? "bearish" : "neutral";
  const strength = Math.min(100, Math.abs(biasScore - 50) * 2);

  // Entry/exit (risk management — always include, per kukapay rules)
  const entry = indicators.currentPrice;
  const atr = Math.max(...highs.slice(-14)) - Math.min(...lows.slice(-14)); // simplified ATR
  const stopLoss = signal === "BUY" ? entry - atr * 1.5 : entry + atr * 1.5;
  const takeProfit = signal === "BUY" ? entry + atr * 3 : entry - atr * 3;
  const positionSize = `${Math.min(5, Math.max(1, strength / 20))}%`; // 1-5% based on strength

  const narrative = `${pair.toUpperCase()}: ${signal} signal (${bias}, strength ${strength}%). ` +
    `RSI: ${indicators.rsi14.toFixed(0)}, MACD: ${indicators.macd?.histogram.toFixed(2) ?? "N/A"}, ` +
    `BB: ${indicators.bb ? "active" : "N/A"}, Stochastic: ${indicators.stochasticK.toFixed(0)}, ` +
    `Sentiment: ${sentiment.label} (${sentiment.score.toFixed(2)}). ` +
    `Entry: ${entry.toLocaleString("id-ID")}, SL: ${stopLoss.toLocaleString("id-ID")}, TP: ${takeProfit.toLocaleString("id-ID")}.`;

  const riskWarning = "Not financial advice. Crypto trading is risky. Always use stop-loss. Position size 1-5% of capital.";

  return { pair, signal, bias, strength, entry, stopLoss, takeProfit, positionSize, timeframe: "swing/day", indicators, sentiment, signals, narrative, riskWarning };
}
