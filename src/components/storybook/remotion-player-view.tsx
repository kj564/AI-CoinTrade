"use client";
// The storybook video, now rendered as a Remotion composition via <Player>.
// This replaces the old canvas player — the video IS the React DOM composition
// (<StoryboardComposition>: <Sequence> scenes, DOM backdrop, live 3D props),
// driven by the frame clock. Play/pause/seek + narration audio + music bed.

import { useEffect, useRef, useState, useCallback } from "react";
import { Play, Pause, SkipBack, SkipForward, Volume2, VolumeX, Music2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Badge } from "@/components/ui/badge";
import { Player, type PlayerHandle } from "@/remotion/Player";
import { StoryboardComposition } from "@/remotion/StoryboardComposition";
import { BeePesticideComposition } from "@/remotion/BeePesticideComposition";
import { MusicBed } from "@/lib/storybook/music";
import { useStorybook } from "@/lib/storybook/store";
import { cn } from "@/lib/utils";

const PREVIEW_W = 1280;
const PREVIEW_H = 720;
const FPS = 30;

function fmt(t: number): string {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function RemotionPlayerView() {
  const scenes = useStorybook((s) => s.scenes);
  const musicOn = useStorybook((s) => s.music);
  const resolution = useStorybook((s) => s.resolution);
  const curIdx = useStorybook((s) => s.currentSceneIndex);
  const setCurIdx = useStorybook((s) => s.setCurrentSceneIndex);
  const isPlaying = useStorybook((s) => s.isPlaying);
  const setPlaying = useStorybook((s) => s.setIsPlaying);
  const projectId = useStorybook((s) => s.projectId);

  const Comp = projectId === "benchmark-bee-pesticide" ? BeePesticideComposition : StoryboardComposition;

  const playerRef = useRef<PlayerHandle | null>(null);
  const musicRef = useRef<MusicBed | null>(null);
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [frame, setFrame] = useState(0);
  const [scale, setScale] = useState(1);
  const [muted, setMuted] = useState(false);

  const totalFrames = Math.round(scenes.reduce((a, s) => a + s.durationSec, 0) * FPS);
  const totalSec = totalFrames / FPS;

  // fit composition to container width
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => {
      const w = el.clientWidth;
      const s = Math.min(w / PREVIEW_W, (el.clientHeight || 9999) / PREVIEW_H);
      setScale(s);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // music bed
  useEffect(() => {
    const m = new MusicBed();
    musicRef.current = m;
    return () => m.stop();
  }, []);

  const playSceneAudio = useCallback((idx: number) => {
    const sc = scenes[idx];
    const a = audioElRef.current;
    if (!a || !sc || !sc.audioUrl) return;
    if (a.src !== sc.audioUrl) a.src = sc.audioUrl;
    a.currentTime = 0;
    a.muted = muted;
    void a.play().catch(() => {});
  }, [scenes, muted]);

  // detect scene change from the frame
  useEffect(() => {
    if (scenes.length === 0) return;
    const t = frame / FPS;
    let acc = 0; let idx = 0;
    for (let i = 0; i < scenes.length; i++) {
      if (t >= acc && t < acc + scenes[i].durationSec) { idx = i; break; }
      acc += scenes[i].durationSec; idx = i;
    }
    if (idx !== curIdx) {
      setCurIdx(idx);
      playSceneAudio(idx);
    }
  }, [frame, scenes, curIdx, setCurIdx, playSceneAudio]);

  const togglePlay = () => {
    const p = playerRef.current;
    if (!p) return;
    if (isPlaying) {
      p.pause();
      setPlaying(false);
      audioElRef.current?.pause();
      musicRef.current?.stop();
    } else {
      p.play();
      setPlaying(true);
      if (musicOn) { musicRef.current?.start(); musicRef.current?.setVolume(0.2); }
      playSceneAudio(p.getFrame() >= 0 ? curIdx : 0);
    }
  };

  const seek = (f: number) => {
    const p = playerRef.current;
    if (!p) return;
    void p.seekToFrame(f);
    setFrame(f);
    // recompute scene
    const t = f / FPS;
    let acc = 0; let idx = 0;
    for (let i = 0; i < scenes.length; i++) {
      if (t >= acc && t < acc + scenes[i].durationSec) { idx = i; break; }
      acc += scenes[i].durationSec; idx = i;
    }
    if (idx !== curIdx) setCurIdx(idx);
    playSceneAudio(idx);
  };

  const next = () => {
    const p = playerRef.current; if (!p || scenes.length === 0) return;
    const i = Math.min(scenes.length - 1, curIdx + 1);
    const fromFrame = Math.round(scenes.slice(0, i).reduce((a, s) => a + s.durationSec, 0) * FPS) + 1;
    seek(fromFrame);
  };
  const prev = () => {
    const p = playerRef.current; if (!p || scenes.length === 0) return;
    const i = Math.max(0, curIdx - 1);
    const fromFrame = Math.round(scenes.slice(0, i).reduce((a, s) => a + s.durationSec, 0) * FPS) + 1;
    seek(fromFrame);
  };

  const toggleMute = () => {
    const m = !muted; setMuted(m);
    if (audioElRef.current) audioElRef.current.muted = m;
  };

  const currentScene = scenes[curIdx];
  const time = frame / FPS;

  if (scenes.length === 0) {
    return <div className="flex items-center justify-center aspect-video rounded-2xl bg-[#fde9c8] text-[#7a5a3a]">No scenes yet.</div>;
  }

  return (
    <div className="flex flex-col gap-3">
      <div ref={containerRef} className="relative w-full overflow-hidden rounded-2xl border-2 border-[#c98b5a]/30 shadow-[0_18px_40px_-18px_rgba(120,70,20,0.5)] bg-[#fde9c8] aspect-video">
        <div style={{ position: "absolute", top: 0, left: 0, width: PREVIEW_W, height: PREVIEW_H, transform: `scale(${scale})`, transformOrigin: "top left" }}>
          <Player
            ref={playerRef}
            component={Comp}
            inputProps={{ scenes }}
            fps={FPS}
            durationInFrames={totalFrames}
            width={PREVIEW_W}
            height={PREVIEW_H}
            compositionId="storybook-preview"
            onFrameUpdate={setFrame}
          />
        </div>
        <div className="pointer-events-none absolute left-3 top-3 flex items-center gap-2">
          <Badge className="bg-[#fff8e7] text-[#7a4a1e] border-[#c98b5a]/40 hover:bg-[#fff8e7]">
            Scene {curIdx + 1} / {scenes.length}
          </Badge>
          {currentScene && (
            <Badge variant="outline" className="bg-[#fff8e7]/80 text-[#7a4a1e] border-[#c98b5a]/40">{currentScene.mood}</Badge>
          )}
        </div>
        <div className="pointer-events-none absolute right-3 top-3 flex items-center gap-2">
          <Badge className="bg-[#5e7a52] text-white border-transparent hover:bg-[#5e7a52]">Remotion RE</Badge>
          <Badge className="bg-[#7a9b6e] text-white border-transparent hover:bg-[#7a9b6e]">{resolution}</Badge>
        </div>
      </div>

      {/* Controls */}
      <div className="flex items-center gap-3 rounded-xl border border-[#c98b5a]/30 bg-[#fff8e7] px-3 py-2">
        <Button size="icon" variant="ghost" onClick={prev} disabled={curIdx <= 0} className="text-[#7a4a1e] hover:bg-[#f4d9b0]">
          <SkipBack className="h-5 w-5" />
        </Button>
        <Button size="icon" onClick={togglePlay} className="bg-[#c7634a] hover:bg-[#b15438] text-white rounded-full h-11 w-11">
          {isPlaying ? <Pause className="h-5 w-5" /> : <Play className="h-5 w-5 ml-0.5" />}
        </Button>
        <Button size="icon" variant="ghost" onClick={next} disabled={curIdx >= scenes.length - 1} className="text-[#7a4a1e] hover:bg-[#f4d9b0]">
          <SkipForward className="h-5 w-5" />
        </Button>
        <span className="text-xs font-mono text-[#7a4a1e] tabular-nums w-12">{fmt(time)}</span>
        <Slider value={[frame]} max={totalFrames || 1} step={1} onValueChange={(v) => seek(v[0])} className="flex-1" />
        <span className="text-xs font-mono text-[#7a4a1e] tabular-nums w-12 text-right">{fmt(totalSec)}</span>
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
