// polyfork-game.mjs — "Polyfork Drive"
// Fully deterministic world layout (no random scatter) + AABB collision with
// per-axis wall-sliding (car slides along walls, never jitters through).

import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

const CDN = (id) => `https://polyfork.dev/cdn/${id}.glb`;
const A = {
  car: "town-car-56eeb6", gems: "power-gem-e28c25",
  bld: ["brownstone-row-house-1b84fd","timber-wash-house-c7e7d5","prewar-apartment-house-1081a6","haunted-victorian-house-886931","boathouse-cf20e6","control-tower-c95a65"],
  tree: ["front-yard-fir-tree-0a278d","lineside-tree-97e02a","toromiro-tree-a50794","lakeside-swing-tree-02c084"],
  prop: ["ammo-crate-ee3ec0","barrel-8d63c4","market-stall-94937d","country-well-8feec8","flower-bicycle-284d0e","mine-cart-94bd76","hayride-wagon-1641de"],
  lamp: "street-oil-lamp-d246ea", fence: "wrought-iron-cemetery-fence-f1a113",
  sign: "taxi-rank-sign-f5f39d", windmill: "windmill-3aad49", flag: "chilean-flag-on-a-8b9693",
  cloud: "towering-cloud-2e00f1", bird: "herring-gull-base",
  animal: ["sheep-base","cow-base","dog-base","chicken-base"],
  npc: ["schoolkid-da94c1","cueca-musician-d71a2e","dragon-slayer-91ab39"],
};

export class PolyforkGame {
  constructor(canvas, { onScore, onWin, onReady } = {}) {
    this.canvas = canvas; this.onScore = onScore; this.onWin = onWin; this.onReady = onReady;
    this.keys = {}; this.gems = []; this.wanderers = []; this.birds = []; this.clouds = [];
    this.traffic = []; this.npcs = []; this.anims = []; this.colliders = [];
    this.score = 0; this.totalGems = 12; this.running = false;
    this.cameraAzimuth = 0; this.mouseDown = false; this.lastMouseX = 0;
    this._init();
  }

