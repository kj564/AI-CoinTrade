import { NextResponse } from "next/server";
import { fetchLastNDays, fetchHistoricalCandles, type Timeframe } from "@/lib/trading/ccxt-provider";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const pair = body.pair || "btc_idr";
    const tf = (body.tf || "1h") as Timeframe;
    const days = body.days || 90;
    const res = await fetchLastNDays(pair, tf, days);
    return NextResponse.json({ success: true, ...res, daysRequested: days });
  } catch (e) { return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 }); }
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const pair = url.searchParams.get("pair") || "btc_idr";
  const tf = (url.searchParams.get("tf") || "1h") as Timeframe;
  const days = parseInt(url.searchParams.get("days") || "90");
  try {
    const fromMs = Date.now() - days * 86400 * 1000;
    const res = await fetchHistoricalCandles(pair, tf, fromMs);
    return NextResponse.json({ success: true, ...res });
  } catch (e) { return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 }); }
}
