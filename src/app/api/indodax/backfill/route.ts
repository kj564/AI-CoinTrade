import { NextResponse } from "next/server";
import { backfillCandles, type Timeframe } from "@/lib/trading/candles";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const pair = body.pair || "btc_idr";
    const tf = (body.tf || "1m") as Timeframe;
    const res = await backfillCandles(pair, tf);
    return NextResponse.json({ success: true, pair, timeframe: tf, ...res });
  } catch (e) { return NextResponse.json({ error: e instanceof Error ? e.message : "Backfill failed" }, { status: 500 }); }
}
