// polyfork-renderer.mjs
// Loads a polyfork parametric ES module (createAsset), TUNES its knobs to the
// scene's mood + palette (colorway, season, per-zone colours), and renders the
// real 3D model to a transparent PNG sprite using three.js.
//
// Both this module and the polyfork module import the bare "three" specifier,
// resolved by the import map in the page layout — so they share ONE three.js
// instance and createAsset() objects render correctly.
//
// Called from the React app via:
//   const r = await import('/polyfork-renderer.mjs');
//   const dataUrl = await r.renderPropToSprite({ moduleUrl, paramsUrl, mood, palette });

import * as THREE from "three";

const cache = new Map();

// Map a scene mood to a polyfork season knob value (real geometry change).
function seasonForMood(mood) {
  const m = (mood || "").toLowerCase();
  if (/(hope|new|spring|begin)/.test(m)) return "spring";
  if (/(joy|happy|bright|summer)/.test(m)) return "summer";
  if (/(sad|tense|bitter|dark|autumn|wilt|droop)/.test(m)) return "autumn";
  if (/(cozy|quiet|calm|still|winter)/.test(m)) return "winter";
  return "summer";
}
// Map a scene mood to a polyfork colorway knob value (curated palette).
function colorwayForMood(mood, options) {
  const m = (mood || "").toLowerCase();
  if (Array.isArray(options)) {
    if (/(sad|tense|bitter|wilt)/.test(m) && options.includes("autumn-beauty")) return "autumn-beauty";
    if (/(cozy|calm|soft)/.test(m) && options.includes("pale-lemon")) return "pale-lemon";
    if (/(hope|new)/.test(m) && options.includes("pale-lemon")) return "pale-lemon";
    if (options.includes("golden")) return "golden";
  }
  return null;
}

// Build tuned params from the polyfork params schema + scene mood + palette.
function tuneParams(schema, mood, palette) {
  const out = {};
  const paletteColors = (palette && palette.length ? palette : ["#E8B547", "#7A9B6E", "#C7634A"]).slice();
  let colorIdx = 0;
  for (const [name, knob] of Object.entries(schema || {})) {
    const k = knob || {};
    if (k.type === "choice") {
      if (name === "colorway") {
        const cw = colorwayForMood(mood, k.options);
        if (cw) out.colorway = cw;
      } else if (name === "season") {
        if ((k.options || []).includes(seasonForMood(mood))) out.season = seasonForMood(mood);
      }
      // other choice knobs: leave default
    } else if (k.type === "color") {
      // tune each colour zone to a palette colour, cycling
      out[name] = paletteColors[colorIdx % paletteColors.length];
      colorIdx++;
    } else if (k.type === "range") {
      if (name === "growth" && /(hope|new|spring|begin|young)/.test((mood || "").toLowerCase())) {
        out.growth = 0.7; // a younger, smaller bloom for "new beginnings"
      }
    }
  }
  return out;
}

function frameObject(obj, camera, renderer) {
  const box = new THREE.Box3().setFromObject(obj);
  const size = new THREE.Vector3();
  box.getSize(size);
  const center = new THREE.Vector3();
  box.getCenter(center);
  const maxDim = Math.max(size.x, size.y, size.z, 0.001);
  // normalise the object so the largest dimension is ~2 units, centred at origin
  const scale = 2 / maxDim;
  obj.scale.setScalar(obj.scale.x * scale);
  obj.position.sub(center.multiplyScalar(scale));
  // recompute after scale
  const box2 = new THREE.Box3().setFromObject(obj);
  const center2 = new THREE.Vector3();
  box2.getCenter(center2);
  const size2 = new THREE.Vector3();
  box2.getSize(size2);
  const max2 = Math.max(size2.x, size2.y, size2.z, 0.001);
  // camera distance to frame the object
  const fov = (camera.fov * Math.PI) / 180;
  const dist = (max2 / (2 * Math.tan(fov / 2))) * 1.25;
  // 3/4 hero angle: front-right-above
  const dir = new THREE.Vector3(0.9, -0.7, 1.1).normalize();
  camera.position.copy(dir.multiplyScalar(dist));
  camera.lookAt(0, size2.y * 0.05, 0); // look slightly above ground
  camera.near = dist / 100;
  camera.far = dist * 100;
  camera.updateProjectionMatrix();
}

