"use client";

import { useRef, useState } from "react";
import { Download, Film, Loader2, Clapperboard, CheckCircle2, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useStorybook, totalDuration } from "@/lib/storybook/store";
import { RESOLUTION_PRESETS, type Resolution } from "@/lib/storybook/types";
import { Player, type PlayerHandle } from "@/remotion/Player";
import { StoryboardComposition } from "@/remotion/StoryboardComposition";
import { BeePesticideComposition } from "@/remotion/BeePesticideComposition";
import { renderRemotion, type RemotionRenderProgress } from "@/remotion/Renderer";
import { toast } from "sonner";

interface ExportProgress {
  phase: "preparing" | "recording" | "finalizing" | "done" | "error";
  ratio: number;
  message: string;
  url?: string;
  ext?: string;
}

export function ExportPanel() {
  const scenes = useStorybook((s) => s.scenes);
  const music = useStorybook((s) => s.music);
  const setMusic = useStorybook((s) => s.setMusic);
  const storeResolution = useStorybook((s) => s.resolution);
  const setResolution = useStorybook((s) => s.setResolution);
  const setPhase = useStorybook((s) => s.setPhase);
  const title = useStorybook((s) => s.title);
  const projectId = useStorybook((s) => s.projectId);

  const Comp = projectId === "benchmark-bee-pesticide" ? BeePesticideComposition : StorybookComposition;

  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const [fps, setFps] = useState(30);
  const busy = progress?.phase === "preparing" || progress?.phase === "recording" || progress?.phase === "finalizing";
  const downloadUrlRef = useRef<string | null>(null);
  const remotionPlayerRef = useRef<PlayerHandle | null>(null);

  const total = totalDuration(scenes);
  const totalFrames = Math.round(total * fps);
  const preset = RESOLUTION_PRESETS[storeResolution];
  const allReady = scenes.length > 0 && scenes.every((s) => s.imageUrl && s.audioUrl);

  async function startExport() {
    if (scenes.length === 0) { toast.error("Nothing to export yet."); return; }
    if (!allReady) { toast.error("Some scenes are still missing art or narration."); return; }
    const player = remotionPlayerRef.current;
    if (!player) { toast.error("Composition not mounted yet."); return; }
    setPhase("exporting");
    setProgress({ phase: "preparing", ratio: 0, message: "Preparing Remotion composition…" });

    await renderRemotion({
      playerRef: remotionPlayerRef,
      scenes,
      resolution: storeResolution,
      fps,
      onProgress: (p: RemotionRenderProgress) => {
        const phase: ExportProgress["phase"] =
          p.phase === "done" ? "done" :
          p.phase === "error" ? "error" :
          p.phase === "loading-ffmpeg" ? "preparing" :
          p.phase === "rendering-frames" ? "recording" :
          (p.phase === "encoding" || p.phase === "muxing-audio") ? "finalizing" : "preparing";
        setProgress({ phase, ratio: p.ratio, message: p.message, url: p.url, ext: p.ext });
        if (p.phase === "done" && p.url) {
          downloadUrlRef.current = p.url;
          setPhase("ready");
          toast.success("MP4 ready — Remotion frame-by-frame render.");
        }
        if (p.phase === "error") {
          setPhase("ready");
          toast.error(p.message);
        }
      },
    });
  }

  function download() {
    const url = downloadUrlRef.current ?? (progress?.url ?? null);
    if (!url) return;
    const a = document.createElement("a");
    a.href = url;
    const ext = progress?.ext ?? "mp4";
    const safeTitle = title.replace(/[^a-zA-Z0-9-_ ]/g, "").trim().slice(0, 40) || "storybook";
    a.download = `${safeTitle.replace(/\s+/g, "-").toLowerCase()}.${ext}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  return (
    <div className="rounded-2xl border-2 border-[#c98b5a]/30 bg-[#fff8e7] p-4 sm:p-5">
      <div className="flex items-center gap-2">
        <Clapperboard className="h-5 w-5 text-[#c7634a]" />
        <h3 className="text-sm font-bold text-[#4a3517]">Export your film</h3>
        <span className="ml-auto text-[10px] font-medium text-[#5e7a52] bg-[#7a9b6e]/10 px-2 py-0.5 rounded-full border border-[#7a9b6e]/30">
          Remotion RE · frame-by-frame
        </span>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className="flex flex-col gap-2">
          <Label className="text-xs font-bold text-[#4a3517]">Resolution</Label>
          <Select value={storeResolution} onValueChange={(v) => setResolution(v as Resolution)} disabled={busy}>
            <SelectTrigger className="border-[#c98b5a]/40 bg-white/60 text-[#3a2a16]"><SelectValue /></SelectTrigger>
            <SelectContent>
              {(Object.keys(RESOLUTION_PRESETS) as Resolution[]).map((r) => (
                <SelectItem key={r} value={r}>{RESOLUTION_PRESETS[r].label} · {RESOLUTION_PRESETS[r].width}×{RESOLUTION_PRESETS[r].height}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-2">
          <Label className="text-xs font-bold text-[#4a3517]">Frame rate</Label>
          <Select value={String(fps)} onValueChange={(v) => setFps(Number(v))} disabled={busy}>
            <SelectTrigger className="border-[#c98b5a]/40 bg-white/60 text-[#3a2a16]"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="24">24 fps · cinematic</SelectItem>
              <SelectItem value="30">30 fps · smooth</SelectItem>
              <SelectItem value="60">60 fps · ultra</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-2">
          <Label className="text-xs font-bold text-[#4a3517]">Music bed</Label>
          <div className="flex items-center gap-2 h-9">
            <Switch checked={music} onCheckedChange={setMusic} disabled={busy} />
            <span className="text-xs text-[#7a5a3a]">{music ? "On" : "Off"}</span>
          </div>
        </div>
      </div>

      <div className="mt-3 rounded-lg bg-[#fde9c8] px-3 py-2 text-xs text-[#7a4a1e]">
        Film length ≈ <b>{total.toFixed(1)}s</b> · {totalFrames} frames · {preset.width}×{preset.height} · {fps}fps
        <span className="block mt-0.5 text-[#9a6a3a]">Rendered frame-by-frame (deterministic) via the reverse-engineered Remotion renderer → MP4 (ffmpeg.wasm).</span>
      </div>

      <div className="mt-4 flex flex-col gap-3">
        {progress && (busy || progress.phase === "done" || progress.phase === "error") && (
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between text-xs">
              <span className="flex items-center gap-1.5 text-[#4a3517] font-medium">
                {progress.phase === "done" ? <CheckCircle2 className="h-4 w-4 text-[#5e9457]" /> :
                 progress.phase === "error" ? <AlertTriangle className="h-4 w-4 text-[#c7634a]" /> :
                 <Loader2 className="h-4 w-4 animate-spin text-[#c7634a]" />}
                {progress.message}
              </span>
              <span className="font-mono text-[#7a4a1e]">{Math.round(progress.ratio * 100)}%</span>
            </div>
            <Progress value={progress.ratio * 100} className="h-2 bg-[#f4d9b0]" />
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={startExport} disabled={busy || !allReady} className="bg-[#c7634a] hover:bg-[#b15438] text-white font-bold">
            {busy ? <><Loader2 className="h-4 w-4 animate-spin" /> Rolling film…</> : <><Film className="h-4 w-4" /> Render {storeResolution} film</>}
          </Button>
          {progress?.phase === "done" && progress.url && (
            <Button onClick={download} className="bg-[#7a9b6e] hover:bg-[#688a5d] text-white font-bold">
              <Download className="h-4 w-4" /> Download .{progress.ext ?? "mp4"}
            </Button>
          )}
        </div>
        <p className="text-[11px] text-[#9a7a55]">Steps every frame exactly → PNG → ffmpeg.wasm encodes MP4 + muxes narration. Bit-identical on every render.</p>
      </div>

      {/* hidden Remotion composition mount (the render target) */}
      {allReady && (
        <div aria-hidden style={{ position: "fixed", left: -99999, top: 0, width: preset.width, height: preset.height, pointerEvents: "none", opacity: 0 }}>
          <Player
            ref={remotionPlayerRef}
            component={Comp}
            inputProps={{ scenes }}
            fps={fps}
            durationInFrames={totalFrames}
            width={preset.width}
            height={preset.height}
            compositionId="storybook"
            fullSize
          />
        </div>
      )}
    </div>
  );
}
