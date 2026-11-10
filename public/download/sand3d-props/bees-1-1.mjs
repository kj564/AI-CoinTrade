import { s3d } from "/sand3d-three.mjs";
export function build() {
  const c0 = s3d.extrude("c0", s3d.polygon(6, 75), 45);
  const parts = [c0];
  const D = 78;
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    parts.push(s3d.at(s3d.extrude("c" + (i + 1), s3d.polygon(6, 75), 45), { on: s3d.local(c0, D * Math.cos(a), D * Math.sin(a), 0, 0, 0, 0) }));
  }
  return s3d.assembly("honeycomb", ...parts);
}
