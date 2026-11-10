import { s3d } from "/sand3d-three.mjs";
export function build() {
  const stem = s3d.cylinder("stem", 12, 140);
  const head = s3d.at(s3d.sphere("head", 38), { on: stem.face("+Z"), z: 0, rx: 50 });
  const petals = [];
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    petals.push(s3d.at(s3d.cone("petal" + i, 30, 55, 8), { on: s3d.local(stem, 0, 0, 140, 70, 0, a) }));
  }
  return s3d.assembly("wiltedflower", stem, head, ...petals);
}
