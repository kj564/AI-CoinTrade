import sand3d as s3d
def build():
    tank = s3d.extrude("tank", s3d.rect(70, 100, r=12), 120)
    nozzle = s3d.at(s3d.cylinder("nozzle", 16, 80), on=tank.face("+Z"), z=20)
    handle = s3d.at(s3d.box("handle", 90, 22, 22), on=tank.face("+Y"), z=60, rx=90)
    trigger = s3d.at(s3d.box("trigger", 20, 16, 40), on=tank.face("-Y"), z=40)
    return s3d.assembly("sprayer", tank, nozzle, handle, trigger)
if __name__ == "__main__":
    s3d.export(build(), "out.glb")
