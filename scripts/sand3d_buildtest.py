#!/usr/bin/env python3
"""Test whether a sand3d program builds successfully (no render).

Exits 0 and prints BUILD_OK on success; exits non-zero and prints
BUILD_FAIL: <error> on failure. Used by the authoring self-healing loop.
"""
import sys, os

def main():
    if len(sys.argv) < 2:
        print("BUILD_FAIL: no program", file=sys.stderr); sys.exit(2)
    prog = sys.argv[1]
    import importlib.util
    d = os.path.dirname(os.path.abspath(prog))
    if d not in sys.path:
        sys.path.insert(0, d)
    name = os.path.splitext(os.path.basename(prog))[0]
    spec = importlib.util.spec_from_file_location(name, prog)
    mod = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(mod)
    except Exception as e:
        print(f"BUILD_FAIL: import: {e}", file=sys.stderr); sys.exit(3)
    build = getattr(mod, "build", None)
    if not build:
        print("BUILD_FAIL: no build()", file=sys.stderr); sys.exit(4)
    import bpy
    bpy.ops.wm.read_factory_settings(use_empty=True)
    try:
        build()
        print("BUILD_OK")
        sys.exit(0)
    except Exception as e:
        print(f"BUILD_FAIL: {e}", file=sys.stderr); sys.exit(5)

if __name__ == "__main__":
    main()
