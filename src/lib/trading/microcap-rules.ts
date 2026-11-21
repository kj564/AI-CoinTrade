// Microcap pair liquidity gate + sizing rules.
//
// Microcap tokens (like UNMD) have fundamentally different risk characteristics
// than major pairs (BTC/ETH/SOL/BNB/XRP):
//   - Liquidity is very thin (24h volume can be < Rp 100jt)
//   - Spreads are wide and volatile (can jump from 0.5% to 5% in minutes)
//   - Price manipulation is easier (small orders can move price 10%+)
//   - Funding rates are unavailable (no perpetuals on Binance)
//   - Historical data may be limited (token recently listed)
//
// This module enforces STRICT liquidity gates before allowing any signal:
//   1. Minimum 100 candles of historical data
//   2. Spread ≤ 1% (notional-relative)
//   3. 24h volume ≥ Rp 500jt (ensures enough liquidity to exit)
//   4. No price spike > 20% in the last 1h (extreme volatility = manipulation risk)
//   5. Minimum 20 OOS trades before promoting from WATCHLIST
//
// If ANY gate fails, the signal is forced to FLAT with a WATCHLIST status.
// The pair stays in WATCHLIST until all gates pass + OOS sample accumulates.
//
// Sizing for microcaps is also restricted:
//   - Risk per trade: 0.1% (vs 0.5% standard)
//   - Max notional: Rp 250,000 (micro position for paper testing)
//   - Limit orders only (never market — slippage too dangerous)

export interface MicrocapRules {
  pair: string;
  minCandles: number;
  minVolume24hIdr: number;
  maxSpreadPct: number;
  maxPriceSpike1hPct: number;
  maxRiskPct: number;        // 0.001 = 0.1%
  maxNotionalIdr: number;
  minOOStrades: number;
  paperTradingOnly: boolean;
}

export const MICROCAP_RULES: Record<string, MicrocapRules> = {
  unmd_idr: {
    pair: "unmd_idr",
    minCandles: 100,
    minVolume24hIdr: 500_000_000,    // Rp 500jt
    maxSpreadPct: 1.0,
    maxPriceSpike1hPct: 20,
    maxRiskPct: 0.001,               // 0.1%
    maxNotionalIdr: 250_000,         // Rp 250k
    minOOStrades: 20,
    paperTradingOnly: true,
  },
};

export function isMicrocap(pair: string): boolean {
  return pair in MICROCAP_RULES;
}

export function getMicrocapRules(pair: string): MicrocapRules | null {
  return MICROCAP_RULES[pair] ?? null;
}

export interface MicrocapGateCheck {
  name: string;
  passed: boolean;
  actual: number;
  required: number;
  unit: string;
}

export interface MicrocapGateResult {
  passed: boolean;
  pair: string;
  rules: MicrocapRules;
  checks: MicrocapGateCheck[];
  failedChecks: string[];
  reason: string;
  status: "WATCHLIST" | "KANDIDAT_EDGE" | "KANDIDAT_LIVE_MICRO";
}

// Run the microcap liquidity gate.
// Inputs: candles (1h), depth (INDODAX order book), idrPrice, oosTradeCount (from CB).
export function runMicrocapGate(
  pair: string,
  candles: { time: number; close: number; high: number; low: number; volume: number }[],
  depth: { buy?: [string, string][]; sell?: [string, string][] } | null,
  idrPrice: number,
  oosTradeCount: number,
): MicrocapGateResult {
  const rules = getMicrocapRules(pair);
  if (!rules) {
    return {
      passed: true,
      pair,
      rules: { pair, minCandles: 0, minVolume24hIdr: 0, maxSpreadPct: 0, maxPriceSpike1hPct: 0, maxRiskPct: 0, maxNotionalIdr: 0, minOOStrades: 0, paperTradingOnly: false },
      checks: [],
      failedChecks: [],
      reason: "not a microcap pair",
      status: "KANDIDAT_EDGE",
    };
  }

  const checks: MicrocapGateCheck[] = [];

  // 1. Minimum candles
  const candleCount = candles.length;
  checks.push({
    name: "Historical data",
    passed: candleCount >= rules.minCandles,
    actual: candleCount,
    required: rules.minCandles,
    unit: "candles",
  });

  // 2. Spread check
  let spreadPct = 0;
  if (depth?.buy?.[0]?.[0] && depth?.sell?.[0]?.[0]) {
    const topBid = parseFloat(depth.buy[0][0]);
    const topAsk = parseFloat(depth.sell[0][0]);
    const midPrice = (topBid + topAsk) / 2;
    spreadPct = midPrice > 0 ? ((topAsk - topBid) / midPrice) * 100 : 0;
  } else {
    spreadPct = 999; // no depth data = fail
  }
  checks.push({
    name: "Spread",
    passed: spreadPct <= rules.maxSpreadPct,
    actual: spreadPct,
    required: rules.maxSpreadPct,
    unit: "%",
  });

  // 3. 24h volume (sum of last 24 1h candles × close price)
  const last24 = candles.slice(-24);
  const volume24hIdr = last24.reduce((sum, c) => sum + c.volume * c.close, 0);
  checks.push({
    name: "24h volume",
    passed: volume24hIdr >= rules.minVolume24hIdr,
    actual: volume24hIdr,
    required: rules.minVolume24hIdr,
    unit: "IDR",
  });

  // 4. Price spike check (last candle close vs previous close)
  let priceSpike1hPct = 0;
  if (candles.length >= 2) {
    const lastClose = candles[candles.length - 1].close;
    const prevClose = candles[candles.length - 2].close;
    if (prevClose > 0) {
      priceSpike1hPct = Math.abs((lastClose - prevClose) / prevClose) * 100;
    }
  }
  checks.push({
    name: "Price spike (1h)",
    passed: priceSpike1hPct <= rules.maxPriceSpike1hPct,
    actual: priceSpike1hPct,
    required: rules.maxPriceSpike1hPct,
    unit: "%",
  });

  // 5. OOS trade count
  checks.push({
    name: "OOS trades",
    passed: oosTradeCount >= rules.minOOStrades,
    actual: oosTradeCount,
    required: rules.minOOStrades,
    unit: "trades",
  });

  const failedChecks = checks.filter((c) => !c.passed).map((c) => c.name);
  const allPassed = failedChecks.length === 0;

  // Determine status
  let status: "WATCHLIST" | "KANDIDAT_EDGE" | "KANDIDAT_LIVE_MICRO";
  if (!allPassed) {
    status = "WATCHLIST";
  } else if (oosTradeCount >= rules.minOOStrades) {
    status = "KANDIDAT_LIVE_MICRO";
  } else {
    status = "KANDIDAT_EDGE";
  }

  const reason = allPassed
    ? `Microcap gate passed. Status: ${status}. Paper trading${status === "KANDIDAT_LIVE_MICRO" ? " ready for live micro" : " active"}.`
    : `Microcap gate FAILED: ${failedChecks.join(", ")}. Pair stays in WATCHLIST. Likuiditas tidak memenuhi syarat — jangan masuk, biaya eksekusi dapat menghapus edge.`;

  return {
    passed: allPassed,
    pair,
    rules,
    checks,
    failedChecks,
    reason,
    status,
  };
}
