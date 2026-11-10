import { s3d } from "/sand3d-three.mjs";
export function build() {
  const a = s3d.sphere("a", 95);
  const b = s3d.at(s3d.sphere("b", 75), { on: s3d.local(a, 80, 10, 0, 0, 0, 0) });
  const c = s3d.at(s3d.sphere("c", 70), { on: s3d.local(a, -80, 5, 0, 0, 0, 0) });
  const d = s3d.at(s3d.sphere("d", 60), { on: s3d.local(a, 30, 0, 35, 0, 0, 0) });
  const e = s3d.at(s3d.sphere("e", 55), { on: s3d.local(a, -35, 5, 30, 0, 0, 0) });
  const f = s3d.at(s3d.sphere("f", 50), { on: s3d.local(a, 0, -10, 20, 0, 0, 0) });
  return s3d.assembly("cloud", a, b, c, d, e, f);
}
