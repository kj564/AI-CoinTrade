import sand3d as s3d

def build():
    # Tank body
    tank = s3d.revolve("tank", [(0, 0), (40, 0), (45, 60), (40, 120), (30, 150), (0, 150)])
    s3d.material(tank, "plastic", color="#4CAF50")
    
    # Handle grip
    grip = s3d.at(s3d.extrude("grip", s3d.rect(25, 60, r=5), 20), 
                  on=s3d.bbox(tank, "+Y"), z=30, rx=90)
    s3d.material(grip, "rubber", color="#795548")
    
    # Pump rod
    rod = s3d.at(s3d.cylinder("rod", 8, 100), 
                  on=s3d.bbox(tank, "+Y"), z=50, rx=90)
    s3d.material(rod, "steel", color="#9E9E9E")
    
    # Wand
    wand = s3d.at(s3d.box("wand", 200, 10, 10), 
                  on=s3d.bbox(tank, "-Y"), z=-150, rx=-90)
    s3d.material(wand, "steel", color="#9E9E9E")
    
    # Nozzle
    nozzle = s3d.at(s3d.cone("nozzle", 15, 30, d2=5), 
                     on=s3d.bbox(wand, "+X"), x=100)
    s3d.material(nozzle, "steel", color="#757575")
    
    # Assembly
    sprayer = s3d.assembly("sprayer", tank, grip, rod, wand, nozzle)
    return sprayer

if __name__ == "__main__":
    s3d.export(build(), "sprayer.glb")