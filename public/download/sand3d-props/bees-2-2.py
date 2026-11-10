import sand3d as s3d
def build():
    a = s3d.sphere("a", 80)
    return s3d.assembly("cloud", a)
if __name__ == "__main__":
    s3d.export(build(), "out.glb")
