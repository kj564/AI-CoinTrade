"use client";
// "Penyelamat Kecil Kita" — built with the REAL vox-explainer-skill methodology
// (learned from github.com/CK42BB/vox-explainer-skill):
//   - VO-first timing (beat durations = measured VO + 0.5s, set by the build script)
//   - Vox visual grammar: paper-collage keyframes (baked into the illustrations)
//   - Motion vocabulary: SLOW 2D push-in + parallax drift + ONE moving element.
//     NO 3D rotation, NO flying, NO camera shake (flat paper cutouts only).
//   - Vox subtitles: bold sans, white fill + heavy black outline, bottom-center,
//     max 2 lines / ~42 chars, clause-split, accent-color highlight on key words.

import React from "react";
import { useCurrentFrame, useVideoConfig } from "./context";
import { Sequence, AbsoluteFill, Img } from "./components";
import { MotionBackground, LensFX } from "./vox";
import { interpolate, Easing } from "@/lib/remotion/core";
import type { Scene } from "@/lib/storybook/types";

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

const ACCENT = "#C7634A";

/** Vox subtitles: bold sans, white + heavy black outline, bottom-center, clause-split. */
function VoxSubtitles({ narration, accent = ACCENT }: { narration: string; accent?: string }) {
  const frame = useCurrentFrame();
  const { durationInFrames, width, height } = useVideoConfig();
  const dur = durationInFrames;
  // split at clause boundaries (, . ;)
  const clauses = narration.split(/(?<=[.,;])\s+/).filter(Boolean);
  // group into chunks of ~2 lines (~84 chars)
  const chunks: string[] = [];
  let cur = "";
  for (const c of clauses) {
    if ((cur + " " + c).length > 84) { if (cur) chunks.push(cur); cur = c; }
    else { cur = cur ? cur + " " + c : c; }
  }
  if (cur) chunks.push(cur);
  if (chunks.length === 0) return null;
  const chunkDur = dur / chunks.length;
  const chunkIdx = Math.min(chunks.length - 1, Math.floor(frame / chunkDur));
  const chunkStart = chunkIdx * chunkDur;
  const alpha = clamp(Math.min((frame - chunkStart + 1) / 6, (chunkStart + chunkDur - frame) / 6), 0, 1);
  const text = chunks[chunkIdx];
  // wrap into lines of ~42 chars
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    if ((line + " " + w).length > 42) { if (line) lines.push(line); line = w; }
    else { line = line ? line + " " + w : w; }
  }
  if (line) lines.push(line);
  const fontSize = Math.round(height * 0.05);
  const outline = Math.max(5, Math.round(height * 0.008));
  // accent-highlight key words
  const accentWords = ["lebah", "pestisida", "neonicotinoid", "organik", "masa depan"];
  const renderLine = (ln: string) =>
    ln.split(/(\s+)/).map((tok, i) => {
      const isAccent = accentWords.some((aw) => tok.toLowerCase().includes(aw));
      return <span key={i} style={{ color: isAccent ? accent : "#fff" }}>{tok}</span>;
    });
  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "flex-end", paddingBottom: "4%", pointerEvents: "none" }}>
      <div style={{ opacity: alpha, textAlign: "center", maxWidth: "82%" }}>
        {lines.map((ln, i) => (
          <div key={i} style={{
            fontSize, fontWeight: 800, lineHeight: 1.25, color: "#fff", fontFamily: "Archivo, Inter, ui-sans-serif, system-ui, sans-serif",
            textShadow: `-${outline}px 0 #000, ${outline}px 0 #000, 0 -${outline}px #000, 0 ${outline}px #000, -${outline}px -${outline}px #000, ${outline}px ${outline}px #000, -${outline}px ${outline}px #000, ${outline}px -${outline}px #000, 0 ${outline * 1.5}px ${outline * 2}px rgba(0,0,0,0.5)`,
          }}>{renderLine(ln)}</div>
        ))}
      </div>
    </AbsoluteFill>
  );
}

