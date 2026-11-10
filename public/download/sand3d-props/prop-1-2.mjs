import { s3d } from "/sand3d-three.mjs";

export function build() {
  const cloud = s3d.assembly("cloud");

  const main = s3d.extrude("main", s3d.circle(120), 30);
  const p1 = s3d.extrude("p1", s3d.circle(60), 25);
  const p2 = s3d.extrude("p2", s3d.circle(70), 25);
  const p3 = s3d.extrude("p3", s3d.circle(50), 20);

  s3d.at(p1, { on: main.face("+X"), x: 30, z: 15 });
  s3d.at(p2, { on: main.face("-X"), x: -30, z: 15 });
  s3d.at(p3, { on: main.face("+Y"), y: 30, z: 15 });

  return s3d.join(cloud, main, p1, p2, p3);
}