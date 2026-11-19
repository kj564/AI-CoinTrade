// Funding Rate analysis — z-score based, not fixed nominal thresholds.
//
// The old version used fixed thresholds (>0.05% = extreme). But funding 0.05%
// might be normal for one pair and extreme for another. The z-score approach:
//   z = (current - rollingMean) / rollingStd
//   |z| > 2 = statistically extreme (top/bottom 5% of that pair's distribution)
//
// This is pair-adaptive: BTC with typical 0.01% funding needs 0.03%+ to be
// "extreme", while a volatile alt with typical 0.05% funding needs 0.10%+.
//
// API: https://fapi.binance.com (free, no auth needed)

export interface FundingRateInfo {
  current: number;           // current funding rate (fraction, e.g. 0.0001 = 0.01%)
  currentPct: number;        // as percentage (0.01%)
  markPrice: number;         // Binance mark price (USD)
  nextFundingTime: number;   // next funding timestamp (ms)
  avgRate: number;           // average of last 30 funding rates
  stdDev: number;            // standard deviation of last 30 rates
  zScore: number;            // (current - mean) / std — pair-adaptive extremeness
  percentile: number;        // 0-100, where current sits in the 30-rate distribution
  extremeHigh: boolean;      // z-score > 2 (top 5% of this pair's distribution)
  extremeLow: boolean;       // z-score < -2 (bottom 5%)
  elevated: boolean;         // z-score > 1 (top 16%) — moderate signal
  depressed: boolean;        // z-score < -1 (bottom 16%) — moderate signal
  sentiment: "overleveraged_long" | "overleveraged_short" | "neutral";
  signal: "contrarian_sell" | "contrarian_buy" | "neutral";
  description: string;
}

const BINANCE_FAPI = "https://fapi.binance.com/fapi/v1";

function pairToBinanceSymbol(pair: string): string {
  const coin = pair.replace("_idr", "").toUpperCase();
  return `${coin}USDT`;
}

export async function getFundingRate(pair: string): Promise<FundingRateInfo | null> {
  const symbol = pairToBinanceSymbol(pair);
  try {
    const premiumRes = await fetch(`${BINANCE_FAPI}/premiumIndex?symbol=${symbol}`, { next: { revalidate: 60 } });
    if (!premiumRes.ok) return null;
    const premium = await premiumRes.json();

    const historyRes = await fetch(`${BINANCE_FAPI}/fundingRate?symbol=${symbol}&limit=30`, { next: { revalidate: 300 } });
    const history = historyRes.ok ? await historyRes.json() : [];

    const current = parseFloat(premium.lastFundingRate || "0");
    const currentPct = current * 100;
    const markPrice = parseFloat(premium.markPrice || "0");
    const nextFundingTime = parseInt(premium.nextFundingTime || "0");

    const rates = Array.isArray(history) ? history.map((h: any) => parseFloat(h.fundingRate || "0")) : [];
    const avgRate = rates.length > 0 ? rates.reduce((a: number, b: number) => a + b, 0) / rates.length : current;

    // Compute standard deviation
    const stdDev = rates.length > 1
      ? Math.sqrt(rates.reduce((a: number, b: number) => a + Math.pow(b - avgRate, 2), 0) / rates.length)
      : 0.0001; // fallback to avoid div-by-zero

    // Z-score: pair-adaptive extremeness measure
    const zScore = stdDev > 0 ? (current - avgRate) / stdDev : 0;

    // Percentile: where current sits in the historical distribution
    const sortedRates = [...rates].sort((a, b) => a - b);
    const rank = sortedRates.filter((r) => r <= current).length;
    const percentile = rates.length > 0 ? (rank / rates.length) * 100 : 50;

    // Classify based on z-score (not fixed nominal thresholds)
    const extremeHigh = zScore > 2;    // top 5% of this pair's distribution
    const extremeLow = zScore < -2;    // bottom 5%
    const elevated = zScore > 1;       // top 16%
    const depressed = zScore < -1;     // bottom 16%

    let sentiment: FundingRateInfo["sentiment"] = "neutral";
    let signal: FundingRateInfo["signal"] = "neutral";
    let description = "";

    if (extremeHigh) {
      sentiment = "overleveraged_long";
      signal = "contrarian_sell";
      description = `Funding ${currentPct.toFixed(4)}% (z=${zScore.toFixed(2)}, ${percentile.toFixed(0)}th %ile) → EXTREME for this pair. Longs overlevered, contrarian SELL.`;
    } else if (extremeLow) {
      sentiment = "overleveraged_short";
      signal = "contrarian_buy";
      description = `Funding ${currentPct.toFixed(4)}% (z=${zScore.toFixed(2)}, ${percentile.toFixed(0)}th %ile) → EXTREME negative. Shorts overlevered, contrarian BUY.`;
    } else if (elevated) {
      sentiment = "overleveraged_long";
      signal = "contrarian_sell";
      description = `Funding ${currentPct.toFixed(4)}% (z=${zScore.toFixed(2)}, elevated) → longs paying. Moderate contrarian bias.`;
    } else if (depressed) {
      sentiment = "overleveraged_short";
      signal = "contrarian_buy";
      description = `Funding ${currentPct.toFixed(4)}% (z=${zScore.toFixed(2)}, depressed) → shorts paying. Moderate contrarian bias.`;
    } else {
      description = `Funding ${currentPct.toFixed(4)}% (z=${zScore.toFixed(2)}, ${percentile.toFixed(0)}th %ile) → neutral for this pair. No contrarian edge.`;
    }

    return { current, currentPct, markPrice, nextFundingTime, avgRate, stdDev, zScore, percentile, extremeHigh, extremeLow, elevated, depressed, sentiment, signal, description };
  } catch {
    return null;
  }
}
