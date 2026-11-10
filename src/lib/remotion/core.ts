// Reverse-engineered Remotion core (https://github.com/remotion-dev/remotion)
// The deterministic, frame-based rendering model: interpolate(), spring(),
// random(), Easing, and the Sequence/Composition frame helpers.
//
// Everything is a pure function of the FRAME — no wall-clock time — so a video
// renders bit-identical every time, and a renderer can step frame-by-frame.

// ---------------- Easing ----------------
type EasingFn = (t: number) => number;
export const Easing = {
  linear: ((t: number) => t) as EasingFn,
  quad: ((t: number) => t * t) as EasingFn,
  cubic: ((t: number) => t * t * t) as EasingFn,
  sin: ((t: number) => 1 - Math.cos((t * Math.PI) / 2)) as EasingFn,
  circle: ((t: number) => 1 - Math.sqrt(1 - t * t)) as EasingFn,
  exp: ((t: number) => Math.pow(2, 10 * (t - 1))) as EasingFn,
  bounce: ((t: number) => {
    if (t < 1 / 2.75) return 7.5625 * t * t;
    if (t < 2 / 2.75) { t -= 1.5 / 2.75; return 7.5625 * t * t + 0.75; }
    if (t < 2.5 / 2.75) { t -= 2.25 / 2.75; return 7.5625 * t * t + 0.9375; }
    t -= 2.625 / 2.75; return 7.5625 * t * t + 0.984375;
  }) as EasingFn,
  in: (easing: EasingFn): EasingFn => (t: number) => easing(t),
  out: (easing: EasingFn): EasingFn => (t: number) => 1 - easing(1 - t),
  inOut: (easing: EasingFn): EasingFn => (t: number) =>
    t < 0.5 ? easing(t * 2) / 2 : 1 - easing((1 - t) * 2) / 2,
  bezier: (x1: number, y1: number, x2: number, y2: number): EasingFn => {
    // cubic-bezier easing (approximation via Newton)
    const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
    const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
    const solveX = (t: number) => { let x = t; for (let i = 0; i < 5; i++) { const v = ((ax * x + bx) * x + cx) * x - t; x -= v / (3 * ax * x * x + 2 * bx * x + cx); } return x; };
    return (t: number) => ((ay * solveX(t) + by) * solveX(t) + cy) * solveX(t);
  },
};

// ---------------- interpolate ----------------
export type ExtrapolateType = "clamp" | "extend" | "identity";
export interface InterpolateOptions {
  extrapolateLeft?: ExtrapolateType;
  extrapolateRight?: ExtrapolateType;
  easing?: EasingFn;
}
const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

export function interpolate(
  input: number,
  inputRange: number[],
  outputRange: number[],
  options: InterpolateOptions = {}
): number {
  const { extrapolateLeft = "clamp", extrapolateRight = "clamp", easing = Easing.linear } = options;
  if (inputRange.length !== outputRange.length) {
    throw new Error("inputRange and outputRange must have the same length");
  }
  if (inputRange.length < 2) {
    throw new Error("inputRange must have at least 2 elements");
  }
  // below range
  if (input < inputRange[0]) {
    if (extrapolateLeft === "clamp") return outputRange[0];
    if (extrapolateLeft === "identity") return input;
  }
  // above range
  if (input > inputRange[inputRange.length - 1]) {
    if (extrapolateRight === "clamp") return outputRange[outputRange.length - 1];
    if (extrapolateRight === "identity") return input;
  }
  // find the segment
  let i = 0;
  for (; i < inputRange.length - 1; i++) {
    if (input >= inputRange[i] && input <= inputRange[i + 1]) break;
  }
  const inMin = inputRange[i], inMax = inputRange[i + 1];
  const outMin = outputRange[i], outMax = outputRange[i + 1];
  const t = (input - inMin) / (inMax - inMin);
  const eased = easing(clamp(t, 0, 1));
  return outMin + (outMax - outMin) * eased;
}

// ---------------- spring ----------------
export interface SpringConfig {
  mass?: number;
  damping?: number;
  stiffness?: number;
  overshootClamping?: boolean;
}
const DEFAULT_SPRING: Required<SpringConfig> = {
  mass: 1,
  damping: 10,
  stiffness: 100,
  overshootClamping: false,
};

export function spring(opts: {
  frame: number;
  fps: number;
  from: number;
  to: number;
  durationInFrames?: number;
  config?: SpringConfig;
}): number {
  const { frame, fps, from, to, config = {} } = opts;
  const c = { ...DEFAULT_SPRING, ...config };
  // damped harmonic oscillator, discrete-stepped at the frame rate
  const w0 = Math.sqrt(c.stiffness / c.mass);
  const zeta = c.damping / (2 * Math.sqrt(c.stiffness * c.mass));
  const dt = 1 / fps;
  let x = from - to; // displacement from target
  let v = 0;
  for (let i = 0; i < frame; i++) {
    const force = -c.stiffness * x - c.damping * v;
    const a = force / c.mass;
    v += a * dt;
    x += v * dt;
    if (c.overshootClamping && (from < to ? x >= 0 : x <= 0)) {
      x = 0; v = 0;
    }
  }
  // ease-out the very start so it doesn't jitter at frame 0
  void w0; void zeta;
  return to + x;
}

// ---------------- random (deterministic, seeded) ----------------
export function random(seed: number | string): number {
  let h = 1779033703 ^ (typeof seed === "string" ? seed.length : seed);
  if (typeof seed === "string") {
    for (let i = 0; i < seed.length; i++) {
      h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
      h = (h << 13) | (h >>> 19);
    }
  } else {
    h = Math.imul(h ^ seed, 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

// ---------------- Sequence frame helper ----------------
// A <Sequence from={F} durationInFrames={D}> only renders children when the
// global frame is within [F, F+D). The children see a LOCAL frame = global - F.
export function seqLocalFrame(globalFrame: number, from: number, durationInFrames: number): number | null {
  if (globalFrame < from) return null;
  if (globalFrame >= from + durationInFrames) return null;
  return globalFrame - from;
}

// ---------------- Composition ----------------
export interface Composition {
  id: string;
  fps: number;
  durationInFrames: number;
  width: number;
  height: number;
  // a render function that draws one frame to a context + 3D layer
  render: (frame: number, ctx: CanvasRenderingContext2D, layer3d: unknown) => void;
}
