// sand3d-three.mjs
// A reverse-engineering of the sand3d modeling vocabulary (sand3d.dev) on top
// of three.js — so sand3d-authored programs run in the BROWSER instead of
// Blender/bpy. Every solid is a real three.js Mesh; every assembly a THREE.Group.
// Combined with polyfork's createAsset(), both prop sources are now three.js 3D
// that can be tuned (material colours) and animated live.
//
// Coordinate system: sand3d is Z-up (objects sit on z=0, extend upward). This
// shim builds in Z-up; the renderer rotates the final assembly -90° about X so
// Z-up becomes three.js Y-up for compositing with polyfork models.
//
// Used by /polyfork-renderer.mjs (renderSand3dProp) and by LLM-authored JS
// programs:  import { s3d } from '/sand3d-three.mjs';  function build(){ ... }

import * as THREE from "three";

// ---------- wrappers ----------
class S3 {
  constructor(obj, name, kind = "solid") {
    this.obj = obj;        // THREE.Mesh | THREE.Group
    this.name = name;
    this.kind = kind;
  }
  face(which) { return frameFromBBox(this.obj, which); }
  edge(which) { return frameFromBBox(this.obj, which); }
}
class Frame {
  constructor(origin, xAxis, yAxis, normal) {
    this.origin = origin;
    this.xAxis = xAxis;
    this.yAxis = yAxis;
    this.normal = normal;
  }
  offset(d) { return new Frame(this.origin.clone().addScaledVector(this.normal, d), this.xAxis, this.yAxis, this.normal); }
  turn(rx = 0, ry = 0, rz = 0) { return this; } // simplified
  move(x = 0, y = 0, z = 0) { return new Frame(this.origin.clone().add(new THREE.Vector3(x, y, z)), this.xAxis, this.yAxis, this.normal); }
  point(x, y, z) { return new THREE.Vector3(x, y, z); }
}

// ---------- materials ----------
let _colorIndex = 0;
const PALETTE_DEFAULT = ["#E8B547", "#7A9B6E", "#C7634A", "#F2B233", "#9AA0A6"];
function nextColor() {
  const c = PALETTE_DEFAULT[_colorIndex % PALETTE_DEFAULT.length];
  _colorIndex++;
  return c;
}
function freshMaterial(color) {
  const m = new THREE.MeshStandardMaterial({
    color: new THREE.Color(color || nextColor()),
    roughness: 0.85,
    metalness: 0.0,
    flatShading: true,
  });
  return m;
}
function mesh(geo, color) {
  const m = new THREE.Mesh(geo, freshMaterial(color));
  return m;
}

