"use client";

import { useRef, useState } from "react";
import { Image as ImageIcon, Loader2, Music, GripVertical, AlertCircle, Pencil, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Slider } from "@/components/ui/slider";
import { cn } from "@/lib/utils";
import { useStorybook } from "@/lib/storybook/store";
import type { Scene } from "@/lib/storybook/types";

const entranceLabel: Record<string, string> = {
  pop: "Pop",
  grow: "Grow",
  "slide-left": "Slide ←",
  "slide-right": "Slide →",
  "slide-up": "Slide ↑",
  fade: "Fade",
};

export function SceneCard({
  scene,
  index,
  onDragStart,
  onDragOver,
  onDrop,
  onRegenerateImage,
  onRegenerateAudio,
}: {
  scene: Scene;
  index: number;
  onDragStart: () => void;
  onDragOver: () => void;
  onDrop: () => void;
  onRegenerateImage: () => void;
  onRegenerateAudio: () => void;
}) {
  const progress = useStorybook((s) => s.assetProgress[scene.id]);
  const updateScene = useStorybook((s) => s.updateScene);
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState(scene.title);
  const [draftNarration, setDraftNarration] = useState(scene.narration);
  const cardRef = useRef<HTMLDivElement>(null);

  const imgStatus = progress?.image ?? "idle";
  const audioStatus = progress?.audio ?? "idle";

  return (
    <div
      ref={cardRef}
      draggable
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      className={cn(
        "group relative rounded-xl border-2 bg-[#fff8e7] p-3 transition-all",
        "border-[#c98b5a]/30 hover:border-[#c7634a]/60 hover:shadow-[0_10px_24px_-12px_rgba(120,70,20,0.5)]"
      )}
    >
      <div className="flex items-start gap-3">
        <div className="flex flex-col items-center gap-1 pt-1">
          <GripVertical className="h-4 w-4 text-[#c98b5a] cursor-grab" />
          <span className="text-xs font-bold text-[#7a4a1e]">{index + 1}</span>
        </div>

        {/* Thumbnail */}
        <div className="relative h-20 w-32 shrink-0 overflow-hidden rounded-lg border border-[#c98b5a]/40 bg-[#fde9c8]">
          {scene.imageUrl ? (
            <img src={scene.imageUrl} alt={scene.title} className="h-full w-full object-cover" />
          ) : (
            <div className="flex h-full w-full items-center justify-center">
              {imgStatus === "loading" ? (
                <Loader2 className="h-5 w-5 animate-spin text-[#c7634a]" />
              ) : imgStatus === "error" ? (
                <AlertCircle className="h-5 w-5 text-[#c7634a]" />
              ) : (
                <ImageIcon className="h-5 w-5 text-[#c98b5a]" />
              )}
            </div>
          )}
        </div>

        {/* Body */}
        <div className="min-w-0 flex-1">
          {editing ? (
            <div className="flex flex-col gap-2">
              <Input
                value={draftTitle}
                onChange={(e) => setDraftTitle(e.target.value)}
                className="h-7 text-sm border-[#c98b5a]/40 bg-[#fff8e7]"
              />
              <Textarea
                value={draftNarration}
                onChange={(e) => setDraftNarration(e.target.value)}
                rows={2}
                className="text-xs border-[#c98b5a]/40 bg-[#fff8e7]"
              />
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  onClick={() => {
                    updateScene(scene.id, { title: draftTitle, narration: draftNarration });
                    setEditing(false);
                  }}
                  className="h-7 bg-[#7a9b6e] hover:bg-[#688a5d] text-white"
                >
                  <Check className="h-3.5 w-3.5" /> Save
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setEditing(false)} className="h-7 text-[#7a4a1e]">
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2">
                <h4 className="truncate text-sm font-bold text-[#4a3517]">{scene.title}</h4>
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={() => {
                    setDraftTitle(scene.title);
                    setDraftNarration(scene.narration);
                    setEditing(true);
                  }}
                  className="h-6 w-6 text-[#7a4a1e] opacity-0 group-hover:opacity-100"
                >
                  <Pencil className="h-3 w-3" />
                </Button>
              </div>
              <p className="mt-0.5 line-clamp-2 text-xs text-[#7a5a3a]">{scene.narration}</p>
              <div className="mt-1.5 flex flex-wrap items-center gap-1">
                <Badge variant="outline" className="text-[10px] bg-[#fde9c8] border-[#c98b5a]/40 text-[#7a4a1e]">
                  {scene.mood}
                </Badge>
                {scene.props.slice(0, 3).map((p) => {
                  const source = p.propSource ?? (p.spriteUrl ? "polyfork" : "emoji");
                  const cls =
                    source === "sand3d"
                      ? "text-[10px] bg-[#c7634a]/12 border-[#c7634a]/45 text-[#9a4a2e]"
                      : source === "polyfork"
                        ? "text-[10px] bg-[#7a9b6e]/15 border-[#7a9b6e]/50 text-[#4a6a3e]"
                        : "text-[10px] bg-[#fff8e7] border-[#c98b5a]/40 text-[#7a5a3a]";
                  const tag = source === "sand3d" ? "sand3d " : source === "polyfork" ? "3D " : "";
                  return (
                    <Badge
                      key={p.id}
                      variant="outline"
                      className={cls}
                      title={
                        source === "sand3d"
                          ? `Authored with sand3d (render locally: ${p.sand3dFile ?? ""})`
                          : source === "polyfork"
                            ? p.spriteTitle
                              ? `Polyfork 3D: ${p.spriteTitle}`
                              : "Polyfork 3D model"
                            : undefined
                      }
                    >
                      {tag}{p.emoji ?? "★"} {p.name}
                    </Badge>
                  );
                })}
                {scene.props.length > 3 && (
                  <span className="text-[10px] text-[#7a5a3a]">+{scene.props.length - 3} props</span>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Footer: duration + regen */}
      <div className="mt-3 flex items-center gap-3 border-t border-[#c98b5a]/20 pt-2">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-medium text-[#7a4a1e]">Duration</span>
          <Slider
            value={[scene.durationSec]}
            min={3}
            max={10}
            step={0.5}
            onValueChange={(v) => updateScene(scene.id, { durationSec: v[0] })}
            className="w-24"
          />
          <span className="text-[10px] font-mono tabular-nums text-[#7a4a1e] w-8">{scene.durationSec.toFixed(1)}s</span>
        </div>
        <div className="ml-auto flex items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            onClick={onRegenerateImage}
            disabled={imgStatus === "loading"}
            className="h-7 gap-1 text-[10px] text-[#7a4a1e] hover:bg-[#f4d9b0]"
          >
            {imgStatus === "loading" ? <Loader2 className="h-3 w-3 animate-spin" /> : <ImageIcon className="h-3 w-3" />}
            <span className="hidden sm:inline">Re-cut</span>
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={onRegenerateAudio}
            disabled={audioStatus === "loading"}
            className="h-7 gap-1 text-[10px] text-[#7a4a1e] hover:bg-[#f4d9b0]"
          >
            {audioStatus === "loading" ? <Loader2 className="h-3 w-3 animate-spin" /> : <Music className="h-3 w-3" />}
            <span className="hidden sm:inline">Re-narrate</span>
          </Button>
        </div>
      </div>

      {/* entrance legend */}
      <div className="mt-1.5 flex flex-wrap gap-1">
        {scene.props.map((p) => (
          <span key={p.id} className="text-[9px] text-[#9a7a55]">
            {p.emoji ?? "★"} {entranceLabel[p.entrance] ?? p.entrance}
          </span>
        ))}
      </div>
    </div>
  );
}
