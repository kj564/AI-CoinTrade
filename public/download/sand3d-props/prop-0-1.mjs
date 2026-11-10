import { s3d } from "/sand3d-three.mjs";

export function build() {
  const sun = s3d.assembly("sun");

  const face = s3d.at(s3d.box("face", 200, 200, 2), { on: s3d.bbox(sun, "bottom"), z: 1 });

  const ray = s3d.extrude("ray", s3d.rect(15, 4), 60);
  for (let i = 0; i < 8; i++) {
    const angle = (i / 8) * Math.PI * 2;
    s3d.at(ray, { on: face, x: 80, z: 0, rz: angle });
  }

  const core = s3d.at(s3d.circle(70), { on: face, x: 0, z: 0 });
  return sun;
}