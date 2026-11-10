import { s3d } from "/sand3d-three.mjs";
export function build() {
  const tank = s3d.revolve("tank", [[0,0],[45,0],[55,25],[55,75],[45,105],[30,120],[12,128],[0,130]]);
  const wand = s3d.at(s3d.cylinder("wand", 14, 130), { on: tank.face("+Y"), z: 30, rx: 60 });
  const nozzle = s3d.at(s3d.cone("nozzle", 24, 35, 8), { on: s3d.local(wand, 0, 0, 0, 60, 0, 0) });
  const handle = s3d.at(s3d.box("handle", 80, 18, 18), { on: tank.face("+Z"), z: 0, rx: 0 });
  const trigger = s3d.at(s3d.box("trigger", 18, 14, 36), { on: tank.face("-Y"), z: 40 });
  return s3d.assembly("sprayer", tank, wand, nozzle, handle, trigger);
}
