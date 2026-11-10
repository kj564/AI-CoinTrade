"use client";
// The storybook as a Remotion composition — pure React DOM (no canvas drawing).
// <Backdrop> is CSS gradient sky + SVG hills + <Img> scene card + caption div +
// vignette div, all styled from useCurrentFrame() via interpolate(). The
// renderer screenshots this DOM per frame (html2canvas) — exactly how Remotion
// renders (video = React DOM, render = screenshot the DOM).

import React, { useEffect, useRef } from "react";
import { useCurrentFrame, useVideoConfig, delayRender, continueRender } from "./context";
import { Sequence, AbsoluteFill, Img } from "./components";
import { Storyboard3D } from "./ThreeCanvas";
import { interpolate, Easing } from "@/lib/remotion/core";
import type { Scene } from "@/lib/storybook/types";

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

/** One scene's backdrop as DOM. Children of <Sequence> so useCurrentFrame() is local. */
function Backdrop({ scene }: { scene: Scene }) {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const localT = frame / fps;
  const hasSunProp = scene.props.some(
    (p) => /\bsun\b/i.test(p.name) && ((p.propSource === "polyfork" && p.moduleUrl) || (p.propSource === "sand3d" && p.programUrl))
  );

  // scene illustration card entrance
  const cardIntro = clamp(localT / 0.6, 0, 1);
  const cardScale = interpolate(cardIntro, [0, 1], [0.92, 1], { easing: Easing.out(Easing.cubic), extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const cardAlpha = clamp(cardIntro * 1.4, 0, 1);
  // caption fade
  const capIn = clamp(localT / 0.3, 0, 1);
  const capOut = clamp((scene.durationSec - localT) / 0.4, 0, 1);
  const capAlpha = Math.min(capIn, capOut);
  // title
  const titleAlpha = Math.min(clamp(localT / 0.4, 0, 1), clamp((scene.durationSec - localT) / 0.3, 0, 1));

  const cardW = width * 0.74;
  const cardH = cardW * (9 / 16);
  const cardX = (width - cardW) / 2;
  const cardY = height * 0.1;

  // layered hill paths (SVG, deterministic)
  const hillLayers = [
    { y: 0.62, amp: 0.05, color: "#9fbf8a", ph: 6 },
    { y: 0.7, amp: 0.06, color: "#7fae6e", ph: 10 },
    { y: 0.8, amp: 0.07, color: "#5e9457", ph: 14 },
    { y: 0.9, amp: 0.05, color: "#4a7a44", ph: 18 },
  ];
  const hillPath = (L: { y: number; amp: number; ph: number }) => {
    const segs = 6;
    const phase = localT * L.ph * 0.04;
    let d = `M0 ${height}`;
    for (let i = 0; i <= segs; i++) {
      const x = (i / segs) * width;
      const y = (L.y + Math.sin(phase + i * 1.3) * L.amp) * height;
      d += ` L${x.toFixed(1)} ${y.toFixed(1)}`;
    }
    d += ` L${width} ${height} Z`;
    return d;
  };

  return (
    <AbsoluteFill style={{ overflow: "hidden", fontFamily: "ui-sans-serif, system-ui, sans-serif" }}>
      {/* sky gradient */}
      <div style={{ position: "absolute", inset: 0, background: "linear-gradient(to bottom, #fde9c8 0%, #fadcb4 55%, #f6cda0 100%)" }} />

      {/* sun (only if no 3D sun prop) */}
      {!hasSunProp && (
        <div style={{
          position: "absolute", left: `calc(${(0.82 * 100).toFixed(1)}% - ${(0.11 * Math.min(width, height)).toFixed(0)}px)`,
          top: `calc(${(0.22 * 100).toFixed(1)}% - ${(0.11 * Math.min(width, height)).toFixed(0)}px)`,
          width: `${(0.22 * Math.min(width, height)).toFixed(0)}px`, height: `${(0.22 * Math.min(width, height)).toFixed(0)}px`,
          borderRadius: "50%",
          background: "radial-gradient(circle at 35% 35%, #ffe7a3, #f2b233 70%, #e89a1e)",
          boxShadow: `0 0 ${(0.25 * Math.min(width, height)).toFixed(0)}px rgba(255,209,128,0.55)`,
        }} />
      )}

      {/* layered hills (SVG) */}
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ position: "absolute", inset: 0 }} preserveAspectRatio="none">
        {hillLayers.map((L, i) => (
          <path key={i} d={hillPath(L)} fill={L.color} />
        ))}
      </svg>

      {/* scene illustration as a paper card */}
      {scene.imageUrl && (
        <div style={{
          position: "absolute", left: cardX, top: cardY, width: cardW, height: cardH,
          borderRadius: Math.max(10, width * 0.01), overflow: "hidden",
          border: `${Math.max(2, width * 0.003)}px solid rgba(120,80,30,0.35)`,
          background: "#fff8e7",
          boxShadow: `0 ${Math.max(6, height * 0.01)}px ${Math.max(8, width * 0.012)}px rgba(80,50,20,0.28)`,
          transform: `scale(${cardScale})`, transformOrigin: "center",
          opacity: cardAlpha,
        }}>
          <Img src={scene.imageUrl} alt={scene.title} style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
        </div>
      )}

      {/* scene title */}
      {titleAlpha > 0 && (
        <div style={{
          position: "absolute", left: `${(0.04 * 100).toFixed(1)}%`, top: `${(0.05 * 100).toFixed(1)}%`,
          fontSize: Math.max(16, height * 0.026), fontWeight: 700, color: "rgba(74,53,23,0.85)",
          opacity: titleAlpha,
        }}>{scene.title}</div>
      )}

      {/* caption (narration) — paper scroll */}
      {capAlpha > 0 && scene.narration && (
        <div style={{
          position: "absolute", left: "50%", top: "86%",
          transform: "translate(-50%, -50%)",
          width: "60%", padding: `${(height * 0.014).toFixed(0)}px ${(width * 0.02).toFixed(0)}px`,
          background: "rgba(255,248,231,0.92)",
          border: `${Math.max(2, height * 0.004)}px solid rgba(120,80,30,0.3)`,
          borderRadius: Math.max(10, height * 0.02),
          textAlign: "center", fontSize: Math.max(18, height * 0.034), fontWeight: 500,
          color: "#4a3517", lineHeight: 1.3, opacity: capAlpha,
          boxShadow: `0 ${Math.max(4, height * 0.006)}px ${Math.max(10, width * 0.01)}px rgba(80,50,20,0.18)`,
        }}>{scene.narration}</div>
      )}

      {/* vignette */}
      <div style={{
        position: "absolute", inset: 0, pointerEvents: "none",
        background: "radial-gradient(ellipse at center, rgba(0,0,0,0) 40%, rgba(60,35,10,0.22) 100%)",
      }} />
    </AbsoluteFill>
  );
}

/** Compute each scene's frame range. */
function sceneRanges(scenes: Scene[], fps: number): { from: number; dur: number }[] {
  const ranges: { from: number; dur: number }[] = [];
  let t = 0;
  for (let i = 0; i < scenes.length; i++) {
    ranges.push({ from: Math.round(t * fps), dur: Math.round(scenes[i].durationSec * fps) });
    t += scenes[i].durationSec;
  }
  return ranges;
}

/** The storybook composition: receives scenes via inputProps. */
export function StoryboardComposition(props: { scenes: Scene[] }) {
  const { fps } = useVideoConfig();
  const scenes = props.scenes;
  const ranges = sceneRanges(scenes, fps);
  return (
    <AbsoluteFill style={{ backgroundColor: "#fde9c8" }}>
      {scenes.map((sc, i) => (
        <Sequence key={sc.id} from={ranges[i].from} durationInFrames={ranges[i].dur}>
          <Backdrop scene={sc} />
        </Sequence>
      ))}
      <Storyboard3D scenes={scenes} />
    </AbsoluteFill>
  );
}
