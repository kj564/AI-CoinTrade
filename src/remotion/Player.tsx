"use client";
// Reverse-engineered @remotion/player <Player>.
// Mounts a composition, drives the frame clock (rAF), play/pause/seek/loop,
// and renders the composition React tree into the DOM at composition size
// (CSS-scaled to fit the container). Exposes an imperative handle for the
// renderer to set the frame and capture.

import React, { useEffect, useImperativeHandle, useRef, useState, useCallback, forwardRef } from "react";
import { CompositionProvider, type VideoConfig, waitForReady } from "./context";
import { AbsoluteFill } from "./components";

export interface PlayerHandle {
  seekToFrame: (f: number) => Promise<void>;
  getFrame: () => number;
  getRoot: () => HTMLElement | null;
  play: () => void;
  pause: () => void;
}

export interface PlayerProps {
  component: React.ComponentType<Record<string, unknown>>;
  inputProps?: Record<string, unknown>;
  fps: number;
  durationInFrames: number;
  width: number;
  height: number;
  compositionId?: string;
  autoPlay?: boolean;
  loop?: boolean;
  style?: React.CSSProperties;
  /** render the composition at full size (no CSS scaling) — used by the renderer */
  fullSize?: boolean;
  /** called whenever the current frame changes (for UI controls) */
  onFrameUpdate?: (frame: number) => void;
}

export const Player = forwardRef<PlayerHandle, PlayerProps>(function Player(
  {
    component: Comp,
    inputProps,
    fps,
    durationInFrames,
    width,
    height,
    compositionId = "comp",
    autoPlay = false,
    loop = false,
    style,
    fullSize = false,
    onFrameUpdate,
  },
  ref
) {
  const [frame, setFrame] = useState(0);
  useEffect(() => { onFrameUpdate?.(frame); }, [frame, onFrameUpdate]);
  const [playing, setPlaying] = useState(autoPlay);
  const rootRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef(0);
  useEffect(() => { frameRef.current = frame; }, [frame]);

  const cfg: VideoConfig = { fps, durationInFrames, width, height, id: compositionId };
  const ctxValue = { ...cfg, frame };

  // frame clock
  const pause = useCallback(() => { setPlaying(false); }, []);

  const play = useCallback(() => {
    if (playing) return;
    if (frameRef.current >= durationInFrames - 1) setFrame(0);
    setPlaying(true);
  }, [playing, durationInFrames]);

  useEffect(() => {
    if (!playing) return;
    let startFrame = frameRef.current;
    let startTime: number | null = null;
    let rafId = 0;
    const step = (now: number) => {
      if (startTime === null) { startTime = now; }
      const elapsed = (now - startTime) / 1000;
      let f = startFrame + elapsed * fps;
      if (f >= durationInFrames) {
        if (loop) {
          // wrap, re-baseline
          startFrame = startFrame % durationInFrames;
          f = f % durationInFrames;
          startTime = now;
        } else {
          setFrame(durationInFrames - 1);
          setPlaying(false);
          return;
        }
      }
      setFrame(Math.floor(f));
      rafId = requestAnimationFrame(step);
    };
    rafId = requestAnimationFrame(step);
    return () => { cancelAnimationFrame(rafId); };
  }, [playing, fps, durationInFrames, loop]);

  const seekToFrame = useCallback(async (f: number) => {
    setFrame(Math.max(0, Math.min(durationInFrames - 1, Math.round(f))));
    // wait for delayRender handles (async assets) to resolve
    await waitForReady(10000);
  }, [durationInFrames]);

  useImperativeHandle(ref, () => ({
    seekToFrame,
    getFrame: () => frameRef.current,
    getRoot: () => rootRef.current,
    play,
    pause,
  }), [seekToFrame, play, pause]);

  // scale to fit container (preview); renderer uses fullSize (scale 1)
  const containerStyle: React.CSSProperties = fullSize
    ? { width, height, position: "relative", overflow: "hidden", ...style }
    : { width: "100%", height: "100%", position: "relative", overflow: "hidden", ...style };

  return (
    <div ref={rootRef} style={containerStyle}>
      <CompositionProvider value={ctxValue}>
        <AbsoluteFill style={{ width, height, transform: fullSize ? undefined : "scale(var(--sb-scale, 1))", transformOrigin: "top left" }}>
          <Comp {...(inputProps || {})} />
        </AbsoluteFill>
      </CompositionProvider>
    </div>
  );
});
