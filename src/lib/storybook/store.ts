"use client";

import { create } from "zustand";
import type { Resolution, Scene, StorybookProject, VoiceId } from "./types";

export type Phase =
  | "input"     // user is composing the topic/script
  | "planning"  // LLM is planning scenes
  | "planned"   // scenes returned, generating assets
  | "ready"     // all assets generated, ready to preview/export
  | "exporting";

export interface AssetProgress {
  image: "idle" | "loading" | "done" | "error";
  audio: "idle" | "loading" | "done" | "error";
}

interface StorybookState {
  phase: Phase;
  topic: string;
  script: string;
  sceneCount: number;
  resolution: Resolution;
  voice: VoiceId;
  music: boolean;

  projectId: string | null;
  title: string;
  scenes: Scene[];
  assetProgress: Record<string, AssetProgress>;
  error: string | null;

  // player
  currentSceneIndex: number;
  isPlaying: boolean;

  // actions
  setTopic: (t: string) => void;
  setScript: (s: string) => void;
  setSceneCount: (n: number) => void;
  setResolution: (r: Resolution) => void;
  setVoice: (v: VoiceId) => void;
  setMusic: (m: boolean) => void;

  setPhase: (p: Phase) => void;
  setProjectId: (id: string | null) => void;
  setTitle: (t: string) => void;
  setScenes: (s: Scene[]) => void;
  updateScene: (id: string, patch: Partial<Scene>) => void;
  reorderScenes: (from: number, to: number) => void;
  setAssetProgress: (id: string, patch: Partial<AssetProgress>) => void;
  setError: (e: string | null) => void;

  setCurrentSceneIndex: (i: number) => void;
  setIsPlaying: (p: boolean) => void;

  reset: () => void;
}

const initialAssetProgress = (): Record<string, AssetProgress> => ({});

export const useStorybook = create<StorybookState>((set) => ({
  phase: "input",
  topic: "",
  script: "",
  sceneCount: 5,
  resolution: "1080p",
  voice: "tongtong",
  music: true,

  projectId: null,
  title: "",
  scenes: [],
  assetProgress: initialAssetProgress(),
  error: null,

  currentSceneIndex: 0,
  isPlaying: false,

  setTopic: (t) => set({ topic: t }),
  setScript: (s) => set({ script: s }),
  setSceneCount: (n) => set({ sceneCount: Math.max(2, Math.min(8, n)) }),
  setResolution: (r) => set({ resolution: r }),
  setVoice: (v) => set({ voice: v }),
  setMusic: (m) => set({ music: m }),

  setPhase: (p) => set({ phase: p }),
  setProjectId: (id) => set({ projectId: id }),
  setTitle: (t) => set({ title: t }),
  setScenes: (s) => {
    const progress: Record<string, AssetProgress> = {};
    for (const sc of s) progress[sc.id] = { image: "idle", audio: "idle" };
    set({ scenes: s, assetProgress: progress, currentSceneIndex: 0 });
  },
  updateScene: (id, patch) =>
    set((st) => ({
      scenes: st.scenes.map((sc) => (sc.id === id ? { ...sc, ...patch } : sc)),
    })),
  reorderScenes: (from, to) =>
    set((st) => {
      const arr = [...st.scenes];
      if (from < 0 || from >= arr.length || to < 0 || to >= arr.length) return {};
      const [moved] = arr.splice(from, 1);
      arr.splice(to, 0, moved);
      const reindexed = arr.map((sc, i) => ({ ...sc, index: i, id: `scene-${i}` }));
      const progress: Record<string, AssetProgress> = {};
      for (const sc of reindexed) {
        progress[sc.id] = st.assetProgress[sc.id] ?? { image: "idle", audio: "idle" };
      }
      return { scenes: reindexed, assetProgress: progress, currentSceneIndex: Math.min(st.currentSceneIndex, reindexed.length - 1) };
    }),
  setAssetProgress: (id, patch) =>
    set((st) => ({
      assetProgress: {
        ...st.assetProgress,
        [id]: { ...(st.assetProgress[id] ?? { image: "idle", audio: "idle" }), ...patch },
      },
    })),
  setError: (e) => set({ error: e }),

  setCurrentSceneIndex: (i) => set({ currentSceneIndex: i }),
  setIsPlaying: (p) => set({ isPlaying: p }),

  reset: () =>
    set({
      phase: "input",
      topic: "",
      script: "",
      sceneCount: 5,
      resolution: "1080p",
      voice: "tongtong",
      music: true,
      projectId: null,
      title: "",
      scenes: [],
      assetProgress: initialAssetProgress(),
      error: null,
      currentSceneIndex: 0,
      isPlaying: false,
    }),
}));

export function totalDuration(scenes: Scene[]): number {
  return scenes.reduce((a, s) => a + (s.durationSec || 0), 0);
}

export function projectToState(p: StorybookProject): Partial<StorybookState> {
  return {
    projectId: p.id,
    title: p.title,
    topic: p.topic,
    script: p.script ?? "",
    sceneCount: p.sceneCount,
    resolution: p.resolution,
    voice: p.voice,
    music: p.music,
    scenes: p.scenes,
    phase: p.scenes.every((s) => s.imageUrl && s.audioUrl) ? "ready" : "planned",
  };
}
