import { NextRequest, NextResponse } from "next/server";
import ZAI from "z-ai-web-dev-sdk";
import fs from "fs";
import path from "path";
import type { GenerateSceneRequest } from "@/lib/storybook/types";

export const runtime = "nodejs";
export const maxDuration = 60;

const ASSETS_DIR = path.join(process.cwd(), "public", "story-assets");

function ensureDir() {
  if (!fs.existsSync(ASSETS_DIR)) {
    fs.mkdirSync(ASSETS_DIR, { recursive: true });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as GenerateSceneRequest;
    const prompt = (body.visualPrompt ?? "").toString().trim();
    const sceneId = (body.sceneId ?? "scene").toString().replace(/[^a-zA-Z0-9_-]/g, "");
    if (!prompt) {
      return NextResponse.json({ error: "visualPrompt is required." }, { status: 400 });
    }

    ensureDir();

    // 1344x768 landscape fits a 16:9 storybook frame nicely
    const zai = await ZAI.create();
    const response = await zai.images.generations.create({
      prompt,
      size: "1344x768",
    });

    const imageBase64 = response.data?.[0]?.base64;
    if (!imageBase64) {
      return NextResponse.json({ error: "Image generation returned no data." }, { status: 502 });
    }

    const buffer = Buffer.from(imageBase64, "base64");
    const filename = `${sceneId}-${Date.now()}.png`;
    fs.writeFileSync(path.join(ASSETS_DIR, filename), buffer);

    return NextResponse.json({ imageUrl: `/story-assets/${filename}` });
  } catch (err) {
    console.error("[generate-scene] error", err);
    const msg = err instanceof Error ? err.message : "Image generation failed.";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