// ---------- profiles (return THREE.Shape or Vector2[]) ----------
function rect(w, d, r = 0, chamfer = 0) {
  const s = new THREE.Shape();
  const hw = w / 2, hd = d / 2;
  if (r > 0) {
    // rounded rect
    s.moveTo(-hw + r, -hd);
    s.lineTo(hw - r, -hd);
    s.quadraticCurveTo(hw, -hd, hw, -hd + r);
    s.lineTo(hw, hd - r);
    s.quadraticCurveTo(hw, hd, hw - r, hd);
    s.lineTo(-hw + r, hd);
    s.quadraticCurveTo(-hw, hd, -hw, hd - r);
    s.lineTo(-hw, -hd + r);
    s.quadraticCurveTo(-hw, -hd, -hw + r, -hd);
  } else {
    s.moveTo(-hw, -hd);
    s.lineTo(hw, -hd);
    s.lineTo(hw, hd);
    s.lineTo(-hw, hd);
    s.lineTo(-hw, -hd);
  }
  return s;
}
function circle(d) {
  const s = new THREE.Shape();
  s.absarc(0, 0, d / 2, 0, Math.PI * 2, false);
  return s;
}
function polygon(n, d) {
  const s = new THREE.Shape();
  const r = d / 2;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const x = Math.cos(a) * r, y = Math.sin(a) * r;
    if (i === 0) s.moveTo(x, y); else s.lineTo(x, y);
  }
  s.closePath();
  return s;
}
function ellipse(w, d) {
  const s = new THREE.Shape();
  const a = w / 2, b = d / 2;
  s.moveTo(a, 0);
  s.absellipse(0, 0, a, b, 0, 0, Math.PI * 2, false, 0);
  return s;
}
function slot(l, d) {
  const s = new THREE.Shape();
  const r = d / 2, hl = l / 2;
  s.moveTo(-hl, -r);
  s.lineTo(hl, -r);
  s.absarc(hl, 0, r, -Math.PI / 2, Math.PI / 2, false);
  s.lineTo(-hl, r);
  s.absarc(-hl, 0, r, Math.PI / 2, -Math.PI / 2, false);
  return s;
}
// stubs that still produce a usable shape
function poly(pts, fillet = 0, chamfer = 0) {
  if (Array.isArray(pts) && pts.length) {
    const s = new THREE.Shape();
    pts.forEach((p, i) => { if (i === 0) s.moveTo(p[0], p[1]); else s.lineTo(p[0], p[1]); });
    s.closePath();
    return s;
  }
  return circle(40);
}
function arc(center, r, start, end) { return circle((r || 40) * 2); }
function spline(pts, closed, tangents, loop) { return poly(pts); }
function superellipse(w, d, n = 2, taper = 0) { return ellipse(w, d); }
function station(z, w, d) { return null; } // loft section
function text(s, size, font) { return circle(size * 2); }
function offset(p, t) { return p; }
function stroke(path, t) { return path; }
function wrap(...profiles) { return profiles[0] || circle(40); }
function mirror(p, flip) { return p; }

