"use client";
// More VOX-style techniques (from the "Edit Like Vox" tutorial playlist):
//   - PieChart (cinematic pie/donut charts)
//   - DictionaryDefinition (animated word definition, docu-style)
//   - NewspaperArticle (3D article/newspaper zoom animation)
//   - TitleCard (epic title cards for YouTube)
//   - Collage3D (Vox-style collage with 3D camera movement / parallax)
//   - MapCollage (map with 3D camera zoom/pan + markers)
// All driven by useCurrentFrame() + interpolate() — deterministic per frame.

import React from "react";
import { useCurrentFrame, useVideoConfig } from "./context";
import { AbsoluteFill, Img } from "./components";
import { interpolate, Easing } from "@/lib/remotion/core";
import { useSteppedFrame } from "./vox";

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

/** Compute pie slice arc paths up to a sweep progress (pure helper, no render mutation). */
function pieArcs(data: { value: number; color: string }[], total: number, cx: number, cy: number, r: number, sweepTotal: number) {
  let acc = 0;
  const out: { path: string; color: string }[] = [];
  for (const d of data) {
    const frac = d.value / total;
    const start = acc;
    const end = Math.min(start + frac * Math.PI * 2, sweepTotal);
    acc += frac * Math.PI * 2;
    if (end <= start) continue;
    const large = end - start > Math.PI ? 1 : 0;
    const x1 = cx + r * Math.cos(start - Math.PI / 2);
    const y1 = cy + r * Math.sin(start - Math.PI / 2);
    const x2 = cx + r * Math.cos(end - Math.PI / 2);
    const y2 = cy + r * Math.sin(end - Math.PI / 2);
    out.push({ path: `M${cx} ${cy} L${x1} ${y1} A${r} ${r} 0 ${large} 1 ${x2} ${y2} Z`, color: d.color });
  }
  return out;
}

