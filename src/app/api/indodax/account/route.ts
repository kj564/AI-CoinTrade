import { NextRequest, NextResponse } from "next/server";
import { getAccountInfo, placeOrder, type IndodaxConfig } from "@/lib/indodax";

export const runtime = "nodejs";
export const maxDuration = 15;

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { apiKey, secretKey } = body;
    if (!apiKey || !secretKey) return NextResponse.json({ error: "API key + secret required" }, { status: 400 });
    const config: IndodaxConfig = { apiKey, secretKey };

    // get account info
    const info = await getAccountInfo(config);
    return NextResponse.json({ success: true, balances: info.return?.balance || {}, serverTime: info.return?.server_time });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Account fetch failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
