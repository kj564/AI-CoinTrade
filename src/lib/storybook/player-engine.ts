import type { Scene, SceneProp } from "./types";
import { interpolate, Easing } from "@/lib/remotion/core";

/**
 * Paper-craft motion built on the reverse-engineered Remotion core:
 * entrances + idle motion use interpolate(frame, ...) + Easing, so every frame
 * is deterministic (bit-identical renders — the Remotion property).
 */
const easeOutBack = (t: number) => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
};
const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
const easeOutQuart = (t: number) => 1 - Math.pow(1 - t, 4);
const clamp01 = (t: number) => Math.max(0, Math.min(1, t));

// ---------- per-prop-type animation behaviours ----------
// Classifies a prop by name and returns motion offsets (dx, dy in pixels, rot in
// radians) as a function of time. Gives each prop visible, in-character motion
// instead of just floating: bees fly a figure-8, flowers sway, the sun spins,
// clouds drift, tractors drive, droplets fall, ladybugs crawl.
type Motion = { dx: number; dy: number; rot: number };
function classifyProp(name: string): string {
  const n = name.toLowerCase();
  if (/(bee|wasp|fly|insect|butterfly|dragonfly)/.test(n)) return "fly";
  if (/(sun)/.test(n)) return "spin";
  if (/(cloud|mist|fog)/.test(n)) return "drift";
  if (/(tractor|truck|car|vehicle|bike|cart)/.test(n)) return "drive";
  if (/(droplet|rain|drop|tear)/.test(n)) return "fall";
  if (/(ladybug|beetle|bug|ant|spider|cricket)/.test(n)) return "crawl";
  if (/(sprayer|bottle|can|pour|jug)/.test(n) && !/(watering)/.test(n)) return "tilt";
  if (/(watering)/.test(n)) return "pour";
  if (/(flower|sunflower|plant|rose|tulip|daisy|bloom|blossom|seedling|sprout)/.test(n)) return "sway";
  if (/(honeycomb|hive|nest)/.test(n)) return "bob";
  if (/(tree|bush|shrub|stump)/.test(n)) return "sway";
  return "bob";
}
function propMotion(name: string, t: number, r: number): Motion {
  const k = classifyProp(name);
  const ph = (name ? name.charCodeAt(0) % 7 : 0) * 0.5; // per-prop phase offset
  switch (k) {
    case "fly":
      // figure-8 / lissajous flight + banking
      return { dx: Math.sin(t * 2.2 + ph) * r * 0.55, dy: Math.sin(t * 3.1 + ph) * r * 0.32, rot: Math.sin(t * 2.2 + ph) * 0.18 };
    case "spin":
      return { dx: 0, dy: 0, rot: t * 0.7 };
    case "drift":
      return { dx: Math.sin(t * 0.45 + ph) * r * 1.3, dy: Math.sin(t * 0.6 + ph) * r * 0.08, rot: 0 };
    case "drive":
      return { dx: Math.sin(t * 0.4 + ph) * r * 1.4, dy: Math.sin(t * 2.5) * r * 0.03, rot: Math.sin(t * 0.4 + ph) * 0.04 };
    case "fall": {
      // fall down, loop reset every ~1.5s
      const cyc = (t * 0.9) % 1.5;
      const fall = cyc / 1.5;
      return { dx: Math.sin(t * 4) * r * 0.06, dy: fall * r * 1.4, rot: Math.sin(t * 3) * 0.1 };
    }
    case "crawl":
      return { dx: Math.sin(t * 0.6 + ph) * r * 0.45, dy: Math.sin(t * 1.2 + ph) * r * 0.04, rot: Math.sin(t * 0.6 + ph) * 0.06 };
    case "tilt":
      return { dx: 0, dy: Math.sin(t * 1.0 + ph) * r * 0.04, rot: Math.sin(t * 1.0 + ph) * 0.18 };
    case "pour":
      return { dx: 0, dy: 0, rot: Math.sin(t * 0.7 + ph) * 0.28 };
    case "sway":
      // sway about the base
      return { dx: 0, dy: 0, rot: Math.sin(t * 1.3 + ph) * 0.13 };
    case "bob":
    default:
      return { dx: 0, dy: Math.sin(t * 1.6 + ph) * r * 0.06, rot: Math.sin(t * 0.9 + ph) * 0.04 };
  }
}

