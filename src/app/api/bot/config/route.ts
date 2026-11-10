import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export const runtime = "nodejs";

export async function GET() {
  let cfg = await db.botConfig.findUnique({ where: { id: "singleton" } });
  if (!cfg) cfg = await db.botConfig.create({ data: { id: "singleton" } });
  return NextResponse.json({ ...cfg, secretKey: cfg.secretKey ? "••••••••" : null, apiKey: cfg.apiKey || null, telegramToken: cfg.telegramToken ? "••••••••" : null, telegramChatId: cfg.telegramChatId || null });
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const allowed = ["enabled", "mode", "pair", "strategy", "capitalIdr", "riskPct", "stopLossPct", "takeProfitPct", "intervalSec"];
    const data: Record<string, unknown> = {};
    for (const k of allowed) if (k in body) data[k] = body[k];
    if (typeof body.apiKey === "string" && body.apiKey && !body.apiKey.includes("•")) data.apiKey = body.apiKey;
    if (typeof body.secretKey === "string" && body.secretKey && !body.secretKey.includes("•")) data.secretKey = body.secretKey;
    if (typeof body.telegramToken === "string" && body.telegramToken && !body.telegramToken.includes("•")) data.telegramToken = body.telegramToken;
    if (typeof body.telegramChatId === "string" && body.telegramChatId) data.telegramChatId = body.telegramChatId;
    if (body.enabled === true) {
      const cur = await db.botConfig.findUnique({ where: { id: "singleton" } });
      const willBeLive = (data.mode as string) === "live" || cur?.mode === "live";
      const hasKeys = (data.apiKey as string) || (data.secretKey as string) || cur?.apiKey;
      if (willBeLive && !hasKeys) return NextResponse.json({ error: "Cannot start bot in LIVE mode without API key + secret. Enter keys first." }, { status: 400 });
    }
    const cfg = await db.botConfig.upsert({ where: { id: "singleton" }, create: { id: "singleton", ...data }, update: data });
    return NextResponse.json({ ...cfg, secretKey: cfg.secretKey ? "••••••••" : null, apiKey: cfg.apiKey || null, telegramToken: cfg.telegramToken ? "••••••••" : null, telegramChatId: cfg.telegramChatId || null });
  } catch (e) { return NextResponse.json({ error: e instanceof Error ? e.message : "Config update failed" }, { status: 500 }); }
}
