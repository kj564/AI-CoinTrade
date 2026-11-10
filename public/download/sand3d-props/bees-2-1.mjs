import { s3d } from "/sand3d-three.mjs";
export function build() {
  const body = s3d.box("body", 200, 95, 65);
  const cabin = s3d.at(s3d.box("cabin", 75, 80, 55), { on: body.face("+Z"), x: -20 });
  const grille = s3d.at(s3d.box("grille", 12, 95, 50), { on: body.face("+X"), z: 0 });
  const exhaust = s3d.at(s3d.cylinder("exhaust", 12, 70), { on: body.face("+Z"), x: 60 });
  const w1 = s3d.at(s3d.cylinder("w1", 52, 34), { on: body.face("-Y"), x: 60, z: -5, rx: 1.5708 });
  const w2 = s3d.at(s3d.cylinder("w2", 52, 34), { on: body.face("-Y"), x: -60, z: -5, rx: 1.5708 });
  const w3 = s3d.at(s3d.cylinder("w3", 52, 34), { on: body.face("+Y"), x: 60, z: -5, rx: 1.5708 });
  const w4 = s3d.at(s3d.cylinder("w4", 52, 34), { on: body.face("+Y"), x: -60, z: -5, rx: 1.5708 });
  return s3d.assembly("tractor", body, cabin, grille, exhaust, w1, w2, w3, w4);
}
