// storybook-3d-layer.mjs
// A LIVE three.js layer for storybook props — rendered every frame so props
// are REAL 3D (they turn, bank, spin, tilt in 3D), not flat sprites.
//
// Composited onto the 2D storybook canvas each frame: the player draws the
// paper-cutout backdrop (hills, sun, scene illustration), calls renderFrame()
// here, then drawImage(this.canvas) onto the 2D canvas, then captions on top.
//
// Uses an orthographic screen-space camera so props sit at exact 2D positions.
// Both polyfork (createAsset) and sand3d (reversed on three.js) models load
// into this one three.js instance (shared via the import map).

import * as THREE from "three";
import { s3d } from "/sand3d-three.mjs";

// ---- param tuning for polyfork (colorway/season by mood, colour knobs by palette) ----
function seasonForMood(mood) {
  const m = (mood || "").toLowerCase();
  if (/(hope|new|spring|begin)/.test(m)) return "spring";
  if (/(joy|happy|bright|summer)/.test(m)) return "summer";
  if (/(sad|tense|bitter|dark|autumn|wilt|droop)/.test(m)) return "autumn";
  if (/(cozy|quiet|calm|still|winter)/.test(m)) return "winter";
  return "summer";
}
function colorwayForMood(mood, options) {
  const m = (mood || "").toLowerCase();
  if (Array.isArray(options)) {
    if (/(sad|tense|bitter|wilt)/.test(m) && options.includes("autumn-beauty")) return "autumn-beauty";
    if (/(cozy|hope|new|calm|soft)/.test(m) && options.includes("pale-lemon")) return "pale-lemon";
    if (options.includes("golden")) return "golden";
  }
  return null;
}
function tunePolyforkParams(schema, mood, palette) {
  const out = {};
  const paletteColors = (palette && palette.length ? palette : ["#E8B547", "#7A9B6E", "#C7634A"]).slice();
  let ci = 0;
  for (const [name, knob] of Object.entries(schema || {})) {
    const k = knob || {};
    if (k.type === "choice") {
      if (name === "colorway") { const cw = colorwayForMood(mood, k.options); if (cw) out.colorway = cw; }
      else if (name === "season") { const s = seasonForMood(mood); if ((k.options || []).includes(s)) out.season = s; }
    } else if (k.type === "color") {
      out[name] = paletteColors[ci % paletteColors.length]; ci++;
    } else if (k.type === "range") {
      if (name === "growth" && /(hope|new|spring|begin|young)/.test((mood || "").toLowerCase())) out.growth = 0.7;
    }
  }
  return out;
}
function tunePaletteMaterials(root, palette) {
  // LIGHT tuning: blend each non-neutral material toward a palette colour (45%),
  // preserving the model's inherent colour variation so the shape reads clearly.
  const colors = (palette && palette.length ? palette : ["#E8B547", "#7A9B6E", "#C7634A"]).map(h => new THREE.Color(h));
  let idx = 0;
  root.traverse((c) => {
    if (c.isMesh && c.material) {
      const cols = Array.isArray(c.material) ? c.material : [c.material];
      cols.forEach((m) => {
        if (!m.color) return;
        const cur = m.color.clone();
        const mx = Math.max(cur.r, cur.g, cur.b), mn = Math.min(cur.r, cur.g, cur.b);
        const neutral = (mx - mn) < 0.12 && (mx < 0.18 || mx > 0.92);
        if (!neutral) {
          const target = colors[idx % colors.length];
          // blend 45% toward palette colour
          m.color = cur.lerp(target, 0.45);
          idx++;
        }
        m.roughness = 0.82; m.metalness = 0.0; m.flatShading = true;
      });
    }
  });
}

