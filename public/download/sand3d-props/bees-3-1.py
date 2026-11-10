import sand3d as s3d
def build():
    drop = s3d.sphere("drop", 60)
    return s3d.assembly("droplet", drop)
if __name__ == "__main__":
    s3d.export(build(), "out.glb")