/** Cinematic animated donut/pie chart (VOX "How To Edit Cinematic Pie Charts"). */
export function PieChart({
  data,
  startFrame = 0,
  durationFrames = 45,
  size,
  unit = "%",
}: {
  data: { label: string; value: number; color: string }[];
  startFrame?: number;
  durationFrames?: number;
  size?: number;
  unit?: string;
}) {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const r = size ?? Math.min(width, height) * 0.16;
  const cx = r, cy = r;
  const total = data.reduce((a, d) => a + d.value, 0) || 1;
  const progress = interpolate(frame, [startFrame, startFrame + durationFrames], [0, 1], {
    easing: Easing.out(Easing.cubic), extrapolateLeft: "clamp", extrapolateRight: "clamp",
  });
  const sweepTotal = progress * Math.PI * 2;
  const arcs = pieArcs(data.map((d) => ({ value: d.value, color: d.color })), total, cx, cy, r, sweepTotal);
  const legendFontSize = Math.round(height * 0.022);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: width * 0.04, justifyContent: "center" }}>
      <svg width={r * 2} height={r * 2} viewBox={`0 0 ${r * 2} ${r * 2}`}>
        {arcs.map((a, i) => <path key={i} d={a.path} fill={a.color} />)}
        <circle cx={cx} cy={cy} r={r * 0.55} fill="#fff" />
      </svg>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {data.map((d, i) => {
          const v = interpolate(frame, [startFrame + i * 4, startFrame + durationFrames], [0, d.value], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
          return (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: legendFontSize, fontWeight: 600, color: "#1a1a1a" }}>
              <div style={{ width: 14, height: 14, borderRadius: 3, background: d.color }} />
              {d.label}: {Math.round(v)}{unit}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Animated dictionary definition (VOX/Johnny Harris docu-style). */
export function DictionaryDefinition({
  word,
  pronunciation,
  pos,
  definition,
  startFrame = 0,
}: {
  word: string;
  pronunciation?: string;
  pos?: string;
  definition: string;
  startFrame?: number;
}) {
  const stepped = useSteppedFrame(12);
  const { width, height } = useVideoConfig();
  const line = (delay: number) => clamp((stepped - startFrame - delay) / 6, 0, 1);
  const wA = line(0), pA = line(4), posA = line(8), dA = line(12);
  const fs = Math.round(height * 0.05);
  return (
    <div style={{ textAlign: "left", maxWidth: "70%", background: "rgba(255,255,255,0.94)", padding: `${height * 0.03}px ${width * 0.04}px`, borderRadius: 8, border: `2px solid #1a1a1a`, boxShadow: `0 ${height * 0.01}px ${height * 0.03}px rgba(0,0,0,0.3)` }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, opacity: wA }}>
        <span style={{ fontSize: fs * 1.6, fontWeight: 900, color: "#1a1a1a" }}>{word}</span>
        {pronunciation && <span style={{ fontSize: fs * 0.6, color: "#666", fontStyle: "italic" }}>{pronunciation}</span>}
      </div>
      {pos && <div style={{ fontSize: fs * 0.6, color: "#c7634a", fontWeight: 700, fontStyle: "italic", marginTop: 4, opacity: posA }}>{pos}</div>}
      <div style={{ fontSize: fs * 0.7, color: "#333", marginTop: 10, lineHeight: 1.4, opacity: dA }}>{definition}</div>
    </div>
  );
}

/** 3D newspaper/article zoom animation (VOX "Newspaper Zoom Transition" / "3D Article Animation"). */
export function NewspaperArticle({
  imageUrl,
  headline,
  startFrame = 0,
}: {
  imageUrl: string;
  headline?: string;
  startFrame?: number;
}) {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  // zoom in (scale 0.6 -> 1.1) + slight 3D tilt (perspective)
  const scale = interpolate(frame, [startFrame, startFrame + 60], [0.6, 1.1], { easing: Easing.out(Easing.cubic), extrapolateLeft: "clamp", extrapolateRight: "extend" });
  const tilt = interpolate(frame, [startFrame, startFrame + 60], [12, 0], { easing: Easing.out(Easing.cubic), extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const alpha = clamp((frame - startFrame) / 10, 0, 1);
  const cardW = width * 0.5, cardH = height * 0.6;
  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", perspective: 1200, opacity: alpha }}>
      <div style={{
        width: cardW, height: cardH, transform: `scale(${scale}) rotateX(${tilt}deg)`,
        transformOrigin: "center", borderRadius: 8, overflow: "hidden",
        border: `3px solid #1a1a1a`, background: "#fff",
        boxShadow: `0 ${height * 0.04}px ${height * 0.06}px rgba(0,0,0,0.4)`,
      }}>
        <Img src={imageUrl} alt={headline ?? "article"} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
        {headline && (
          <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, padding: "4% 6%", background: "rgba(0,0,0,0.7)", color: "#fff", fontSize: Math.round(height * 0.03), fontWeight: 700 }}>{headline}</div>
        )}
      </div>
    </AbsoluteFill>
  );
}

/** Epic title card (VOX "How To Edit EPIC Title Cards For YouTube"). */
export function TitleCard({
  title,
  subtitle,
  startFrame = 0,
  color = "#1a1a1a",
  accent = "#E8B547",
}: {
  title: string;
  subtitle?: string;
  startFrame?: number;
  color?: string;
  accent?: string;
}) {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  // settle from large to normal + fade
  const t = clamp((frame - startFrame) / 25, 0, 1);
  const scale = interpolate(t, [0, 1], [1.4, 1], { easing: Easing.out(Easing.cubic), extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const alpha = clamp(t * 2, 0, 1);
  const fs = Math.round(height * 0.13);
  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", opacity: alpha, pointerEvents: "none" }}>
      <div style={{ transform: `scale(${scale})`, textAlign: "center" }}>
        <div style={{ fontSize: fs, fontWeight: 900, color, lineHeight: 1, textShadow: `0 ${height * 0.01}px 0 ${accent}` }}>{title}</div>
        {subtitle && <div style={{ marginTop: 12, fontSize: Math.round(height * 0.035), fontWeight: 600, color: accent, letterSpacing: 2 }}>{subtitle}</div>}
      </div>
    </AbsoluteFill>
  );
}

/** Vox-style collage with 3D camera movement / parallax (layered images with depth). */
export function Collage3D({
  layers,
  startFrame = 0,
}: {
  layers: { url: string; x: number; y: number; w: number; depth: number }[];
  startFrame?: number;
}) {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  // camera pans horizontally; nearer layers (higher depth) move more
  const pan = interpolate(frame, [startFrame, startFrame + 120], [-0.06, 0.06], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <AbsoluteFill style={{ perspective: 1400 }}>
      {layers.map((L, i) => {
        const off = pan * L.depth * width;
        const z = -L.depth * 200;
        const intro = clamp((frame - startFrame - i * 4) / 15, 0, 1);
        return (
          <div key={i} style={{
            position: "absolute", left: L.x * width + off, top: L.y * height,
            width: L.w * width, transform: `translateZ(${z}px)`, transformStyle: "preserve-3d",
            opacity: intro, borderRadius: 8, overflow: "hidden",
            border: `2px solid rgba(0,0,0,0.2)`, boxShadow: `0 ${height * 0.02}px ${height * 0.03}px rgba(0,0,0,0.3)`,
          }}>
            <Img src={L.url} alt="" style={{ width: "100%", height: "auto", display: "block" }} />
          </div>
        );
      })}
    </AbsoluteFill>
  );
}

/** Stylized map with 3D camera zoom/pan + markers (VOX "Map Collage Animation"). */
export function MapCollage({
  startFrame = 0,
  markers,
  zoomTo,
}: {
  startFrame?: number;
  markers?: { x: number; y: number; label: string; color?: string }[];
  zoomTo?: { x: number; y: number; scale: number };
}) {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const t = clamp((frame - startFrame) / 60, 0, 1);
  const z = zoomTo ? interpolate(t, [0, 1], [1, zoomTo.scale], { easing: Easing.out(Easing.cubic), extrapolateLeft: "clamp", extrapolateRight: "clamp" }) : 1;
  const tx = zoomTo ? interpolate(t, [0, 1], [0, -(zoomTo.x - 0.5) * width * zoomTo.scale], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) : 0;
  const ty = zoomTo ? interpolate(t, [0, 1], [0, -(zoomTo.y - 0.5) * height * zoomTo.scale], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) : 0;
  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
      <div style={{ position: "relative", width: width, height: height * 0.6, overflow: "hidden", borderRadius: 8, border: `2px solid #1a1a1a` }}>
        <div style={{ position: "absolute", inset: 0, transform: `translate(${tx}px, ${ty}px) scale(${z})`, transformOrigin: "0 0" }}>
          {/* stylized map: landmass blobs */}
          <svg width={width} height={height * 0.6} viewBox={`0 0 ${width} ${height * 0.6}`} style={{ background: "#cfe0ff" }}>
            <path d={`M${width * 0.1} ${height * 0.1} Q${width * 0.3} ${height * 0.05} ${width * 0.4} ${height * 0.2} T ${width * 0.6} ${height * 0.3} Q${width * 0.7} ${height * 0.4} ${width * 0.5} ${height * 0.45} Z`} fill="#9fc97a" />
            <path d={`M${width * 0.6} ${height * 0.15} Q${width * 0.8} ${height * 0.1} ${width * 0.9} ${height * 0.25} T ${width * 0.85} ${height * 0.4} Z`} fill="#9fc97a" />
          </svg>
          {markers?.map((m, i) => {
            const mA = clamp((frame - startFrame - 20 - i * 8) / 10, 0, 1);
            return (
              <div key={i} style={{ position: "absolute", left: m.x * width, top: m.y * height * 0.6, transform: "translate(-50%,-100%)", opacity: mA }}>
                <div style={{ width: 14, height: 14, borderRadius: "50% 50% 50% 0", background: m.color ?? "#c7634a", transform: "rotate(-45deg)" }} />
                <div style={{ fontSize: Math.round(height * 0.022), fontWeight: 700, color: "#1a1a1a", marginTop: 2 }}>{m.label}</div>
              </div>
            );
          })}
        </div>
      </div>
    </AbsoluteFill>
  );
}
