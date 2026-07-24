// heat_exchanger_core.csx
// ---------------------------------------------------------------------------
// Parametric gyroid heat-exchanger core — the TEMPLATE for LEAP71-style,
// code-to-geometry work in Anvil.
//
// The pattern below is the whole recipe you reuse for computational parts:
//
//   1. read parameters (Params / ParamF) so one script makes a whole family;
//   2. build a SOLID envelope as Voxels (here a box via MeshUtil.CreateBox);
//   3. define a periodic FIELD (TPMSWall — an IImplicit signed-distance wall);
//   4. INTERSECT the envelope with the field (voxIntersectImplicit) so the
//      lattice is clipped exactly to the envelope;
//   5. SavePart(...) — Anvil meshes it, removes floating islands, checks
//      watertightness, and registers it as a normal part.
//
// A sheet gyroid splits space into two interpenetrating, never-touching flow
// channels separated by one continuous wall — exactly what a counter-flow heat
// exchanger core wants: hot fluid one side, cold the other, huge surface area.
//
// Parameters (all optional; sensible defaults):
//   sizeMM  cube edge length            (default 40)
//   cellMM  gyroid unit-cell size       (default 6)
//   wallMM  wall thickness              (default 0.8)
// ---------------------------------------------------------------------------

float sizeMM = ParamF("sizeMM", 40f);
float cellMM = ParamF("cellMM", 6f);
float wallMM = ParamF("wallMM", 0.8f);

Log($"heat exchanger core: {sizeMM}mm cube, {cellMM}mm cell, {wallMM}mm wall @ voxel {VoxelSizeMM}mm");

// (2) solid cube envelope, centred on the origin.
Mesh mshBox = MeshUtil.CreateBox(new Vector3(sizeMM, sizeMM, sizeMM), Vector3.Zero);
Voxels voxEnvelope = new Voxels(mshBox);

// (3) sheet gyroid field: |gyroid| band of thickness wallMM.
var gyroid = new TPMSWall(
    new Vector3(cellMM, cellMM, cellMM),   // per-axis unit cell
    wallMM,                                // sheet wall thickness
    TPMSWall.EFn.Gyroid,
    TPMSWall.ELattice.Sheet,
    0f,                                    // bias (skeletal only)
    Vector3.Zero,                          // rotation pivot
    Vector3.Zero,                          // rotation (deg)
    Vector3.Zero);                         // phase offset (cell fractions)

// (4) clip the gyroid wall to the cube.
Voxels voxCore = voxEnvelope.voxIntersectImplicit(gyroid);

// (5) register the result part.
SavePart("heat_exchanger_core", voxCore);
