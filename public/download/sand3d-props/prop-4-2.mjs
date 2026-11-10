import { s3d } from "/sand3d-three.mjs";

export function build() {
  // Body
  const body = s3d.extrude("body", s3d.ellipse(30, 50), 25);
  // Head
  const head = s3d.sphere("head", 18);
  // Wings
  const wingL = s3d.extrude("wingL", s3d.ellipse(25, 15), 2);
  const wingR = s3d.copy(wingL);

  // Placement
  s3d.at(head, { on: body.face("-Z"), z: 14 });
  s3d.at(wingL, { on: body.face("+Y"), z: 10, rx: -20 });
  s3d.at(wingR, { on: body.face("-Y"), z: 10, rx: 20 });

  return s3d.assembly("bee", body, head, wingL, wingR);
}