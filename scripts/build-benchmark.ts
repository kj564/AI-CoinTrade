/**
 * Build the benchmark storybook video: "Bella Bee and the Bitter Mist".
 *
 * Runs against the dev server (http://localhost:3000) and produces a complete,
 * ready-to-render storybook bundle saved to public/benchmark/bees-pesticides.json.
 *
 * The bundle combines:
 *   - polyfork.dev low-poly 3D props (bee, sunflower, hive, ladybug, ...) and
 *   - sand3d-authored custom props (pesticide sprayer) that the user renders locally.
 *
 * Usage: bun run scripts/build-benchmark.ts
 */
import fs from "fs";
import path from "path";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";

interface Prop {
  name: string;
  emoji: string;
  placement: "center" | "left" | "right" | "top" | "bottom";
  entrance: "pop" | "grow" | "slide-left" | "slide-right" | "slide-up" | "fade";
  delay: number;
}
interface ScenePlan {
  title: string;
  narration: string;
  visualPrompt: string;
  durationSec: number;
  mood: string;
  palette: string[];
  props: Prop[];
}

const STYLE =
  "paper-cutout collage illustration, layered green rolling hills, warm round sun, " +
  "soft clay and felt textures, hand-cut paper shapes, child craft storybook art, " +
  "gentle paper shadows, textured paper grain, warm cream background, charming and cozy, " +
  "no text, no watermark, no photorealism";

const SCENES: ScenePlan[] = [
  {
    title: "A Buzzing Garden",
    narration: "Bella the honeybee woke to a golden morning, dancing from sunflower to sunflower, sipping sweet nectar.",
    visualPrompt: "A joyful honeybee flying between tall bright sunflowers in a sunlit paper-cutout garden, warm golden morning light",
    durationSec: 6,
    mood: "joyful",
    palette: ["#E8B547", "#F2B233", "#7A9B6E"],
    props: [
      { name: "honeybee", emoji: "🐝", placement: "center", entrance: "pop", delay: 200 },
      { name: "sunflower", emoji: "🌻", placement: "left", entrance: "grow", delay: 400 },
      { name: "sun", emoji: "☀️", placement: "top", entrance: "fade", delay: 0 },
    ],
  },
  {
    title: "The Sweet Hive",
    narration: "She carried the nectar home to the hive, tucking it into the honeycomb to feed her sisters.",
    visualPrompt: "A cozy wooden beehive with golden honeycomb cells inside, a little bee entering, warm afternoon paper-cutout scene",
    durationSec: 6,
    mood: "cozy",
    palette: ["#E8B547", "#C7634A", "#F2B233"],
    props: [
      { name: "beehive", emoji: "🏠", placement: "center", entrance: "grow", delay: 200 },
      { name: "honeycomb", emoji: "🍯", placement: "left", entrance: "pop", delay: 600 },
      { name: "honeybee", emoji: "🐝", placement: "right", entrance: "slide-left", delay: 1000 },
    ],
  },
  {
    title: "The Bitter Mist",
    narration: "Then a farmer came with a pesticide sprayer, and a bitter mist drifted across the blooms.",
    visualPrompt: "A tense paper-cutout scene of a farmer walking through a field spraying a grey chemical mist over flowers, muted cool tones, droplets drifting",
    durationSec: 7,
    mood: "tense",
    palette: ["#9AA0A6", "#6B7280", "#C7634A"],
    props: [
      { name: "pesticide sprayer", emoji: "🧴", placement: "center", entrance: "pop", delay: 300 },
      { name: "tractor", emoji: "🚜", placement: "left", entrance: "slide-right", delay: 600 },
      { name: "cloud", emoji: "☁️", placement: "top", entrance: "fade", delay: 0 },
    ],
  },
  {
    title: "The Quiet Flowers",
    narration: "The flowers drooped, the nectar dried up, and Bella could find no sweetness anywhere.",
    visualPrompt: "A sad paper-cutout scene of wilted drooping flowers in a quiet field, a small bee searching, muted brown and grey tones, a single fallen petal",
    durationSec: 6,
    mood: "sad",
    palette: ["#8B7355", "#A0522D", "#C7634A"],
    props: [
      { name: "wilted flower", emoji: "🥀", placement: "center", entrance: "grow", delay: 200 },
      { name: "droplet", emoji: "💧", placement: "left", entrance: "slide-up", delay: 800 },
      { name: "honeybee", emoji: "🐝", placement: "right", entrance: "fade", delay: 1200 },
    ],
  },
  {
    title: "A Kinder Garden",
    narration: "The farmer learned, and switched to ladybugs and gentle ways — and the bees came buzzing back.",
    visualPrompt: "A hopeful paper-cutout scene of a bright garden blooming again, ladybugs on leaves, bees returning to sunflowers, a watering can, warm golden light",
    durationSec: 7,
    mood: "hopeful",
    palette: ["#E8B547", "#C7634A", "#7A9B6E"],
    props: [
      { name: "sunflower", emoji: "🌻", placement: "center", entrance: "pop", delay: 200 },
      { name: "ladybug", emoji: "🐞", placement: "left", entrance: "grow", delay: 600 },
      { name: "honeybee", emoji: "🐝", placement: "right", entrance: "slide-left", delay: 1000 },
      { name: "watering can", emoji: "🚿", placement: "top", entrance: "fade", delay: 0 },
    ],
  },
];

