"use client";
// Reverse-engineered @remotion/renderer — the faithful Remotion render path:
// the composition is React DOM; we screenshot the DOM once per frame and encode
// the PNG sequence to MP4 with ffmpeg.wasm. Deterministic + frame-accurate.
//
// (Real Remotion screenshots via headless Chromium/Puppeteer server-side; here
// we screenshot in-browser via html2canvas — same paradigm, web-native.)

import html2canvas from "html2canvas";
import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile } from "@ffmpeg/util";
import type { PlayerHandle } from "./Player";
import type { Resolution, Scene } from "@/lib/storybook/types";
import { RESOLUTION_PRESETS } from "@/lib/storybook/types";

const CORE_BASE = "https://unpkg.com/@ffmpeg/core@0.12.10/dist/umd";

export interface RemotionRenderProgress {
  phase: "loading-ffmpeg" | "rendering-frames" | "encoding" | "muxing-audio" | "done" | "error";
  ratio: number;
  message: string;
  url?: string;
  ext?: "mp4";
}

let _ffmpeg: FFmpeg | null = null;
async function getFFmpeg(): Promise<FFmpeg> {
  if (_ffmpeg && _ffmpeg.loaded) return _ffmpeg;
  const ff = new FFmpeg();
  await ff.load({ coreURL: `${CORE_BASE}/ffmpeg-core.js`, wasmURL: `${CORE_BASE}/ffmpeg-core.wasm` });
  _ffmpeg = ff;
  return ff;
}

const pad = (n: number) => String(n).padStart(6, "0");
const raf = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

/** Render the composition frame-by-frame: screenshot the DOM per frame -> MP4. */
export async function renderRemotion(opts: {
  playerRef: React.RefObject<PlayerHandle | null>;
  scenes: Scene[];
  resolution: Resolution;
  fps: number;
  onProgress: (p: RemotionRenderProgress) => void;
}): Promise<void> {
  const { playerRef, scenes, resolution, fps, onProgress } = opts;
  try {
    const player = playerRef.current;
    if (!player) throw new Error("Player not ready.");
    const preset = RESOLUTION_PRESETS[resolution];
    const totalFrames = Math.round(scenes.reduce((a, s) => a + s.durationSec, 0) * fps);
    if (totalFrames <= 0) throw new Error("Nothing to render.");
    const root = player.getRoot();
    if (!root) throw new Error("Player root not found.");

    onProgress({ phase: "loading-ffmpeg", ratio: 0.02, message: "Loading encoder…" });
    const ffmpeg = await getFFmpeg();

    onProgress({ phase: "rendering-frames", ratio: 0.05, message: `Rendering frame 1/${totalFrames}…` });
    const frameFiles: string[] = [];

    for (let f = 0; f < totalFrames; f++) {
      await player.seekToFrame(f);
      await raf(); // let React commit + layout effects + paint settle
      // screenshot the React DOM (this is the Remotion render step)
      const canvas = await html2canvas(root, {
        width: preset.width,
        height: preset.height,
        backgroundColor: null,
        scale: 1,
        useCORS: true,
        logging: false,
        allowTaint: false,
      });
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob((b) => resolve(b), "image/png"));
      if (blob) {
        const name = `f${pad(f)}.png`;
        await ffmpeg.writeFile(name, await fetchFile(blob));
        frameFiles.push(name);
      }
      if (f % 3 === 0 || f === totalFrames - 1) {
        onProgress({ phase: "rendering-frames", ratio: 0.05 + (f / totalFrames) * 0.6, message: `Rendering frame ${f + 1}/${totalFrames}…` });
      }
    }

    // narration audio mux (per scene, delayed by scene start)
    const audioInputs: string[] = [];
    const audioFilters: string[] = [];
    let sceneStartMs = 0; let ai = 0;
    for (const sc of scenes) {
      if (sc.audioUrl) {
        try {
          const ablob = await fetch(sc.audioUrl).then((r) => r.blob());
          const aname = `a${ai}.${(sc.audioUrl.split(".").pop() || "wav").toLowerCase()}`;
          await ffmpeg.writeFile(aname, await fetchFile(ablob));
          audioInputs.push(aname);
          audioFilters.push(`[${ai + 1}:a]adelay=${sceneStartMs}|${sceneStartMs},aresample=44100[a${ai}]`);
          ai++;
        } catch (e) { console.warn("[render] audio fetch failed", sc.id, e); }
      }
      sceneStartMs += Math.round(sc.durationSec * 1000);
    }

    onProgress({ phase: audioInputs.length ? "muxing-audio" : "encoding", ratio: 0.68, message: "Encoding MP4…" });
    const args: string[] = ["-framerate", String(fps), "-i", "f%06d.png"];
    for (const a of audioInputs) args.push("-i", a);
    if (audioInputs.length > 0) {
      const mix = audioFilters.map((_, i) => `[a${i}]`).join("");
      args.push(
        "-filter_complex", `${audioFilters.join(";")};${mix}amix=inputs=${audioInputs.length}:duration=longest:dropout_transition=0[aout]`,
        "-map", "0:v", "-map", "[aout]",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast", "-crf", "20",
        "-c:a", "aac", "-b:a", "128k", "-shortest", "out.mp4"
      );
    } else {
      args.push("-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast", "-crf", "20", "out.mp4");
    }
    await ffmpeg.exec(args);
    const data = await ffmpeg.readFile("out.mp4");
    const url = URL.createObjectURL(new Blob([data], { type: "video/mp4" }));

    for (const name of frameFiles) { try { await ffmpeg.deleteFile(name); } catch { /* ignore */ } }
    for (const a of audioInputs) { try { await ffmpeg.deleteFile(a); } catch { /* ignore */ } }
    try { await ffmpeg.deleteFile("out.mp4"); } catch { /* ignore */ }

    onProgress({ phase: "done", ratio: 1, message: "MP4 ready", url, ext: "mp4" });
  } catch (err) {
    console.error("[render] remotion DOM screenshot render failed", err);
    const msg = err instanceof Error ? err.message : "Render failed.";
    onProgress({ phase: "error", ratio: 0, message: msg });
  }
}
