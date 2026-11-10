#!/usr/bin/env python3
"""Render a sand3d program to a transparent 3D PNG sprite (Cycles CPU).

Usage:
  python sand3d_render.py <program.py> <output.png> [palette=hex,hex,...] [mood]

The program must define build() returning an assembly/solid. After building,
the model's materials are TUNED to the scene palette (non-neutral colours are
remapped to palette colours), the object is framed at a 3/4 hero angle, and
rendered with Cycles CPU on a transparent background.
"""
import sys, os, math, ast

def import_program(path):
    import importlib.util
    name = os.path.splitext(os.path.basename(path))[0]
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    # ensure the program's dir is importable (it may import siblings)
    d = os.path.dirname(os.path.abspath(path))
    if d not in sys.path:
        sys.path.insert(0, d)
    spec.loader.exec_module(mod)
    return mod

def hex_to_rgb(h):
    h = h.lstrip("#")
    if len(h) == 3:
        h = "".join(c*2 for c in h)
    return tuple(int(h[i:i+2], 16) / 255.0 for i in (0, 2, 4))

def is_neutral(rgb, tol=0.12):
    r, g, b = rgb
    mx, mn = max(r, g, b), min(r, g, b)
    if mx - mn > tol:  # colourful
        return False
    return mx < 0.18 or mx > 0.92  # very dark or very light

def tune_materials(palette_hex):
    import bpy
    palette = [hex_to_rgb(h) for h in palette_hex if h]
    if not palette:
        return
    idx = 0
    for mat in bpy.data.materials:
        if not mat.use_nodes:
            mat.use_nodes = True
        bsdf = None
        for n in mat.node_tree.nodes:
            if n.type == "BSDF_PRINCIPLED":
                bsdf = n
                break
        if not bsdf:
            continue
        base = bsdf.inputs.get("Base Color")
        if not base:
            continue
        cur = tuple(base.default_value[:3])
        if is_neutral(cur):
            continue  # keep eyes / shadows / white highlights
        base.default_value = (*palette[idx % len(palette)], 1.0)
        idx += 1
        # flat, slightly rough clay/low-poly look
        if "Roughness" in bsdf.inputs:
            bsdf.inputs["Roughness"].default_value = 0.85
        if "Specular IOR Level" in bsdf.inputs:
            bsdf.inputs["Specular IOR Level"].default_value = 0.2
        elif "Specular" in bsdf.inputs:
            bsdf.inputs["Specular"].default_value = 0.2

