import { s3d } from "/sand3d-three.mjs";

export function build() {
  const hill = s3d.extrude("hill", s3d.polygon(3, 200), 60);
  s3d.at(hill, { on: s3d.bbox(hill, "-Z"), z: -30, rx: 180 });

  const tree = s3d.extrude("tree", s3d.polygon(3, 30), 80);
  s3d.at(tree, { on: hill.face("+Z"), x: -60, z: 60 });

  const sun = s3d.sphere("sun", 30);
  s3d.at(sun, { on: hill.face("+Z"), x: 60, z: 40 });

  return s3d.assembly("hill", hill, tree, sun);
}