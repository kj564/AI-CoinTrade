import { NextRequest, NextResponse } from "next/server";
import { placeOrder, type IndodaxConfig } from "@/lib/indodax";

export const runtime = "nodejs";
export const maxDuration = 15;

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { apiKey, secretKey, pair, type, price, amount } = body;
    if (!apiKey || !secretKey) return NextResponse.json({ error: "API key + secret required" }, { status: 400 });
    if (!pair || !type || !price || !amount) return NextResponse.json({ error: "pair, type, price, amount required" }, { status: 400 });

    const config: IndodaxConfig = { apiKey, secretKey };
    const result = await placeOrder(config, { pair, type, price: Number(price), amount: Number(amount) });
    return NextResponse.json({ success: true, order: result.return });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Order failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