def frame_and_render(out_png, samples=48, res=512):
    import bpy
    scene = bpy.context.scene
    # collect mesh objects
    meshes = [o for o in bpy.data.objects if o.type == "MESH"]
    if not meshes:
        raise RuntimeError("no mesh objects after build()")
    # origin + apply transforms
    bpy.ops.object.select_all(action="DESELECT")
    for o in meshes:
        o.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    try:
        bpy.ops.object.origin_set(type="ORIGIN_GEOMETRY", center="BOUNDS")
    except Exception:
        pass
    for o in meshes:
        o.location = (0, 0, 0)
    try:
        bpy.ops.object.transform_apply(location=True, rotation=False, scale=True)
    except Exception:
        pass

    # bounding box of all meshes
    xs, ys, zs = [], [], []
    for o in meshes:
        for v in o.bound_box:
            wv = o.matrix_world @ __import__("mathutils").Vector(v)
            xs.append(wv.x); ys.append(wv.y); zs.append(wv.z)
    if not xs:
        raise RuntimeError("empty bounding box")
    cx = (max(xs) + min(xs)) / 2
    cy = (max(ys) + min(ys)) / 2
    cz = (max(zs) + min(zs)) / 2
    sx, sy, sz = max(xs) - min(xs), max(ys) - min(ys), max(zs) - min(zs)
    maxd = max(sx, sy, sz, 1e-6)
    # normalise scale so largest dim = 2
    scale = 2.0 / maxd
    for o in meshes:
        o.scale = (o.scale.x * scale, o.scale.y * scale, o.scale.z * scale)
    try:
        bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    except Exception:
        pass
    # recompute after scale
    xs2, ys2, zs2 = [], [], []
    for o in meshes:
        for v in o.bound_box:
            wv = o.matrix_world @ __import__("mathutils").Vector(v)
            xs2.append(wv.x); ys2.append(wv.y); zs2.append(wv.z)
    maxd2 = max(max(xs2) - min(xs2), max(ys2) - min(ys2), max(zs2) - min(zs2), 1e-6)
    ground_y = min(zs2)

    # camera at 3/4 hero angle
    cam_data = bpy.data.cameras.new("Cam")
    cam_data.lens = 50
    cam = bpy.data.objects.new("Cam", cam_data)
    scene.collection.objects.link(cam)
    dist = (maxd2 / (2 * math.tan(math.radians(32) / 2))) * 1.25
    dirv = (0.9, -0.7, 1.1)
    n = math.sqrt(sum(c*c for c in dirv))
    cam.location = (dirv[0]/n * dist, dirv[1]/n * dist, dirv[2]/n * dist)
    # point camera at model centre (slightly above ground)
    target = (0, 0, (max(zs2)-min(zs2)) * 0.05)
    direction = (target[0]-cam.location[0], target[1]-cam.location[1], target[2]-cam.location[2])
    # look_at via track_to
    track = cam.constraints.new(type="TRACK_TO")
    empty = bpy.data.objects.new("Target", None)
    empty.location = target
    scene.collection.objects.link(empty)
    track.target = empty
    track.track_axis = "TRACK_NEGATIVE_Z"
    track.up_axis = "UP_Y"
    scene.camera = cam

    # lights: warm key + cool fill + hemisphere-ish sun
    key = bpy.data.lights.new("Key", type="AREA")
    key.energy = 800; key.size = 3; key.color = (1.0, 0.96, 0.88)
    ko = bpy.data.objects.new("Key", key); scene.collection.objects.link(ko)
    ko.location = (3, -3, 4); ko.rotation_euler = (math.radians(55), 0, math.radians(35))

    fill = bpy.data.lights.new("Fill", type="AREA")
    fill.energy = 250; fill.size = 4; fill.color = (0.85, 0.92, 1.0)
    fo = bpy.data.objects.new("Fill", fill); scene.collection.objects.link(fo)
    fo.location = (-3, -2, 2); fo.rotation_euler = (math.radians(70), 0, math.radians(-40))

    # ground contact shadow: a dark plane with shadow catcher
    bpy.context.view_layer.cycles.use_denoising = True
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = samples
    scene.cycles.use_denoising = True
    scene.render.film_transparent = True
    scene.render.resolution_x = res
    scene.render.resolution_y = res
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.view_settings.view_transform = "Standard"
    scene.render.filepath = out_png
    bpy.ops.render.render(write_still=True)

def main():
    if len(sys.argv) < 3:
        print("USAGE: sand3d_render.py <program.py> <output.png> [palette] [mood]", file=sys.stderr)
        sys.exit(2)
    prog = sys.argv[1]
    out = sys.argv[2]
    palette = []
    mood = ""
    for a in sys.argv[3:]:
        if a.startswith("#") or "," in a or a.replace("-", "").replace(" ", "").isalnum():
            if "," in a or a.startswith("#"):
                palette = [h.strip() for h in a.split(",") if h.strip()]
            else:
                mood = a
    # parse Next.js passes args after "--"
    # (already handled above)
    import bpy
    bpy.ops.wm.read_factory_settings(use_empty=True)
    try:
        mod = import_program(prog)
    except Exception as e:
        print(f"IMPORT_FAIL: {e}", file=sys.stderr); sys.exit(3)
    build = getattr(mod, "build", None)
    if not build:
        print("NO_BUILD", file=sys.stderr); sys.exit(4)
    # try with params dict, then without
    obj = None
    for args in ({"palette": palette, "mood": mood}, {}):
        try:
            obj = build(**args) if args else build()
            break
        except TypeError:
            continue
        except Exception as e:
            print(f"BUILD_FAIL({args}): {e}", file=sys.stderr)
            continue
    if obj is None:
        # last attempt: build() no kwargs
        try:
            obj = build()
        except Exception as e:
            print(f"BUILD_FAIL_FINAL: {e}", file=sys.stderr); sys.exit(5)
    try:
        tune_materials(palette)
    except Exception as e:
        print(f"TUNE_WARN: {e}", file=sys.stderr)
    try:
        frame_and_render(out)
    except Exception as e:
        print(f"RENDER_FAIL: {e}", file=sys.stderr); sys.exit(6)
    print(f"OK {out} {os.path.getsize(out)}")

if __name__ == "__main__":
    main()
