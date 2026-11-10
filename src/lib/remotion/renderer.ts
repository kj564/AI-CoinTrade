"use client";

// Reverse-engineered Remotion renderer: deterministic, FRAME-BY-FRAME rendering.
// Instead of capturing the canvas in real time (MediaRecorder, which drops/drifts
// frames), we step every frame exactly: renderFrame(f) -> capture PNG -> encode
// the PNG sequence to MP4 with ffmpeg.wasm at an exact frame rate.
//
// The result is bit-identical on every render and frame-accurate — the core
// property of Remotion's @remotion/renderer.

import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile } from "@ffmpeg/util";
import type { StorybookPlayer } from "@/lib/storybook/player-engine";
import { RESOLUTION_PRESETS, type Resolution, type Scene } from "@/lib/storybook/types";

const CORE_BASE = "https://unpkg.com/@ffmpeg/core@0.12.10/dist/umd";

export interface RenderProgress {
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
  await ff.load({
    coreURL: `${CORE_BASE}/ffmpeg-core.js`,
    wasmURL: `${CORE_BASE}/ffmpeg-core.wasm`,
  });
  _ffmpeg = ff;
  return ff;
}

const pad = (n: number) => String(n).padStart(6, "0");

/**
 * Render the storybook frame-by-frame (deterministic) and encode to MP4.
 * Each frame is rendered exactly via player.renderFrame(f), captured as PNG,
 * then ffmpeg encodes the PNG sequence (+ narration audio) to MP4.
 */
export async function renderStoryboardFrameByFrame(opts: {
  player: StorybookPlayer;
  canvas: HTMLCanvasElement;
  scenes: Scene[];
  resolution: Resolution;
  fps: number;
  onProgress: (p: RenderProgress) => void;
}): Promise<void> {
  const { player, canvas, scenes, resolution, fps, onProgress } = opts;
  try {
    const preset = RESOLUTION_PRESETS[resolution];
    // render at target resolution
    canvas.width = preset.width;
    canvas.height = preset.height;
    player.setSize(preset.width, preset.height);
    player.setFps(fps);
    player.pause();
    // ensure 3D models + scene images are preloaded
    await player.load(scenes);

    const totalFrames = player.getTotalFrames();
    if (totalFrames <= 0) throw new Error("Nothing to render.");

    // 1) load ffmpeg.wasm
    onProgress({ phase: "loading-ffmpeg", ratio: 0.02, message: "Loading encoder…" });
    const ffmpeg = await getFFmpeg();

    // 2) render + capture each frame
    onProgress({ phase: "rendering-frames", ratio: 0.05, message: `Rendering frame 1/${totalFrames}…` });
    const frameFiles: string[] = [];
    for (let f = 0; f < totalFrames; f++) {
      player.renderFrame(f);
      // give the browser a paint tick so the WebGL composite is flushed
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob((b) => resolve(b), "image/png")
      );
      if (blob) {
        const name = `f${pad(f)}.png`;
        await ffmpeg.writeFile(name, await fetchFile(blob));
        frameFiles.push(name);
      }
      if (f % 5 === 0 || f === totalFrames - 1) {
        onProgress({
          phase: "rendering-frames",
          ratio: 0.05 + (f / totalFrames) * 0.6,
          message: `Rendering frame ${f + 1}/${totalFrames}…`,
        });
      }
    }

    // 3) collect narration audio (per scene, delayed by scene start)
    const audioInputs: string[] = [];
    const audioFilters: string[] = [];
    let sceneStartMs = 0;
    let audioIdx = 0;
    for (const sc of scenes) {
      if (sc.audioUrl) {
        try {
          const ablob = await fetch(sc.audioUrl).then((r) => r.blob());
          const aname = `a${audioIdx}.${(sc.audioUrl.split(".").pop() || "wav").toLowerCase()}`;
          await ffmpeg.writeFile(aname, await fetchFile(ablob));
          audioInputs.push(aname);
          audioFilters.push(`[${audioIdx + 1}:a]adelay=${sceneStartMs}|${sceneStartMs},aresample=44100[a${audioIdx}]`);
          audioIdx++;
        } catch (e) {
          console.warn("[render] audio fetch failed for scene", sc.id, e);
        }
      }
      sceneStartMs += Math.round(sc.durationSec * 1000);
    }

    // 4) encode
    onProgress({ phase: audioInputs.length ? "muxing-audio" : "encoding", ratio: 0.68, message: "Encoding MP4…" });
    const args: string[] = ["-framerate", String(fps), "-i", "f%06d.png"];
    for (const a of audioInputs) args.push("-i", a);

    if (audioInputs.length > 0) {
      const mixInputs = audioFilters.map((f) => `[a${audioFilters.indexOf(f)}]`).join("");
      args.push(
        "-filter_complex",
        `${audioFilters.join(";")};${mixInputs}amix=inputs=${audioInputs.length}:duration=longest:dropout_transition=0[aout]`,
        "-map", "0:v", "-map", "[aout]",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast", "-crf", "20",
        "-c:a", "aac", "-b:a", "128k",
        "-shortest", "out.mp4"
      );
    } else {
      args.push("-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast", "-crf", "20", "out.mp4");
    }

    await ffmpeg.exec(args);
    const data = await ffmpeg.readFile("out.mp4");
    const url = URL.createObjectURL(new Blob([data], { type: "video/mp4" }));

    // 5) cleanup ffmpeg FS
    for (const name of frameFiles) { try { await ffmpeg.deleteFile(name); } catch { /* ignore */ } }
    for (const a of audioInputs) { try { await ffmpeg.deleteFile(a); } catch { /* ignore */ } }
    try { await ffmpeg.deleteFile("out.mp4"); } catch { /* ignore */ }

    onProgress({ phase: "done", ratio: 1, message: "MP4 ready", url, ext: "mp4" });
  } catch (err) {
    console.error("[render] frame-by-frame failed", err);
    const msg = err instanceof Error ? err.message : "Render failed.";
    onProgress({ phase: "error", ratio: 0, message: msg });
  }
}
