import { s3d } from "/sand3d-three.mjs";
export function build() {
  const drop = s3d.revolve("drop", [[0,0],[35,0],[45,15],[40,40],[28,65],[12,85],[0,95]]);
  return s3d.assembly("droplet", drop);
}
