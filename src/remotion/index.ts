// Reverse-engineered Remotion — public API.
// React components + hooks for building videos declaratively, a <Player> for
// preview, and a deterministic frame-by-frame renderer (-> MP4).

export {
  Composition,
  Sequence,
  Series,
  AbsoluteFill,
  Img,
  Audio,
  Freeze,
  Loop,
  registerComposition,
  getComposition,
  getCompositions,
} from "./components";
export {
  useCurrentFrame,
  useVideoConfig,
  delayRender,
  continueRender,
  cancelRender,
  waitForReady,
  getPendingCount,
  CompositionProvider,
  type VideoConfig,
  type CompositionContextValue,
} from "./context";
export { Player, type PlayerHandle, type PlayerProps } from "./Player";
export { Storyboard3D } from "./ThreeCanvas";
export { StoryboardComposition } from "./StoryboardComposition";
export { renderRemotion, type RemotionRenderProgress } from "./Renderer";
export { interpolate, spring, random, Easing, seqLocalFrame, type Composition } from "@/lib/remotion/core";
