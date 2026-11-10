import { s3d } from "/sand3d-three.mjs";

export function build() {
  const stem = s3d.box("stem", 10, 10, 60);
  const leaf = s3d.extrude("leaf", s3d.polygon(5, 30), 3);
  const placedLeaf = s3d.at(leaf, { on: stem.face("+Z"), y: -20, rz: 45 });
  return s3d.assembly("stem", stem, placedLeaf);
}