import crypto from "crypto";

// INDODAX API client — public market data + private trading (HMAC-SHA512).
// Docs: https://github.com/indodax/indodax-docs (v2)

const PUBLIC_BASE = "https://indodax.com/api";
const PRIVATE_BASE = "https://indodax.com/tapi";

// ── Public API (no auth) ──

export interface Ticker {
  high: string; low: string; last: string; buy: string; sell: string;
  vol_btc?: string; vol_idr?: string; server_time: number;
}
export interface TickerResponse { ticker: Ticker }
export interface SummariesResponse { server_time: number; tickers: Record<string, Ticker> }
export interface DepthEntry { price: string; amount: string }
export interface DepthResponse { buy: [string, string][]; sell: [string, string][] }

export async function getTicker(pair: string): Promise<Ticker | null> {
  // pair format: "btc_idr" (with underscore)
  try {
    const r = await fetch(`${PUBLIC_BASE}/ticker/${pair}`, { next: { revalidate: 10 } });
    if (!r.ok) return null;
    const d = (await r.json()) as TickerResponse;
    return d.ticker;
  } catch { return null; }
}

export async function getSummaries(): Promise<Record<string, Ticker> | null> {
  try {
    const r = await fetch(`${PUBLIC_BASE}/summaries`, { next: { revalidate: 15 } });
    if (!r.ok) return null;
    const d = (await r.json()) as SummariesResponse;
    return d.tickers;
  } catch { return null; }
}

export async function getDepth(pair: string): Promise<DepthResponse | null> {
  // pair format: "btcidr" (NO underscore for depth!)
  try {
    const r = await fetch(`${PUBLIC_BASE}/depth/${pair}`, { next: { revalidate: 5 } });
    if (!r.ok) return null;
    return (await r.json()) as DepthResponse;
  } catch { return null; }
}

export interface RawTrade {
  tid: string; type: "buy" | "sell"; price: string; amount: string; date: string;
}

export async function getTrades(pair: string): Promise<RawTrade[]> {
  const p = pair.includes("_") ? pair.replace("_", "") : pair;
  try {
    const r = await fetch(`${PUBLIC_BASE}/trades/${p}`, { next: { revalidate: 5 } });
    if (!r.ok) return [];
    const d = await r.json();
    return Array.isArray(d) ? (d as RawTrade[]) : [];
  } catch { return []; }
}

// ── Private API (HMAC-SHA512 signed) ──

export interface IndodaxConfig {
  apiKey: string;
  secretKey: string;
}

function sign(body: string, secret: string): string {
  return crypto.createHmac("sha512", secret).update(body).digest("hex");
}

export async function privateRequest<T = unknown>(
  method: string,
  params: Record<string, string | number> = {},
  config: IndodaxConfig
): Promise<T> {
  const nonce = Date.now().toString();
  const allParams: Record<string, string> = {
    method,
    nonce,
    ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
  };
  const body = new URLSearchParams(allParams).toString();
  const signature = sign(body, config.secretKey);

  const r = await fetch(PRIVATE_BASE, {
    method: "POST",
    headers: {
      Key: config.apiKey,
      Sign: signature,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  const text = await r.text();
  try {
    const json = JSON.parse(text);
    if (json.error) throw new Error(json.error);
    return json as T;
  } catch (e) {
    if (e instanceof Error && e.message !== text) throw e;
    throw new Error(`INDODAX API error: ${text.slice(0, 200)}`);
  }
}

// ── Trading methods ──

export interface AccountBalance {
  success: number;
  return: {
    balance: Record<string, string>;
    server_time: number;
  };
}

export async function getAccountInfo(config: IndodaxConfig): Promise<AccountBalance> {
  return privateRequest<AccountBalance>("getInfo", {}, config);
}

export interface TradeResult {
  success: number;
  return: {
    order_id: string;
    balance: Record<string, string>;
    submit_price: string;
    type: string;
    pair: string;
  };
}

export async function placeOrder(
  config: IndodaxConfig,
  opts: { pair: string; type: "buy" | "sell"; price: number; amount: number }
): Promise<TradeResult> {
  // pair format for trading: "btc_idr" (with underscore)
  return privateRequest<TradeResult>("trade", {
    pair: opts.pair,
    type: opts.type,
    price: opts.price,
    [opts.type === "buy" ? "idr" : "coin"]: opts.amount,
  }, config);
}

export async function cancelOrder(config: IndodaxConfig, orderId: string, pair: string) {
  return privateRequest("cancelOrder", { order_id: orderId, pair }, config);
}

export async function getOrderHistory(config: IndodaxConfig, pair: string, count = 10) {
  return privateRequest("orderHistory", { pair, count }, config);
}

// ── Helpers ──

export const POPULAR_PAIRS = [
  "btc_idr", "eth_idr", "bnb_idr", "sol_idr", "xrp_idr",
  "ada_idr", "doge_idr", "matic_idr", "avax_idr", "dot_idr",
];

export function pairToDepthFormat(pair: string): string {
  return pair.replace("_", ""); // btc_idr → btcidr
}

export function formatIDR(value: string | number): string {
  const n = typeof value === "string" ? parseFloat(value) : value;
  return new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 }).format(n);
}
