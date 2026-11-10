import { s3d } from "/sand3d-three.mjs";

export function build() {
  const body = s3d.extrude("body", s3d.ellipse(40, 25), 30);
  const head = s3d.sphere("head", 20);
  const wing1 = s3d.extrude("wing1", s3d.ellipse(30, 15, 5), 2);
  const wing2 = s3d.extrude("wing2", s3d.ellipse(25, 12, 5), 2);

  s3d.at(head, { on: body.face("+Z"), z: 15 });
  s3d.at(wing1, { on: body.face("-Y"), z: 15, rx: 30 });
  s3d.at(wing2, { on: body.face("-Y"), z: 15, rx: 30, x: -5 });

  return s3d.assembly("bee", body, head, wing1, wing2);
}