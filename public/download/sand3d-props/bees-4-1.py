import sand3d as s3d
def build():
    body = s3d.sphere("body", 70)
    head = s3d.at(s3d.sphere("head", 32), on=s3d.bbox(body, "+Z"), z=-15)
    return s3d.assembly("ladybug", body, head)
if __name__ == "__main__":
    s3d.export(build(), "out.glb")