// ---------- solids ----------
function extrude(name, profile, h, taper = 0, twist = 0, both = false) {
  if (!profile) return box(name, 40, 40, h || 40);
  const geo = new THREE.ExtrudeGeometry(profile, {
    depth: h || 40,
    bevelEnabled: false,
    steps: twist ? 16 : 1,
    // approx twist/taper
  });
  if (twist) {
    // crude twist: shear vertices
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const z = pos.getZ(i);
      const a = (z / (h || 40)) * twist * Math.PI / 180;
      const x = pos.getX(i), y = pos.getY(i);
      pos.setX(i, x * Math.cos(a) - y * Math.sin(a));
      pos.setY(i, x * Math.sin(a) + y * Math.cos(a));
    }
    geo.computeVertexNormals();
  }
  geo.translate(0, 0, 0); // ExtrudeGeometry already base at z=0
  return new S3(mesh(geo), name);
}
function revolve(name, profile, angle = 360) {
  let pts;
  if (Array.isArray(profile)) pts = profile.map(p => new THREE.Vector2(Math.max(p[0], 0), p[1]));
  else if (profile && profile.getPoints) pts = profile.getPoints(48).map(p => new THREE.Vector2(Math.max(p.x, 0), p.y));
  else pts = [new THREE.Vector2(20, 0), new THREE.Vector2(30, 50), new THREE.Vector2(10, 60)];
  // ensure starts at z=0
  const minY = Math.min(...pts.map(p => p.y));
  if (minY !== 0) pts = pts.map(p => new THREE.Vector2(p.x, p.y - minY));
  const geo = new THREE.LatheGeometry(pts, 48, 0, (angle / 360) * Math.PI * 2);
  geo.rotateX(Math.PI / 2); // lathe axis Y -> Z (Z-up)
  // base already at z=0 (profile y starts at 0 -> z=0)
  geo.computeVertexNormals();
  return new S3(mesh(geo), name);
}
function sweep(name, profile, path, scale = 1, twist = 0) {
  // sweep a circular/shape profile along a path of [x,y,z] points
  if (Array.isArray(path) && path.length >= 2) {
    const v3 = path.map(p => new THREE.Vector3(p[0], p[1], p[2]));
    const curve = new THREE.CatmullRomCurve3(v3);
    let radius = 10;
    if (profile && profile.getPoints) {
      const pp = profile.getPoints(8); radius = Math.max(...pp.map(q => Math.hypot(q.x, q.y))) || 10;
    } else if (typeof profile === "number") radius = profile / 2;
    const geo = new THREE.TubeGeometry(curve, Math.max(8, path.length * 4), radius * scale, 12, false);
    return new S3(mesh(geo), name);
  }
  return cylinder(name, 20, 80);
}
function loft(name, ...sections) {
  // sections: array of [r, h] pairs OR shapes; build via lathe of radii at heights
  if (sections.length >= 2 && Array.isArray(sections[0])) {
    const pts = sections.map(s => new THREE.Vector2(Math.max(s[0], 0), s[1]));
    const minY = Math.min(...pts.map(p => p.y));
    if (minY !== 0) pts.forEach((p, i) => pts[i] = new THREE.Vector2(p.x, p.y - minY));
    const geo = new THREE.LatheGeometry(pts, 48);
    geo.rotateX(Math.PI / 2);
    geo.computeVertexNormals();
    return new S3(mesh(geo), name);
  }
  return box(name, 40, 40, 80);
}
function box(name, w, d, h) {
  const geo = new THREE.BoxGeometry(w, h, d);
  geo.translate(0, 0, h / 2); // base at z=0
  return new S3(mesh(geo), name);
}
function cylinder(name, d, h) {
  const geo = new THREE.CylinderGeometry(d / 2, d / 2, h, 32);
  geo.rotateX(Math.PI / 2); // axis Y -> Z
  geo.translate(0, 0, h / 2); // base at z=0
  return new S3(mesh(geo), name);
}
function tube(name, d, d_in, h) {
  const geo = new THREE.CylinderGeometry(d / 2, d / 2, h, 32);
  geo.rotateX(Math.PI / 2);
  geo.translate(0, 0, h / 2);
  return new S3(mesh(geo), name);
}
function cone(name, d, h, d2 = 0) {
  const geo = new THREE.CylinderGeometry(d2 / 2, d / 2, h, 32);
  geo.rotateX(Math.PI / 2);
  geo.translate(0, 0, h / 2);
  return new S3(mesh(geo), name);
}
function sphere(name, d) {
  const geo = new THREE.SphereGeometry(d / 2, 20, 14);
  geo.translate(0, 0, d / 2); // sits ON z=0
  return new S3(mesh(geo), name);
}
function wedge(name, w, d, h, top = 0) { return box(name, w, d, h); }
function torus(name, d, d_wire) {
  const geo = new THREE.TorusGeometry(d / 2 - d_wire / 2, d_wire / 2, 16, 48);
  geo.rotateX(Math.PI / 2); // lie flat
  return new S3(mesh(geo), name);
}
function dome(name, d, h) {
  const geo = new THREE.SphereGeometry(d / 2, 28, 18, 0, Math.PI * 2, 0, Math.PI / 2);
  geo.translate(0, 0, 0);
  return new S3(mesh(geo), name);
}
function body(name, plan, top, bottom, n) { return box(name, 40, 40, 80); }
function wire(name, path, d) { return cylinder(name, d, 40); }
function helix(d, pitch, h) { return cylinder("helix", d, h); }

