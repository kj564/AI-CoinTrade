"use client";

import { useState } from "react";
import { StorybookPlayer } from "@/lib/storybook/player-engine";
import { SceneCard } from "./scene-card";
import { useStorybook, totalDuration } from "@/lib/storybook/store";
import type { Scene } from "@/lib/storybook/types";

export function SceneTimeline({
  onRegenerateImage,
  onRegenerateAudio,
}: {
  onRegenerateImage: (scene: Scene) => void;
  onRegenerateAudio: (scene: Scene) => void;
}) {
  const scenes = useStorybook((s) => s.scenes);
  const reorder = useStorybook((s) => s.reorderScenes);
  const setCurIdx = useStorybook((s) => s.setCurrentSceneIndex);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);

  void StorybookPlayer; // keep type import meaningful for tooling

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-bold text-[#4a3517]">
          Film Reel · {scenes.length} scenes · {totalDuration(scenes).toFixed(1)}s
        </h3>
        <span className="text-xs text-[#7a5a3a]">Drag to reorder</span>
      </div>
      <div className="flex flex-col gap-2">
        {scenes.map((scene, idx) => (
          <div
            key={scene.id}
            className={dragOver === idx && dragFrom !== null && dragFrom !== idx ? "ring-2 ring-[#c7634a] rounded-xl" : ""}
          >
            <SceneCard
              scene={scene}
              index={idx}
              onDragStart={() => setDragFrom(idx)}
              onDragOver={() => setDragOver(idx)}
              onDrop={() => {
                if (dragFrom !== null && dragFrom !== idx) reorder(dragFrom, idx);
                setDragFrom(null);
                setDragOver(null);
              }}
              onRegenerateImage={() => onRegenerateImage(scene)}
              onRegenerateAudio={() => onRegenerateAudio(scene)}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

export { SceneTimeline as default };
