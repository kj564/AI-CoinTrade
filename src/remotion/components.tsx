"use client";
// Reverse-engineered Remotion React components.
// <Sequence from durationInFrames> time-shifts children (local frame).
// <Series>/<Series.Sequence> lays sequences end-to-end.
// <AbsoluteFill>, <Img> (delayRender until decoded), <Audio>, <Freeze>, <Loop>,
// <Composition> (registration).

import React, { useContext, useEffect, useRef } from "react";
import {
  CompositionContext,
  CompositionContextValue,
  CompositionProvider,
  delayRender,
  continueRender,
} from "./context";

export interface CompositionProps {
  id: string;
  component: React.ComponentType<Record<string, unknown>>;
  durationInFrames: number;
  fps: number;
  width: number;
  height: number;
  defaultProps?: Record<string, unknown>;
}

// module registry of compositions (like Remotion's Root)
const REGISTRY = new Map<string, CompositionProps>();
export function registerComposition(c: CompositionProps) { REGISTRY.set(c.id, c); }
export function getComposition(id: string): CompositionProps | undefined { return REGISTRY.get(id); }
export function getCompositions(): CompositionProps[] { return Array.from(REGISTRY.values()); }

/** <Composition> registers itself (renders null) — like Remotion's Root entry. */
export function Composition(props: CompositionProps) {
  registerComposition(props);
  return null;
}

/** Full-screen positioned container (Remotion's AbsoluteFill). */
export const AbsoluteFill = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  function AbsoluteFill({ style, children, ...rest }, ref) {
    return (
      <div
        ref={ref}
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          ...style,
        }}
        {...rest}
      >
        {children}
      </div>
    );
  }
);

/** <Sequence from durationInFrames> — renders children only within the window,
 *  with a LOCAL frame (children see frame - from). */
export function Sequence({
  from = 0,
  durationInFrames,
  name,
  layout = "absolute-fill",
  children,
}: {
  from?: number;
  durationInFrames?: number;
  name?: string;
  layout?: "absolute-fill" | "none";
  children?: React.ReactNode;
}) {
  const ctx = useContext(CompositionContext);
  if (!ctx) return null;
  const localFrame = ctx.frame - from;
  if (durationInFrames !== undefined) {
    if (localFrame < 0 || localFrame >= durationInFrames) return null;
  }
  const childCtx: CompositionContextValue = { ...ctx, frame: localFrame };
  const inner = (
    <CompositionProvider value={childCtx}>{children}</CompositionProvider>
  );
  void name;
  return layout === "absolute-fill" ? <AbsoluteFill>{inner}</AbsoluteFill> : inner;
}

/** <Series> — lays <Series.Sequence> children end-to-end automatically.
 *  Offsets are pre-computed from each child's durationInFrames (no render-phase
 *  ref mutation). */
function SeriesSequence({
  durationInFrames,
  children,
}: {
  durationInFrames: number;
  children?: React.ReactNode;
}) {
  // from is provided by the parent <Series> via cloning; if used standalone, from=0
  return (
    <Sequence from={0} durationInFrames={durationInFrames}>
      {children}
    </Sequence>
  );
}
export function Series({ children }: { children?: React.ReactNode }) {
  let acc = 0;
  const items: React.ReactNode[] = [];
  React.Children.forEach(children, (child) => {
    if (React.isValidElement(child) && child.type === SeriesSequence) {
      const dur: number = (child.props as { durationInFrames?: number }).durationInFrames ?? 0;
      const kids = (child.props as { children?: React.ReactNode }).children;
      items.push(
        <Sequence key={child.key ?? `s${acc}`} from={acc} durationInFrames={dur}>
          {kids}
        </Sequence>
      );
      acc += dur;
    } else if (React.isValidElement(child)) {
      items.push(<React.Fragment key={child.key ?? `s${acc}`}>{child}</React.Fragment>);
    }
  });
  return <>{items}</>;
}
Series.Sequence = SeriesSequence;

/** <Freeze frame={N}> — render children at a frozen frame. */
export function Freeze({ frame, children }: { frame: number; children?: React.ReactNode }) {
  const ctx = useContext(CompositionContext);
  if (!ctx) return null;
  return <CompositionProvider value={{ ...ctx, frame }}>{children}</CompositionProvider>;
}

/** <Loop durationInFrames> — loop children's frame. */
export function Loop({ durationInFrames, children }: { durationInFrames: number; children?: React.ReactNode }) {
  const ctx = useContext(CompositionContext);
  if (!ctx) return null;
  const f = ((ctx.frame % durationInFrames) + durationInFrames) % durationInFrames;
  return <CompositionProvider value={{ ...ctx, frame: f }}>{children}</CompositionProvider>;
}

/** <Img src> — delays rendering until the image has decoded. */
export function Img({ src, ...rest }: React.ImgHTMLAttributes<HTMLImageElement> & { src: string }) {
  const ref = useRef<HTMLImageElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (el.complete && el.naturalWidth > 0) return;
    const h = delayRender(`Img ${src}`);
    const done = () => continueRender(h);
    el.addEventListener("load", done);
    el.addEventListener("error", done);
    return () => {
      el.removeEventListener("load", done);
      el.removeEventListener("error", done);
      continueRender(h);
    };
  }, [src]);
  return <img ref={ref} src={src} crossOrigin="anonymous" alt="" {...rest} />;
}

/** <Audio src> — audio element (preview playback; renderer muxes separately). */
export function Audio({ src, ...rest }: React.AudioHTMLAttributes<HTMLAudioElement> & { src: string }) {
  return <audio src={src} {...rest} />;
}

export { CompositionProvider };