function makeContactShadow(renderer, scene, groundY) {
  // a soft radial-gradient shadow plane under the model
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 256;
  const g = c.getContext("2d");
  const grad = g.createRadialGradient(128, 128, 10, 128, 128, 120);
  grad.addColorStop(0, "rgba(60,40,20,0.42)");
  grad.addColorStop(1, "rgba(60,40,20,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 256, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 3.2), mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = groundY + 0.001;
  scene.add(mesh);
}

/**
 * Render a polyfork parametric model to a transparent PNG data URL.
 * @param {object} opts
 * @param {string} opts.moduleUrl  e.g. https://polyfork.dev/cdn/sunflower-80ce15.mjs
 * @param {string} [opts.paramsUrl] e.g. https://polyfork.dev/cdn/sunflower-80ce15-params.json
 * @param {string} [opts.mood]      scene mood (joyful, sad, hopeful, ...)
 * @param {string[]} [opts.palette] scene palette hexes
 * @param {number} [opts.size]      output square size (default 512)
 * @returns {Promise<string|null>}  data URL, or null on failure
 */
export async function renderPropToSprite({ moduleUrl, paramsUrl, mood, palette, size = 512 }) {
  // fetch params schema (for tuning) and the module in parallel
  const schemaP = (async () => {
    if (!paramsUrl) return {};
    try {
      const r = await fetch(paramsUrl);
      if (!r.ok) return {};
      const j = await r.json();
      return j.params || {};
    } catch {
      return {};
    }
  })();
  const modP = (async () => {
    try {
      return await import(moduleUrl);
    } catch (e) {
      console.warn("[polyfork-renderer] module import failed", moduleUrl, e);
      return null;
    }
  })();

  const [schema, mod] = await Promise.all([schemaP, modP]);
  if (!mod || typeof mod.createAsset !== "function") return null;

  const tuned = tuneParams(schema, mood, palette);
  const cacheKey = moduleUrl + JSON.stringify(tuned);
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  let obj;
  try {
    obj = mod.createAsset(tuned);
  } catch (e) {
    console.warn("[polyfork-renderer] createAsset failed", e);
    // retry with default params (no tuning)
    try {
      obj = mod.createAsset({});
    } catch (e2) {
      console.warn("[polyfork-renderer] createAsset default failed", e2);
      return null;
    }
  }
  if (!obj) return null;

  // scene
  const scene = new THREE.Scene();
  scene.add(obj);

  // ground Y for contact shadow (bottom of the model after framing)
  const box0 = new THREE.Box3().setFromObject(obj);
  const groundY = box0.min.y;

  // lights: warm key + cool fill + hemisphere
  const key = new THREE.DirectionalLight(0xfff4e0, 2.4);
  key.position.set(2.5, 3, 2.5);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xcfe0ff, 0.9);
  fill.position.set(-2, 1.5, -1.5);
  scene.add(fill);
  scene.add(new THREE.HemisphereLight(0xfff3d6, 0x6b5236, 0.7));

  // contact shadow
  try {
    makeContactShadow(null, scene, groundY);
  } catch {
    /* non-fatal */
  }

  // camera + renderer
  const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 100);
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const renderer = new THREE.WebGLRenderer({
    canvas,
    alpha: true,
    antialias: true,
    preserveDrawingBuffer: true,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(size, size, false);
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  frameObject(obj, camera, renderer);
  renderer.render(scene, camera);

  let dataUrl;
  try {
    dataUrl = canvas.toDataURL("image/png");
  } catch (e) {
    console.warn("[polyfork-renderer] toDataURL failed", e);
    dataUrl = null;
  }

  // cleanup
  renderer.dispose();
  scene.traverse((o) => {
    if (o.geometry) o.geometry.dispose?.();
    if (o.material) {
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      mats.forEach((m) => {
        m.map?.dispose?.();
        m.dispose?.();
      });
    }
  });

  if (dataUrl) cache.set(cacheKey, dataUrl);
  return dataUrl;
}

// ---------- shared rendering of an arbitrary THREE.Object3D ----------
function _tunePalette(root, palette) {
  const colors = (palette && palette.length ? palette : ["#E8B547", "#7A9B6E", "#C7634A"]).map(h => new THREE.Color(h));
  let idx = 0;
  root.traverse((c) => {
    if (c.isMesh && c.material) {
      const cols = Array.isArray(c.material) ? c.material : [c.material];
      cols.forEach((m) => {
        if (!m.color) return;
        const cur = m.color;
        const mx = Math.max(cur.r, cur.g, cur.b), mn = Math.min(cur.r, cur.g, cur.b);
        const neutral = (mx - mn) < 0.12 && (mx < 0.18 || mx > 0.92);
        if (!neutral) {
          m.color = colors[idx % colors.length].clone();
          idx++;
        }
        m.roughness = 0.85; m.metalness = 0.0; m.flatShading = true;
      });
    }
  });
}

function _renderThreeObject(obj, size = 512) {
  const scene = new THREE.Scene();
  scene.add(obj);
  const box0 = new THREE.Box3().setFromObject(obj);
  const groundY = box0.min.y;

  const key = new THREE.DirectionalLight(0xfff4e0, 2.4);
  key.position.set(2.5, 3, 2.5);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xcfe0ff, 0.9);
  fill.position.set(-2, 1.5, -1.5);
  scene.add(fill);
  scene.add(new THREE.HemisphereLight(0xfff3d6, 0x6b5236, 0.7));

  try { makeContactShadow(null, scene, groundY); } catch { /* non-fatal */ }

  const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 100);
  const canvas = document.createElement("canvas");
  canvas.width = size; canvas.height = size;
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(size, size, false);
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  frameObject(obj, camera, renderer);
  renderer.render(scene, camera);

  let dataUrl = null;
  try { dataUrl = canvas.toDataURL("image/png"); } catch (e) { console.warn("[renderer] toDataURL failed", e); }

  renderer.dispose();
  scene.traverse((o) => {
    if (o.geometry) o.geometry.dispose?.();
    if (o.material) {
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      mats.forEach((m) => { m.map?.dispose?.(); m.dispose?.(); });
    }
  });
  return dataUrl;
}

