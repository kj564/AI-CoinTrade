"use client";
// VOX-style motion-graphic components (reverse-engineered from the PremiumBeat
// "Replicating the VOX Motion Graphic Look" breakdowns):
//   1. Motion graphics at 12fps — stuttered/stepped motion for rough character.
//   2. Step-by-step lower thirds — kinetic typography, word-by-word, delayed.
//   3. Simple motion background — subtle moving gradient (no static color blocks).
//   4. Lens characteristics — chromatic aberration + edge blur (vignette).
// Plus data-viz staples of VOX explainers: animated counter + bar chart.
//
// All driven by useCurrentFrame() + interpolate() — deterministic per frame.

import React from "react";
import { useCurrentFrame, useVideoConfig } from "./context";
import { AbsoluteFill } from "./components";
import { interpolate, Easing } from "@/lib/remotion/core";

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

/** Quantize the frame to a lower fps (e.g., 12) for the VOX stepped look. */
export function useSteppedFrame(stepFps = 12): number {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const step = Math.max(1, Math.round(fps / stepFps));
  return Math.floor(frame / step) * step;
}

/**
 * VOX-style kinetic typography: the text reveals WORD BY WORD, stepped at 12fps,
 * each word popping in with a slight scale + fade (the "rough character" lower
 * third). Words already shown stay; upcoming are hidden until their turn.
 */
export function VoxText({
  text,
  wordsPerSecond = 2.5,
  highlight,
  style,
}: {
  text: string;
  wordsPerSecond?: number;
  highlight?: string[]; // words to emphasize (e.g. ["LEBAH"])
  style?: React.CSSProperties;
}) {
  const stepped = useSteppedFrame(12);
  const { fps, width, height } = useVideoConfig();
  const words = text.split(/\s+/);
  const wordsShown = Math.floor((stepped / fps) * wordsPerSecond);
  const fontSize = Math.round(height * 0.06);
  return (
    <div style={{ textAlign: "center", maxWidth: "86%", ...style }}>
      {words.map((w, i) => {
        const shown = i < wordsShown;
        // a word that just appeared (within last ~6 stepped frames) gets a pop
        const justShown = shown && i >= wordsShown - 1;
        const popT = clamp((wordsShown - i) / 1, 0, 1);
        const scale = shown ? (justShown ? interpolate(popT, [0, 1], [1.25, 1], { easing: Easing.out(Easing.cubic), extrapolateLeft: "clamp", extrapolateRight: "clamp" }) : 1) : 0.7;
        const isHi = highlight?.some((h) => w.toUpperCase().includes(h.toUpperCase()));
        return (
          <span key={i} style={{
            display: "inline-block",
            opacity: shown ? 1 : 0,
            transform: `scale(${scale})`,
            transition: "none",
            fontSize, fontWeight: 900, lineHeight: 1.15,
            color: isHi ? "#E8B547" : "#1a1a1a",
            padding: "0 0.18em",
            ...(isHi ? { background: "#1a1a1a", borderRadius: 6, color: "#fff" } : {}),
            textShadow: isHi ? "none" : "0 2px 0 #fff",
          }}>{w} </span>
        );
      })}
    </div>
  );
}

/** Subtle motion background — a slowly drifting gradient (no static color block). */
export function MotionBackground({ baseColor, accent }: { baseColor: string; accent: string }) {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const t = frame * 0.02;
  const x = interpolate(Math.sin(t), [-1, 1], [0, 100], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const y = interpolate(Math.cos(t * 0.8), [-1, 1], [0, 100], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <AbsoluteFill style={{ overflow: "hidden" }}>
      <div style={{ position: "absolute", inset: "-20%", background: baseColor }} />
      <div style={{
        position: "absolute", inset: "-20%",
        background: `radial-gradient(circle at ${x}% ${y}%, ${accent} 0%, transparent 55%)`,
        opacity: 0.5,
      }} />
      <div style={{
        position: "absolute", inset: "-20%",
        background: `radial-gradient(circle at ${100 - x}% ${100 - y}%, ${accent} 0%, transparent 60%)`,
        opacity: 0.3,
      }} />
    </AbsoluteFill>
  );
}

/** Lens characteristics: vignette + edge blur + faint chromatic aberration (RGB split). */
export function LensFX() {
  const { width, height } = useVideoConfig();
  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      {/* vignette: darkened edges, clear center */}
      <div style={{
        position: "absolute", inset: 0,
        background: "radial-gradient(ellipse at center, rgba(0,0,0,0) 55%, rgba(0,0,0,0.28) 100%)",
      }} />
      {/* faint chromatic aberration: thin red/cyan offset rings at the very edge */}
      <div style={{
        position: "absolute", inset: 0,
        boxShadow: `inset ${Math.max(2, width * 0.002)}px 0 0 rgba(255,0,40,0.10), inset ${-Math.max(2, width * 0.002)}px 0 0 rgba(0,200,255,0.10)`,
      }} />
    </AbsoluteFill>
  );
}

/** Animated count-up number (VOX data staple). */
export function Counter({
  to,
  from = 0,
  startFrame = 0,
  durationFrames = 30,
  suffix = "",
  prefix = "",
}: {
  to: number;
  from?: number;
  startFrame?: number;
  durationFrames?: number;
  suffix?: string;
  prefix?: string;
}) {
  const frame = useCurrentFrame();
  const v = interpolate(frame, [startFrame, startFrame + durationFrames], [from, to], {
    easing: Easing.out(Easing.cubic),
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const { height } = useVideoConfig();
  return (
    <span style={{ fontSize: Math.round(height * 0.16), fontWeight: 900, fontVariantNumeric: "tabular-nums" }}>
      {prefix}{Math.round(v)}{suffix}
    </span>
  );
}

/** Animated bar chart (e.g., bee population decline). */
export function BarChart({
  data,
  startFrame = 0,
  durationFrames = 45,
  color = "#c7634a",
  labelColor = "#1a1a1a",
  unit = "",
}: {
  data: { label: string; value: number }[];
  startFrame?: number;
  durationFrames?: number;
  color?: string;
  labelColor?: string;
  unit?: string;
}) {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const max = Math.max(...data.map((d) => d.value), 1);
  const chartH = height * 0.32;
  const barW = (width * 0.5) / data.length;
  return (
    <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "center", gap: width * 0.02, height: chartH, width: "60%" }}>
      {data.map((d, i) => {
        const target = (d.value / max) * chartH;
        const stagger = startFrame + i * Math.round(durationFrames / data.length);
        const h = interpolate(frame, [stagger, stagger + durationFrames], [0, target], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.out(Easing.cubic) });
        return (
          <div key={i} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
            <div style={{ fontSize: Math.round(height * 0.022), fontWeight: 700, color: labelColor }}>{d.value}{unit}</div>
            <div style={{ width: barW * 0.7, height: Math.max(1, h), background: color, borderRadius: 4 }} />
            <div style={{ fontSize: Math.round(height * 0.02), color: labelColor }}>{d.label}</div>
          </div>
        );
      })}
    </div>
  );
}
