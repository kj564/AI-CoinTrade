import { NextRequest, NextResponse } from "next/server";
import ZAI from "z-ai-web-dev-sdk";
import { buildPlanPrompt, decorateVisualPrompt, extractJson, normalizeScenes } from "@/lib/storybook/prompt";
import type { PlanRequest, PlanResponse } from "@/lib/storybook/types";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as PlanRequest;
    const topic = (body.topic ?? "").toString().trim();
    if (!topic) {
      return NextResponse.json({ error: "Topic is required." }, { status: 400 });
    }
    const sceneCount = Math.max(2, Math.min(8, Number(body.sceneCount ?? 5) || 5));

    const { system, user } = buildPlanPrompt({
      topic,
      script: body.script,
      sceneCount,
      style: body.style,
    });

    const zai = await ZAI.create();
    const completion = await zai.chat.completions.create({
      messages: [
        { role: "assistant", content: system },
        { role: "user", content: user },
      ],
      thinking: { type: "disabled" },
    });

    const raw = completion.choices[0]?.message?.content ?? "";
    let payload: unknown;
    try {
      payload = extractJson(raw);
    } catch {
      return NextResponse.json(
        { error: "The director returned an unparseable plan. Please try again.", raw },
        { status: 502 }
      );
    }

    const obj = payload as { title?: string };
    const scenes = normalizeScenes(payload).map((s) => ({
      ...s,
      visualPrompt: decorateVisualPrompt(s.visualPrompt),
    }));

    if (scenes.length === 0) {
      return NextResponse.json({ error: "No scenes were planned. Try a clearer topic." }, { status: 422 });
    }

    const title = (obj.title ?? "Untitled Storybook").toString().slice(0, 80);
    const response: PlanResponse = { title, scenes };
    return NextResponse.json(response);
  } catch (err) {
    console.error("[plan-scenes] error", err);
    const msg = err instanceof Error ? err.message : "Scene planning failed.";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
