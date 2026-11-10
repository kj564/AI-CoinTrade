import { NextResponse } from "next/server";
import { getAccountInfo, type IndodaxConfig } from "@/lib/indodax";

export const runtime = "nodejs";
export const maxDuration = 15;

export async function POST(req: Request) {
  try {
    const body = await req.json();
    if (!body.apiKey || !body.secretKey) return NextResponse.json({ ok: false, error: "apiKey + secretKey required" });
    const cfg: IndodaxConfig = { apiKey: body.apiKey, secretKey: body.secretKey };
    const res = await getAccountInfo(cfg);
    const balances = res.return?.balance || {};
    const nonZero = Object.entries(balances).filter(([, v]) => parseFloat(v) > 0).map(([k, v]) => ({ coin: k, amount: v }));
    return NextResponse.json({ ok: true, serverTime: res.return?.server_time, balanceCount: Object.keys(balances).length, nonZeroCount: nonZero.length, sample: nonZero.slice(0, 5) });
  } catch (e) { return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "Connection failed" }); }
}
