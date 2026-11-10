"use client";
// Reverse-engineered @remotion/three <ThreeCanvas>-style integration.
// Renders the live three.js prop layer (polyfork createAsset + sand3d shim)
// driven by useCurrentFrame() — deterministic per frame. The WebGL canvas is
// appended to the DOM so the renderer can capture it.

import React, { useEffect, useLayoutEffect, useRef } from "react";
import { useCurrentFrame, useVideoConfig, delayRender, continueRender } from "./context";
import type { Scene, SceneProp } from "@/lib/storybook/types";

function isLive3D(prop: SceneProp): boolean {
  return (
    (prop.propSource === "polyfork" && !!prop.moduleUrl) ||
    (prop.propSource === "sand3d" && !!prop.programUrl)
  );
}
function propPosition(placement: SceneProp["placement"], W: number, H: number) {
  switch (placement) {
    case "left":   return { x: W * 0.18, y: H * 0.50 };
    case "right":  return { x: W * 0.82, y: H * 0.50 };
    case "top":    return { x: W * 0.5,  y: H * 0.22 };
    case "bottom": return { x: W * 0.5,  y: H * 0.80 };
    default:       return { x: W * 0.5,  y: H * 0.52 };
  }
}

interface ActiveProp {
  prop: SceneProp;
  screenX: number; screenY: number; r: number;
  entranceP: number; localT: number;
}
function computeActiveProps(scenes: Scene[], frame: number, fps: number, W: number, H: number): ActiveProp[] {
  const time = frame / fps;
  let acc = 0; let idx = -1; let sceneStart = 0;
  for (let i = 0; i < scenes.length; i++) {
    const d = scenes[i].durationSec;
    if (time >= acc && time < acc + d) { idx = i; sceneStart = acc; break; }
    acc += d;
  }
  if (idx < 0) { idx = scenes.length - 1; sceneStart = acc - scenes[idx].durationSec; }
  const scene = scenes[idx];
  const localT = time - sceneStart;
  const r = Math.min(W, H) * 0.075;
  const out: ActiveProp[] = [];
  for (const prop of scene.props) {
    if (!isLive3D(prop)) continue;
    const start = prop.delay / 1000; const dur = 0.5;
    const p = Math.max(0, Math.min(1, (localT - start) / dur));
    if (p <= 0) continue;
    const pos = propPosition(prop.placement, W, H);
    out.push({ prop, screenX: pos.x, screenY: pos.y, r, entranceP: p, localT });
  }
  return out;
}

interface LayerInstance {
  canvas: HTMLCanvasElement;
  setSize: (w: number, h: number) => void;
  preload: (s: Scene[]) => Promise<void>;
  renderFrame: (a: ActiveProp[]) => void;
  dispose: () => void;
}

export function Storyboard3D({ scenes }: { scenes: Scene[] }) {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const containerRef = useRef<HTMLDivElement>(null);
  const layerRef = useRef<LayerInstance | null>(null);
  const readyRef = useRef(false);

  // set up the three.js layer once
  useEffect(() => {
    let disposed = false;
    const h = delayRender("3D prop models");
    (async () => {
      try {
        const mod = await import(/* webpackIgnore: true */ "/storybook-3d-layer.mjs");
        if (disposed) return;
        const layer = new mod.Prop3DLayer() as LayerInstance;
        layer.setSize(width, height);
        layer.canvas.style.position = "absolute";
        layer.canvas.style.top = "0";
        layer.canvas.style.left = "0";
        layer.canvas.style.width = "100%";
        layer.canvas.style.height = "100%";
        containerRef.current?.appendChild(layer.canvas);
        layerRef.current = layer;
        await layer.preload(scenes);
        if (disposed) return;
        readyRef.current = true;
        continueRender(h);
        // first frame render
        const active = computeActiveProps(scenes, frame, fps, width, height);
        layer.renderFrame(active);
      } catch (e) {
        console.error("[Storyboard3D] layer load failed", e);
        continueRender(h);
      }
    })();
    return () => {
      disposed = true;
      try { layerRef.current?.dispose(); } catch { /* ignore */ }
      layerRef.current = null;
      readyRef.current = false;
      continueRender(h);
    };
  }, []);

  // re-render the layer every frame
  useEffect(() => {
    const layer = layerRef.current;
    if (!layer || !readyRef.current) return;
    const active = computeActiveProps(scenes, frame, fps, width, height);
    layer.renderFrame(active);
  }, [frame, scenes, fps, width, height]);

  return <div ref={containerRef} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }} />;
}
