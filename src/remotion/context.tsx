"use client";
// Reverse-engineered Remotion React core.
// Videos are React components. A <Composition> provides the video config +
// current frame via context. <Sequence> time-shifts children. Hooks
// useCurrentFrame()/useVideoConfig() read the context. delayRender()/
// continueRender() gate async assets so a renderer never captures a frame
// before it is ready.

import React, { createContext, useContext } from "react";

export interface VideoConfig {
  fps: number;
  durationInFrames: number;
  width: number;
  height: number;
  id: string;
}
export interface CompositionContextValue extends VideoConfig {
  frame: number; // the LOCAL frame (relative to the nearest <Sequence>)
}
export const CompositionContext = createContext<CompositionContextValue | null>(null);

export function useCurrentFrame(): number {
  const ctx = useContext(CompositionContext);
  if (!ctx) throw new Error("useCurrentFrame() must be used inside a <Composition>");
  return ctx.frame;
}
export function useVideoConfig(): VideoConfig {
  const ctx = useContext(CompositionContext);
  if (!ctx) throw new Error("useVideoConfig() must be used inside a <Composition>");
  const { fps, durationInFrames, width, height, id } = ctx;
  return { fps, durationInFrames, width, height, id };
}

// ---------------- delayRender / continueRender ----------------
interface DelayHandle { label?: string }
const pending = new Set<DelayHandle>();
const readyListeners = new Set<() => void>();

export function delayRender(label?: string): DelayHandle {
  const h: DelayHandle = { label };
  pending.add(h);
  return h;
}
export function continueRender(handle: DelayHandle): void {
  pending.delete(handle);
  if (pending.size === 0) {
    for (const fn of readyListeners) { try { fn(); } catch { /* ignore */ } }
  }
}
export function cancelRender(handle: DelayHandle): void { pending.delete(handle); }
export function getPendingCount(): number { return pending.size; }
export function onReady(fn: () => void): () => void {
  if (pending.size === 0) { fn(); return () => {}; }
  readyListeners.add(fn);
  return () => { readyListeners.delete(fn); };
}
export function waitForReady(timeoutMs = 30000): Promise<void> {
  return new Promise((resolve) => {
    if (pending.size === 0) return resolve();
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    onReady(finish);
    setTimeout(finish, timeoutMs);
  });
}

export function CompositionProvider({
  value,
  children,
}: {
  value: CompositionContextValue;
  children: React.ReactNode;
}) {
  return <CompositionContext.Provider value={value}>{children}</CompositionContext.Provider>;
}

