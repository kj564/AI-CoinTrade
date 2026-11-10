import sand3d as s3d
def build():
    stem = s3d.cylinder("stem", 12, 120)
    petal = s3d.at(s3d.cone("petal", 50, 60, d2=10), on=stem.face("+Z"), z=0)
    return s3d.assembly("wiltedflower", stem, petal)
if __name__ == "__main__":
    s3d.export(build(), "out.glb")
