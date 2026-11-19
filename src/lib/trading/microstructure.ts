// Microstructure confirmation — OI change + CVD + absorption detection.
//
// Funding extreme alone is NOT enough for entry. Momentum can persist through
// several funding periods, and blind fading is dangerous. This module adds
// the confirmation layer:
//
//   1. OPEN INTEREST CHANGE — if OI is still rising when funding is extreme,
//      new positions are still being opened → momentum alive → DON'T fade yet.
//      If OI is declining/stagnant after the extreme → positions closing →
//      reversal more likely → SAFE to fade.
//
//   2. CUMULATIVE VOLUME DELTA (CVD) — net taker buy vs sell volume over
//      recent window. If CVD strongly positive but price stalling = absorption
//      (buyers can't push price up → sellers absorbing → reversal down likely).
//      If CVD strongly negative but price holding = sellers exhausted → bounce.
//
//   3. ABSORPTION RATIO — volume / |price_change|. High volume + low price
//      change = absorption (big players taking the other side). This is the
//      strongest microstructural confirmation for a reversal.
//
// All data from Binance fapi (free, no auth).

const BINANCE_FAPI = "https://fapi.binance.com/fapi/v1";
const BINANCE_FUTURES_DATA = "https://fapi.binance.com/futures/data";

function pairToBinanceSymbol(pair: string): string {
  const coin = pair.replace("_idr", "").toUpperCase();
  return `${coin}USDT`;
}

export interface MicrostructureData {
  openInterest: number;          // current OI (in contracts)
  openInterestUsd: number;       // current OI in USD
  oiChange1hPct: number;         // OI change last 1h (%)
  oiChange4hPct: number;         // OI change last 4h (%)
  oiTrend: "rising" | "declining" | "stagnant";  // OI trend over last 4h
  cvd1h: number;                 // cumulative volume delta last 1h (positive = net buy)
  cvd4h: number;                 // CVD last 4h
  cvdDivergence: boolean;        // CVD diverges from price direction (absorption signal)
  absorptionRatio: number;       // volume / |price_change| — high = absorption
  absorptionDetected: boolean;   // true if absorptionRatio > threshold
  takerBuyRatio1h: number;       // fraction of taker volume that was buys (0-1)
  confirmation: "reversal_likely" | "momentum_alive" | "neutral";
  description: string;
}