  async _init() {
    const W = this.canvas.clientWidth || 1280, H = this.canvas.clientHeight || 720;
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true });
    this.renderer.setSize(W, H, false);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color("#a3d5ff");
    this.scene.fog = new THREE.Fog("#a3d5ff", 80, 220);
    this.camera = new THREE.PerspectiveCamera(55, W / H, 0.1, 600);
    this.camera.position.set(0, 8, 14);
    const sun = new THREE.DirectionalLight("#fff4e0", 2.2);
    sun.position.set(40, 60, 25); sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -90; sun.shadow.camera.right = 90; sun.shadow.camera.top = 90; sun.shadow.camera.bottom = -90;
    sun.shadow.camera.far = 200;
    this.scene.add(sun);
    this.scene.add(new THREE.AmbientLight("#b8d8ff", 0.5));
    this.scene.add(new THREE.HemisphereLight("#b8e0ff", "#6b8f3a", 0.7));
    // ground
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(500, 500), new THREE.MeshStandardMaterial({ color: "#6b8f3a", roughness: 1 }));
    ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; this.scene.add(ground);
    // ring road
    const road = new THREE.Mesh(new THREE.RingGeometry(22, 30, 64), new THREE.MeshStandardMaterial({ color: "#555", roughness: 1 }));
    road.rotation.x = -Math.PI / 2; road.position.y = 0.01; road.receiveShadow = true; this.scene.add(road);
    // plaza
    const plaza = new THREE.Mesh(new THREE.CircleGeometry(10, 32), new THREE.MeshStandardMaterial({ color: "#8a8a7a", roughness: 1 }));
    plaza.rotation.x = -Math.PI / 2; plaza.position.y = 0.02; plaza.receiveShadow = true; this.scene.add(plaza);
    this.loader = new GLTFLoader();
    await this._buildWorld();
    this._bindInput();
    this.onReady?.();
    this._loop();
  }

  async _load(id, x, z, scale, rotY, y = 0, collide = false) {
    let base = this.cache?.get(id);
    if (!base) {
      try { const gltf = await this.loader.loadAsync(CDN(id)); base = gltf.scene; if (!this.cache) this.cache = new Map(); this.cache.set(id, base); }
      catch (e) { console.warn("[game] load failed", id); return null; }
    }
    const m = base.clone(true);
    m.position.set(x, y, z); m.scale.setScalar(scale); m.rotation.y = rotY;
    m.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    m.updateMatrixWorld(true);
    this.scene.add(m);
    if (collide) {
      const box = new THREE.Box3().setFromObject(m);
      this.colliders.push({ minX: box.min.x, maxX: box.max.x, minZ: box.min.z, maxZ: box.max.z });
    }
    return m;
  }

  // ── DETERMINISTIC WORLD LAYOUT (no Math.random for placement) ──
  async _buildWorld() {
    // player car at south of ring road
    this.car = await this._load(A.car, 0, 26, 1.2, Math.PI);
    this.carState = { x: 0, z: 26, heading: Math.PI, speed: 0 };

    // 12 buildings: inner ring at r=38, every 30°, facing center
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * 6.2832, r = 38;
      await this._load(A.bld[i % A.bld.length], Math.cos(a) * r, Math.sin(a) * r, 1.3, a + Math.PI, 0, true);
    }
    // 8 buildings: outer ring at r=60, offset 22.5°
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * 6.2832 + 0.3927, r = 60;
      await this._load(A.bld[(i + 2) % A.bld.length], Math.cos(a) * r, Math.sin(a) * r, 1.5, a + Math.PI, 0, true);
    }
    // 24 trees: two rows at r=32 & r=34.5, every 15° offset 7.5°
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * 6.2832 + 0.1309, r = i % 2 === 0 ? 32 : 34.5;
      await this._load(A.tree[i % A.tree.length], Math.cos(a) * r, Math.sin(a) * r, 0.9, a, 0, true);
    }
    // 16 outer field trees: every 22.5° at r=48
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * 6.2832, r = 48;
      await this._load(A.tree[i % A.tree.length], Math.cos(a) * r, Math.sin(a) * r, 1.1, a, 0, true);
    }
    // 16 street lamps: every 22.5° at r=31 (road edge)
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * 6.2832;
      await this._load(A.lamp, Math.cos(a) * 31, Math.sin(a) * 31, 1, a, 0, true);
    }
    // 8 fence segments: every 45° at r=35.5, offset 22.5°
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * 6.2832 + 0.3927;
      await this._load(A.fence, Math.cos(a) * 35.5, Math.sin(a) * 35.5, 1, a, 0, true);
    }
    // plaza: well at center + 4 market stalls at cardinal directions
    await this._load(A.prop[3], 0, 0, 1, 0, 0, true); // well
    for (let i = 0; i < 4; i++) {
      const a = i * 1.5708, r = 8;
      await this._load(A.prop[2], Math.cos(a) * r, Math.sin(a) * r, 1, a + Math.PI, 0, true);
    }
    // signs at 2 plaza entrances (north + south)
    await this._load(A.sign, 0, 14, 1, 0, 0, true);
    await this._load(A.sign, 0, -14, 1, Math.PI, 0, true);
    // 12 props: every 30° at r=20, offset 15° (between road and buildings)
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * 6.2832 + 0.2618, r = 20;
      await this._load(A.prop[i % A.prop.length], Math.cos(a) * r, Math.sin(a) * r, 0.9, a, 0, true);
    }
    // windmill at fixed position (spinning)
    const wm = await this._load(A.windmill, -55, -50, 1.5, 0, 0, true);
    if (wm) this.anims.push({ obj: wm, fn: (dt) => { wm.rotation.y += dt * 0.5; } });
    // flag at fixed position (waving)
    const fl = await this._load(A.flag, 55, 50, 1.2, 0, 0, true);
    if (fl) this.anims.push({ obj: fl, fn: (dt, t) => { fl.rotation.z = Math.sin(t * 3) * 0.05; } });

    // 12 gems: every 30° at r=26 (ON the ring road — drive past to collect)
    for (let i = 0; i < this.totalGems; i++) {
      const a = (i / 12) * 6.2832 + 0.1309, r = 26;
      const m = await this._load(A.gems, Math.cos(a) * r, Math.sin(a) * r, 0.8, 0, 1.2);
      if (m) { m.userData = { baseY: 1.2, collected: false, phase: i * 0.5 }; this.gems.push(m); }
    }
    // 8 animals: every 45° at r=42 (grazing field between rings)
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * 6.2832 + 0.3927, r = 42;
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      const m = await this._load(A.animal[i % A.animal.length], x, z, 0.8, a);
      if (m) this.wanderers.push({ obj: m, x, z, tx: x, tz: z, speed: 1.2, pickTime: 0 });
    }
    // 4 NPCs: at cardinal directions on the road edge (r=20)
    for (let i = 0; i < 4; i++) {
      const a = i * 1.5708, r = 20;
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      const m = await this._load(A.npc[i % A.npc.length], x, z, 1, a + Math.PI);
      if (m) this.npcs.push({ obj: m, x, z, tx: x, tz: z, speed: 1.8, pickTime: 0 });
    }
    // 3 birds: fixed radii/heights
    for (let i = 0; i < 3; i++) {
      const m = await this._load(A.bird, 0, 0, 1, 0, 0);
      if (m) this.birds.push({ obj: m, t: i * 2.094, r: 15 + i * 6, h: 12 + i * 4, sp: 0.35 });
    }
    // 4 clouds: fixed positions
    for (let i = 0; i < 4; i++) {
      const x = -80 + i * 53, z = -30 + (i % 2) * 60;
      const m = await this._load(A.cloud, x, z, 2.5, 0, 45 + i * 5);
      if (m) this.clouds.push({ obj: m, sp: 0.6 });
    }
    // 3 AI traffic: 120° apart on ring road
    for (let i = 0; i < 3; i++) {
      const m = await this._load(A.car, 0, 0, 1.1, 0);
      if (m) this.traffic.push({ obj: m, angle: i * 2.094, r: 26, sp: 5 });
    }
  }

  _bindInput() {
    window.addEventListener("keydown", (e) => { this.keys[e.key.toLowerCase()] = true; if (["arrowup","arrowdown","arrowleft","arrowright"," "].includes(e.key.toLowerCase())) e.preventDefault(); });
    window.addEventListener("keyup", (e) => { this.keys[e.key.toLowerCase()] = false; });
    this.canvas.addEventListener("mousedown", (e) => { this.mouseDown = true; this.lastMouseX = e.clientX; });
    window.addEventListener("mouseup", () => { this.mouseDown = false; });
    window.addEventListener("mousemove", (e) => { if (this.mouseDown) { this.cameraAzimuth += (e.clientX - this.lastMouseX) * 0.005; this.lastMouseX = e.clientX; } });
    this._onResize = () => { const w = this.canvas.clientWidth, h = this.canvas.clientHeight; if (w&&h) { this.renderer.setSize(w,h,false); this.camera.aspect=w/h; this.camera.updateProjectionMatrix(); } };
    window.addEventListener("resize", this._onResize);
  }

  // ── AABB COLLISION with per-axis wall-sliding ──
  _collidesAABB(x, z) {
    const hw = 1.5, hd = 2.5; // car half-extents
    for (const c of this.colliders) {
      if (x + hw > c.minX && x - hw < c.maxX && z + hd > c.minZ && z - hd < c.maxZ) return true;
    }
    return false;
  }

  _updateCar(dt) {
    if (!this.car || !this.carState) return;
    const s = this.carState, accel = 28, maxSpeed = 32, maxReverse = -14, steerRate = 2.2;
    const gas = this.keys["w"]||this.keys["arrowup"], brake = this.keys["s"]||this.keys["arrowdown"];
    if (gas) s.speed += accel * dt;
    else if (brake) s.speed -= accel * dt;
    else s.speed *= 0.985;
    s.speed = Math.max(maxReverse, Math.min(maxSpeed, s.speed));
    if (Math.abs(s.speed) < 0.03) s.speed = 0;
    const steer = (this.keys["a"]||this.keys["arrowleft"]?1:0) - (this.keys["d"]||this.keys["arrowright"]?1:0);
    s.heading += steer * steerRate * dt * Math.sign(s.speed) * Math.min(1, Math.abs(s.speed) / 8);
    const fwd = new THREE.Vector3(Math.sin(s.heading), 0, Math.cos(s.heading));
    const dx = fwd.x * s.speed * dt, dz = fwd.z * s.speed * dt;
    // per-axis movement: try X, then Z → wall-sliding (car slides along walls, never jitters through)
    if (!this._collidesAABB(s.x + dx, s.z)) s.x += dx;
    else s.speed *= 0.3;
    if (!this._collidesAABB(s.x, s.z + dz)) s.z += dz;
    else s.speed *= 0.3;
    // world bounds
    const b = 95; s.x = Math.max(-b, Math.min(b, s.x)); s.z = Math.max(-b, Math.min(b, s.z));
    this.car.position.set(s.x, 0, s.z); this.car.rotation.y = s.heading; this._speed = Math.abs(s.speed);
  }

  _updateCamera() {
    if (!this.carState) return;
    const s = this.carState, az = s.heading + this.cameraAzimuth + Math.PI;
    this.camera.position.lerp(new THREE.Vector3(s.x + Math.sin(az) * 11, 6, s.z + Math.cos(az) * 11), 0.1);
    this.camera.lookAt(s.x, 1.5, s.z);
  }
  _updateGems(dt, t) {
    if (!this.carState) return;
    const s = this.carState;
    for (const g of this.gems) {
      if (g.userData.collected) continue;
      g.position.y = g.userData.baseY + Math.sin(t * 2 + g.userData.phase) * 0.3;
      g.rotation.y += dt * 2;
      const dx = g.position.x - s.x, dz = g.position.z - s.z;
      if (dx * dx + dz * dz < 9) {
        g.userData.collected = true; g.visible = false; this.score++;
        this.onScore?.(this.score, this.totalGems);
        if (this.score >= this.totalGems) this.onWin?.();
      }
    }
  }
  _updateWanderers(dt) {
    for (const w of this.wanderers.concat(this.npcs)) {
      w.pickTime -= dt;
      if (w.pickTime <= 0) {
        // wander to a nearby deterministic offset (not random scatter)
        w.tx = w.x + Math.cos(w.phase ?? 0) * 8; w.tz = w.z + Math.sin(w.phase ?? 0) * 8;
        w.phase = (w.phase ?? 0) + 1.2; w.pickTime = 4;
      }
      const dx = w.tx - w.x, dz = w.tz - w.z, d = Math.hypot(dx, dz);
      if (d > 0.5) { w.x += (dx / d) * w.speed * dt; w.z += (dz / d) * w.speed * dt; w.obj.rotation.y = Math.atan2(dx, dz); }
      w.obj.position.set(w.x, 0, w.z);
    }
  }
  _updateBirds(dt) {
    for (const b of this.birds) {
      b.t += b.sp * dt;
      b.obj.position.set(Math.cos(b.t) * b.r, b.h + Math.sin(b.t * 2) * 3, Math.sin(b.t) * b.r);
      b.obj.rotation.y = -b.t + Math.PI / 2;
    }
  }
  _updateClouds(dt) {
    for (const c of this.clouds) { c.obj.position.x += c.sp * dt; if (c.obj.position.x > 120) c.obj.position.x = -120; }
  }
  _updateTraffic(dt) {
    for (const tr of this.traffic) {
      tr.angle += (tr.sp / tr.r) * dt;
      tr.obj.position.set(Math.cos(tr.angle) * tr.r, 0, Math.sin(tr.angle) * tr.r);
      tr.obj.rotation.y = -tr.angle + Math.PI / 2;
    }
  }

  _loop = () => {
    if (!this.running) return;
    const now = performance.now(), dt = Math.min(0.05, (now - (this._last || now)) / 1000);
    this._last = now; const t = now / 1000;
    this._updateCar(dt); this._updateCamera(); this._updateGems(dt, t);
    this._updateWanderers(dt); this._updateBirds(dt); this._updateClouds(dt); this._updateTraffic(dt);
    for (const a of this.anims) a.fn(dt, t);
    this.renderer.render(this.scene, this.camera);
    this.rafId = requestAnimationFrame(this._loop);
  };
  start() { this.running = true; this._last = performance.now(); this._loop(); }
  stop() { this.running = false; if (this.rafId) cancelAnimationFrame(this.rafId); }
  getSpeed() { return this._speed || 0; }
  dispose() { this.stop(); window.removeEventListener("resize", this._onResize); this.renderer?.dispose(); }
}
