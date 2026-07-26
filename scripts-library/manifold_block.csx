// manifold_block.csx
// ---------------------------------------------------------------------------
// A ported pneumatic manifold: drilled port bores, an internal gallery that
// joins them, and a gyroid lattice filling that gallery. This is the whole
// ANVIL story in one script, written as code instead of clicked in a CAD tree.
//
// WHAT THIS DEMONSTRATES
//   Box          the billet.
//   Cylinder     one port bore, drilled from the top face down to the gallery.
//   ArrayLinear  repeating that bore along X on a fixed pitch, so "6 ports at
//                18 mm" is a parameter change and not a redraw.
//   Pipe         the gallery: a polyline swept round, so the right-angle turn
//                out of the side face rounds itself and every joint stays
//                watertight. This is the passage a drill press cannot make.
//   Union        collecting bores plus gallery into one cavity solid.
//   Subtract     cutting that cavity out of the billet in a single call.
//   Intersect    trimming the gallery back to the part, so the lattice never
//                grows out of the open ends.
//   Lattice      filling the gallery with a TPMS sheet gyroid, clipped exactly
//                to the cavity: a flow conditioner and a print support in one,
//                fused to the manifold wall because the two fields share a
//                voxel grid.
//   Volume       the infill fraction, measured rather than assumed.
//
// LAYOUT
//   X runs along the port line. Y is up. The gallery runs along X below the
//   bores, then turns out through the +Z face as the supply connection, and
//   the -X end face carries the return.
//
// PARAMETERS (all optional)
//   ports          number of port bores                         (default 4)
//   spacingMM      port pitch along X                           (default 20)
//   boreDiaMM      port bore diameter                           (default 6)
//   galleryDiaMM   internal gallery diameter                    (default 12)
//   wallMM         wall between a passage and the outside       (default 4)
//   cellMM         lattice unit cell                            (default 6)
//   latticeWallMM  lattice sheet thickness                      (default 0.9)
//   pattern        gyroid | schwarzP | schwarzD | lidinoid | neovius
//                                                               (default gyroid)
//
// RUNTIME
//   About 5 s at voxelSizeMM 0.3 (the API default). The lattice is the
//   expensive half; set cellMM larger for a quicker look.
// ---------------------------------------------------------------------------

int    ports         = (int)Math.Round(ParamF("ports", 4f));
double spacingMM     = ParamF("spacingMM", 20f);
double boreDiaMM     = ParamF("boreDiaMM", 6f);
double galleryDiaMM  = ParamF("galleryDiaMM", 12f);
double wallMM        = ParamF("wallMM", 4f);
double cellMM        = ParamF("cellMM", 6f);
double latticeWallMM = ParamF("latticeWallMM", 0.9f);
string pattern       = ParamS("pattern", "gyroid");

if (ports < 1) throw new ArgumentException($"ports must be at least 1 (got {ports})");
if (spacingMM <= boreDiaMM)
    throw new ArgumentException($"spacingMM ({spacingMM}) must exceed boreDiaMM ({boreDiaMM}) or the bores merge");
if (galleryDiaMM < boreDiaMM)
    throw new ArgumentException($"galleryDiaMM ({galleryDiaMM}) should be at least boreDiaMM ({boreDiaMM})");
if (latticeWallMM < 2 * VoxelSizeMM)
    throw new ArgumentException($"latticeWallMM {latticeWallMM} is under two voxels at {VoxelSizeMM} mm");

// ---------------------------------------------------------------------------
// 1. Sizes derived from the port pattern. Change ports or spacing and the
//    billet, the gallery and the lattice all follow.
// ---------------------------------------------------------------------------
double blockLenMM = (ports - 1) * spacingMM + galleryDiaMM + 2 * wallMM;   // along X
double blockWidMM = galleryDiaMM + 2 * wallMM;                             // along Z
double blockHgtMM = galleryDiaMM + 2 * wallMM + 8;                         // along Y