export async function getMicrostructure(pair: string, currentPrice: number): Promise<MicrostructureData | null> {
  const symbol = pairToBinanceSymbol(pair);
  try {
    // 1. Current Open Interest
    const oiRes = await fetch(`${BINANCE_FAPI}/openInterest?symbol=${symbol}`, { next: { revalidate: 60 } });
    if (!oiRes.ok) return null;
    const oiData = await oiRes.json();
    const openInterest = parseFloat(oiData.openInterest || "0");
    const openInterestUsd = openInterest * currentPrice;

    // 2. OI History (last 5 hours for 1h + 4h change)
    const oiHistRes = await fetch(`${BINANCE_FUTURES_DATA}/openInterestHist?symbol=${symbol}&period=1h&limit=5`, { next: { revalidate: 60 } });
    const oiHist = oiHistRes.ok ? await oiHistRes.json() : [];
    const oiValues = Array.isArray(oiHist) ? oiHist.map((h: any) => parseFloat(h.sumOpenInterest || "0")) : [];

    const oiNow = oiValues.length > 0 ? oiValues[oiValues.length - 1] : openInterest;
    const oi1hAgo = oiValues.length > 1 ? oiValues[oiValues.length - 2] : oiNow;
    const oi4hAgo = oiValues.length > 4 ? oiValues[oiValues.length - 5] : oiValues[0] ?? oiNow;

    const oiChange1hPct = oi1hAgo > 0 ? ((oiNow - oi1hAgo) / oi1hAgo) * 100 : 0;
    const oiChange4hPct = oi4hAgo > 0 ? ((oiNow - oi4hAgo) / oi4hAgo) * 100 : 0;

    let oiTrend: MicrostructureData["oiTrend"] = "stagnant";
    if (oiChange4hPct > 2) oiTrend = "rising";
    else if (oiChange4hPct < -2) oiTrend = "declining";

    // 3. Recent trades for CVD + absorption (last 1000 trades ≈ 1-4h depending on activity)
    const tradesRes = await fetch(`${BINANCE_FAPI}/aggTrades?symbol=${symbol}&limit=1000`, { next: { revalidate: 30 } });
    const trades = tradesRes.ok ? await tradesRes.json() : [];

    let takerBuyVol = 0, takerSellVol = 0;
    let totalVol = 0;
    let firstPrice = 0, lastPrice = 0;

    if (Array.isArray(trades) && trades.length > 0) {
      firstPrice = parseFloat(trades[0].p || "0");
      lastPrice = parseFloat(trades[trades.length - 1].p || "0");
      for (const t of trades) {
        const vol = parseFloat(t.q || "0");
        const isBuyerMaker = t.m === true; // m=true means buyer is maker → taker is seller
        if (isBuyerMaker) {
          takerSellVol += vol;
        } else {
          takerBuyVol += vol;
        }
        totalVol += vol;
      }
    }

    // CVD: positive = net taker buying, negative = net taker selling
    const cvd = takerBuyVol - takerSellVol;
    const takerBuyRatio = totalVol > 0 ? takerBuyVol / totalVol : 0.5;

    // Split CVD into 1h (last 25% of trades) and 4h (all)
    const splitIdx = Math.floor(trades.length * 0.75);
    let cvd1h = 0;
    if (Array.isArray(trades)) {
      for (let i = splitIdx; i < trades.length; i++) {
        const t = trades[i];
        const vol = parseFloat(t.q || "0");
        cvd1h += t.m ? -vol : vol;
      }
    }
    const cvd4h = cvd;

    // Absorption: high volume but low price change.
    // P2: OOS-validated threshold — instead of fixed >100, compute the
    // absorption ratio distribution from the current trade batch and use
    // the 80th percentile as the threshold. This adapts to each pair's
    // typical volume/price_change ratio. High-volume pairs naturally have
    // higher ratios, so a fixed threshold over-flags them.
    const priceChangePct = firstPrice > 0 ? Math.abs((lastPrice - firstPrice) / firstPrice) * 100 : 0;
    const absorptionRatio = priceChangePct > 0 ? totalVol / priceChangePct : 0;

    // Compute per-trade absorption ratios to build a distribution
    const perTradeRatios: number[] = [];
    if (Array.isArray(trades) && trades.length > 10) {
      // Chunk trades into 20-trade segments, compute absorption ratio per chunk
      const chunkSize = Math.max(5, Math.floor(trades.length / 20));
      for (let i = 0; i < trades.length - chunkSize; i += chunkSize) {
        const chunk = trades.slice(i, i + chunkSize);
        let chunkVol = 0, chunkFirst = parseFloat(chunk[0].p || "0"), chunkLast = parseFloat(chunk[chunk.length - 1].p || "0");
        for (const t of chunk) chunkVol += parseFloat(t.q || "0");
        const chunkPriceChange = chunkFirst > 0 ? Math.abs((chunkLast - chunkFirst) / chunkFirst) * 100 : 0;
        if (chunkPriceChange > 0 && chunkVol > 0) perTradeRatios.push(chunkVol / chunkPriceChange);
      }
    }
    // Threshold = 80th percentile of the chunk distribution (top 20% = absorption)
    perTradeRatios.sort((a, b) => a - b);
    const thresholdIdx = Math.floor(perTradeRatios.length * 0.8);
    const dynamicThreshold = perTradeRatios.length > 5 ? perTradeRatios[thresholdIdx] : 100;
    const absorptionDetected = absorptionRatio > dynamicThreshold && totalVol > 0;

    // CVD divergence: CVD says one direction but price went the other
    const priceDir = lastPrice > firstPrice ? "up" : lastPrice < firstPrice ? "down" : "flat";
    const cvdDir = cvd > 0 ? "up" : cvd < 0 ? "down" : "flat";
    const cvdDivergence = (priceDir !== cvdDir) && (priceDir !== "flat") && (cvdDir !== "flat");

    // Confirmation logic
    let confirmation: MicrostructureData["confirmation"] = "neutral";
    let description = "";

    if (cvdDivergence || absorptionDetected) {
      confirmation = "reversal_likely";
      description = `Absorption detected: CVD ${cvdDir} but price ${priceDir}. High volume failed to move price → big players taking the other side. Reversal more likely.`;
    } else if (oiTrend === "rising" && Math.abs(cvd) > totalVol * 0.1) {
      confirmation = "momentum_alive";
      description = `OI ${oiTrend} (${oiChange4hPct.toFixed(1)}% 4h) + strong CVD ${cvdDir} → momentum still building. Fading is dangerous.`;
    } else if (oiTrend === "declining") {
      confirmation = "reversal_likely";
      description = `OI declining (${oiChange4hPct.toFixed(1)}% 4h) → positions closing. If funding is extreme, reversal confirmation strengthens.`;
    } else {
      description = `OI ${oiTrend} (${oiChange4hPct.toFixed(1)}% 4h), CVD ${cvd.toFixed(0)}, taker buy ratio ${(takerBuyRatio * 100).toFixed(0)}%. No strong microstructural confirmation.`;
    }

    return {
      openInterest,
      openInterestUsd,
      oiChange1hPct,
      oiChange4hPct,
      oiTrend,
      cvd1h,
      cvd4h,
      cvdDivergence,
      absorptionRatio,
      absorptionDetected,
      takerBuyRatio1h: takerBuyRatio,
      confirmation,
      description,
    };
  } catch (e) {
    console.warn(`[microstructure] failed for ${pair}:`, e instanceof Error ? e.message : e);
    return null;
  }
}
