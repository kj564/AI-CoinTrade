import { NextRequest, NextResponse } from "next/server";
import { getZaiConfigStatus, createZaiWithTokenCheck } from "@/lib/zai";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/zai/health
//
// Diagnoses the ZAI SDK config + does a lightweight test call.
// Use this to verify that /etc/.z-ai-config has a valid token and the
// ZAI backend API accepts it.
//
// ?test=1 — also sends a 1-token chat completion to verify end-to-end.
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const doTest = url.searchParams.get("test") === "1";

  const status = await getZaiConfigStatus();

  const result: {
    config: typeof status;
    testCall?: { ok: boolean; durationMs: number; error?: string; model?: string; responsePreview?: string };
    hint: string;
  } = {
    config: status,
    hint: status.valid
      ? "Config looks complete (baseUrl + apiKey + token present). Try ?test=1 to verify end-to-end."
      : status.found
        ? status.hasToken
          ? "Config found but incomplete — check baseUrl/apiKey."
          : "Config found but `token` field is missing or empty. The ZAI SDK skips the X-Token header when token is falsy → API returns 401. The sandbox refreshes /etc/.z-ai-config periodically; wait a moment and retry."
        : "No .z-ai-config file found in project, home, or /etc. The sandbox should create /etc/.z-ai-config automatically.",
  };

  if (!doTest) {
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store, max-age=0" } });
  }

  // Lightweight test call — 1 token, disabled thinking
  const t0 = Date.now();
  try {
    const zai = await createZaiWithTokenCheck();
    const completion = await zai.chat.completions.create({
      messages: [{ role: "user", content: "Say OK." }],
      thinking: { type: "disabled" },
    });
    const content = completion.choices[0]?.message?.content ?? "";
    result.testCall = {
      ok: true,
      durationMs: Date.now() - t0,
      model: completion.model,
      responsePreview: content.slice(0, 50),
    };
  } catch (e) {
    result.testCall = {
      ok: false,
      durationMs: Date.now() - t0,
      error: e instanceof Error ? e.message : String(e),
    };
  }

  return NextResponse.json(result, { headers: { "Cache-Control": "no-store, max-age=0" } });
}
