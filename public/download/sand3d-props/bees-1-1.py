import sand3d as s3d
def build():
    cell = s3d.extrude("cell", s3d.polygon(6, 70), 45)
    return s3d.assembly("honeycomb", cell)
if __name__ == "__main__":
    s3d.export(build(), "out.glb")
