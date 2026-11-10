import { NextRequest, NextResponse } from "next/server";
import { authorSand3dProgram } from "@/lib/storybook/sand3d";

export const runtime = "nodejs";
export const maxDuration = 120;

interface PolyAsset {
  id: string;
  title: string;
  class?: string;
  thumbnail: string;
  triangles?: number;
}

/** Search polyfork, with a fallback chain of query terms. Returns null if no confident match. */
async function searchPolyfork(rawName: string): Promise<PolyAsset | null> {
  const clean = rawName.replace(/[^a-zA-Z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  if (!clean) return null;
  const words = clean.split(" ").filter((w) => w.length > 2);
  const queries: string[] = [clean];
  if (words.length > 1) {
    queries.push(words[words.length - 1]);
    queries.push(words[0]);
  }

  let bestOverall: { a: PolyAsset; score: number } | null = null;

  for (const q of queries) {
    try {
      const url = `https://polyfork.dev/api/assets?q=${encodeURIComponent(q)}&per_page=12`;
      const res = await fetch(url, { headers: { accept: "application/json" } });
      if (!res.ok) continue;
      const data = (await res.json()) as { assets?: PolyAsset[] };
      const assets = data.assets ?? [];
      if (assets.length === 0) continue;

      const ql = q.toLowerCase();
      const qWords = ql.split(" ").filter(Boolean);
      const qWordCount = qWords.length;

      for (const a of assets) {
        if (!a.thumbnail) continue;
        const tl = a.title.toLowerCase();
        const tWords = tl.split(/[\s\-_]+/).filter(Boolean);
        const tWordCount = tWords.length;

        let score = 0;
        if (tl === ql) score += 1000;
        const allWordsMatch = qWords.every((qw) => tWords.includes(qw));
        if (allWordsMatch && qWordCount > 0) score += 200;
        if (tWords[0] === qWords[0]) score += 60;
        if (tWordCount === qWordCount) score += 40;
        const extra = Math.max(0, tWordCount - qWordCount);
        score -= extra * 12;
        if (a.class === "prop") score += 5;
        if ((a.triangles ?? 9999) < 2000) score += 5;

        if (!bestOverall || score > bestOverall.score) {
          bestOverall = { a, score };
        }
      }
    } catch {
      /* try next query */
    }
  }

  if (!bestOverall || bestOverall.score < 200) return null;
  const ba = bestOverall.a;
  const btWords = ba.title.toLowerCase().split(/[\s\-_]+/).filter(Boolean);
  const bqWords = clean.toLowerCase().split(" ").filter(Boolean);
  const exact = ba.title.toLowerCase() === clean.toLowerCase();
  const allWords = bqWords.length > 0 && bqWords.every((w) => btWords.includes(w));
  const tightWordCount = btWords.length <= bqWords.length;
  if (!(exact || (allWords && tightWordCount))) return null;
  return ba;
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      name?: string;
      emoji?: string;
      propId?: string;
      description?: string;
    };
    const name = (body.name ?? "").toString().trim();
    const propId = (body.propId ?? "prop").toString().replace(/[^a-zA-Z0-9_-]/g, "");
    if (!name) return NextResponse.json({ spriteUrl: null });

    // --- 1) polyfork: return parametric module metadata (client renders tuned 3D) ---
    const asset = await searchPolyfork(name);
    if (asset) {
      return NextResponse.json({
        propSource: "polyfork",
        assetId: asset.id,
        assetTitle: asset.title,
        assetPage: `https://polyfork.dev/asset/${asset.id}`,
        moduleUrl: `https://polyfork.dev/cdn/${asset.id}.mjs`,
        paramsUrl: `https://polyfork.dev/cdn/${asset.id}-params.json`,
        glbUrl: `https://polyfork.dev/cdn/${asset.id}-preview.glb`,
      });
    }

    // --- 2) sand3d reversed on three.js: author a JS program, client renders it ---
    const s3d = await authorSand3dProgram(
      name,
      (body.description ?? "").toString(),
      propId,
      body.emoji
    ).catch((e) => {
      console.error("[prop-sprite] sand3d authoring failed", e);
      return null;
    });

    if (s3d) {
      return NextResponse.json({
        propSource: "sand3d",
        assetTitle: `sand3d: ${name}`,
        sand3dProgram: s3d.program,
        sand3dFile: s3d.programPath,
        programUrl: s3d.programUrl,
        assetPage: s3d.programPath,
      });
    }

    // --- 3) Last resort: emoji fallback ---
    return NextResponse.json({ spriteUrl: null, searched: name });
  } catch (err) {
    console.error("[prop-sprite] error", err);
    const msg = err instanceof Error ? err.message : "Prop sprite failed.";
    return NextResponse.json({ error: msg, spriteUrl: null }, { status: 500 });
  }
}