// ---- per-prop 3D animation (true 3D rotation/translation) ----
function classifyProp(name) {
  const n = (name || "").toLowerCase();
  if (/(bee|wasp|fly|insect|butterfly|dragonfly)/.test(n)) return "fly";
  if (/(sun)/.test(n)) return "spin";
  if (/(cloud|mist|fog)/.test(n)) return "drift";
  if (/(tractor|truck|car|vehicle|bike|cart)/.test(n)) return "drive";
  if (/(droplet|rain|drop|tear)/.test(n)) return "fall";
  if (/(ladybug|beetle|bug|ant|spider|cricket)/.test(n)) return "crawl";
  if (/(watering)/.test(n)) return "pour";
  if (/(sprayer|bottle|jug)/.test(n)) return "tilt";
  if (/(flower|sunflower|plant|rose|tulip|daisy|bloom|blossom|seedling|sprout|tree|bush|shrub)/.test(n)) return "sway";
  if (/(honeycomb|hive|nest)/.test(n)) return "bob";
  return "bob";
}
function motion3D(name, t, r) {
  const k = classifyProp(name);
  const ph = (name ? name.charCodeAt(0) % 7 : 0) * 0.5;
  switch (k) {
    case "fly":   return { dx: Math.sin(t*2.2+ph)*r*0.55, dy: Math.sin(t*3.1+ph)*r*0.32, rx: 0, ry: Math.sin(t*2.2+ph)*0.2, rz: Math.sin(t*2.2+ph)*0.18 };
    case "spin":  return { dx: 0, dy: 0, rx: 0, ry: t*0.7, rz: 0 };                  // yaw (turn about vertical)
    case "drift": return { dx: Math.sin(t*0.45+ph)*r*1.3, dy: Math.sin(t*0.6+ph)*r*0.08, rx:0, ry:0, rz:0 };
    case "drive": return { dx: Math.sin(t*0.4+ph)*r*1.4, dy: Math.sin(t*2.5)*r*0.03, rx:0, ry: Math.sin(t*0.4+ph)*0.08, rz: Math.sin(t*0.4+ph)*0.04 };
    case "fall":  { const cyc=(t*0.9)%1.5, fall=cyc/1.5; return { dx: Math.sin(t*4)*r*0.06, dy: fall*r*1.4, rx:0, ry:0, rz: Math.sin(t*3)*0.1 }; }
    case "crawl": return { dx: Math.sin(t*0.6+ph)*r*0.45, dy: Math.sin(t*1.2+ph)*r*0.04, rx:0, ry: Math.sin(t*0.6+ph)*0.1, rz:0 };
    case "tilt":  return { dx:0, dy: Math.sin(t*1.0+ph)*r*0.04, rx:0, ry:0, rz: Math.sin(t*1.0+ph)*0.18 };
    case "pour":  return { dx:0, dy:0, rx:0, ry:0, rz: Math.sin(t*0.7+ph)*0.28 };
    case "sway":  return { dx:0, dy:0, rx: Math.sin(t*1.3+ph)*0.14, ry:0, rz: Math.sin(t*1.3+ph)*0.05 }; // tilt in 3D (about X)
    case "bob":
    default:      return { dx:0, dy: Math.sin(t*1.6+ph)*r*0.06, rx:0, ry:0, rz: Math.sin(t*0.9+ph)*0.04 };
  }
}
// ---- Remotion-style interpolate (deterministic per-frame) ----
function interpolate(input, inRange, outRange, opts = {}) {
  const { extrapolateLeft = "clamp", extrapolateRight = "clamp", easing = (x) => x } = opts;
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  if (input < inRange[0]) { if (extrapolateLeft === "clamp") return outRange[0]; if (extrapolateLeft === "identity") return input; }
  if (input > inRange[inRange.length - 1]) { if (extrapolateRight === "clamp") return outRange[outRange.length - 1]; if (extrapolateRight === "identity") return input; }
  let i = 0; for (; i < inRange.length - 1; i++) { if (input >= inRange[i] && input <= inRange[i + 1]) break; }
  const t = (input - inRange[i]) / (inRange[i + 1] - inRange[i]);
  return outRange[i] + (outRange[i + 1] - outRange[i]) * easing(clamp(t, 0, 1));
}
const Easing = {
  cubic: (t) => t * t * t,
  quad: (t) => t * t,
  out: (e) => (t) => 1 - e(1 - t),
};
function entrance3D(entrance, p) {
  // entrances via Remotion interpolate + Easing (deterministic per frame)
  const alpha = interpolate(p, [0, 0.66], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  switch (entrance) {
    case "pop": {
      let s = interpolate(p, [0, 1], [0.4, 1], { easing: Easing.out(Easing.cubic), extrapolateLeft: "clamp", extrapolateRight: "clamp" });
      s += Math.sin(p * Math.PI) * 0.12 * (1 - p); // overshoot
      return { scale: s, alpha, ox: 0, oy: 0 };
    }
    case "grow": return { scale: interpolate(p, [0, 1], [0, 1], { easing: Easing.out(Easing.quad), extrapolateLeft: "clamp", extrapolateRight: "clamp" }), alpha, ox: 0, oy: 0 };
    case "slide-left": return { scale: 1, alpha, ox: interpolate(p, [0, 1], [-1, 0], { easing: Easing.out(Easing.cubic), extrapolateLeft: "clamp", extrapolateRight: "clamp" }), oy: 0 };
    case "slide-right": return { scale: 1, alpha, ox: interpolate(p, [0, 1], [1, 0], { easing: Easing.out(Easing.cubic), extrapolateLeft: "clamp", extrapolateRight: "clamp" }), oy: 0 };
    case "slide-up": return { scale: 1, alpha, ox: 0, oy: interpolate(p, [0, 1], [1, 0], { easing: Easing.out(Easing.cubic), extrapolateLeft: "clamp", extrapolateRight: "clamp" }) };
    case "fade":
    default: return { scale: 1, alpha, ox: 0, oy: 0 };
  }
}

export class Prop3DLayer {
  constructor() {
    this.canvas = document.createElement("canvas");
    this.canvas.width = 1280; this.canvas.height = 720;
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, alpha: true, antialias: true, preserveDrawingBuffer: true });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-640, 640, 360, -360, -2000, 2000);
    this.camera.position.z = 1000;
    // lights (warm key + cool fill + ambient)
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.35));
    const key = new THREE.DirectionalLight(0xfff4e0, 2.1); key.position.set(1.1, 1.3, 0.7); this.scene.add(key);
    const fill = new THREE.DirectionalLight(0xcfe0ff, 0.55); fill.position.set(-0.9, 0.4, 0.5); this.scene.add(fill);
    const rim = new THREE.DirectionalLight(0xffe0b0, 0.5); rim.position.set(0, -0.5, -0.9); this.scene.add(rim);
    this.W = 1280; this.H = 720;
    // propKey -> { obj, ready }
    this.models = new Map();
    // propId -> object in scene
    this.instances = new Map();
    this._loading = new Map();
  }

  setSize(w, h) {
    this.W = w; this.H = h;
    this.renderer.setSize(w, h, false);
    this.camera.left = -w / 2; this.camera.right = w / 2;
    this.camera.top = h / 2; this.camera.bottom = -h / 2;
    this.camera.updateProjectionMatrix();
  }

  _key(prop, mood, palette) {
    const url = prop.moduleUrl || prop.programUrl || "";
    return `${prop.propSource}:${url}:${mood}:${(palette || []).join(",")}`;
  }

  /** Load + tune a prop model (polyfork createAsset or sand3d shim build). */
  async loadModel(prop, mood, palette) {
    const key = this._key(prop, mood, palette);
    if (this.models.has(key)) return this.models.get(key);
    if (this._loading.has(key)) return this._loading.get(key);
    const p = this._loadModelInner(prop, mood, palette).then((obj) => {
      this.models.set(key, { obj, ready: true });
      this._loading.delete(key);
      return this.models.get(key);
    }).catch((e) => {
      console.warn("[3d-layer] load failed", key, e);
      this._loading.delete(key);
      return null;
    });
    this._loading.set(key, p);
    return p;
  }

  async _loadModelInner(prop, mood, palette) {
    let obj = null;
    if (prop.propSource === "polyfork" && prop.moduleUrl) {
      // fetch params schema
      let schema = {};
      try { if (prop.paramsUrl) { const r = await fetch(prop.paramsUrl); if (r.ok) schema = (await r.json()).params || {}; } } catch {}
      const mod = await import(prop.moduleUrl);
      if (typeof mod.createAsset !== "function") throw new Error("no createAsset");
      const tuned = tunePolyforkParams(schema, mood, palette);
      obj = mod.createAsset(tuned);
      if (!obj) throw new Error("createAsset returned null");
      // polyfork is Y-up already; tune palette
      tunePaletteMaterials(obj, palette);
    } else if (prop.propSource === "sand3d" && prop.programUrl) {
      const mod = await import(prop.programUrl);
      const build = mod.build || mod.default?.build;
      if (typeof build !== "function") throw new Error("no build()");
      const result = build();
      obj = result && result.obj ? result.obj : result;
      if (!obj) throw new Error("build returned null");
      // sand3d is Z-up; rotate -90° X -> Y-up
      obj.rotation.x = -Math.PI / 2;
      obj.updateMatrixWorld(true);
      tunePaletteMaterials(obj, palette);
    } else {
      throw new Error("unknown prop source");
    }
    // normalize: scale so largest dim = 1 unit (baked into the model), base at origin.
    // Then wrap in a Group so renderFrame can set a live scale without losing it.
    const box = new THREE.Box3().setFromObject(obj);
    const size = new THREE.Vector3(); box.getSize(size);
    const maxd = Math.max(size.x, size.y, size.z, 1e-6);
    const s = 1 / maxd;
    obj.scale.setScalar(obj.scale.x * s);
    obj.updateMatrixWorld(true);
    const box2 = new THREE.Box3().setFromObject(obj);
    const c = new THREE.Vector3(); box2.getCenter(c);
    obj.position.x -= c.x;
    obj.position.z -= c.z;
    obj.position.y -= box2.min.y; // base at y=0
    obj.updateMatrixWorld(true);
    const root = new THREE.Group();
    root.add(obj);
    return root;
  }

  /** Preload models for all props across scenes. */
  async preload(scenes) {
    const tasks = [];
    for (const sc of scenes) {
      for (const p of sc.props) {
        if ((p.propSource === "polyfork" && p.moduleUrl) || (p.propSource === "sand3d" && p.programUrl)) {
          tasks.push(this.loadModel(p, sc.mood, sc.palette).then((m) => this._ensureInstance(p.id, m)));
        }
      }
    }
    await Promise.all(tasks);
  }

  _ensureInstance(propId, modelWrap) {
    if (!modelWrap || !modelWrap.ready) return;
    if (this.instances.has(propId)) return;
    const obj = modelWrap.obj;
    this.scene.add(obj);
    obj.visible = false;
    this.instances.set(propId, obj);
  }

  /** Render this frame's active props. activeProps: [{prop, screenX, screenY, r, entranceP, localT}] */
  renderFrame(activeProps) {
    const activeIds = new Set(activeProps.map((a) => a.prop.id));
    // hide inactive
    for (const [id, obj] of this.instances) {
      if (!activeIds.has(id)) obj.visible = false;
    }
    for (const a of activeProps) {
      const obj = this.instances.get(a.prop.id);
      if (!obj) continue;
      obj.visible = true;
      const r = a.r;
      // placement → world (screen-space ortho, Y flipped)
      const wx = a.screenX - this.W / 2;
      const wy = this.H / 2 - a.screenY;
      // entrance
      const e = entrance3D(a.prop.entrance, a.entranceP);
      const entranceOx = e.ox * r * 1.4;
      const entranceOy = e.oy * r * 1.4;
      // motion (true 3D rotation/translation)
      const m = motion3D(a.prop.name, a.localT, r);
      const motionAmt = Math.max(0, Math.min(1, (a.entranceP - 0.6) / 0.4));
      // obj is the root Group; the inner model already holds normalization +
      // (for sand3d) the -90° X orientation. Set only live transform here.
      obj.position.x = wx + entranceOx + m.dx * motionAmt;
      obj.position.y = wy + entranceOy + m.dy * motionAmt;
      obj.position.z = 0;
      const targetScale = r * 3.0 * e.scale;
      obj.scale.set(targetScale, targetScale, targetScale);
      obj.rotation.set(m.rx * motionAmt, m.ry * motionAmt, m.rz * motionAmt);
      obj.visible = e.alpha > 0.01;
      obj.traverse((c) => {
        if (c.isMesh && c.material) {
          const cols = Array.isArray(c.material) ? c.material : [c.material];
          cols.forEach((mm) => { mm.transparent = true; mm.opacity = e.alpha; mm.depthWrite = e.alpha > 0.5; });
        }
      });
    }
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.scene.traverse((o) => {
      if (o.geometry) o.geometry.dispose?.();
      if (o.material) { const ms = Array.isArray(o.material) ? o.material : [o.material]; ms.forEach((m) => { m.map?.dispose?.(); m.dispose?.(); }); }
    });
    this.renderer.dispose();
  }
}
