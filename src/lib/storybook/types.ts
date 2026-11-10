// Core types for the Paper-Cutout Storybook video generator

export type Resolution = "1080p" | "2K" | "4K";

export type VoiceId =
  | "tongtong"
  | "chuichui"
  | "xiaochen"
  | "jam"
  | "kazi"
  | "douji"
  | "luodo";

export type EntranceType = "pop" | "grow" | "slide-left" | "slide-right" | "slide-up" | "fade";

export interface SceneProp {
  id: string;
  name: string;       // e.g. "apple tree", "little fox"
  emoji?: string;     // optional visual hint
  placement: "center" | "left" | "right" | "top" | "bottom";
  entrance: EntranceType;
  delay: number;      // ms after scene starts
  spriteUrl?: string;   // transparent cutout sprite (polyfork 3D render or sand3d stand-in)
  spriteAssetId?: string;
  spriteTitle?: string;
  propSource?: "polyfork" | "sand3d" | "emoji";  // where the 3D model came from
  // polyfork parametric 3D: the client loads createAsset() and tunes knobs per scene
  moduleUrl?: string;   // https://polyfork.dev/cdn/{id}.mjs
  paramsUrl?: string;   // https://polyfork.dev/cdn/{id}-params.json
  glbUrl?: string;      // https://polyfork.dev/cdn/{id}-preview.glb
  polyforkAssetId?: string;
  // sand3d: LLM-authored program reverse-engineered on three.js (runs in browser)
  sand3dProgram?: string;
  sand3dFile?: string;     // path to the saved .mjs program under download/sand3d-props/
  programUrl?: string;     // URL to the .mjs program (client renders via the shim)
}

export interface Scene {
  id: string;
  index: number;          // 0-based order
  title: string;          // short scene title
  narration: string;      // voiceover text (also shown as caption)
  visualPrompt: string;   // prompt sent to image generation
  imageUrl?: string;      // image url once generated
  audioUrl?: string;      // narration audio url
  durationSec: number;    // how long this scene plays
  props: SceneProp[];
  mood: string;           // e.g. "curious", "joyful", "calm"
  palette: string[];      // suggested paper colours
}

export interface StorybookProject {
  id: string;
  title: string;
  topic: string;
  script?: string;
  style: string;
  resolution: Resolution;
  voice: VoiceId;
  music: boolean;
  sceneCount: number;
  scenes: Scene[];
  status: "draft" | "planned" | "rendering" | "done";
  createdAt: string;
  updatedAt: string;
}

export interface PlanRequest {
  topic: string;
  script?: string;
  sceneCount: number;
  style?: string;
}

export interface PlanResponse {
  title: string;
  scenes: Scene[];
}

export interface GenerateSceneRequest {
  visualPrompt: string;
  sceneId: string;
}

export interface GenerateSceneResponse {
  imageUrl: string;
}

export interface GenerateNarrationRequest {
  text: string;
  voice: VoiceId;
  sceneId: string;
}

export interface GenerateNarrationResponse {
  audioUrl: string;
}

export const RESOLUTION_PRESETS: Record<Resolution, { width: number; height: number; label: string }> = {
  "1080p": { width: 1920, height: 1080, label: "1080p · Full HD" },
  "2K": { width: 2560, height: 1440, label: "2K · QHD" },
  "4K": { width: 3840, height: 2160, label: "4K · Ultra HD" },
};

export const VOICE_OPTIONS: { value: VoiceId; label: string; description: string }[] = [
  { value: "tongtong", label: "Tongtong", description: "Warm & friendly" },
  { value: "chuichui", label: "Chuichui", description: "Lively & cute" },
  { value: "xiaochen", label: "Xiaochen", description: "Calm & professional" },
  { value: "jam", label: "Jam", description: "Gentle storyteller" },
  { value: "kazi", label: "Kazi", description: "Clear & standard" },
  { value: "douji", label: "Douji", description: "Natural & flowing" },
  { value: "luodo", label: "Luodo", description: "Expressive & rich" },
];
