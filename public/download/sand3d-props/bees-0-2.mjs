import { s3d } from "/sand3d-three.mjs";
export function build() {
  // big prominent shaded disc + chunky cone rays + ring
  const disc = s3d.sphere("disc", 170);
  const ring = s3d.at(s3d.torus("ring", 210, 22), { on: s3d.local(disc, 0, 0, 0, 0, 0, 0) });
  const parts = [disc, ring];
  const R = 175;
  for (let i = 0; i < 10; i++) {
    const th = (i / 10) * Math.PI * 2;
    const fx = R * Math.cos(th), fy = R * Math.sin(th);
    parts.push(s3d.at(s3d.cone("ray" + i, 22, 70, 7), { on: s3d.local(disc, fx, fy, 0, 0, Math.PI / 2, th) }));
  }
  return s3d.assembly("sun", ...parts);
}
