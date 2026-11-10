import { NextResponse } from "next/server";
import { sendTelegram } from "@/lib/telegram";

export const runtime = "nodejs";
export const maxDuration = 15;

// POST /api/bot/test-telegram  body: { token, chatId }
export async function POST(req: Request) {
  try {
    const body = await req.json();
    if (!body.token || !body.chatId) return NextResponse.json({ ok: false, error: "token + chatId required" });
    const ok = await sendTelegram(body.token, body.chatId, "🤖 INDODAX Bot — Telegram notifications connected ✓\n\nYou will receive alerts when the bot opens/closes positions.");
    return NextResponse.json({ ok, error: ok ? null : "Send failed — check token & chatId" });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "Failed" });
  }
}
