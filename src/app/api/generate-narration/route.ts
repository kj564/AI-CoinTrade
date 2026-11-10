import { NextRequest, NextResponse } from "next/server";
import ZAI from "z-ai-web-dev-sdk";
import fs from "fs";
import path from "path";
import type { GenerateNarrationRequest, VoiceId } from "@/lib/storybook/types";

export const runtime = "nodejs";
export const maxDuration = 60;

const ASSETS_DIR = path.join(process.cwd(), "public", "story-assets");
const VALID_VOICES: VoiceId[] = ["tongtong", "chuichui", "xiaochen", "jam", "kazi", "douji", "luodo"];

function ensureDir() {
  if (!fs.existsSync(ASSETS_DIR)) {
    fs.mkdirSync(ASSETS_DIR, { recursive: true });
  }
}

/** Splits text into <=900 char chunks at sentence boundaries (TTS limit is 1024). */
function splitText(text: string, maxLen = 900): string[] {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= maxLen) return [clean];
  const sentences = clean.match(/[^.!?]+[.!?]+|\S+|\s+$/g) ?? [clean];
  const chunks: string[] = [];
  let cur = "";
  for (const s of sentences) {
    if ((cur + s).length <= maxLen) {
      cur += s;
    } else {
      if (cur) chunks.push(cur.trim());
      cur = s;
    }
  }
  if (cur) chunks.push(cur.trim());
  return chunks.filter(Boolean);
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as GenerateNarrationRequest;
    const text = (body.text ?? "").toString().trim();
    const sceneId = (body.sceneId ?? "scene").toString().replace(/[^a-zA-Z0-9_-]/g, "");
    const voice = (VALID_VOICES.includes(body.voice) ? body.voice : "tongtong") as VoiceId;
    if (!text) {
      return NextResponse.json({ error: "text is required." }, { status: 400 });
    }

    ensureDir();

    const chunks = splitText(text);
    const zai = await ZAI.create();

    const buffers: Buffer[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      let lastErr: unknown = null;
      let ok = false;
      // retry up to 3 times with backoff (the TTS endpoint can rate-limit)
      for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
        try {
          const response = await zai.audio.tts.create({
            input: chunk,
            voice,
            speed: 0.95,
            response_format: "wav",
            stream: false,
          });
          const ab = await response.arrayBuffer();
          buffers.push(Buffer.from(new Uint8Array(ab)));
          ok = true;
        } catch (e) {
          lastErr = e;
          if (attempt < 3) await new Promise((r) => setTimeout(r, 800 * attempt));
        }
      }
      if (!ok) throw lastErr instanceof Error ? lastErr : new Error("Narration failed after retries.");
    }

    const filename = `${sceneId}-${Date.now()}.wav`;
    fs.writeFileSync(path.join(ASSETS_DIR, filename), Buffer.concat(buffers));

    return NextResponse.json({ audioUrl: `/story-assets/${filename}` });
  } catch (err) {
    console.error("[generate-narration] error", err);
    const msg = err instanceof Error ? err.message : "Narration generation failed.";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
