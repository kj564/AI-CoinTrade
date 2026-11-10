import { s3d } from "/sand3d-three.mjs";

export function build() {
  const stem = s3d.at(
    s3d.extrude("stem", s3d.rect(4, 4), 40),
    { on: s3d.bbox(s3d.assembly("bud"), "bottom"), z: 20 }
  );

  const petal = s3d.at(
    s3d.extrude("petal", s3d.ellipse(15, 8), 2),
    { on: stem.face("+Z"), z: 5, rx: 45 }
  );

  const bud = s3d.assembly("bud", stem, petal);
  s3d.at(bud, { on: s3d.bbox(bud, "bottom"), z: -20 });
  return bud;
}