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
export function computeWalkTheBookCap(
  depth: { buy: [string, string][]; sell: [string, string][] },
  midPrice: number,
): { buySide: WalkTheBookResult | null; sellSide: WalkTheBookResult | null; maxNotional: number } {
  const buySide = walkTheBook(depth.sell, "buy", midPrice);
  const sellSide = walkTheBook(depth.buy, "sell", midPrice);
  const maxNotional = Math.min(
    buySide?.maxNotionalAtSlippageCap ?? Infinity,
    sellSide?.maxNotionalAtSlippageCap ?? Infinity,
  );
  return { buySide, sellSide, maxNotional: maxNotional === Infinity ? 0 : maxNotional };
}

// ── P2: LIMIT ORDER cost model ──
// For limit orders, the cost structure is different from market orders:
//   - You place at a specific price (e.g., the bid for a buy limit)
//   - You join the queue at that price level
//   - You get filled when counter-parties cross your price
//   - If price moves away from you, you DON'T get filled (opportunity cost)
//   - If price moves toward you, you get filled — but that's adverse selection
//     (the price was moving in your favor anyway, and now you're filled at a
//     price that's about to move further in your favor — but you're capped at
//     your limit price, so you miss the extra gain)
//
// The expected cost of a limit order has three components:
//   1. Spread savings (you don't cross the spread — this is a BENEFIT, negative cost)
//   2. Fill probability (probability you actually get filled)
//   3. Adverse selection cost (when filled, price was moving against you)
//
// If fillProb is low, you might not get filled at all → opportunity cost of
// missing the trade. This module estimates these for the INDODAX order book.

export interface LimitOrderCostModel {
  side: "buy" | "sell";
  limitPrice: number;            // the price you place the limit at
  midPrice: number;
  spreadPct: number;             // half-spread (the savings if filled)
  queueAheadVol: number;         // volume already in the queue at your price level
  queuePositionPct: number;      // your position in the queue (0 = front, 1 = back)
  fillProbability: number;       // estimated probability of getting filled (0-1)
  adverseSelectionPct: number;   // expected adverse move when filled (%)
  netExpectedCostPct: number;    // spread savings - adverse selection - opportunity cost
  recommendation: "use_limit" | "use_market" | "improve_price";
  description: string;
}

export function computeLimitOrderCost(
  depth: { buy: [string, string][]; sell: [string, string][] },
  side: "buy" | "sell",
  orderVol: number,
): LimitOrderCostModel | null {
  if (!depth || !depth.buy || !depth.sell || orderVol <= 0) return null;

  // For a buy limit, place at the top bid (join the queue)
  // For a sell limit, place at the top ask
  const refLevels = side === "buy" ? depth.buy : depth.sell;
  if (refLevels.length === 0) return null;

  const topBid = parseFloat(depth.buy[0]?.[0] ?? "0");
  const topAsk = parseFloat(depth.sell[0]?.[0] ?? "0");
  if (topBid <= 0 || topAsk <= 0) return null;

  const midPrice = (topBid + topAsk) / 2;
  const limitPrice = side === "buy" ? topBid : topAsk;
  const halfSpreadPct = ((topAsk - topBid) / (2 * midPrice)) * 100;

  // Queue ahead: the volume already at your price level (you're behind them)
  const queueAheadVol = parseFloat(refLevels[0]?.[1] ?? "0");
  // Your queue position: rough estimate (you're at the back of the current level)
  const queuePositionPct = 1.0; // conservative: you're last at this level

  // Fill probability estimate: based on queue size relative to your order
  // and the typical trade flow. If queue is huge relative to your order,
  // fill prob is low. This is a simplified model.
  const queueRatio = queueAheadVol / orderVol;
  // If queue is 10x your order, fill prob ~ 0.3. If queue is 1x, fill prob ~ 0.7.
  const fillProbability = Math.max(0.1, Math.min(0.9, 0.8 / (1 + queueRatio * 0.1)));

  // Adverse selection: when you get filled on a limit buy, it's often because
  // price was dropping (sellers hitting your bid). The adverse move is the
  // expected further drop after you're filled.
  // Simplified: adverse selection ≈ half the spread (you save the spread but
  // give back half of it to adverse selection).
  const adverseSelectionPct = halfSpreadPct * 0.4; // 40% of half-spread

  // Net expected cost: spread savings (benefit) - adverse selection (cost)
  // - opportunity cost of not getting filled (prob-weighted)
  const spreadSavings = halfSpreadPct;
  const opportunityCost = (1 - fillProbability) * halfSpreadPct; // if not filled, you missed the spread savings
  const netExpectedCostPct = adverseSelectionPct + opportunityCost - spreadSavings;

  let recommendation: LimitOrderCostModel["recommendation"];
  let description: string;

  if (netExpectedCostPct < -0.02 && fillProbability > 0.5) {
    recommendation = "use_limit";
    description = `Limit order favorable: net cost ${(netExpectedCostPct).toFixed(3)}% (spread savings > adverse selection + opportunity cost). Fill prob ${(fillProbability * 100).toFixed(0)}%. Queue ahead: ${queueAheadVol.toFixed(2)} units.`;
  } else if (netExpectedCostPct > 0.02 || fillProbability < 0.3) {
    recommendation = "use_market";
    description = `Market order preferred: limit net cost ${(netExpectedCostPct).toFixed(3)}% (adverse selection + low fill prob outweigh spread savings). Fill prob only ${(fillProbability * 100).toFixed(0)}%. Queue too deep (${queueAheadVol.toFixed(2)} ahead).`;
  } else {
    recommendation = "improve_price";
    description = `Marginal: limit net cost ${(netExpectedCostPct).toFixed(3)}%. Consider improving price (cross half-spread) for better fill probability, or use market if urgency is high.`;
  }

  return {
    side,
    limitPrice,
    midPrice,
    spreadPct: halfSpreadPct,
    queueAheadVol,
    queuePositionPct,
    fillProbability,
    adverseSelectionPct,
    netExpectedCostPct,
    recommendation,
    description,
  };
}

