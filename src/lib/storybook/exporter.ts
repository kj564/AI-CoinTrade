"use client";

import type { Scene, Resolution } from "./types";
import { RESOLUTION_PRESETS } from "./types";
import { StorybookPlayer } from "./player-engine";
import { MusicBed } from "./music";

export interface ExportProgress {
  phase: "preparing" | "recording" | "finalizing" | "done" | "error";
  ratio: number; // 0..1
  message: string;
  url?: string;
  mimeType?: string;
  ext?: string;
}

export interface ExportOptions {
  resolution: Resolution;
  fps: number;
  music: boolean;
  musicVolume?: number;
}

function pickRecorderMime(): { mimeType: string; ext: "mp4" | "webm" } {
  const candidates: { mimeType: string; ext: "mp4" | "webm" }[] = [
    { mimeType: "video/mp4;codecs=avc1.42E01E,mp4a.40.2", ext: "mp4" },
    { mimeType: "video/mp4;codecs=h264,aac", ext: "mp4" },
    { mimeType: "video/mp4", ext: "mp4" },
    { mimeType: "video/webm;codecs=vp9,opus", ext: "webm" },
    { mimeType: "video/webm;codecs=vp8,opus", ext: "webm" },
    { mimeType: "video/webm", ext: "webm" },
  ];
  for (const c of candidates) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(c.mimeType)) {
      return c;
    }
  }
  return { mimeType: "", ext: "webm" };
}

/**
 * Renders the storybook to a downloadable video file by capturing the
 * live canvas + mixed audio (narration + optional music) via MediaRecorder.
 *
 * The video is encoded in real-time (a 30s storybook takes ~30s to export).
 */
export class StoryExporter {
  private player: StorybookPlayer;
  private music: MusicBed;
  private canvas: HTMLCanvasElement;

  constructor(canvas: HTMLCanvasElement, player: StorybookPlayer, music: MusicBed) {
    this.canvas = canvas;
    this.player = player;
    this.music = music;
  }

