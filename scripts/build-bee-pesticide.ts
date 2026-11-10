/**
 * Build the "Penyelamat Kecil Kita (Lebah vs Pestisida)" 60s video bundle.
 * Generates per-section narration (Indonesian TTS), illustrations (minimalist
 * bright), and the bee 3D prop (polyfork). Saves a Remotion bundle to
 * public/benchmark/bee-pesticide.json.
 *
 * Usage: bun run scripts/build-bee-pesticide.ts
 */
import fs from "fs";
import path from "path";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";

interface Section {
  id: string;
  title: string;
  durationSec: number;
  mood: string;
  palette: string[];
  fromColor: string;
  toColor: string;
  overlayText: string;
  overlaySub?: string;
  vo: string;
  visualPrompt: string;
}

const SECTIONS: Section[] = [
  {
    id: "bee-sec-1",
    title: "Peran Lebah",
    durationSec: 10,
    mood: "joyful",
    palette: ["#E8B547", "#7fae6e", "#1a1a1a"],
    fromColor: "#7fae6e",
    toColor: "#9aa0a6",
    overlayText: "1 dari 3 makanan kita bergantung pada LEBAH.",
    vo: "Tahukah kamu? Setiap kali kamu makan buah atau sayur, ada jasa makhluk kecil ini. Lebah adalah pahlawan penyerbukan terbesar di planet kita.",
    visualPrompt: "Minimalist bright illustration of a cute cartoon bee flying between colorful flowers in a fresh green garden, glowing golden pollen particles, flat vector design, yellow green black palette",
  },
  {
    id: "bee-sec-2",
    title: "Datangnya Ancaman",
    durationSec: 15,
    mood: "tense",
    palette: ["#6b7280", "#9aa0a6", "#1a1a1a"],
    fromColor: "#9aa0a6",
    toColor: "#4b5563",
    overlayText: "Ancaman Nyata: Pestisida Kimia",
    vo: "Namun sekarang, rumah mereka tidak lagi aman. Penggunaan pestisida kimia berlebih di pertanian modern menjadi racun tak terlihat bagi mereka.",
    visualPrompt: "Minimalist illustration of a dark grey pesticide chemical spray cloud drifting over a wilted field, muted cold tones, flat vector design",
  },
  {
    id: "bee-sec-3",
    title: "Efek Neonicotinoid",
    durationSec: 15,
    mood: "sad",
    palette: ["#4b5563", "#c7634a", "#1a1a1a"],
    fromColor: "#4b5563",
    toColor: "#7fae6e",
    overlayText: "Kehilangan Arah & Sistem Imun Lemah",
    vo: "Racun tertentu seperti neonicotinoid merusak sistem saraf lebah. Mereka kehilangan arah untuk pulang ke sarang, menjadi cepat sakit, dan akhirnya koloni mereka hancur.",
    visualPrompt: "Minimalist diagram of a bee with a glowing red brain and nervous system, dark background, scientific flat vector design",
  },
  {
    id: "bee-sec-4",
    title: "Solusi: Pertanian Organik",
    durationSec: 15,
    mood: "hopeful",
    palette: ["#E8B547", "#7fae6e", "#f2b233"],
    fromColor: "#7fae6e",
    toColor: "#fde68a",
    overlayText: "Gunakan Pestisida Alami!",
    overlaySub: "Pertanian Alami / Organik",
    vo: "Kabar baiknya, kita bisa berubah. Petani bisa beralih ke pestisida alami atau metode organik yang ramah terhadap serangga penyerbuk.",
    visualPrompt: "Minimalist bright illustration of a sunrise over a lush organic flower garden with a healthy bee, warm golden light, flat vector design",
  },
  {
    id: "bee-sec-5",
    title: "Call to Action",
    durationSec: 5,
    mood: "hopeful",
    palette: ["#fde68a", "#E8B547", "#1a1a1a"],
    fromColor: "#fde68a",
    toColor: "#fde68a",
    overlayText: "Jaga Lebah, Jaga Masa Depan.",
    overlaySub: "Share video ini!",
    vo: "Mari jaga lebah kita, demi menjaga masa depan pangan kita!",
    visualPrompt: "Minimalist illustration of a smiling cute bee flying toward the viewer holding a Save The Bees badge, clean bright yellow background, flat vector design",
  },
];

const STYLE = "minimalist flat vector illustration, bright clean colors, yellow green black palette, simple shapes, no photorealism, no text in image";

async function postJSON(url: string, body: unknown): Promise<any> {
  const res = await fetch(BASE + url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new Error(`${url} -> ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : {};
}

async function main() {
  console.log("Building: Penyelamat Kecil Kita (Lebah vs Pestisida) — 60s");
  const start = Date.now();

  // bee 3D prop (polyfork)
  console.log("[prop] honeybee…");
  const beeProp = await postJSON("/api/prop-sprite", { name: "honeybee", propId: "bee-hero", emoji: "🐝" });
  const beeModuleUrl = beeProp.moduleUrl;
  const beeProgramUrl = beeProp.programUrl;
  const beeSource = beeProp.propSource;
  console.log("  bee:", beeSource, beeModuleUrl || beeProgramUrl);

  const sections = [];
  for (let i = 0; i < SECTIONS.length; i++) {
    const s = SECTIONS[i];
    console.log(`\nSection ${i + 1}: ${s.title} (${s.durationSec}s)`);
    const [imageUrl, audioUrl] = await Promise.all([
      (async () => { console.log("  illustration…"); const d = await postJSON("/api/generate-scene", { visualPrompt: `${s.visualPrompt}, ${STYLE}`, sceneId: s.id }); return d.imageUrl; })(),
      (async () => { console.log("  narration…"); const d = await postJSON("/api/generate-narration", { text: s.vo, voice: "tongtong", sceneId: s.id }); return d.audioUrl; })(),
    ]);
    sections.push({
      id: s.id,
      index: i,
      title: s.title,
      narration: s.vo,
      visualPrompt: s.visualPrompt,
      imageUrl,
      audioUrl,
      durationSec: s.durationSec,
      mood: s.mood,
      palette: s.palette,
      props: [{
        id: `prop-${i}-0`,
        name: "honeybee",
        emoji: "🐝",
        placement: i === 4 ? "center" : "right",
        entrance: "pop",
        delay: 200,
        propSource: beeSource,
        moduleUrl: beeModuleUrl,
        programUrl: beeProgramUrl,
        polyforkAssetId: beeProp.assetId,
      }],
      // BeePesticideComposition fields:
      fromColor: s.fromColor,
      toColor: s.toColor,
      overlayText: s.overlayText,
      overlaySub: s.overlaySub,
    });
  }

  const bundle = {
    id: "benchmark-bee-pesticide",
    title: "Penyelamat Kecil Kita (Lebah vs Pestisida)",
    topic: "Lebah vs Pestisida — 60s educational short",
    style: "paper-cutout",
    resolution: "1080p",
    voice: "tongtong",
    music: true,
    sceneCount: sections.length,
    scenes: sections,
    status: "ready",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    benchmark: true,
    compositionKind: "bee-pesticide",
  };

  const out = path.join(process.cwd(), "public", "benchmark", "bee-pesticide.json");
  fs.writeFileSync(out, JSON.stringify(bundle, null, 2));
  console.log(`\n✓ Saved ${out} (${(fs.statSync(out).size / 1024).toFixed(0)} KB) in ${((Date.now() - start) / 1000).toFixed(1)}s`);
  console.log(`  ${sections.length} sections, 60s total, bee prop: ${beeSource}`);
}

main().catch((e) => { console.error("BUILD FAILED:", e); process.exit(1); });
