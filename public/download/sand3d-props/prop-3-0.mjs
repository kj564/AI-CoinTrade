import { s3d } from "/sand3d-three.mjs";

export function build() {
  const body = s3d.extrude("body", s3d.ellipse(40, 25), 30);
  const head = s3d.sphere("head", 20);
  const stinger = s3d.cylinder("stinger", 5, 15);
  const wing1 = s3d.extrude("wing1", s3d.ellipse(30, 15), 3);
  const wing2 = s3d.extrude("wing2", s3d.ellipse(30, 15), 3);

  s3d.at(body, { on: s3d.bbox(body, "+Z"), z: 15 });
  s3d.at(head, { on: body.face("-Z") });
  s3d.at(stinger, { on: body.face("+Z"), z: 15 });
  s3d.at(wing1, { on: body.face("-Y"), z: 10, rx: -Math.PI/6 });
  s3d.at(wing2, { on: body.face("+Y"), z: 10, rx: Math.PI/6 });

  return s3d.assembly("bee", body, head, stinger, wing1, wing2);
}