const lerpColor = (a: string, b: string, t: number) => {
  const pa = [parseInt(a.slice(1, 3), 16), parseInt(a.slice(3, 5), 16), parseInt(a.slice(5, 7), 16)];
  const pb = [parseInt(b.slice(1, 3), 16), parseInt(b.slice(3, 5), 16), parseInt(b.slice(5, 7), 16)];
  return `rgb(${Math.round(pa[0]+(pb[0]-pa[0])*t)},${Math.round(pa[1]+(pb[1]-pa[1])*t)},${Math.round(pa[2]+(pb[2]-pa[2])*t)})`;
};

/**
 * One beat's backdrop — TRUE PARALLAX: 3+ layered paper-cutout elements at
 * different depths, each drifting at a different rate (background slowest,
 * foreground fastest), plus a slow 2D push-in. This is the Vox collage motion:
 * "Layer parallax (background drifts slower)" + "slow 2D push-in".
 *
 * Layers:
 *   0. Background — aged-cream paper + halftone grain + layered SVG hills (drift ×0.25)
 *   1. Midground — the keyframe illustration card (drift ×0.5 + push-in)
 *   2. Foreground — halftone dots + accent geometric shapes + washi tape (drift ×1.0)
 */
function BeatBackdrop({ scene }: { scene: Scene }) {
  const frame = useCurrentFrame();
  const { fps, width, height, durationInFrames } = useVideoConfig();
  const localT = frame / fps;
  // slow 2D push-in (3% zoom over the clip)
  const pushIn = interpolate(frame, [0, durationInFrames], [1.0, 1.03], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  // parallax drift: each layer drifts at a different rate
  const drift = Math.sin(localT * 0.35) * width * 0.015;
  const bgDrift = drift * 0.25;
  const midDrift = drift * 0.5;
  const fgDrift = drift * 1.0;
  // color transition over the beat
  const tCol = clamp(frame / durationInFrames, 0, 1);
  const bg = lerpColor(scene.fromColor ?? "#f5efe0", scene.toColor ?? "#f5efe0", tCol);
  // illustration card entrance
  const intro = clamp(localT / 0.5, 0, 1);
  const cardScale = interpolate(intro, [0, 1], [0.94, 1], { easing: Easing.out(Easing.cubic), extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const cardAlpha = clamp(intro * 1.4, 0, 1);
  const cardW = width * 0.72, cardH = height * 0.72;
  const cardX = (width - cardW) / 2, cardY = (height - cardH) / 2;
  const ink = lerpColor(bg, "#1a1a1a", 0.4);
  return (
    <AbsoluteFill style={{ overflow: "hidden" }}>
      {/* ── LAYER 0: BACKGROUND (drift ×0.25, slowest) ── */}
      <div style={{ position: "absolute", inset: "-5%", transform: `translateX(${bgDrift}px) scale(${pushIn})`, transformOrigin: "center" }}>
        {/* aged-cream paper base */}
        <div style={{ position: "absolute", inset: 0, background: bg }} />
        {/* paper grain / halftone texture */}
        <div style={{ position: "absolute", inset: 0, backgroundImage: "repeating-radial-gradient(circle at 50% 50%, rgba(0,0,0,0.05) 0, rgba(0,0,0,0.05) 1px, transparent 1px, transparent 5px)", opacity: 0.6 }} />
        {/* layered SVG hills (shallow depth, ink-tinted) */}
        <svg width={width * 1.1} height={height} viewBox={`0 0 ${width * 1.1} ${height}`} style={{ position: "absolute", bottom: 0, left: "-5%" }} preserveAspectRatio="none">
          <path d={`M0 ${height * 0.7} Q${width * 0.2} ${height * 0.62} ${width * 0.4} ${height * 0.7} T ${width * 0.8} ${height * 0.68} T ${width * 1.1} ${height * 0.7} L${width * 1.1} ${height} L0 ${height} Z`} fill={lerpColor(bg, ink, 0.2)} opacity={0.6} />
          <path d={`M0 ${height * 0.82} Q${width * 0.25} ${height * 0.74} ${width * 0.5} ${height * 0.82} T ${width * 1.1} ${height * 0.8} L${width * 1.1} ${height} L0 ${height} Z`} fill={lerpColor(bg, ink, 0.4)} opacity={0.7} />
        </svg>
      </div>

      {/* ── LAYER 1: MIDGROUND (drift ×0.5 + push-in) — the keyframe illustration ── */}
      {scene.imageUrl && (
        <div style={{
          position: "absolute", left: cardX, top: cardY, width: cardW, height: cardH,
          transform: `translateX(${midDrift}px) scale(${cardScale * pushIn})`, transformOrigin: "center",
          opacity: cardAlpha, borderRadius: Math.max(6, width * 0.006), overflow: "hidden",
          border: `${Math.max(4, width * 0.005)}px solid #fff`, // white sticker border (Vox)
          boxShadow: `0 ${Math.max(8, height * 0.015)}px ${Math.max(16, width * 0.02)}px rgba(0,0,0,0.4), 0 0 0 ${Math.max(2, width * 0.002)}px rgba(0,0,0,0.12)`,
          background: "#f5efe0",
        }}>
          <Img src={scene.imageUrl} alt={scene.title} style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
        </div>
      )}

      {/* ── LAYER 2: FOREGROUND (drift ×1.0, fastest) — halftone dots + accent shapes + tape ── */}
      <div style={{ position: "absolute", inset: 0, transform: `translateX(${fgDrift}px)`, pointerEvents: "none" }}>
        {/* halftone dot overlay (screen-print tell) */}
        <div style={{ position: "absolute", inset: 0, backgroundImage: "radial-gradient(circle, rgba(0,0,0,0.10) 1.5px, transparent 2px)", backgroundSize: "14px 14px", opacity: 0.4 }} />
        {/* accent geometric shapes (1-2 per frame, asymmetric) */}
        <div style={{ position: "absolute", top: "7%", right: "8%", width: Math.round(width * 0.035), height: Math.round(width * 0.035), background: ACCENT, borderRadius: "50%", opacity: 0.65 }} />
        <div style={{ position: "absolute", bottom: "12%", left: "6%", width: 0, height: 0, borderLeft: `${Math.round(width * 0.018)}px solid transparent`, borderRight: `${Math.round(width * 0.018)}px solid transparent`, borderBottom: `${Math.round(width * 0.03)}px solid ${ACCENT}`, opacity: 0.5 }} />
        {/* washi tape strips (pinned-to-board feel) */}
        <div style={{ position: "absolute", top: "3%", left: "12%", width: Math.round(width * 0.06), height: Math.round(height * 0.025), background: "rgba(200,180,140,0.55)", transform: "rotate(-7deg)", borderRadius: 1 }} />
        <div style={{ position: "absolute", top: "4%", right: "14%", width: Math.round(width * 0.05), height: Math.round(height * 0.022), background: "rgba(180,160,120,0.5)", transform: "rotate(5deg)", borderRadius: 1 }} />
      </div>

      <LensFX />
    </AbsoluteFill>
  );
}

function sceneRanges(scenes: Scene[], fps: number) {
  const r: { from: number; dur: number }[] = [];
  let t = 0;
  for (const s of scenes) { r.push({ from: Math.round(t * fps), dur: Math.round(s.durationSec * fps) }); t += s.durationSec; }
  return r;
}

export interface BeeSection extends Scene {
  fromColor: string;
  toColor: string;
  overlayText: string;
  motion?: string;
}

export function BeePesticideComposition(props: { scenes: BeeSection[] }) {
  const { fps } = useVideoConfig();
  const sections = props.scenes;
  const ranges = sceneRanges(sections, fps);
  return (
    <AbsoluteFill style={{ backgroundColor: "#f5efe0", fontFamily: "ui-sans-serif, system-ui, sans-serif" }}>
      {sections.map((s, i) => (
        <Sequence key={s.id} from={ranges[i].from} durationInFrames={ranges[i].dur}>
          <BeatBackdrop scene={s} />
          <VoxSubtitles narration={s.narration} accent={ACCENT} />
        </Sequence>
      ))}
      {/* NO 3D props — Vox is flat paper collage. Motion is 2D push-in/parallax only. */}
    </AbsoluteFill>
  );
}