interface PlayerOptions {
  onSceneChange?: (index: number, scene: Scene) => void;
  onTick?: (timeSec: number, totalSec: number) => void;
  onEnded?: () => void;
}

interface LoadedScene {
  scene: Scene;
  img: HTMLImageElement | null;
  startSec: number;
  endSec: number;
}

/** The live three.js prop layer (rendered each frame, composited via drawImage). */
export interface Prop3DLayerLike {
  canvas: HTMLCanvasElement;
  setSize: (w: number, h: number) => void;
  preload: (scenes: Scene[]) => Promise<void>;
  renderFrame: (activeProps: ActiveProp[]) => void;
}
export interface ActiveProp {
  prop: SceneProp;
  screenX: number;
  screenY: number;
  r: number;
  entranceP: number;
  localT: number;
}

/** A canvas rendering engine for the paper-cutout storybook. */
export class StorybookPlayer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private scenes: LoadedScene[] = [];
  private totalSec = 0;
  private time = 0;
  private rafId: number | null = null;
  private lastTickMs = 0;
  private playing = false;
  private currentSceneIndex = -1;
  private opts: PlayerOptions;
  // reusable paper texture
  private paperPattern: CanvasPattern | null = null;
  private width = 1280;
  private height = 720;
  // live three.js prop layer (real 3D props composited each frame)
  private layer3d: Prop3DLayerLike | null = null;

  constructor(canvas: HTMLCanvasElement, opts: PlayerOptions = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d", { alpha: false })!;
    this.opts = opts;
    this.buildPaperPattern();
  }

  private buildPaperPattern() {
    const size = 128;
    const c = document.createElement("canvas");
    c.width = size;
    c.height = size;
    const g = c.getContext("2d")!;
    // base
    g.fillStyle = "#fbf3e0";
    g.fillRect(0, 0, size, size);
    // fibrous speckle
    const img = g.createImageData(size, size);
    for (let i = 0; i < img.data.length; i += 4) {
      const n = (Math.random() - 0.5) * 22;
      img.data[i] = 251 + n;
      img.data[i + 1] = 243 + n;
      img.data[i + 2] = 224 + n;
      img.data[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    this.paperPattern = this.ctx.createPattern(c, "repeat");
  }

  /** Load scenes (preloads scene illustrations). Resolves when all decoded (or errored). */
  async load(scenes: Scene[]) {
    // live 3D prop models are preloaded by the Prop3DLayer (set via setLayer3D)
    if (this.layer3d) {
      try { await this.layer3d.preload(scenes); } catch (e) { console.warn("[player] layer3d preload", e); }
    }

    let acc = 0;
    this.scenes = await Promise.all(
      scenes.map(async (scene) => {
        const startSec = acc;
        acc += scene.durationSec;
        const loaded: LoadedScene = { scene, img: null, startSec, endSec: acc };
        if (scene.imageUrl) {
          const img = new Image();
          img.crossOrigin = "anonymous";
          img.src = scene.imageUrl;
          try {
            await img.decode();
            loaded.img = img;
          } catch {
            loaded.img = img; // may still draw once loaded
          }
        }
        return loaded;
      })
    );
    this.totalSec = acc;
    this.resize();
    this.time = 0;
    this.currentSceneIndex = -1;
    this.render(0);
  }

  setSize(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.canvas.width = width;
    this.canvas.height = height;
    if (this.layer3d) this.layer3d.setSize(width, height);
    this.resize();
  }

  private resize() {
    if (!this.canvas.width) {
      this.canvas.width = this.width;
      this.canvas.height = this.height;
    }
  }

  play() {
    if (this.playing) return;
    if (this.time >= this.totalSec - 0.01) this.time = 0;
    this.playing = true;
    this.lastTickMs = performance.now();
    this.rafId = requestAnimationFrame(this.tick);
  }

  pause() {
    this.playing = false;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = null;
  }

  seek(timeSec: number) {
    this.time = Math.max(0, Math.min(this.totalSec, timeSec));
    this.render(this.time);
    this.detectSceneChange();
  }

  isPlaying() {
    return this.playing;
  }

  getTime() {
    return this.time;
  }

  getTotal() {
    return this.totalSec;
  }

  // ---- Remotion-style frame model ----
  private fps = 30;
  setFps(fps: number) { this.fps = fps; }
  getFps() { return this.fps; }
  getTotalFrames() { return Math.round(this.totalSec * this.fps); }
  getFrame() { return Math.round(this.time * this.fps); }
  /** Render exactly one frame (deterministic — used by the frame-by-frame renderer). */
  renderFrame(frame: number) {
    this.render(frame / this.fps);
  }

  getCurrentSceneIndex() {
    return this.currentSceneIndex;
  }

  setOptions(opts: PlayerOptions) {
    this.opts = { ...this.opts, ...opts };
  }

  /** Attach the live three.js prop layer (real 3D props). */
  setLayer3D(layer: Prop3DLayerLike | null) {
    this.layer3d = layer;
    if (layer) layer.setSize(this.canvas.width, this.canvas.height);
  }

  dispose() {
    this.pause();
  }

  private tick = (now: number) => {
    if (!this.playing) return;
    const dt = (now - this.lastTickMs) / 1000;
    this.lastTickMs = now;
    this.time += dt;
    if (this.time >= this.totalSec) {
      this.time = this.totalSec;
      this.playing = false;
      this.render(this.time);
      this.opts.onEnded?.();
      return;
    }
    this.render(this.time);
    this.detectSceneChange();
    this.opts.onTick?.(this.time, this.totalSec);
    this.rafId = requestAnimationFrame(this.tick);
  };

  private detectSceneChange() {
    const idx = this.sceneIndexAt(this.time);
    if (idx !== this.currentSceneIndex) {
      this.currentSceneIndex = idx;
      if (idx >= 0) this.opts.onSceneChange?.(idx, this.scenes[idx].scene);
    }
  }

  private sceneIndexAt(t: number): number {
    for (let i = 0; i < this.scenes.length; i++) {
      const ls = this.scenes[i];
      if (t >= ls.startSec && t < ls.endSec) return i;
    }
    return this.scenes.length - 1;
  }

  // ---------- Rendering ----------

  private render(t: number) {
    const ctx = this.ctx;
    const W = this.canvas.width;
    const H = this.canvas.height;
    ctx.save();

    // Sky gradient (warm cream -> peach)
    const sky = ctx.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, "#fde9c8");
    sky.addColorStop(0.55, "#fadcb4");
    sky.addColorStop(1, "#f6cda0");
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, W, H);

    // paper grain overlay (subtle)
    if (this.paperPattern) {
      ctx.globalAlpha = 0.18;
      ctx.fillStyle = this.paperPattern;
      ctx.fillRect(0, 0, W, H);
      ctx.globalAlpha = 1;
    }

    // Active scene illustration + props
    const idx = this.sceneIndexAt(t);
    const hasSunProp = idx >= 0 && this.scenes[idx].scene.props.some((p) => /sun\b/i.test(p.name) && this.isLive3D(p));
    // Backdrop sun (2D) only when the scene has no live 3D sun prop
    if (!hasSunProp) this.drawSun(t, W, H);

    // Layered green hills (parallax based on time)
    this.drawHills(t, W, H);

    if (idx >= 0) {
      const ls = this.scenes[idx];
      const localT = t - ls.startSec;
      this.drawSceneIllustration(ls, localT, W, H);
      // soft contact shadows under live 3D props (grounds them on the scene)
      if (this.layer3d) this.drawPropShadows(this.collectActiveProps(ls.scene, localT, W, H), W, H);
      // emoji-fallback props drawn on the 2D canvas (props without a 3D source)
      this.drawEmojiProps(ls.scene, localT, W, H);
      // LIVE 3D props composited from the three.js layer (real 3D, animated)
      if (this.layer3d) {
        const active = this.collectActiveProps(ls.scene, localT, W, H);
        this.layer3d.renderFrame(active);
        ctx.drawImage(this.layer3d.canvas, 0, 0, W, H);
      }
      this.drawCaption(ls.scene, localT, W, H);
      this.drawSceneTitle(ls.scene, localT, W, H);
    }

    // Vignette + soft frame
    this.drawVignette(W, H);

    ctx.restore();
  }

  private drawSun(t: number, W: number, H: number) {
    const ctx = this.ctx;
    const cx = W * 0.82 + Math.sin(t * 0.15) * W * 0.01;
    const cy = H * 0.22 + Math.cos(t * 0.2) * H * 0.01;
    const r = Math.min(W, H) * 0.11;
    // glow
    const glow = ctx.createRadialGradient(cx, cy, r * 0.4, cx, cy, r * 2.4);
    glow.addColorStop(0, "rgba(255, 209, 128, 0.55)");
    glow.addColorStop(1, "rgba(255, 209, 128, 0)");
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(cx, cy, r * 2.4, 0, Math.PI * 2);
    ctx.fill();
    // rays (slow rotation)
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(t * 0.08);
    ctx.strokeStyle = "rgba(245, 183, 71, 0.55)";
    ctx.lineWidth = Math.max(3, r * 0.06);
    ctx.lineCap = "round";
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * r * 1.25, Math.sin(a) * r * 1.25);
      ctx.lineTo(Math.cos(a) * r * 1.6, Math.sin(a) * r * 1.6);
      ctx.stroke();
    }
    ctx.restore();
    // disc
    const disc = ctx.createRadialGradient(cx - r * 0.3, cy - r * 0.3, r * 0.2, cx, cy, r);
    disc.addColorStop(0, "#ffe7a3");
    disc.addColorStop(1, "#f2b233");
    ctx.fillStyle = disc;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    // paper edge shadow
    ctx.strokeStyle = "rgba(180, 120, 40, 0.25)";
    ctx.lineWidth = Math.max(2, r * 0.03);
    ctx.stroke();
  }

  private drawHills(t: number, W: number, H: number) {
    const ctx = this.ctx;
    const layers = [
      { y: H * 0.62, amp: H * 0.05, color: "#9fbf8a", speed: 6, shade: 0 },
      { y: H * 0.7, amp: H * 0.06, color: "#7fae6e", speed: 10, shade: 0.05 },
      { y: H * 0.8, amp: H * 0.07, color: "#5e9457", speed: 14, shade: 0.1 },
      { y: H * 0.9, amp: H * 0.05, color: "#4a7a44", speed: 18, shade: 0.16 },
    ];
    for (const layer of layers) {
      ctx.save();
      ctx.fillStyle = layer.color;
      ctx.beginPath();
      ctx.moveTo(0, H);
      const phase = t * layer.speed * 0.04;
      const segs = 6;
      for (let i = 0; i <= segs; i++) {
        const x = (i / segs) * W;
        const y = layer.y + Math.sin(phase + i * 1.3) * layer.amp;
        if (i === 0) ctx.lineTo(x, y);
        else {
          const px = ((i - 0.5) / segs) * W;
          const py = layer.y + Math.sin(phase + (i - 0.5) * 1.3) * layer.amp;
          ctx.quadraticCurveTo(px, py, x, y);
        }
      }
      ctx.lineTo(W, H);
      ctx.closePath();
      ctx.fill();
      // shade overlay for depth
      ctx.fillStyle = `rgba(60, 40, 20, ${layer.shade})`;
      ctx.fill();
      // paper top edge highlight
      ctx.strokeStyle = "rgba(255,255,255,0.18)";
      ctx.lineWidth = Math.max(2, H * 0.004);
      ctx.beginPath();
      ctx.moveTo(0, layer.y);
      for (let i = 0; i <= segs; i++) {
        const x = (i / segs) * W;
        const y = layer.y + Math.sin(phase + i * 1.3) * layer.amp;
        ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.restore();
    }
  }

  private drawSceneIllustration(ls: LoadedScene, localT: number, W: number, H: number) {
    const ctx = this.ctx;
    const { img, scene } = ls;
    if (!img || !img.complete || img.naturalWidth === 0) {
      // placeholder paper card while loading
      this.drawPlaceholderCard(localT, W, H, scene.palette);
      return;
    }
    // frame: a paper card centered, 16:9, leaving hills visible at bottom
    const cardW = W * 0.74;
    const cardH = cardW * (9 / 16);
    const cardX = (W - cardW) / 2;
    const cardY = H * 0.1;

    // entrance: grow + fade in over 0.6s, settle with easeOutBack
    const intro = clamp01(localT / 0.6);
    const eased = easeOutBack(intro);
    const scale = 0.92 + 0.08 * eased;
    const alpha = clamp01(intro * 1.4);

    ctx.save();
    ctx.globalAlpha = alpha;
    const cx = cardX + cardW / 2;
    const cy = cardY + cardH / 2;
    ctx.translate(cx, cy);
    ctx.scale(scale, scale);
    ctx.translate(-cx, -cy);

    // soft drop shadow (paper)
    ctx.save();
    ctx.shadowColor = "rgba(80, 50, 20, 0.28)";
    ctx.shadowBlur = Math.max(8, W * 0.012);
    ctx.shadowOffsetY = Math.max(6, H * 0.01);
    ctx.fillStyle = "#fff8e7";
    this.roundRect(cardX, cardY, cardW, cardH, Math.max(10, W * 0.01));
    ctx.fill();
    ctx.restore();

    // clip image into rounded card
    ctx.save();
    this.roundRect(cardX, cardY, cardW, cardH, Math.max(10, W * 0.01));
    ctx.clip();
    // cover-fit the image
    const ir = img.naturalWidth / img.naturalHeight;
    const cr = cardW / cardH;
    let dw = cardW;
    let dh = cardH;
    if (ir > cr) {
      dh = cardH;
      dw = dh * ir;
    } else {
      dw = cardW;
      dh = dw / ir;
    }
    const dx = cardX + (cardW - dw) / 2;
    const dy = cardY + (cardH - dh) / 2;
    ctx.drawImage(img, dx, dy, dw, dh);
    ctx.restore();

    // card border
    ctx.strokeStyle = "rgba(120, 80, 30, 0.35)";
    ctx.lineWidth = Math.max(2, W * 0.003);
    this.roundRect(cardX, cardY, cardW, cardH, Math.max(10, W * 0.01));
    ctx.stroke();

    ctx.restore();
  }

  private drawPlaceholderCard(localT: number, W: number, H: number, palette: string[]) {
    const ctx = this.ctx;
    const cardW = W * 0.74;
    const cardH = cardW * (9 / 16);
    const cardX = (W - cardW) / 2;
    const cardY = H * 0.1;
    const intro = clamp01(localT / 0.5);
    ctx.save();
    ctx.globalAlpha = intro;
    ctx.fillStyle = "#fff8e7";
    this.roundRect(cardX, cardY, cardW, cardH, Math.max(10, W * 0.01));
    ctx.fill();
    // palette swatches as a "loading" collage
    const n = palette.length || 3;
    const sw = cardW / (n + 1);
    for (let i = 0; i < n; i++) {
      ctx.fillStyle = palette[i] ?? "#E8B547";
      this.roundRect(cardX + sw * (i + 0.5), cardY + cardH * 0.4, sw * 0.6, cardH * 0.2, 6);
      ctx.fill();
    }
    ctx.restore();
  }

  /** Draw emoji-fallback props (those without a live 3D source) on the 2D canvas. */
  private drawEmojiProps(scene: Scene, localT: number, W: number, H: number) {
    const ctx = this.ctx;
    for (const prop of scene.props) {
      if (this.isLive3D(prop)) continue; // handled by the 3D layer
      const p = this.propProgress(prop, localT); // 0..1
      if (p <= 0) continue;
      const pos = this.propPosition(prop.placement, W, H);
      this.drawPropChip(prop, pos.x, pos.y, p, W, H, localT, undefined);
    }
  }

  /** Collect active live-3D props + their screen state for the layer this frame. */
  private collectActiveProps(scene: Scene, localT: number, W: number, H: number): ActiveProp[] {
    const r = Math.min(W, H) * 0.075;
    const out: ActiveProp[] = [];
    for (const prop of scene.props) {
      if (!this.isLive3D(prop)) continue;
      const p = this.propProgress(prop, localT);
      if (p <= 0) continue;
      const pos = this.propPosition(prop.placement, W, H);
      out.push({ prop, screenX: pos.x, screenY: pos.y, r, entranceP: p, localT });
    }
    return out;
  }

  private isLive3D(prop: SceneProp): boolean {
    return (
      (prop.propSource === "polyfork" && !!prop.moduleUrl) ||
      (prop.propSource === "sand3d" && !!prop.programUrl)
    );
  }

  /** Soft contact shadows under live 3D props, drawn on the 2D canvas. */
  private drawPropShadows(active: ActiveProp[], W: number, H: number) {
    const ctx = this.ctx;
    for (const a of active) {
      if (a.entranceP <= 0) continue;
      const e = a.entranceP;
      const r = a.r;
      // shadow sits at the prop's base, slightly below the placement point
      const sx = a.screenX;
      const sy = a.screenY + r * 1.3;
      const sw = r * 2.8 * e;
      const sh = r * 0.8 * e;
      const grad = ctx.createRadialGradient(sx, sy, 1, sx, sy, sw / 2);
      grad.addColorStop(0, "rgba(45, 28, 10, 0.46)");
      grad.addColorStop(0.55, "rgba(45, 28, 10, 0.22)");
      grad.addColorStop(1, "rgba(45, 28, 10, 0)");
      ctx.save();
      ctx.globalAlpha = Math.min(1, e * 1.3);
      ctx.translate(sx, sy);
      ctx.scale(1, sh / (sw / 2));
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(0, 0, sw / 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  private propProgress(prop: SceneProp, localT: number): number {
    // Remotion interpolate: entrance ramps 0->1 over [start, start+dur]
    const start = prop.delay / 1000;
    const dur = 0.5;
    return interpolate(localT, [start, start + dur], [0, 1], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    });
  }

  private propPosition(placement: SceneProp["placement"], W: number, H: number) {
    switch (placement) {
      case "left":   return { x: W * 0.18, y: H * 0.50 };
      case "right":  return { x: W * 0.82, y: H * 0.50 };
      case "top":    return { x: W * 0.5,  y: H * 0.22 };
      case "bottom": return { x: W * 0.5,  y: H * 0.80 };
      default:       return { x: W * 0.5,  y: H * 0.52 };
    }
  }

  private drawPropChip(
    prop: SceneProp,
    x: number,
    y: number,
    p: number,
    W: number,
    H: number,
    localT: number,
    sprite?: HTMLImageElement
  ) {
    const ctx = this.ctx;
    const r = Math.min(W, H) * 0.075;
    // entrances via Remotion interpolate + Easing (deterministic per frame)
    const alpha = interpolate(p, [0, 0.66], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
    let scale = 1;
    let ox = 0;
    let oy = 0;
    switch (prop.entrance) {
      case "pop": {
        scale = interpolate(p, [0, 1], [0.4, 1], { easing: Easing.out(Easing.cubic), extrapolateLeft: "clamp", extrapolateRight: "clamp" });
        // overshoot via back ease
        scale = scale + Math.sin(p * Math.PI) * 0.12 * (1 - p);
        break;
      }
      case "grow": {
        scale = interpolate(p, [0, 1], [0, 1], { easing: Easing.out(Easing.quad), extrapolateLeft: "clamp", extrapolateRight: "clamp" });
        break;
      }
      case "slide-left": {
        ox = interpolate(p, [0, 1], [-W * 0.18, 0], { easing: Easing.out(Easing.cubic), extrapolateLeft: "clamp", extrapolateRight: "clamp" });
        break;
      }
      case "slide-right": {
        ox = interpolate(p, [0, 1], [W * 0.18, 0], { easing: Easing.out(Easing.cubic), extrapolateLeft: "clamp", extrapolateRight: "clamp" });
        break;
      }
      case "slide-up": {
        oy = interpolate(p, [0, 1], [H * 0.18, 0], { easing: Easing.out(Easing.cubic), extrapolateLeft: "clamp", extrapolateRight: "clamp" });
        break;
      }
      case "fade":
      default: {
        break;
      }
    }

    // per-type animation behavior (bees fly, flowers sway, sun spins, clouds
    // drift, tractors drive, droplets fall, ladybugs crawl...). Blends in as
    // the entrance settles so motion ramps up after the prop pops in.
    const motion = propMotion(prop.name, localT, r);
    const motionAmt = clamp01((p - 0.6) / 0.4); // ramp motion in over the last 40% of entrance
    const mdx = motion.dx * motionAmt;
    const mdy = motion.dy * motionAmt;
    const mrot = motion.rot * motionAmt;

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(x + ox + mdx, y + oy + mdy);
    ctx.rotate(mrot);
    ctx.scale(scale, scale);

    if (sprite && sprite.complete && sprite.naturalWidth > 0) {
      // --- Polyfork 3D cutout: draw the transparent sprite as a paper piece ---
      const sw = sprite.naturalWidth;
      const sh = sprite.naturalHeight;
      // fit the sprite into a box ~ r*3.2 tall, preserving aspect
      const boxH = r * 3.4;
      const boxW = boxH * (sw / sh);
      const dw = boxW;
      const dh = boxH;
      const dx = -dw / 2;
      const dy = -dh / 2;

      // soft contact shadow on the ground
      ctx.save();
      ctx.globalAlpha = alpha * 0.28;
      ctx.fillStyle = "rgba(60, 38, 12, 1)";
      ctx.beginPath();
      ctx.ellipse(0, dh / 2 - r * 0.1, dw * 0.34, r * 0.18, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      // the cutout itself, with a paper drop shadow
      ctx.save();
      ctx.shadowColor = "rgba(70, 45, 15, 0.32)";
      ctx.shadowBlur = r * 0.35;
      ctx.shadowOffsetY = r * 0.18;
      ctx.drawImage(sprite, dx, dy, dw, dh);
      ctx.restore();

      // name tag (paper label)
      ctx.font = `600 ${Math.max(11, r * 0.3)}px ui-sans-serif, system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const tagW = Math.max(ctx.measureText(prop.name).width + r * 0.6, r * 1.4);
      const tagH = r * 0.5;
      const tagY = dh / 2 + r * 0.35;
      ctx.fillStyle = "rgba(255, 248, 231, 0.92)";
      this.roundRect(-tagW / 2, tagY - tagH / 2, tagW, tagH, tagH * 0.4);
      ctx.fill();
      ctx.strokeStyle = "rgba(120, 80, 30, 0.3)";
      ctx.lineWidth = Math.max(1, r * 0.03);
      this.roundRect(-tagW / 2, tagY - tagH / 2, tagW, tagH, tagH * 0.4);
      ctx.stroke();
      ctx.fillStyle = "#4a3517";
      ctx.fillText(prop.name, 0, tagY);
    } else {
      // --- Emoji fallback chip ---
      // paper chip shadow
      ctx.save();
      ctx.shadowColor = "rgba(70, 45, 15, 0.3)";
      ctx.shadowBlur = r * 0.25;
      ctx.shadowOffsetY = r * 0.12;
      ctx.fillStyle = "#fff8e7";
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      // paper chip body
      ctx.fillStyle = "#fff8e7";
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "rgba(120, 80, 30, 0.35)";
      ctx.lineWidth = Math.max(2, r * 0.04);
      ctx.stroke();

      // emoji / glyph
      ctx.font = `${r * 1.1}px serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = "#3a2a16";
      ctx.fillText(prop.emoji ?? "★", 0, r * 0.06);

      // name tag
      ctx.font = `600 ${Math.max(12, r * 0.32)}px ui-sans-serif, system-ui, sans-serif`;
      ctx.fillStyle = "rgba(58,42,22,0.9)";
      ctx.fillText(prop.name, 0, r * 1.35);
    }

    ctx.restore();
  }

  private drawCaption(scene: Scene, localT: number, W: number, H: number) {
    const ctx = this.ctx;
    // fade in 0.3s, hold, fade out last 0.4s
    const inP = clamp01(localT / 0.3);
    const outP = clamp01((scene.durationSec - localT) / 0.4);
    const alpha = Math.min(inP, outP);
    if (alpha <= 0) return;

    const pad = W * 0.02;
    const boxW = W * 0.6;
    const fontSize = Math.max(18, H * 0.034);
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.font = `500 ${fontSize}px ui-sans-serif, system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    // wrap
    const maxW = boxW - pad * 2;
    const lines = this.wrapText(scene.narration, maxW);
    const lineH = fontSize * 1.3;
    const boxH = lines.length * lineH + pad * 1.4;
    const bx = (W - boxW) / 2;
    const by = H * 0.86 - boxH / 2;

    // paper scroll background
    ctx.fillStyle = "rgba(255, 248, 231, 0.92)";
    this.roundRect(bx, by, boxW, boxH, Math.max(10, H * 0.02));
    ctx.fill();
    ctx.strokeStyle = "rgba(120, 80, 30, 0.3)";
    ctx.lineWidth = Math.max(2, H * 0.004);
    this.roundRect(bx, by, boxW, boxH, Math.max(10, H * 0.02));
    ctx.stroke();

    ctx.fillStyle = "#4a3517";
    lines.forEach((ln, i) => {
      ctx.fillText(ln, W / 2, by + pad * 0.7 + i * lineH + lineH / 2);
    });
    ctx.restore();
  }

  private drawSceneTitle(scene: Scene, localT: number, W: number, H: number) {
    const ctx = this.ctx;
    const p = clamp01(localT / 0.4);
    if (p <= 0) return;
    const alpha = Math.min(p, clamp01((scene.durationSec - localT) / 0.3));
    if (alpha <= 0) return;
    const fontSize = Math.max(16, H * 0.026);
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.font = `700 ${fontSize}px ui-sans-serif, system-ui, sans-serif`;
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillStyle = "rgba(74,53,23,0.85)";
    ctx.fillText(scene.title, W * 0.04, H * 0.05);
    ctx.restore();
  }

  private drawVignette(W: number, H: number) {
    const ctx = this.ctx;
    const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.3, W / 2, H / 2, Math.max(W, H) * 0.75);
    g.addColorStop(0, "rgba(0,0,0,0)");
    g.addColorStop(1, "rgba(60, 35, 10, 0.22)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }

  private roundRect(x: number, y: number, w: number, h: number, r: number) {
    const ctx = this.ctx;
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  private wrapText(text: string, maxWidth: number): string[] {
    const ctx = this.ctx;
    const words = text.split(/\s+/);
    const lines: string[] = [];
    let cur = "";
    for (const w of words) {
      const test = cur ? cur + " " + w : w;
      if (ctx.measureText(test).width > maxWidth && cur) {
        lines.push(cur);
        cur = w;
      } else {
        cur = test;
      }
    }
    if (cur) lines.push(cur);
    return lines.slice(0, 3);
  }
}
