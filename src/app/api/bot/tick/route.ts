import { NextResponse } from "next/server";
import { botTick } from "@/lib/trading/bot";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST() {
  try { const result = await botTick(); return NextResponse.json(result); }
  catch (e) { return NextResponse.json({ error: e instanceof Error ? e.message : "Tick failed" }, { status: 500 }); }
}
