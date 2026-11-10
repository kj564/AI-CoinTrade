/**
 * Build the bee-vs-pesticide video following the REAL vox-explainer-skill
 * pipeline (learned from github.com/CK42BB/vox-explainer-skill):
 *   Stage 1 Script  — Vox arc (cold-open → context → escalation → complication → reframe)
 *   Stage 2 VO      — generate narration PER BEAT, MEASURE duration → master clock
 *   Stage 3 Keyframes — Vox style suffix (paper collage grammar) + style anchor pattern
 * Beat duration = measured VO duration + 0.5s breathing room (VO-first timing).
 *
 * Usage: bun run scripts/build-vox-bee.ts
 */
import fs from "fs";
import path from "path";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";

// The Vox style suffix (verbatim from references/vox-style-guide.md), adapted.
const ACCENT = "#C7634A"; // single accent color carried through every frame
const STYLE_SUFFIX =
  `Editorial mixed-media collage style: illustrated paper cutouts with white sticker borders ` +
  `(3-6px edge) and soft drop shadows layered on textured aged-cream paper, halftone dot accents, ` +
  `washi tape strips at corners, one or two flat geometric shapes in ${ACCENT}, limited palette of ` +
  `cream, charcoal ink, and ${ACCENT}, bold condensed editorial typography, generous margins, ` +
  `16:9 composition with clear focal hierarchy, flat graphic lighting, print-media texture. ` +
  `NOT photorealistic, no 3D rendering, no gradients.`;

interface Beat {
  id: number;
  narration: string;   // written as SPOKEN (words for numbers, no em dashes)
  visual: string;      // subject + arrangement + focal point
  captionText?: string; // on-frame kinetic typography (key stat/term), <5 words
  motion: string;       // subtle 2D motion vocabulary (no 3D)
}

// Stage 1 — Script: the Vox arc (cold-open → context → escalation → complication → reframe).
// ~25-35 words/beat, Indonesian, spoken-style.
const BEATS: Beat[] = [
  {
    id: 1,
    narration: "Satu dari tiga suapan makanan kamu, berhutang nyawa pada satu makhluk kecil. Lebah.",
    visual: "A cute bee as a paper cutout with white sticker border, centered, flanked by two flower cutouts, aged-cream paper background, a large bold number '1/3' as a flat geometric accent in the accent color upper-right.",
    captionText: "1 dari 3",
    motion: "slow 2D push-in on the bee, flower cutouts drift slightly, one halftone dot field shimmers gently",
  },
  {
    id: 2,
    narration: "Untuk faham kenapa, kita kena tengok macam mana lebah kerja. Mereka terbang bunga ke bunga, memindahkan debu yang jadikan buah dan sayur wujud.",
    visual: "A bee paper cutout flying between three flower cutouts arranged left-to-right, tiny pollen-dot particles as halftone accents, a soft arrow connecting flowers, cream paper panel.",
    captionText: null,
    motion: "bee cutout slides left-to-right and settles on each flower, pollen dots shimmer, slow 2D parallax between bee layer and flower layer",
  },
  {
    id: 3,
    narration: "Tapi kini, ladang moden sembur racun perosak. Awan kimia abu-abu menutup medan. Lebah mula hilang arah.",
    visual: "A grey chemical-spray cloud cutout drifting over a field of drooping flower cutouts, the bee cutout tumbling off-balance, washi tape strip reading a warning symbol, palette shifts cooler but cream base remains.",
    captionText: "Ancaman: Pestisida",
    motion: "grey cloud cutout drifts laterally left, flower cutouts wilt slightly (one settling element), slow 2D camera hold",
  },
  {
    id: 4,
    narration: "Racun jenis neonicotinoid rosakkan sistem saraf lebah. Mereka sesat, tak boleh pulang ke sarang, dan koloni mula runtuh.",
    visual: "An anatomical bee cutout with a glowing red brain/nervous-system overlay as a flat geometric accent, a small bar-chart cutout showing declining colonies 2015 to 2021, halftone dot shadow, charcoal ink lines.",
    captionText: "Neonicotinoid",
    motion: "slow 2D push-in on the bee brain detail, bar-chart bars grow subtly, one element only",
  },
  {
    id: 5,
    narration: "Tapi ada jalan. Petani boleh beralih ke kaedah organik dan semula jadi yang ramah serangga penyerbuk.",
    visual: "A sunrise as a flat geometric circle in warm yellow, a lush organic flower-garden collage with a healthy bee cutout flying, a small leaf stamp seal motif, accent color returns warm, cream paper panel.",
    captionText: "Solusi: Organik",
    motion: "sun circle rises slightly and settles, flower cutouts bloom open one by one, bee cutout drifts gently",
  },
  {
    id: 6,
    narration: "Sebab lebah bukan sekadar serangga. Mereka penjaga masa depan makanan kita. Jaga lebah, jaga masa depan.",
    visual: "A smiling bee cutout flying toward the viewer holding a small badge cutout reading 'Save The Bees' in bold condensed type, clean cream background, one accent-color triangle, generous margins.",
    captionText: "Jaga Lebah, Jaga Masa Depan",
    motion: "slow 2D push-in on the bee, badge cutout settles, subtle texture shimmer, flat paper only",
  },
];

