// Funding Rate analysis — z-score based on 180-period rolling window.
//
// v3: Extended from 30 → 180 periods for a more stable baseline. Funding is
// regime-dependent (higher in trending markets, lower in ranging), so a
// short window conflates regimes. 180 periods ≈ 60 days of 8h funding gives
// a multi-regime baseline that adapts slowly enough to be stable but fast
// enough to catch structural shifts.
//
// API: https://fapi.binance.com (free, no auth needed)

export interface FundingRateInfo {
  current: number;
  currentPct: number;
  markPrice: number;
  nextFundingTime: number;
  avgRate: number;
  stdDev: number;
  zScore: number;          // z-score over 180-period window
  percentile: number;      // 0-100
  extremeHigh: boolean;    // z > 2
  extremeLow: boolean;     // z < -2
  elevated: boolean;       // z > 1
  depressed: boolean;      // z < -1
  windowSize: number;      // how many periods used (180 if available)
  sentiment: "overleveraged_long" | "overleveraged_short" | "neutral";
  signal: "contrarian_sell" | "contrarian_buy" | "neutral";
  description: string;
}

const BINANCE_FAPI = "https://fapi.binance.com/fapi/v1";
const FUNDING_WINDOW = 180; // 180 periods ≈ 60 days of 8h funding

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

    // Fetch 180 periods for stable multi-regime baseline
    const historyRes = await fetch(`${BINANCE_FAPI}/fundingRate?symbol=${symbol}&limit=${FUNDING_WINDOW}`, { next: { revalidate: 300 } });
    const history = historyRes.ok ? await historyRes.json() : [];

    const current = parseFloat(premium.lastFundingRate || "0");
    const currentPct = current * 100;
    const markPrice = parseFloat(premium.markPrice || "0");
    const nextFundingTime = parseInt(premium.nextFundingTime || "0");

    const rates = Array.isArray(history) ? history.map((h: any) => parseFloat(h.fundingRate || "0")) : [];
    const avgRate = rates.length > 0 ? rates.reduce((a: number, b: number) => a + b, 0) / rates.length : current;

    const stdDev = rates.length > 1
      ? Math.sqrt(rates.reduce((a: number, b: number) => a + Math.pow(b - avgRate, 2), 0) / rates.length)
      : 0.0001;

    const zScore = stdDev > 0 ? (current - avgRate) / stdDev : 0;

    const sortedRates = [...rates].sort((a, b) => a - b);
    const rank = sortedRates.filter((r) => r <= current).length;
    const percentile = rates.length > 0 ? (rank / rates.length) * 100 : 50;

    const extremeHigh = zScore > 2;
    const extremeLow = zScore < -2;
    const elevated = zScore > 1;
    const depressed = zScore < -1;

    let sentiment: FundingRateInfo["sentiment"] = "neutral";
    let signal: FundingRateInfo["signal"] = "neutral";
    let description = "";
    const windowNote = `(${rates.length}p window)`;

    if (extremeHigh) {
      sentiment = "overleveraged_long";
      signal = "contrarian_sell";
      description = `Funding ${currentPct.toFixed(4)}% (z=${zScore.toFixed(2)}, ${percentile.toFixed(0)}th %ile ${windowNote}) → EXTREME. Longs overlevered, contrarian SELL.`;
    } else if (extremeLow) {
      sentiment = "overleveraged_short";
      signal = "contrarian_buy";
      description = `Funding ${currentPct.toFixed(4)}% (z=${zScore.toFixed(2)}, ${percentile.toFixed(0)}th %ile ${windowNote}) → EXTREME negative. Shorts overlevered, contrarian BUY.`;
    } else if (elevated) {
      sentiment = "overleveraged_long";
      signal = "contrarian_sell";
      description = `Funding ${currentPct.toFixed(4)}% (z=${zScore.toFixed(2)}, elevated ${windowNote}) → longs paying. Moderate contrarian bias.`;
    } else if (depressed) {
      sentiment = "overleveraged_short";
      signal = "contrarian_buy";
      description = `Funding ${currentPct.toFixed(4)}% (z=${zScore.toFixed(2)}, depressed ${windowNote}) → shorts paying. Moderate contrarian bias.`;
    } else {
      description = `Funding ${currentPct.toFixed(4)}% (z=${zScore.toFixed(2)}, ${percentile.toFixed(0)}th %ile ${windowNote}) → neutral. No contrarian edge.`;
    }

    return { current, currentPct, markPrice, nextFundingTime, avgRate, stdDev, zScore, percentile, extremeHigh, extremeLow, elevated, depressed, windowSize: rates.length, sentiment, signal, description };
  } catch {
    return null;
  }
}
