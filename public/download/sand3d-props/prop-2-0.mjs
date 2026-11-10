import { s3d } from "/sand3d-three.mjs";

export function build() {
  const body = s3d.extrude("body", s3d.ellipse(25, 35), 12);
  const head = s3d.sphere("head", 15);
  const wing1 = s3d.extrude("wing1", s3d.ellipse(30, 15, 10), 2);
  const wing2 = s3d.copy(wing1);

  s3d.at(head, { on: body.face("-Z"), z: 8 });
  s3d.at(wing1, { on: body.face("+Y"), z: 10, rx: 30 });
  s3d.at(wing2, { on: body.face("-Y"), z: 10, rx: -30 });

  return s3d.assembly("bee", body, head, wing1, wing2);
}