// ---------- frames / placement ----------
const UP = new THREE.Vector3(0, 0, 1);
function basisFromNormal(n) {
  const normal = n.clone().normalize();
  let xAxis = new THREE.Vector3().crossVectors(UP, normal);
  if (xAxis.lengthSq() < 1e-6) xAxis = new THREE.Vector3(1, 0, 0);
  xAxis.normalize();
  const yAxis = new THREE.Vector3().crossVectors(normal, xAxis).normalize();
  return { xAxis, yAxis, normal };
}
function dirToVec(which) {
  const w = String(which || "").toLowerCase();
  const map = { "+z": [0,0,1], "-z": [0,0,-1], "+y": [0,1,0], "-y": [0,-1,0], "+x": [1,0,0], "-x": [-1,0,0], top: [0,0,1], bottom: [0,0,-1], side: [0,1,0] };
  const d = map[w] || map["+z"];
  return new THREE.Vector3(d[0], d[1], d[2]);
}
function boxOf(obj) {
  const box = new THREE.Box3().setFromObject(obj);
  return box;
}
function frameFromBBox(obj, which) {
  const b = boxOf(obj);
  const c = new THREE.Vector3(); b.getCenter(c);
  const min = b.min, max = b.max;
  // support combos like "+X-Y", "+X-Y+Z" -> corner; single -> face center
  const w = String(which || "+Z");
  const signs = { x: 0, y: 0, z: 0 };
  let cnt = 0;
  for (const ax of ["x","y","z"]) {
    if (w.includes("+" + ax.toUpperCase())) { signs[ax] = 1; cnt++; }
    else if (w.includes("-" + ax.toUpperCase())) { signs[ax] = -1; cnt++; }
  }
  if (cnt === 0) {
    // named face
    const n = dirToVec(w);
    const origin = new THREE.Vector3(c.x, c.y, c.z);
    // project to the face on the normal axis
    if (Math.abs(n.z) > 0.5) origin.z = n.z > 0 ? max.z : min.z;
    else if (Math.abs(n.y) > 0.5) origin.y = n.y > 0 ? max.y : min.y;
    else if (Math.abs(n.x) > 0.5) origin.x = n.x > 0 ? max.x : min.x;
    const { xAxis, yAxis, normal } = basisFromNormal(n);
    return new Frame(origin, xAxis, yAxis, normal);
  }
  // combo: corner/edge
  const origin = new THREE.Vector3(
    signs.x === 1 ? max.x : signs.x === -1 ? min.x : c.x,
    signs.y === 1 ? max.y : signs.y === -1 ? min.y : c.y,
    signs.z === 1 ? max.z : signs.z === -1 ? min.z : c.z,
  );
  // normal: prefer first signed axis
  let n;
  if (signs.x !== 0) n = new THREE.Vector3(signs.x, 0, 0);
  else if (signs.y !== 0) n = new THREE.Vector3(0, signs.y, 0);
  else n = new THREE.Vector3(0, 0, signs.z);
  const { xAxis, yAxis, normal } = basisFromNormal(n);
  return new Frame(origin, xAxis, yAxis, normal);
}
function bbox(obj, which) {
  // obj may be S3 or raw
  const o = obj && obj.obj ? obj.obj : obj;
  return frameFromBBox(o, which);
}

// place a child on a frame, with offsets (x,y,z along frame axes) + rotation (rx,ry,rz about frame axes)
function at(child, opts = {}) {
  const { on: frame, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0 } = opts;
  const o = child && child.obj ? child.obj : child;
  if (!frame) return child;
  // orient child's local +Z to frame.normal, +X to frame.xAxis
  const m = new THREE.Matrix4().makeBasis(frame.xAxis, frame.yAxis, frame.normal);
  // extra rotation about frame-local axes
  const extra = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rx, ry, rz, "XYZ"));
  m.multiply(extra);
  // apply orientation about child's base-center (its local origin): compose
  // position = frame.origin + offset
  const offset = new THREE.Vector3()
    .addScaledVector(frame.xAxis, x)
    .addScaledVector(frame.yAxis, y)
    .addScaledVector(frame.normal, z);
  o.quaternion.setFromRotationMatrix(m);
  o.position.copy(frame.origin).add(offset);
  return child;
}
function transform(child, opts = {}) {
  const { x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, s = 1, mirror } = opts;
  const o = child && child.obj ? child.obj : child;
  o.position.x += x; o.position.y += y; o.position.z += z;
  o.rotation.x += rx; o.rotation.y += ry; o.rotation.z += rz;
  if (s !== 1) o.scale.multiplyScalar(s);
  return child;
}
function local(parent, x, y, z, rx, ry, rz) {
  // a pivot frame in parent's local space
  const origin = new THREE.Vector3(x, y, z);
  const e = new THREE.Euler(rx || 0, ry || 0, rz || 0);
  const m = new THREE.Matrix4().makeRotationFromEuler(e);
  const xAxis = new THREE.Vector3(1,0,0).applyMatrix4(m);
  const yAxis = new THREE.Vector3(0,1,0).applyMatrix4(m);
  const normal = new THREE.Vector3(0,0,1).applyMatrix4(m);
  return new Frame(origin, xAxis, yAxis, normal);
}

