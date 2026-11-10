# Render the "pesticide-sprayer" sand3d prop to a transparent PNG sprite.
#
# Setup (once):
#   uv venv --python 3.11          # or 3.13
#   source .venv/bin/activate
#   pip install sand3d bpy pillow
#
# Run:
#   python render_pesticide-sprayer.py
#
# Output: pesticide-sprayer.glb and pesticide-sprayer.png next to this script.

import os
import sand3d as s3d
from pesticide-sprayer import build

out_dir = os.path.dirname(os.path.abspath(__file__))
glb_path = os.path.join(out_dir, "pesticide-sprayer.glb")
png_path = os.path.join(out_dir, "pesticide-sprayer.png")

assembly = build()
s3d.export(assembly, glb_path)
print("wrote", glb_path)

# Render the GLB to a transparent PNG using bpy's Eevee.
import bpy
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=glb_path)

# frame the object
import math
objs = [o for o in bpy.data.objects if o.type == "MESH"]
if objs:
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.origin_set(type="ORIGIN_GEOMETRY", center="BOUNDS")
    objs[0].location = (0, 0, 0)
    bpy.ops.object.transform_apply(location=True, rotation=False, scale=True)

    # camera + light
    cam_data = bpy.data.cameras.new("Cam")
    cam = bpy.data.objects.new("Cam", cam_data)
    bpy.context.scene.collection.objects.link(cam)
    cam.location = (1.6, -2.2, 1.4)
    cam.rotation_euler = (math.radians(65), 0, math.radians(35))
    bpy.context.scene.camera = cam

    light_data = bpy.data.lights.new("Key", type="AREA")
    light_data.energy = 800
    light_data.size = 3
    light = bpy.data.objects.new("Key", light_data)
    light.location = (2, -2, 3)
    bpy.context.scene.collection.objects.link(light)

    bpy.context.scene.render.engine = "BLENDER_EEVEE"
    bpy.context.scene.render.image_settings.file_format = "PNG"
    bpy.context.scene.render.film_transparent = True
    bpy.context.scene.render.resolution_x = 640
    bpy.context.scene.render.resolution_y = 640
    bpy.context.scene.render.filepath = png_path
    bpy.ops.render.render(write_still=True)
    print("wrote", png_path)
