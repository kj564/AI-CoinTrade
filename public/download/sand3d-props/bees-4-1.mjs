import { s3d } from "/sand3d-three.mjs";
export function build() {
  const body = s3d.sphere("body", 80);
  const head = s3d.at(s3d.sphere("head", 38), { on: s3d.local(body, 55, 0, 20, 0, Math.PI / 2, 0) });
  const spots = [];
  const spotPos = [[20, 25, 35], [-20, 25, 35], [25, -25, 35], [-25, -25, 35]];
  spotPos.forEach((p, i) => {
    spots.push(s3d.at(s3d.sphere("spot" + i, 12), { on: s3d.local(body, p[0], p[1], p[2], 0, 0, 0) }));
  });
  const legs = [];
  for (let i = 0; i < 6; i++) {
    const side = i < 3 ? 1 : -1;
    const idx = i % 3;
    legs.push(s3d.at(s3d.cylinder("leg" + i, 6, 50), { on: s3d.local(body, -10 + idx * 20, side * 45, 10, 0, Math.PI / 2, side > 0 ? 0 : Math.PI) }));
  }
  return s3d.assembly("ladybug", body, head, ...spots, ...legs);
}
