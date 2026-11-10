import type { PlanRequest, Scene, SceneProp } from "./types";

/**
 * Builds the system + user prompt for the LLM that turns a topic / script
 * into a structured paper-cutout storybook scene plan (JSON).
 */
export function buildPlanPrompt(req: PlanRequest): { system: string; user: string } {
  const n = Math.max(2, Math.min(8, req.sceneCount));

  const system = `You are a storybook director who turns any topic, lesson or brand message into a charming paper-cutout storybook video plan.

Visual world:
- Soft clay-and-felt pieces, layered paper collage, child-craft aesthetic.
- Layered green rolling hills, a warm round sun, hand-cut props.
- Props POP, GROW and SLIDE into place like a child's collage.

You output STRICT JSON only. No markdown fences, no commentary.
The JSON shape:
{
  "title": string,                 // short storybook title (<= 60 chars)
  "scenes": [
    {
      "title": string,             // scene title (<= 40 chars)
      "narration": string,         // voiceover line, 1-2 sentences, warm storybook voice (<= 220 chars)
      "visualPrompt": string,      // a vivid image prompt describing the paper-cutout scene illustration
      "durationSec": number,       // 4-8 seconds
      "mood": string,              // one word mood
      "palette": [string, ...],    // 3-5 paper colour hexes used in scene
      "props": [
        {
          "name": string,          // prop name e.g. "apple tree"
          "emoji": string,         // single emoji hint
          "placement": "center" | "left" | "right" | "top" | "bottom",
          "entrance": "pop" | "grow" | "slide-left" | "slide-right" | "slide-up" | "fade",
          "delay": number          // ms after scene start, 0-2500
        }
      ]
    }
  ]
}

Rules:
- Produce exactly ${n} scenes, numbered by array order.
- Each scene narration, read aloud, should fit comfortably in durationSec.
- visualPrompt MUST describe a paper-cutout collage illustration with clay/felt textures, layered green hills, warm sun, the scene's props, and the palette colours. Do NOT mention text, watermarks or photorealism.
- Keep narration kid-friendly, vivid, and on-message for the topic.
- If a script is provided, follow its beats; otherwise invent a gentle arc (beginning, middle, end).
- The whole story should feel cohesive across scenes.
- PROPS: 2-5 per scene. Each prop name MUST be a CONCRETE physical object or creature that exists in the real world and could be found as a toy or 3D model — e.g. "sunflower", "apple", "rabbit", "watering can", "worm", "cloud", "butterfly", "tree", "bicycle". Avoid abstract or formless names like "patience", "growth", "soil" (use "seed" or "sprout" instead), "rain" (use "rain cloud" or "umbrella"), "wind". Prefer short singular nouns (one or two words).`;

  const user = req.script && req.script.trim().length > 0
    ? `Topic: ${req.topic}\n\nScript / notes to follow:\n"""\n${req.script.trim()}\n"""\n\nTurn this into a ${n}-scene paper-cutout storybook plan as strict JSON.`
    : `Topic: ${req.topic}\n\nInvent a warm ${n}-scene paper-cutout storybook around this topic. Return strict JSON only.`;

  return { system, user };
}

/** Robustly extract a JSON object from an LLM response that may contain fences or prose. */
export function extractJson(raw: string): unknown {
  let text = raw.trim();
  // strip code fences
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();
  // find first { ... last }
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first !== -1 && last !== -1 && last > first) {
    text = text.slice(first, last + 1);
  }
  return JSON.parse(text);
}

interface RawScene {
  title?: string;
  narration?: string;
  visualPrompt?: string;
  durationSec?: number;
  mood?: string;
  palette?: string[];
  props?: RawProp[];
}
interface RawProp {
  name?: string;
  emoji?: string;
  placement?: SceneProp["placement"];
  entrance?: SceneProp["entrance"];
  delay?: number;
}

/** Normalises the LLM payload into typed Scene[], filling ids and defaults. */
export function normalizeScenes(payload: unknown): Scene[] {
  const obj = (payload ?? {}) as { scenes?: RawScene[] };
  const raw = Array.isArray(obj.scenes) ? obj.scenes : [];
  return raw.map((r, i): Scene => {
    const props: SceneProp[] = (Array.isArray(r.props) ? r.props : []).map((p, j): SceneProp => ({
      id: `prop-${i}-${j}`,
      name: (p.name ?? "prop").toString().slice(0, 40),
      emoji: p.emoji?.toString().slice(0, 4),
      placement: p.placement ?? "center",
      entrance: p.entrance ?? "pop",
      delay: Math.max(0, Math.min(3000, Number(p.delay ?? 0) || 0)),
    }));
    const dur = Math.max(3, Math.min(10, Number(r.durationSec ?? 5) || 5));
    return {
      id: `scene-${i}`,
      index: i,
      title: (r.title ?? `Scene ${i + 1}`).toString().slice(0, 60),
      narration: (r.narration ?? "").toString().slice(0, 320),
      visualPrompt: (r.visualPrompt ?? r.title ?? "").toString(),
      durationSec: dur,
      props,
      mood: (r.mood ?? "warm").toString().slice(0, 30),
      palette: Array.isArray(r.palette) ? r.palette.slice(0, 6) : ["#E8B547", "#7A9B6E", "#C7634A"],
    };
  });
}

/** Decorates a base visualPrompt with the consistent paper-cutout house style. */
export function decorateVisualPrompt(prompt: string): string {
  const style =
    "paper-cutout collage illustration, layered green rolling hills, warm round sun, " +
    "soft clay and felt textures, hand-cut paper shapes, child craft storybook art, " +
    "gentle paper shadows, textured paper grain, warm cream background, charming and cozy, " +
    "no text, no watermark, no photorealism";
  return `${prompt}, ${style}`;
}