/**
 * Render a sand3d-authored JS program (reverse-engineered on three.js) to a
 * transparent PNG sprite. The program imports { s3d } from '/sand3d-three.mjs'
 * and exports build(). Materials are tuned to the scene palette, and the
 * Z-up model is rotated to three.js Y-up before rendering.
 */
export async function renderSand3dProp({ programUrl, palette, mood, size = 512 }) {
  const cacheKey = "sand3d:" + programUrl + JSON.stringify({ palette, mood });
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  let mod;
  try {
    mod = await import(programUrl);
  } catch (e) {
    console.warn("[sand3d-renderer] program import failed", programUrl, e);
    return null;
  }
  const build = mod.build || mod.default?.build;
  if (typeof build !== "function") {
    console.warn("[sand3d-renderer] no build() export");
    return null;
  }

  let result;
  try {
    result = build();
  } catch (e) {
    console.warn("[sand3d-renderer] build() failed", e);
    return null;
  }
  const obj = result && result.obj ? result.obj : result;
  if (!obj) return null;

  // tune material colours to the scene palette (the "tuning")
  _tunePalette(obj, palette);

  // sand3d is Z-up; rotate -90° about X so Z-up -> three.js Y-up
  obj.rotation.x = -Math.PI / 2;
  obj.updateMatrixWorld(true);

  const dataUrl = _renderThreeObject(obj, size);
  if (dataUrl) cache.set(cacheKey, dataUrl);
  return dataUrl;
}
