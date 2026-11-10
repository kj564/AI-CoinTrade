import { s3d } from "/sand3d-three.mjs";

export function build() {
  const base = s3d.box("base", 80, 80, 10);
  const center = s3d.cylinder("center", 40, 20);
  const centerTop = s3d.at(center, { on: base.face("+Z"), z: 10 });

  return s3d.assembly("sunflower_center", base, centerTop);
}