double galleryY   = -blockHgtMM * 0.5 + wallMM + galleryDiaMM * 0.5;       // gallery axis height
double topY       = blockHgtMM * 0.5;
double boreHgt    = (topY + 1) - galleryY;                                 // bore breaks into the gallery
double boreCentreY = (galleryY + topY + 1) * 0.5;
double firstBoreX = -(ports - 1) * spacingMM * 0.5;

Log($"manifold: {ports} ports dia {boreDiaMM:0.##} at {spacingMM:0.##} mm pitch, gallery dia {galleryDiaMM:0.##}, " +
    $"billet {blockLenMM:0.##} x {blockHgtMM:0.##} x {blockWidMM:0.##} mm, voxel {VoxelSizeMM} mm");

// ---------------------------------------------------------------------------
// 2. The billet.
// ---------------------------------------------------------------------------
Shape block = Box(blockLenMM, blockHgtMM, blockWidMM);

// ---------------------------------------------------------------------------
// 3. The port bores. One cylinder, repeated along X.
// ---------------------------------------------------------------------------
Shape oneBore = Cylinder(d: boreDiaMM, h: boreHgt, at: V(firstBoreX, boreCentreY, 0));
Shape bores   = ArrayLinear(oneBore, ports, V(spacingMM, 0, 0));

// ---------------------------------------------------------------------------
// 4. The gallery. It runs the length of the port line, then turns out through
//    the +Z face. Pipe rounds the corner for you; both open ends are pushed
//    2 mm past the billet so they break cleanly through the faces.
// ---------------------------------------------------------------------------
double turnX = blockLenMM * 0.5 - galleryDiaMM * 0.75;
var galleryPath = new List<Vec3>
{
    V(-blockLenMM * 0.5 - 2, galleryY, 0),          // return, out of the -X face
    V(turnX,                 galleryY, 0),          // the run under every bore
    V(turnX,                 galleryY, blockWidMM * 0.5 + 2),  // supply, out of the +Z face
};
Shape gallery = Pipe(galleryPath, galleryDiaMM);

// ---------------------------------------------------------------------------
// 5. Drill it. Bores and gallery become one cavity, removed in one Subtract.
// ---------------------------------------------------------------------------
Shape cavity = Union(bores, gallery);
Shape drilled = Subtract(block, cavity);

double vSolid  = Volume(block);
double vCavity = vSolid - Volume(drilled);
Log($"drilled: {vCavity:0.#} mm3 of passage removed from a {vSolid:0.#} mm3 billet " +
    $"({100.0 * vCavity / vSolid:0.#}% hollow)");

// ---------------------------------------------------------------------------
// 6. Fill the gallery with a lattice. Intersect the gallery with the billet
//    first, so the stubs poking out of the faces stay clear; then clip the
//    bores back out so every port keeps an open path to the gallery.
// ---------------------------------------------------------------------------
Shape galleryInside = Intersect(gallery, block);
double vGallery = Volume(galleryInside);

Shape fill = Lattice(galleryInside, pattern: pattern, cell: cellMM, wall: latticeWallMM, type: "sheet");
fill = Subtract(fill, bores);
double vFill = Volume(fill);

Log($"lattice: {pattern} cell {cellMM:0.##} mm wall {latticeWallMM:0.##} mm, {vFill:0.#} mm3 in a " +
    $"{vGallery:0.#} mm3 gallery ({100.0 * vFill / vGallery:0.#}% infill)");

// ---------------------------------------------------------------------------
// 7. Weld the lattice into the manifold. Both fields sit on the same voxel
//    grid, so the sheet fuses to the gallery wall where it touches it.
// ---------------------------------------------------------------------------
Shape manifold = Union(drilled, fill);

Bounds bb = BBox(manifold);
Log($"manifold: {Volume(manifold):0.#} mm3, bbox {bb.Size}");
SavePart("manifold_block", manifold);