  async export(scenes: Scene[], opts: ExportOptions, onProgress: (p: ExportProgress) => void): Promise<void> {
    try {
      const preset = RESOLUTION_PRESETS[opts.resolution];
      // Render at target resolution. Note: very high resolutions (4K) may be
      // limited by the browser / GPU; we still attempt and fall back gracefully.
      const W = preset.width;
      const H = preset.height;
      this.canvas.width = W;
      this.canvas.height = H;

      onProgress({ phase: "preparing", ratio: 0, message: `Preparing ${opts.resolution} film…` });

      // Reload scenes into the player at the target size so images decode at full res.
      this.player.setSize(W, H);
      await this.player.load(scenes);
      this.player.seek(0);

      // ---- Audio graph: narration <audio> + music -> MediaStreamDestination ----
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const actx = new AudioCtx();
      const dest = actx.createMediaStreamDestination();

      // narration source: build one <audio> per scene, connect when its scene plays
      const audioEls: HTMLAudioElement[] = [];
      const srcNodes: MediaElementAudioSourceNode[] = [];
      const narrGain = actx.createGain();
      narrGain.gain.value = 1.0;
      narrGain.connect(dest);
      for (const s of scenes) {
        if (!s.audioUrl) continue;
        const a = new Audio(s.audioUrl);
        a.crossOrigin = "anonymous";
        a.preload = "auto";
        try {
          await a.load();
        } catch {
          /* ignore */
        }
        try {
          const src = actx.createMediaElementSource(a);
          src.connect(narrGain);
          srcNodes.push(src);
        } catch {
          // element already connected previously; skip
        }
        audioEls.push(a);
      }

      // music: start the bed and route its output into the export graph
      if (opts.music) {
        await this.music.start();
        this.music.setVolume(opts.musicVolume ?? 0.25);
        // route music bed output: create an extra gain and tap into destination
        // The MusicBed plays through its own context->destination. For export we
        // instead use a standalone generator here so it can be captured.
        this.injectCaptureMusic(actx, dest, opts.musicVolume ?? 0.25);
      }

      // ---- Video stream ----
      const fps = opts.fps;
      const stream = this.canvas.captureStream(fps);
      const audioTracks = dest.stream.getAudioTracks();
      for (const tr of audioTracks) stream.addTrack(tr);

      const { mimeType, ext } = pickRecorderMime();
      const recorder = new MediaRecorder(stream, {
        mimeType: mimeType || undefined,
        videoBitsPerSecond: bitrateFor(opts.resolution),
        audioBitsPerSecond: 128000,
      });

      const chunks: BlobPart[] = [];
      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunks.push(e.data);
      };

      const done = new Promise<void>((resolve) => {
        recorder.onstop = () => resolve();
      });

      recorder.start(100);
      onProgress({ phase: "recording", ratio: 0.02, message: "Rolling film…" });

      // drive playback + narration in real time
      this.player.play();
      const total = this.player.getTotal();
      let sceneIdx = -1;

      const playSceneAudio = (idx: number) => {
        // stop others, play this scene's narration (if any)
        for (let i = 0; i < audioEls.length; i++) {
          const a = audioEls[i];
          if (i === idx) {
            try {
              a.currentTime = 0;
              void a.play().catch(() => {});
            } catch {
              /* ignore */
            }
          } else {
            try {
              a.pause();
            } catch {
              /* ignore */
            }
          }
        }
      };

      // initial scene audio
      const firstIdx = this.player.getCurrentSceneIndex();
      if (firstIdx >= 0) playSceneAudio(firstIdx);
      sceneIdx = firstIdx;

      // hook scene changes
      const prevOnSceneChange = () => {};
      void prevOnSceneChange;
      this.player.setOptions({
        onSceneChange: (idx) => {
          sceneIdx = idx;
          playSceneAudio(idx);
        },
      });

      // progress poll
      const poll = setInterval(() => {
        const t = this.player.getTime();
        const ratio = total > 0 ? clamp01(t / total) : 0;
        onProgress({
          phase: "recording",
          ratio: 0.05 + ratio * 0.9,
          message: `Rendering film… ${Math.floor(ratio * 100)}%`,
        });
        void sceneIdx;
      }, 200);

      // wait for end
      await new Promise<void>((resolve) => {
        this.player.setOptions({ onEnded: () => resolve() });
      });
      clearInterval(poll);

      // small tail so last audio frame flushes
      await wait(400);
      this.player.pause();
      for (const a of audioEls) {
        try {
          a.pause();
        } catch {
          /* ignore */
        }
      }
      this.music.stop();

      onProgress({ phase: "finalizing", ratio: 0.97, message: "Finalizing film…" });
      recorder.stop();
      await done;
      try {
        actx.close();
      } catch {
        /* ignore */
      }

      const blob = new Blob(chunks, { type: mimeType || "video/webm" });
      const url = URL.createObjectURL(blob);
      onProgress({
        phase: "done",
        ratio: 1,
        message: ext === "mp4" ? "Your MP4 film is ready!" : "Your film is ready! (WebM — MP4 not supported in this browser)",
        url,
        mimeType: mimeType || "video/webm",
        ext,
      });

      // restore player to preview size handled by caller
    } catch (err) {
      console.error("[export] error", err);
      const msg = err instanceof Error ? err.message : "Export failed.";
      onProgress({ phase: "error", ratio: 0, message: msg });
    }
  }

  /** Standalone music generator for the export audio graph (capturable). */
  private injectCaptureMusic(actx: AudioContext, dest: MediaStreamAudioDestinationNode, volume: number) {
    const master = actx.createGain();
    master.gain.value = volume;
    master.connect(dest);
    const lp = actx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 1100;
    lp.connect(master);

    const padFreqs = [196.0, 246.94, 293.66, 392.0];
    for (const f of padFreqs) {
      const o1 = actx.createOscillator();
      o1.type = "sawtooth";
      o1.frequency.value = f;
      o1.detune.value = -6;
      const o2 = actx.createOscillator();
      o2.type = "sawtooth";
      o2.frequency.value = f;
      o2.detune.value = 7;
      const g = actx.createGain();
      g.gain.value = 0.08;
      o1.connect(g);
      o2.connect(g);
      g.connect(lp);
      o1.start();
      o2.start();
    }
    const bellFreqs = [587.33, 698.46, 880.0, 1046.5];
    let step = 0;
    setInterval(() => {
      const now = actx.currentTime;
      const f = bellFreqs[step % bellFreqs.length];
      const o = actx.createOscillator();
      o.type = "sine";
      o.frequency.value = f;
      const g = actx.createGain();
      g.gain.setValueAtTime(0.0001, now);
      g.gain.exponentialRampToValueAtTime(0.05, now + 0.05);
      g.gain.exponentialRampToValueAtTime(0.0001, now + 1.6);
      o.connect(g);
      g.connect(master);
      o.start(now);
      o.stop(now + 1.7);
      step++;
    }, 2200);
  }
}

function bitrateFor(res: Resolution): number {
  switch (res) {
    case "4K":
      return 16_000_000;
    case "2K":
      return 8_000_000;
    default:
      return 4_500_000;
  }
}

function wait(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function clamp01(v: number) {
  return Math.max(0, Math.min(1, v));
}