async function postJSON(url: string, body: unknown): Promise<any> {
  const res = await fetch(BASE + url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new Error(`${url} -> ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : {};
}

/** Measure a WAV file's duration in seconds (Stage 2: VO-first master clock). */
function wavDuration(file: string): number {
  try {
    const buf = fs.readFileSync(file);
    // find the "data" subchunk
    let off = 12;
    while (off < buf.length - 8) {
      const id = buf.slice(off, off + 4).toString("ascii");
      const size = buf.readUInt32LE(off + 4);
      if (id === "data") {
        const sampleRate = buf.readUInt32LE(24);
        const channels = buf.readUInt16LE(22);
        const bits = buf.readUInt16LE(34);
        return size / (sampleRate * channels * (bits / 8));
      }
      off += 8 + size;
    }
  } catch { /* ignore */ }
  // fallback: estimate from word count at 150 wpm
  return 0;
}

async function main() {
  console.log("VOX-EXPLAINER-SKILL pipeline: bee vs pesticide (Indonesian, 60s)");
  const start = Date.now();
  const ASSETS = path.join(process.cwd(), "public", "story-assets");

  // ---- Stage 2: Voiceover FIRST (generate + measure → master clock) ----
  console.log("\n[Stage 2] Voiceover (VO-first timing)");
  const voDurations: number[] = [];
  const audioUrls: string[] = [];
  for (const b of BEATS) {
    const data = await postJSON("/api/generate-narration", { text: b.narration, voice: "tongtong", sceneId: `vox-beat-${b.id}` });
    audioUrls.push(data.audioUrl);
    // measure the generated WAV
    const localFile = path.join(ASSETS, path.basename(data.audioUrl));
    let dur = wavDuration(localFile);
    if (!dur) dur = (b.narration.split(/\s+/).length / 150) * 60; // fallback 150 wpm
    const beatDur = dur + 0.5; // +0.5s breathing room (VO-first)
    voDurations.push(beatDur);
    console.log(`  beat ${b.id}: VO ${dur.toFixed(2)}s → beat ${beatDur.toFixed(2)}s`);
  }
  const total = voDurations.reduce((a, b) => a + b, 0);
  console.log(`  total: ${total.toFixed(1)}s (VO-driven)`);

  // ---- Stage 3: Keyframes (style anchor + Vox style suffix) ----
  console.log("\n[Stage 3] Keyframes (style anchor pattern + Vox style suffix)");
  const imageUrl: string[] = [];
  // anchor = beat 1; remaining beats inherit the style via the SAME suffix
  // (reference-image editing not available in this API, so consistency comes
  //  from the locked style suffix + accent color — the anchor is beat 1)
  for (let i = 0; i < BEATS.length; i++) {
    const b = BEATS[i];
    const cap = b.captionText ? ` Large title text reading '${b.captionText}' in bold condensed type, top-right panel.` : " No text in image.";
    const prompt = `${b.visual}. Composition: ${b.visual}. ${cap} ${STYLE_SUFFIX}`;
    const data = await postJSON("/api/generate-scene", { visualPrompt: prompt, sceneId: `vox-frame-${b.id}` });
    imageUrl.push(data.imageUrl);
    console.log(`  frame ${b.id}: ${b.captionText ?? "(no caption)"}`);
  }

  // ---- Save bundle (VO-driven durations) ----
  const scenes = BEATS.map((b, i) => ({
    id: `vox-beat-${b.id}`,
    index: i,
    title: b.captionText ?? `Beat ${b.id}`,
    narration: b.narration,
    visualPrompt: b.visual,
    imageUrl: imageUrl[i],
    audioUrl: audioUrls[i],
    durationSec: Math.round(voDurations[i] * 10) / 10, // VO-first master clock
    mood: ["joyful", "context", "tense", "sad", "hopeful", "hopeful"][i] ?? "warm",
    palette: ["#f5efe0", "#f5efe0", "#9aa0a6", "#4b5563", "#f5efe0", "#fde68a"],
    props: [],
    fromColor: ["#f5efe0", "#f5efe0", "#9aa0a6", "#4b5563", "#f5efe0", "#fde68a"][i] ?? "#f5efe0",
    toColor: ["#f5efe0", "#9aa0a6", "#4b5563", "#f5efe0", "#fde68a", "#fde68a"][i] ?? "#f5efe0",
    overlayText: b.captionText ?? "",
    motion: b.motion,
  }));

  const bundle = {
    id: "benchmark-bee-pesticide",
    title: "Penyelamat Kecil Kita (Lebah vs Pestisida) — VOX style",
    topic: "Lebah vs Pestisida",
    style: "vox-paper-collage",
    resolution: "1080p",
    voice: "tongtong",
    music: true,
    sceneCount: scenes.length,
    scenes,
    status: "ready",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    benchmark: true,
    compositionKind: "bee-pesticide",
    accentColor: ACCENT,
    voxPipeline: true,
  };
  const out = path.join(process.cwd(), "public", "benchmark", "bee-pesticide.json");
  fs.writeFileSync(out, JSON.stringify(bundle, null, 2));
  console.log(`\n✓ Saved ${out} (${(fs.statSync(out).size / 1024).toFixed(0)} KB) in ${((Date.now() - start) / 1000).toFixed(1)}s`);
  console.log(`  ${scenes.length} beats, ${total.toFixed(1)}s (VO-driven), Vox paper-collage style, accent ${ACCENT}`);
}

main().catch((e) => { console.error("BUILD FAILED:", e); process.exit(1); });
