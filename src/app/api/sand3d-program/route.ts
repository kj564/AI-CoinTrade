import { NextRequest, NextResponse } from "next/server";
import { authorSand3dProgram } from "@/lib/storybook/sand3d";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      name?: string;
      description?: string;
      propId?: string;
      emoji?: string;
    };
    const name = (body.name ?? "").toString().trim();
    if (!name) return NextResponse.json({ error: "name is required" }, { status: 400 });

    const res = await authorSand3dProgram(
      name,
      (body.description ?? "").toString(),
      (body.propId ?? "prop").toString(),
      body.emoji
    );
    return NextResponse.json({
      sand3dProgram: res.program,
      sand3dFile: res.programPath,
      renderScript: res.renderScript,
      slug: res.slug,
    });
  } catch (err) {
    console.error("[sand3d-program] error", err);
    const msg = err instanceof Error ? err.message : "sand3d authoring failed.";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