async function postJSON(url: string, body: unknown): Promise<any> {
  const res = await fetch(BASE + url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: any;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  if (!res.ok) throw new Error(`${url} -> ${res.status}: ${text.slice(0, 200)}`);
  return json;
}

async function generateSceneArt(scene: ScenePlan, index: number) {
  console.log(`  [scene ${index + 1}] generating illustration…`);
  const data = await postJSON("/api/generate-scene", {
    visualPrompt: `${scene.visualPrompt}, ${STYLE}`,
    sceneId: `bees-scene-${index}`,
  });
  return data.imageUrl as string;
}

async function generateSceneAudio(scene: ScenePlan, index: number) {
  console.log(`  [scene ${index + 1}] generating narration…`);
  const data = await postJSON("/api/generate-narration", {
    text: scene.narration,
    voice: "tongtong",
    sceneId: `bees-scene-${index}`,
  });
  return data.audioUrl as string;
}

async function generatePropSprite(prop: Prop, sceneIndex: number, propIndex: number) {
  const propId = `bees-${sceneIndex}-${propIndex}`;
  console.log(`    [prop] ${prop.name} (${propId})…`);
  try {
    const data = await postJSON("/api/prop-sprite", {
      name: prop.name,
      emoji: prop.emoji,
      propId,
      description: `a ${prop.name} as a hand-held paper-cutout storybook prop`,
    });
    return {
      ...prop,
      spriteUrl: data.spriteUrl ?? undefined,
      spriteAssetId: data.assetId,
      spriteTitle: data.assetTitle,
      propSource: data.propSource ?? (data.spriteUrl ? "polyfork" : "emoji"),
      // polyfork parametric metadata (client renders the tuned 3D on load):
      moduleUrl: data.moduleUrl,
      paramsUrl: data.paramsUrl,
      glbUrl: data.glbUrl,
      polyforkAssetId: data.assetId,
      // sand3d authored program (user renders):
      sand3dProgram: data.sand3dProgram,
      sand3dFile: data.sand3dFile,
    };
  } catch (e) {
    console.warn(`    [prop] ${prop.name} FAILED: ${(e as Error).message}`);
    return { ...prop, propSource: "emoji" as const };
  }
}

async function main() {
  console.log("Building benchmark: Bella Bee and the Bitter Mist");
  console.log(`Server: ${BASE}`);
  const start = Date.now();

  const scenes = [];
  for (let i = 0; i < SCENES.length; i++) {
    const plan = SCENES[i];
    console.log(`\nScene ${i + 1}: ${plan.title}`);
    // art + audio in parallel
    const [imageUrl, audioUrl] = await Promise.all([
      generateSceneArt(plan, i),
      generateSceneAudio(plan, i),
    ]);
    // props — run in parallel
    const propsWithSprites = await Promise.all(
      plan.props.map((p, j) => generatePropSprite(p, i, j))
    );
    scenes.push({
      id: `scene-${i}`,
      index: i,
      title: plan.title,
      narration: plan.narration,
      visualPrompt: `${plan.visualPrompt}, ${STYLE}`,
      imageUrl,
      audioUrl,
      durationSec: plan.durationSec,
      props: propsWithSprites.map((p, j) => ({
        id: `prop-${i}-${j}`,
        name: p.name,
        emoji: p.emoji,
        placement: p.placement,
        entrance: p.entrance,
        delay: p.delay,
        spriteUrl: p.spriteUrl,
        spriteAssetId: p.spriteAssetId,
        spriteTitle: p.spriteTitle,
        propSource: p.propSource,
        moduleUrl: p.moduleUrl,
        paramsUrl: p.paramsUrl,
        glbUrl: p.glbUrl,
        polyforkAssetId: p.polyforkAssetId,
        sand3dProgram: p.sand3dProgram,
        sand3dFile: p.sand3dFile,
      })),
      mood: plan.mood,
      palette: plan.palette,
    });
  }

  // polyfork vs sand3d summary
  const allProps = scenes.flatMap((s) => s.props);
  const poly = allProps.filter((p) => p.propSource === "polyfork").length;
  const sand = allProps.filter((p) => p.propSource === "sand3d").length;
  const emoji = allProps.filter((p) => p.propSource === "emoji").length;
  console.log(`\nProp sources: polyfork=${poly}  sand3d=${sand}  emoji=${emoji}`);

  const bundle = {
    id: "benchmark-bees-pesticides",
    title: "Bella Bee and the Bitter Mist",
    topic: "A bees and pesticides storybook — benchmark",
    script: undefined,
    style: "paper-cutout",
    resolution: "1080p",
    voice: "tongtong",
    music: true,
    sceneCount: scenes.length,
    scenes,
    status: "ready",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    benchmark: true,
    propSummary: { polyfork: poly, sand3d: sand, emoji },
  };

  const out = path.join(process.cwd(), "public", "benchmark", "bees-pesticides.json");
  fs.writeFileSync(out, JSON.stringify(bundle, null, 2));
  const sec = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`\n✓ Benchmark saved to ${out} (${(fs.statSync(out).size / 1024).toFixed(0)} KB) in ${sec}s`);
  console.log(`  ${scenes.length} scenes, ${allProps.length} props (polyfork=${poly}, sand3d=${sand}, emoji=${emoji})`);
}

main().catch((e) => {
  console.error("BUILD FAILED:", e);
  process.exit(1);
});
