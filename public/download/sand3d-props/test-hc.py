import sand3d as s3d

def build():
    # Create honeycomb cells
    cell_size = 20
    cell_depth = 30
    honey_height = 15
    
    # Create a single hexagonal cell
    cell = s3d.extrude("cell", s3d.polygon(6, cell_size), cell_depth)
    
    # Create honey top
    honey = s3d.at(s3d.extrude("honey", s3d.rect(cell_size*1.5, cell_size*1.5, r=2), honey_height), 
                   on=cell.face("top"))
    
    # Create honeycomb base
    base = s3d.box("base", cell_size*3, cell_size*3, 5)
    
    # Place cells on base
    honeycomb = s3d.at(s3d.group("cells", cell, honey), 
                       on=base.face("top"), z=5)
    
    # Add more cells in a simple pattern
    cell2 = s3d.at(s3d.copy(cell), x=cell_size*1.5, on=base.face("top"), z=5)
    honey2 = s3d.at(s3d.copy(honey), x=cell_size*1.5, on=base.face("top"), z=5+honey_height)
    s3d.join(honeycomb, cell2, honey2)
    
    cell3 = s3d.at(s3d.copy(cell), x=-cell_size*1.5, on=base.face("top"), z=5)
    honey3 = s3d.at(s3d.copy(honey), x=-cell_size*1.5, on=base.face("top"), z=5+honey_height)
    s3d.join(honeycomb, cell3, honey3)
    
    cell4 = s3d.at(s3d.copy(cell), y=cell_size*1.5, on=base.face("top"), z=5)
    honey4 = s3d.at(s3d.copy(honey), y=cell_size*1.5, on=base.face("top"), z=5+honey_height)
    s3d.join(honeycomb, cell4, honey4)
    
    cell5 = s3d.at(s3d.copy(cell), y=-cell_size*1.5, on=base.face("top"), z=5)
    honey5 = s3d.at(s3d.copy(honey), y=-cell_size*1.5, on=base.face("top"), z=5+honey_height)
    s3d.join(honeycomb, cell5, honey5)
    
    # Final assembly
    return s3d.assembly("honeycomb", base, honeycomb)

if __name__ == "__main__":
    s3d.export(build(), "honeycomb.glb")