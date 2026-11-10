"use client";

import { useEffect, useRef, useState } from "react";
import { Play, Pause, SkipBack, SkipForward, Volume2, VolumeX, Music2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Badge } from "@/components/ui/badge";
import { StorybookPlayer } from "@/lib/storybook/player-engine";
import { MusicBed } from "@/lib/storybook/music";
import { useStorybook, totalDuration } from "@/lib/storybook/store";
import type { Scene } from "@/lib/storybook/types";
import { cn } from "@/lib/utils";

function fmt(t: number): string {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function StorybookPlayerView({
  canvasRef,
  onReady,
}: {
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  onReady?: (player: StorybookPlayer | null, music: MusicBed | null) => void;
}) {
  const scenes = useStorybook((s) => s.scenes);
  const musicOn = useStorybook((s) => s.music);
  const resolution = useStorybook((s) => s.resolution);
  const isPlaying = useStorybook((s) => s.isPlaying);
  const setPlaying = useStorybook((s) => s.setIsPlaying);
  const curIdx = useStorybook((s) => s.currentSceneIndex);
  const setCurIdx = useStorybook((s) => s.setCurrentSceneIndex);

  const playerRef = useRef<StorybookPlayer | null>(null);
  const musicRef = useRef<MusicBed | null>(null);
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const onReadyRef = useRef(onReady);
  const handlersRef = useRef<{
    playSceneAudio: (idx: number) => void;
    stopMusic: () => void;
  } | null>(null);
  const [time, setTime] = useState(0);
  const [total, setTotal] = useState(0);
  const [muted, setMuted] = useState(false);

  useEffect(() => {
    onReadyRef.current = onReady;
  }, [onReady]);

  // preview resolution: keep canvas performant (cap at 1280x720 for live preview)
  const PREVIEW_W = 1280;
  const PREVIEW_H = 720;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const p = new StorybookPlayer(canvas, {
      onTick: (t, tot) => {
        setTime(t);
        setTotal(tot);
      },
      onSceneChange: (idx) => {
        setCurIdx(idx);
        handlersRef.current?.playSceneAudio(idx);
      },
      onEnded: () => {
        setPlaying(false);
        handlersRef.current?.stopMusic();
      },
    });
    p.setSize(PREVIEW_W, PREVIEW_H);
    playerRef.current = p;

    const m = new MusicBed();
    musicRef.current = m;

    // Attach the LIVE three.js prop layer (real 3D props composited each frame).
    // Loaded as a public ES module so it shares the import-map three.js with
    // polyfork + the sand3d shim (one three.js instance).
    let layer: { canvas: HTMLCanvasElement; setSize: (w: number, h: number) => void; preload: (s: unknown[]) => Promise<void>; renderFrame: (a: unknown[]) => void; dispose: () => void } | null = null;
    (async () => {
      try {
        const mod = await import(/* webpackIgnore: true */ "/storybook-3d-layer.mjs");
        layer = new mod.Prop3DLayer();
        p.setLayer3D(layer as unknown as import("@/lib/storybook/player-engine").Prop3DLayerLike);
        // preload prop models for current scenes, then seek to a populated frame
        const cur = useStorybook.getState().scenes;
        if (cur.length > 0) {
          await p.load(cur);
          p.seek(0.8);
        }
      } catch (e) {
        console.error("[player] 3D layer load failed", e);
      }
    })();

    onReadyRef.current?.(p, m);

    return () => {
      try { layer?.dispose(); } catch { /* ignore */ }
      p.dispose();
      m.stop();
      onReadyRef.current?.(null, null);
    };
  }, []);

  useEffect(() => {
    const p = playerRef.current;
    if (!p || scenes.length === 0) return;
    let active = true;
    (async () => {
      await p.load(scenes);
      if (!active) return;
      setTotal(p.getTotal());
      // seek slightly past 0 so the first frame shows props (entrance alphas
      // are 0 exactly at t=0, which would render an empty scene on load)
      p.seek(0.8);
    })();
    return () => {
      active = false;
    };
  }, [scenes]);

  const playSceneAudio = (idx: number) => {
    const sc = scenes[idx];
    const a = audioElRef.current;
    if (!a || !sc || !sc.audioUrl) return;
    if (a.src !== sc.audioUrl) a.src = sc.audioUrl;
    a.currentTime = 0;
    a.muted = muted;
    void a.play().catch(() => {});
  };

  const startMusic = () => {
    if (!musicOn) return;
    musicRef.current?.start();
    musicRef.current?.setVolume(0.2);
  };
  const stopMusic = () => {
    musicRef.current?.stop();
  };

  // keep latest handlers in a ref so the mount-effect callbacks stay fresh
  useEffect(() => {
    handlersRef.current = { playSceneAudio, stopMusic };
  });

  function togglePlay() {
    const p = playerRef.current;
    if (!p) return;
    if (p.isPlaying()) {
      p.pause();
      setPlaying(false);
      audioElRef.current?.pause();
      stopMusic();
    } else {
      p.play();
      setPlaying(true);
      if (musicOn) startMusic();
      const idx = p.getCurrentSceneIndex();
      if (idx >= 0) playSceneAudio(idx);
    }
  }

  function seek(value: number) {
    const p = playerRef.current;
    if (!p) return;
    p.seek(value);
    setTime(value);
    const idx = p.getCurrentSceneIndex();
    setCurIdx(idx);
    if (idx >= 0) playSceneAudio(idx);
  }

  function next() {
    const p = playerRef.current;
    if (!p) return;
    const idx = Math.min(scenes.length - 1, p.getCurrentSceneIndex() + 1);
    if (scenes[idx]) {
      p.seek(scenes.slice(0, idx).reduce((a, s) => a + s.durationSec, 0) + 0.001);
      setTime(p.getTime());
    }
  }
  function prev() {
    const p = playerRef.current;
    if (!p) return;
    const idx = Math.max(0, p.getCurrentSceneIndex() - 1);
    if (scenes[idx]) {
      p.seek(scenes.slice(0, idx).reduce((a, s) => a + s.durationSec, 0) + 0.001);
      setTime(p.getTime());
    }
  }

  function toggleMute() {
    const m = !muted;
    setMuted(m);
    if (audioElRef.current) audioElRef.current.muted = m;
  }

  const currentScene: Scene | undefined = scenes[curIdx];

  return (
    <div className="flex flex-col gap-3">
      <div className="relative w-full overflow-hidden rounded-2xl border-2 border-[#c98b5a]/30 shadow-[0_18px_40px_-18px_rgba(120,70,20,0.5)] bg-[#fde9c8]">
        <canvas
          ref={canvasRef}
          width={PREVIEW_W}
          height={PREVIEW_H}
          className="block w-full h-auto aspect-video"
        />
        <div className="pointer-events-none absolute left-3 top-3 flex items-center gap-2">
          <Badge className="bg-[#fff8e7] text-[#7a4a1e] border-[#c98b5a]/40 hover:bg-[#fff8e7]">
            Scene {curIdx + 1} / {scenes.length}
          </Badge>
          {currentScene && (
            <Badge variant="outline" className="bg-[#fff8e7]/80 text-[#7a4a1e] border-[#c98b5a]/40">
              {currentScene.mood}
            </Badge>
          )}
        </div>
        <div className="pointer-events-none absolute right-3 top-3">
          <Badge className="bg-[#7a9b6e] text-white border-transparent hover:bg-[#7a9b6e]">
            {resolution}
          </Badge>
        </div>
      </div>

      {/* Controls */}
      <div className="flex items-center gap-3 rounded-xl border border-[#c98b5a]/30 bg-[#fff8e7] px-3 py-2">
        <Button
          size="icon"
          variant="ghost"
          onClick={prev}
          disabled={curIdx <= 0}
          className="text-[#7a4a1e] hover:bg-[#f4d9b0]"
        >
          <SkipBack className="h-5 w-5" />
        </Button>
        <Button
          size="icon"
          onClick={togglePlay}
          className="bg-[#c7634a] hover:bg-[#b15438] text-white rounded-full h-11 w-11"
        >
          {isPlaying ? <Pause className="h-5 w-5" /> : <Play className="h-5 w-5 ml-0.5" />}
        </Button>
        <Button
          size="icon"
          variant="ghost"
          onClick={next}
          disabled={curIdx >= scenes.length - 1}
          className="text-[#7a4a1e] hover:bg-[#f4d9b0]"
        >
          <SkipForward className="h-5 w-5" />
        </Button>

        <span className="text-xs font-mono text-[#7a4a1e] tabular-nums w-12">{fmt(time)}</span>
        <Slider
          value={[time]}
          max={total || 1}
          step={0.05}
          onValueChange={(v) => seek(v[0])}
          className="flex-1"
        />
        <span className="text-xs font-mono text-[#7a4a1e] tabular-nums w-12 text-right">{fmt(total)}</span>

        <Button size="icon" variant="ghost" onClick={toggleMute} className="text-[#7a4a1e] hover:bg-[#f4d9b0]">
          {muted ? <VolumeX className="h-5 w-5" /> : <Volume2 className="h-5 w-5" />}
        </Button>
        <div className={cn("flex items-center gap-1 text-xs", musicOn ? "text-[#7a9b6e]" : "text-muted-foreground")}>
          <Music2 className="h-4 w-4" />
          <span className="hidden sm:inline">{musicOn ? "Music on" : "No music"}</span>
        </div>
      </div>

      <audio ref={audioElRef} preload="auto" className="hidden" />
    </div>
  );
}
