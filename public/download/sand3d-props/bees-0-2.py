import sand3d as s3d, math
def build():
    disc = s3d.sphere("disc", 90)
    # place 8 cone rays around the disc using bbox faces
    parts = [disc]
    for i in range(8):
        a = math.radians(i * 45)
        # ray cone placed on the +Z face then we rely on assembly; simple upright rays
        ray = s3d.cone("ray%d" % i, 14, 50, d2=5)
        parts.append(ray)
    return s3d.assembly("sun", *parts)
if __name__ == "__main__":
    s3d.export(build(), "out.glb")
