// Walk-the-book slippage simulation.
//
// P3: Instead of just using top-5 depth × 20%, simulate actually consuming
// the order book level by level. For a given notional, compute:
//   - How many levels to eat through
//   - Volume-weighted average fill price
//   - Slippage = (avgFill - mid) / mid
//
// Then find the max notional where slippage < 0.5% (the slippage cap).
// This is more accurate than the simple depth estimate because it accounts
// for thin levels deep in the book that the simple method ignores.

export interface WalkTheBookResult {
  maxNotionalAtSlippageCap: number;  // max IDR notional before slippage exceeds cap
  slippageCapPct: number;            // the cap used (0.5%)
  levelsConsumed: number;            // how many levels eaten at max notional
  avgFillPrice: number;              // VWAP fill at max notional
  midPrice: number;                  // reference mid price
  actualSlippagePct: number;         // slippage at max notional
  topBidLevels: number;              // total bid levels available
  topAskLevels: number;              // total ask levels available
  spreadPct: number;                 // top-of-book spread
}

const SLIPPAGE_CAP_PCT = 0.5; // 0.5% max acceptable slippage

// Simulate walking the book for a BUY (consume asks) or SELL (consume bids).
// Returns the max notional (in IDR) that can be placed without exceeding
// the slippage cap.
export function walkTheBook(
  levels: [string, string][], // [[price, volume], ...] from INDODAX depth
  side: "buy" | "sell",
  midPrice: number,
): WalkTheBookResult | null {
  if (!levels || levels.length === 0 || midPrice <= 0) return null;

  let cumulativeVol = 0;
  let cumulativeNotional = 0;
  let maxNotionalAtCap = 0;
  let levelsConsumed = 0;
  let avgFillPrice = 0;

  for (let i = 0; i < levels.length; i++) {
    const levelPrice = parseFloat(levels[i][0]);
    const levelVol = parseFloat(levels[i][1]);
    if (levelPrice <= 0 || levelVol <= 0) continue;

    // Notional at this level = vol × price
    const levelNotional = levelVol * levelPrice;

    // If we consumed this entire level, what would our VWAP be?
    const newCumVol = cumulativeVol + levelVol;
    const newCumNotional = cumulativeNotional + levelNotional;
    const newVWAP = newCumNotional / newCumVol;

    // Slippage = (VWAP - mid) / mid for buys (paying above mid)
    //          = (mid - VWAP) / mid for sells (selling below mid)
    const slippage = side === "buy"
      ? ((newVWAP - midPrice) / midPrice) * 100
      : ((midPrice - newVWAP) / midPrice) * 100;

    if (slippage > SLIPPAGE_CAP_PCT) {
      // This level pushes us over the cap. Compute how much of this level
      // we can consume before hitting the cap.
      // Solve: (cumNotional + partialVol × levelPrice) / (cumVol + partialVol) = mid × (1 + cap/100)
      const targetVWAP = side === "buy"
        ? midPrice * (1 + SLIPPAGE_CAP_PCT / 100)
        : midPrice * (1 - SLIPPAGE_CAP_PCT / 100);

      // partialVol × (levelPrice - targetVWAP) = targetVWAP × cumVol - cumNotional
      const numerator = targetVWAP * cumulativeVol - cumulativeNotional;
      const denominator = levelPrice - targetVWAP;
      let partialVol = denominator !== 0 ? numerator / denominator : 0;
      if (partialVol < 0) partialVol = 0;
      if (partialVol > levelVol) partialVol = levelVol;

      const partialNotional = partialVol * levelPrice;
      maxNotionalAtCap = cumulativeNotional + partialNotional;
      levelsConsumed = i + (partialVol > 0 ? 1 : 0);
      const finalVol = cumulativeVol + partialVol;
      avgFillPrice = finalVol > 0 ? (cumulativeNotional + partialNotional) / finalVol : midPrice;
      break;
    }

    // Consume entire level
    cumulativeVol = newCumVol;
    cumulativeNotional = newCumNotional;
    levelsConsumed = i + 1;
    avgFillPrice = newVWAP;
    maxNotionalAtCap = cumulativeNotional;

    // Safety: stop after 50 levels (don't walk infinitely deep)
    if (i >= 49) break;
  }

  const actualSlippage = side === "buy"
    ? ((avgFillPrice - midPrice) / midPrice) * 100
    : ((midPrice - avgFillPrice) / midPrice) * 100;

  const topBid = parseFloat(levels[0]?.[0] ?? "0");
  const topAsk = parseFloat(levels[0]?.[0] ?? "0");
  const spreadPct = midPrice > 0 ? (side === "buy"
    ? ((parseFloat(levels[0][0]) - midPrice) / midPrice) * 100
    : ((midPrice - parseFloat(levels[0][0])) / midPrice) * 100) : 0;

  return {
    maxNotionalAtSlippageCap: maxNotionalAtCap,
    slippageCapPct: SLIPPAGE_CAP_PCT,
    levelsConsumed,
    avgFillPrice,
    midPrice,
    actualSlippagePct: Math.abs(actualSlippage),
    topBidLevels: levels.length,
    topAskLevels: levels.length,
    spreadPct: Math.abs(spreadPct),
  };
}

// Compute liquidity cap using walk-the-book for both sides.
// Returns the min of buy-side and sell-side max notional (conservative).
export function computeWalkTheBookCap(
  depth: { buy: [string, string][]; sell: [string, string][] },
  midPrice: number,
): { buySide: WalkTheBookResult | null; sellSide: WalkTheBookResult | null; maxNotional: number } {
  const buySide = walkTheBook(depth.sell, "buy", midPrice);  // buying consumes asks
  const sellSide = walkTheBook(depth.buy, "sell", midPrice); // selling consumes bids
  const maxNotional = Math.min(
    buySide?.maxNotionalAtSlippageCap ?? Infinity,
    sellSide?.maxNotionalAtSlippageCap ?? Infinity,
  );
  return { buySide, sellSide, maxNotional: maxNotional === Infinity ? 0 : maxNotional };
}
