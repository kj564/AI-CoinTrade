// Funding Rate analysis — fetches Binance perpetual futures funding rate
// as a crypto-specific sentiment/contrarian signal.
// Funding > 0 = longs pay shorts → overleveraged longs → contrarian SELL
// Funding < 0 = shorts pay longs → overleveraged shorts → contrarian BUY
// API: https://fapi.binance.com (free, no auth needed)

export interface FundingRateInfo {
  current: number;           // current funding rate (fraction, e.g. 0.0001 = 0.01%)
  currentPct: number;        // as percentage (0.01%)
  markPrice: number;         // Binance mark price (USD)
  nextFundingTime: number;   // next funding timestamp (ms)
  avgRate: number;           // average of last 30 funding rates
  extremeHigh: boolean;      // funding > 0.05% (overleveraged longs)
  extremeLow: boolean;       // funding < -0.01% (overleveraged shorts)
  sentiment: "overleveraged_long" | "overleveraged_short" | "neutral";
  signal: "contrarian_sell" | "contrarian_buy" | "neutral";
  description: string;
}

const BINANCE_FAPI = "https://fapi.binance.com/fapi/v1";

// Map INDODAX pair to Binance symbol
function pairToBinanceSymbol(pair: string): string {
  const coin = pair.replace("_idr", "").toUpperCase();
  return `${coin}USDT`;
}

export async function getFundingRate(pair: string): Promise<FundingRateInfo | null> {
  const symbol = pairToBinanceSymbol(pair);
  try {
    // Fetch current premium index (has funding rate + mark price)
    const premiumRes = await fetch(`${BINANCE_FAPI}/premiumIndex?symbol=${symbol}`, { next: { revalidate: 60 } });
    if (!premiumRes.ok) return null;
    const premium = await premiumRes.json();

    // Fetch funding rate history (last 30)
    const historyRes = await fetch(`${BINANCE_FAPI}/fundingRate?symbol=${symbol}&limit=30`, { next: { revalidate: 300 } });
    const history = historyRes.ok ? await historyRes.json() : [];

    const current = parseFloat(premium.lastFundingRate || "0");
    const currentPct = current * 100;
    const markPrice = parseFloat(premium.markPrice || "0");
    const nextFundingTime = parseInt(premium.nextFundingTime || "0");

    // Average of last 30 funding rates
    const rates = Array.isArray(history) ? history.map((h: any) => parseFloat(h.fundingRate || "0")) : [];
    const avgRate = rates.length > 0 ? rates.reduce((a: number, b: number) => a + b, 0) / rates.length : current;

    // Classify
    const extremeHigh = current > 0.0005; // > 0.05%
    const extremeLow = current < -0.0001; // < -0.01%

    let sentiment: "overleveraged_long" | "overleveraged_short" | "neutral" = "neutral";
    let signal: "contrarian_sell" | "contrarian_buy" | "neutral" = "neutral";
    let description = "";

    if (extremeHigh) {
      sentiment = "overleveraged_long";
      signal = "contrarian_sell";
      description = `Funding rate ${currentPct.toFixed(4)}% (EXTREME HIGH) → longs overleveraged, paying shorts. Contrarian SELL: market likely top.`;
    } else if (extremeLow) {
      sentiment = "overleveraged_short";
      signal = "contrarian_buy";
      description = `Funding rate ${currentPct.toFixed(4)}% (NEGATIVE) → shorts overleveraged, paying longs. Contrarian BUY: market likely bottom.`;
    } else if (current > 0.0002) {
      sentiment = "overleveraged_long";
      signal = "contrarian_sell";
      description = `Funding rate ${currentPct.toFixed(4)}% (elevated) → longs paying shorts. Cautious on BUY signals.`;
    } else if (current < -0.00002) {
      sentiment = "overleveraged_short";
      signal = "contrarian_buy";
      description = `Funding rate ${currentPct.toFixed(4)}% (slightly negative) → shorts paying longs. Mild contrarian BUY bias.`;
    } else {
      description = `Funding rate ${currentPct.toFixed(4)}% (neutral) → balanced positioning. No strong contrarian signal.`;
    }

    return { current, currentPct, markPrice, nextFundingTime, avgRate, extremeHigh, extremeLow, sentiment, signal, description };
  } catch {
    return null;
  }
}
