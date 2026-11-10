import { NextResponse } from "next/server";
import { ensureCandles, loadCandles, resample, TF_SECONDS, type Timeframe } from "@/lib/trading/candles";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function GET(req: Request) {
  const url = new URL(req.url);
  const pair = url.searchParams.get("pair") || "btc_idr";
  const tf = (url.searchParams.get("tf") || "1m") as Timeframe;
  const limit = parseInt(url.searchParams.get("limit") || "100");
  const doFetch = url.searchParams.get("fetch") === "1";
  try {
    let candles, source = "db";
    if (doFetch) { const res = await ensureCandles(pair, "1m", 30); const tfSec = TF_SECONDS[tf] || 60; candles = resample(res.candles, tfSec).slice(-limit); source = res.source; }
    else { const raw = await loadCandles(pair, "1m", 600); const tfSec = TF_SECONDS[tf] || 60; candles = (tf === "1m" ? raw : resample(raw, tfSec)).slice(-limit); source = raw.length > 0 ? "db" : "empty"; }
    return NextResponse.json({ pair, timeframe: tf, count: candles.length, source, first: candles[0]?.time || null, last: candles[candles.length - 1]?.time || null, candles });
  } catch (e) { return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 }); }
}