// ---------- edits (mostly stubs; join/group/material are real) ----------
function join(a, ...others) {
  // fuse visually: add others into a's group (or make a group)
  const ao = a && a.obj ? a.obj : a;
  if (!a._group) {
    const g = new THREE.Group();
    g.add(ao);
    a._group = g;
  }
  for (const other of others) {
    const oo = other && other.obj ? other.obj : other;
    if (oo && oo.parent !== a._group) a._group.add(oo);
  }
  return a;
}
function group(name, ...parts) {
  const g = new THREE.Group();
  g.name = name;
  for (const p of parts) {
    const o = p && p.obj ? (p._group || p.obj) : p;
    if (o) g.add(o);
  }
  const s = new S3(g, name, "group");
  return s;
}
function assembly(name, ...parts) {
  const g = new THREE.Group();
  g.name = name;
  for (const p of parts) {
    if (!p) continue;
    const o = p._group || (p.obj ? p.obj : p);
    if (o) g.add(o);
  }
  return new S3(g, name, "assembly");
}
function joint(name, child, parent, opts = {}) { return child; } // joints are visual-only here
function copy(obj) {
  const o = obj && obj.obj ? obj.obj : obj;
  const c = o.clone(true);
  if (obj) return new S3(c, obj.name, obj.kind);
  return c;
}
function cut(ob, ...tools) { return ob; }
function intersect(ob, tool) { return ob; }
function split(ob, frame, keep) { return ob; }
function deleteOb(ob) { return ob; }
function hole(ob, d, on, depth, cbore, csk) { return ob; }
function pocket(ob, profile, depth, on) { return ob; }
function merge(...obs) { return assembly("merge", ...obs); }
function scale(ob, s) { const o = ob && ob.obj ? ob.obj : ob; o.scale.multiplyScalar(s); return ob; }
function fillet(ob, r, edges) { return ob; }
function chamfer(ob, d, edges, d2, angle) { return ob; }
function soften(ob, r, angle) { return ob; }
function shell(ob, t, open) { return ob; }
function dent(ob, points, r, depth) { return ob; }
function material(ob, name, params = {}) {
  // set material colour (used for tuning)
  const o = ob && ob.obj ? ob.obj : ob;
  if (params && params.color) {
    o.traverse((c) => {
      if (c.isMesh && c.material) {
        const cols = Array.isArray(c.material) ? c.material : [c.material];
        cols.forEach((m) => { if (m.color) m.color = new THREE.Color(params.color); });
      }
    });
  }
  return ob;
}
function grid(nx, ny, sx, sy) {
  const frames = [];
  for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
    const x = (i - (nx - 1) / 2) * sx;
    const y = (j - (ny - 1) / 2) * sy;
    frames.push(new Frame(new THREE.Vector3(x, y, 0), new THREE.Vector3(1,0,0), new THREE.Vector3(0,1,0), new THREE.Vector3(0,0,1)));
  }
  return frames;
}

// ---------- export / units (no-ops; the renderer captures the scene) ----------
function exportObj(obj, path) { /* no-op in browser */ return path; }
function units(u) { /* no-op */ }
function pose(child, value) { return child; }

// ---------- tuning: recolour materials to a palette ----------
function tuneToPalette(root, palette) {
  const colors = (palette && palette.length ? palette : PALETTE_DEFAULT).map(h => new THREE.Color(h));
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

const s3d = {
  // profiles
  rect, circle, ellipse, slot, polygon, poly, arc, spline, superellipse, station, text, offset, stroke, wrap, mirror,
  // solids
  extrude, revolve, sweep, loft, box, cylinder, tube, cone, sphere, wedge, torus, dome, body, wire, helix,
  // frames
  Frame, bbox, at, transform, local,
  // edits
  join, group, assembly, joint, copy, cut, intersect, split, delete: deleteOb, hole, pocket, merge, scale, fillet, chamfer, soften, shell, dent, material, grid,
  // meta
  export: exportObj, units, pose, tuneToPalette,
};

export { s3d };
