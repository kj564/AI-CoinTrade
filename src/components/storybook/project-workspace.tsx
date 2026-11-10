"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { RotateCcw, Scissors, Loader2, Sparkles, Film } from "lucide-react";
import { Button } from "@/components/ui/button";
import { StoryInput } from "./story-input";
import { SceneTimeline } from "./scene-timeline";
import { StorybookPlayerView } from "./storybook-player-view";
import { RemotionPlayerView } from "./remotion-player-view";
import { ExportPanel } from "./export-panel";
import { Hero } from "./hero";
import { useStorybook } from "@/lib/storybook/store";
import type { Resolution, Scene, VoiceId } from "@/lib/storybook/types";
import { StorybookPlayer } from "@/lib/storybook/player-engine";
import { MusicBed } from "@/lib/storybook/music";
import { toast } from "sonner";

export function ProjectWorkspace() {
  const phase = useStorybook((s) => s.phase);
  const scenes = useStorybook((s) => s.scenes);
  const voice = useStorybook((s) => s.voice);
  const title = useStorybook((s) => s.title);
  const setScenes = useStorybook((s) => s.setScenes);
  const updateScene = useStorybook((s) => s.updateScene);
  const setAssetProgress = useStorybook((s) => s.setAssetProgress);
  const setPhase = useStorybook((s) => s.setPhase);
  const setTitle = useStorybook((s) => s.setTitle);
  const reset = useStorybook((s) => s.reset);
  const setTopic = useStorybook((s) => s.setTopic);
  const setSceneCount = useStorybook((s) => s.setSceneCount);
  const setResolution = useStorybook((s) => s.setResolution);
  const setVoice = useStorybook((s) => s.setVoice);
  const setMusic = useStorybook((s) => s.setMusic);
  const setProjectId = useStorybook((s) => s.setProjectId);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const playerRef = useRef<StorybookPlayer | null>(null);
  const musicRef = useRef<MusicBed | null>(null);
  const [benchmarkLoading, setBenchmarkLoading] = useState(false);
  const benchmarkTried = useRef(false);

  // ---- Load the benchmark storybook (the bees & pesticides video) ----
  const loadBenchmark = useCallback(
    async (silent = false) => {
      setBenchmarkLoading(true);
      try {
        const res = await fetch("/benchmark/bee-pesticide.json", { cache: "no-store" });
        if (!res.ok) throw new Error("Benchmark not found.");
        const data = await res.json();
        setProjectId(data.id ?? "benchmark-bees-pesticides");
        setTitle(data.title ?? "Benchmark");
        setTopic(data.topic ?? "");
        setSceneCount(data.scenes?.length ?? 5);
        setResolution((data.resolution ?? "1080p") as Resolution);
        setVoice((data.voice ?? "tongtong") as VoiceId);
        setMusic(!!data.music);
        setScenes(data.scenes as Scene[]);
        setPhase("ready");
        if (!silent) toast.success(`Loaded benchmark: "${data.title}"`);
      } catch (e) {
        if (!silent) toast.error("Benchmark not built yet.");
      } finally {
        setBenchmarkLoading(false);
      }
    },
    [setProjectId, setTitle, setTopic, setSceneCount, setResolution, setVoice, setMusic, setScenes, setPhase]
  );

  // Auto-load the benchmark on first visit so the app opens straight to the video.
  useEffect(() => {
    if (benchmarkTried.current) return;
    benchmarkTried.current = true;
    if (phase === "input") void loadBenchmark(true);
  }, []);

  // ---- Asset generation helpers ----
  const generateImage = useCallback(
    async (scene: Scene) => {
      setAssetProgress(scene.id, { image: "loading" });
      try {
        const res = await fetch("/api/generate-scene", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ visualPrompt: scene.visualPrompt, sceneId: scene.id }),
        });
        if (!res.ok) throw new Error("Image cut failed.");
        const data = await res.json();
        updateScene(scene.id, { imageUrl: data.imageUrl });
        setAssetProgress(scene.id, { image: "done" });
        return data.imageUrl;
      } catch (e) {
        setAssetProgress(scene.id, { image: "error" });
        throw e;
      }
    },
    [setAssetProgress, updateScene]
  );

  const generateAudio = useCallback(
    async (scene: Scene) => {
      setAssetProgress(scene.id, { audio: "loading" });
      try {
        const res = await fetch("/api/generate-narration", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: scene.narration, voice, sceneId: scene.id }),
        });
        if (!res.ok) throw new Error("Narration failed.");
        const data = await res.json();
        updateScene(scene.id, { audioUrl: data.audioUrl });
        setAssetProgress(scene.id, { audio: "done" });
        return data.audioUrl;
      } catch (e) {
        setAssetProgress(scene.id, { audio: "error" });
        throw e;
      }
    },
    [setAssetProgress, updateScene, voice]
  );

  // ---- Polyfork 3D prop sprites ----
  // For every prop, look up a matching low-poly 3D model on polyfork.dev and
  // cut a transparent paper-cutout sprite from its render.
  const generatePropSprites = useCallback(
    async () => {
      // Build the task list from the LATEST store state so we skip props that
      // already have a sprite (avoids duplicate fetches on re-renders).
      const live = useStorybook.getState().scenes;
      const tasks: { sceneId: string; propId: string; name: string; emoji?: string; mood: string; palette: string[] }[] = [];
      for (const sc of live) {
        for (const p of sc.props) {
          if (p.spriteUrl) continue; // already cut
          tasks.push({ sceneId: sc.id, propId: p.id, name: p.name, emoji: p.emoji, mood: sc.mood, palette: sc.palette });
        }
      }
      if (tasks.length === 0) return;
      const inflight = new Set<string>();
      let cursor = 0;
      const concurrency = 2; // sand3d authoring+render is heavier now
      async function worker() {
        while (cursor < tasks.length) {
          const t = tasks[cursor++];
          if (!t || inflight.has(t.propId)) continue;
          inflight.add(t.propId);
          try {
            const res = await fetch("/api/prop-sprite", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                name: t.name,
                emoji: t.emoji,
                propId: t.propId,
                description: `a ${t.name} as a hand-held paper-cutout storybook prop`,
                mood: t.mood,
                palette: t.palette,
              }),
            });
            if (!res.ok) continue;
            const data = await res.json();
            // polyfork: store module/params metadata (client renders tuned 3D).
            // sand3d: store the JS programUrl (client renders via the three.js shim).
            if (data.propSource === "polyfork" || data.propSource === "sand3d" || data.sand3dProgram || data.spriteUrl) {
              const st = useStorybook.getState();
              const scene = st.scenes.find((s) => s.id === t.sceneId);
              if (!scene) continue;
              const newProps = scene.props.map((p) =>
                p.id === t.propId
                  ? {
                      ...p,
                      spriteUrl: data.spriteUrl,
                      spriteAssetId: data.assetId,
                      spriteTitle: data.assetTitle ?? (data.propSource === "sand3d" ? `sand3d: ${t.name}` : undefined),
                      propSource: (data.propSource ?? (data.spriteUrl ? "polyfork" : "emoji")) as "polyfork" | "sand3d" | "emoji",
                      moduleUrl: data.moduleUrl,
                      paramsUrl: data.paramsUrl,
                      glbUrl: data.glbUrl,
                      polyforkAssetId: data.assetId,
                      sand3dProgram: data.sand3dProgram,
                      sand3dFile: data.sand3dFile,
                      programUrl: data.programUrl,
                    }
                  : p
              );
              updateScene(t.sceneId, { props: newProps });
            }
          } catch {
            /* keep emoji fallback for this prop */
          } finally {
            inflight.delete(t.propId);
          }
        }
      }
      await Promise.all(Array.from({ length: concurrency }, worker));
      // 3D rendering is triggered by the scenes effect below (renderPropSprites)
      // once the module/program metadata is stored.
    },
    [updateScene]
  );

  const generateAllAssets = useCallback(
    async (scenesToGen: Scene[]) => {
      // Kick off prop sprites in parallel with scene images (independent, fast).
      const propPromise = generatePropSprites();

      // Scene illustrations (concurrency 2)
      const queue = [...scenesToGen];
      const concurrency = 2;
      async function workerImage() {
        while (queue.length) {
          const sc = queue.shift();
          if (!sc) break;
          try {
            await generateImage(sc);
          } catch {
            // error already recorded; continue
          }
        }
      }
      await Promise.all([
        Promise.all(Array.from({ length: concurrency }, workerImage)),
        propPromise,
      ]);

      // Narration (concurrency 1 — TTS rate-limits)
      const audioQueue = [...scenesToGen];
      async function workerAudio() {
        while (audioQueue.length) {
          const sc = audioQueue.shift();
          if (!sc) break;
          try {
            await generateAudio(sc);
            await new Promise((r) => setTimeout(r, 400));
          } catch {
            // continue
          }
        }
      }
      await Promise.all([workerAudio()]);
    },
    [generateImage, generateAudio, generatePropSprites]
  );

  // ---- When scenes arrive from planning, kick off asset generation ----
  const planningDone = useRef(false);
  useEffect(() => {
    if (phase !== "planning") return;
    if (planningDone.current) return;
    if (scenes.length === 0) return;
    planningDone.current = true;
    setPhase("planned");
    void generateAllAssets(scenes).then(() => {
      const st = useStorybook.getState();
      const allReady = st.scenes.every((s) => s.imageUrl && s.audioUrl);
      if (allReady) {
        st.setPhase("ready");
        toast.success("All scenes cut and narrated — ready to preview!");
      } else {
        st.setPhase("planned");
        toast.warning("Some scenes need a re-cut. Use the Re-cut buttons.");
      }
    });
  }, [phase, scenes, generateAllAssets, setPhase]);

  function handlePlanResult(data: { title: string; scenes: Scene[] }) {
    planningDone.current = false;
    setTitle(data.title);
    setScenes(data.scenes);
    // phase is already "planning" (set by StoryInput); the effect above will
    // pick up scenes + planning and start asset generation.
  }

  function handleRegenerateImage(scene: Scene) {
    void generateImage(scene).catch(() => toast.error("Re-cut failed."));
  }
  function handleRegenerateAudio(scene: Scene) {
    void generateAudio(scene).catch(() => toast.error("Re-narrate failed."));
  }
  function handleRematchProps(scene: Scene) {
    // fully reset this scene's prop metadata so they re-search polyfork/sand3d
    updateScene(scene.id, {
      props: scene.props.map((p) => ({
        ...p,
        spriteUrl: undefined,
        spriteAssetId: undefined,
        spriteTitle: undefined,
        propSource: undefined,
        moduleUrl: undefined,
        paramsUrl: undefined,
        glbUrl: undefined,
        polyforkAssetId: undefined,
        sand3dProgram: undefined,
        sand3dFile: undefined,
      })),
    });
    toast.info("Re-matching props (polyfork → sand3d)…");
    void generatePropSprites().then(() => {
      const st = useStorybook.getState();
      const withSprite = st.scenes.flatMap((s) => s.props).filter((p) => p.spriteUrl || p.moduleUrl).length;
      toast.success(`Props re-matched (${withSprite} resolved).`);
    }).catch(() => toast.error("Re-match failed."));
  }

  function startOver() {
    reset();
    planningDone.current = false;
  }

  const assetProgress = useStorybook((s) => s.assetProgress);
  const totalAssets = scenes.length * 2;
  const doneAssets = scenes.reduce((acc, s) => {
    const p = assetProgress[s.id];
    return acc + ((p?.image === "done" ? 1 : 0) + (p?.audio === "done" ? 1 : 0));
  }, 0);
  const allReady = scenes.length > 0 && scenes.every((s) => s.imageUrl && s.audioUrl);

  return (
    <div className="flex min-h-screen flex-col">
      <main className="flex-1">
        {/* Top bar */}
        <header className="sticky top-0 z-30 border-b border-[#c98b5a]/20 bg-[#fbf3e0]/90 backdrop-blur">
          <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
            <div className="flex items-center gap-2">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#c7634a] text-white shadow-sm">
                <Scissors className="h-5 w-5" />
              </div>
              <div className="leading-tight">
                <div className="text-sm font-extrabold text-[#4a3517]">PaperCuts</div>
                <div className="text-[10px] text-[#9a7a55]">Storybook Film Studio</div>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {phase !== "input" && (
                <>
                  {title && <span className="hidden sm:inline text-xs font-medium text-[#7a4a1e] truncate max-w-[200px]">{title}</span>}
                  <Button size="sm" variant="ghost" onClick={startOver} className="text-[#7a4a1e] hover:bg-[#f4d9b0]">
                    <RotateCcw className="h-4 w-4" /> New
                  </Button>
                </>
              )}
            </div>
          </div>
        </header>

        {/* INPUT phase */}
        {phase === "input" && (
          <div className="mx-auto max-w-6xl px-4">
            {benchmarkLoading ? (
              <div className="flex flex-col items-center gap-4 py-24">
                <Loader2 className="h-10 w-10 animate-spin text-[#c7634a]" />
                <p className="text-sm text-[#7a5a3a]">Opening the benchmark film…</p>
              </div>
            ) : (
              <>
                <Hero />
                {/* Benchmark banner */}
                <div className="mx-auto mb-5 w-full max-w-3xl rounded-xl border-2 border-[#7a9b6e]/40 bg-[#7a9b6e]/10 p-4 flex items-center gap-3">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[#7a9b6e] text-white">
                    <Film className="h-5 w-5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-bold text-[#4a3517]">Penyelamat Kecil Kita — Lebah vs Pestisida</div>
                    <div className="text-xs text-[#5e7a52]">
                      60s educational short · 5 sections · Remotion composition · bee 3D
                    </div>
                  </div>
                  <Button
                    onClick={() => loadBenchmark()}
                    className="bg-[#7a9b6e] hover:bg-[#688a5d] text-white font-bold"
                  >
                    <Film className="h-4 w-4" /> Open the film
                  </Button>
                </div>
                <StoryInput onPlan={handlePlanResult} />
              </>
            )}
          </div>
        )}

        {/* PLANNING phase */}
        {phase === "planning" && (
          <div className="mx-auto flex max-w-6xl flex-col items-center gap-6 px-4 py-20">
            <Loader2 className="h-10 w-10 animate-spin text-[#c7634a]" />
            <div className="text-center">
              <h2 className="text-xl font-bold text-[#4a3517]">The director is planning scenes…</h2>
              <p className="text-sm text-[#7a5a3a]">Breaking your story into collage moments and props.</p>
            </div>
          </div>
        )}

        {/* PLANNED / READY phase: workspace */}
        {(phase === "planned" || phase === "ready" || phase === "exporting") && (
          <div className="mx-auto grid max-w-6xl grid-cols-1 gap-6 px-4 py-6 lg:grid-cols-[1fr_400px]">
            {/* Left: player */}
            <div className="flex flex-col gap-4">
              <RemotionPlayerView />

              {/* Asset progress when still generating */}
              {!allReady && (
                <div className="rounded-xl border border-[#c98b5a]/30 bg-[#fff8e7] p-3">
                  <div className="flex items-center justify-between">
                    <span className="flex items-center gap-2 text-sm font-bold text-[#4a3517]">
                      <Sparkles className="h-4 w-4 text-[#c7634a]" /> Cutting scenes, 3D props & narration
                    </span>
                    <span className="text-xs font-mono text-[#7a4a1e]">{doneAssets}/{totalAssets}</span>
                  </div>
                  <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-[#f4d9b0]">
                    <div
                      className="h-full bg-[#c7634a] transition-all"
                      style={{ width: `${totalAssets ? (doneAssets / totalAssets) * 100 : 0}%` }}
                    />
                  </div>
                  <p className="mt-1.5 text-[11px] text-[#9a7a55]">
                    Each scene gets a paper-cutout illustration, real low-poly 3D props from{" "}
                    <a href="https://polyfork.dev/assets" target="_blank" rel="noreferrer" className="underline text-[#7a9b6e]">polyfork.dev</a>,
                    and a warm voiceover.
                  </p>
                </div>
              )}

              {allReady && (
                <ExportPanel />
              )}
            </div>

            {/* Right: timeline */}
            <div className="lg:sticky lg:top-20 lg:max-h-[calc(100vh-6rem)] lg:overflow-y-auto pr-1">
              <SceneTimeline
                onRegenerateImage={handleRegenerateImage}
                onRegenerateAudio={handleRegenerateAudio}
              />
            </div>
          </div>
        )}
      </main>

      <footer className="mt-auto border-t border-[#c98b5a]/20 bg-[#fbf3e0]">
        <div className="mx-auto max-w-6xl px-4 py-4 text-center text-xs text-[#9a7a55]">
          PaperCuts · turn any story into a paper-cutout storybook film · clay, felt & collage · 1080p / 2K / 4K
        </div>
      </footer>
    </div>
  );
}
