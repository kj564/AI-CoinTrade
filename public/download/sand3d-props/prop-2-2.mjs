import { s3d } from "/sand3d-three.mjs";

export function build() {
    const body = s3d.extrude("body", s3d.circle(120), 10);
    const sphere = s3d.sphere("sphere", 60);
    s3d.at(sphere, { on: body.face("+Z"), z: -5 });

    return s3d.assembly("pollen", body, sphere);
}