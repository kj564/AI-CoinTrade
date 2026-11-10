import sand3d as s3d
def build():
    body = s3d.box("body", 180, 90, 70)
    cabin = s3d.at(s3d.box("cabin", 70, 80, 60), on=body.face("+Z"), z=0)
    wheel1 = s3d.at(s3d.cylinder("wheel1", 50, 30), on=body.face("-Y"), z=0, rx=90)
    wheel2 = s3d.at(s3d.cylinder("wheel2", 50, 30), on=body.face("+Y"), z=0, rx=90)
    return s3d.assembly("tractor", body, cabin, wheel1, wheel2)
if __name__ == "__main__":
    s3d.export(build(), "out.glb")
