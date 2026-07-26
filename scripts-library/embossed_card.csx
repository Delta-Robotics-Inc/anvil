// embossed_card.csx
// ---------------------------------------------------------------------------
// The Hyperganic classic, at credit-card scale: an 85.6 x 54 x 1.6 mm card with
// the ANVIL emblem raised on the front and engraved on the back — one grayscale
// depth map, used as both the stamp and its die.
//
// WHAT THIS DEMONSTRATES
//   Emboss         the finishing tool, and the reason this example exists. It
//                  projects a grayscale image along a bounding-box face normal:
//                  WHITE is full relief, BLACK is none, and greys ramp smoothly
//                  between (the map is sampled bilinearly, so you get a real
//                  ramp, not a staircase). mode "raise" adds material outward,
//                  mode "cut" engraves inward, so the SAME map gives you a
//                  positive and its negative.
//   Union          the card outline: two overlapping slabs plus four corner
//                  cylinders is the exact way to get a true 3 mm corner radius
//                  on a card that has to stay flat and 1.6 mm thick.
//   Smooth         a small edge break on the finished outline. Smooth rounds
//                  EVERY edge including the two big faces, which is why it is
//                  used here at 0.3 mm and not as the corner treatment: a
//                  1.6 mm card cannot afford a 3 mm all-edge radius.
//   Cylinder(axis) the corner radii, standing along +Z with the card.
//   BBox / Volume  measuring the finished stack height and reporting it.
//
// ORIENTATION
//   The card LIES FLAT ON THE PLATE, z in [0, thickMM]: X is its width, Y its
//   height, Z its thickness. The emblem faces "+z" (up) and "-z" (down), which
//   is also the only sane way to print it.
//
// THE DEPTH MAP
//   assets/emboss-sample.png is the real ANVIL logo (server/wwwroot/anvil.svg)
//   rasterised to a 512 x 512 grayscale map with a soft shoulder on every edge.
//   The image keeps its aspect ratio and is centred on the face, so a square map
//   on a rectangular card lands as a square region 54 - 2 x marginMM across.
//   Swap in any grayscale PNG/JPG/BMP: white is proud, black is flat.
//
// PARAMETERS (all optional)
//   widthMM      card width, along X                          (default 85.6)
//   heightMM     card height, along Y                         (default 54)
//   thickMM      card thickness, along Z                      (default 1.6)
//   cornerMM     outline corner radius                        (default 3)
//   edgeMM       edge break on the finished outline           (default 0.3)
//   depthMM      relief height at pure white                  (default 0.8)
//   marginMM     inset of the emblem from the card edges      (default 4)
//   image        depth map filename or absolute path          (default emboss-sample.png)
//   mode         both | raise | cut                           (default both)
//
// RESOLUTION AND RUNTIME
//   Stated default voxelSizeMM 0.12 — about 45 s. This is a SMALL part, so it
//   can afford a fine voxel, and it needs one: the emblem's inside corners are
//   under a millimetre across, and at the API default of 0.3 mm they turn to
//   mush. 0.15 mm is a good compromise at half the time; the script warns if the
//   relief drops under three voxels.
//   Smooth is a triple offset, so it also trims about a voxel off the blank; the
//   script measures and reports the finished thickness rather than promising it.
//   The relief is deliberately half the card thickness: a 0.2 mm emboss is
//   correct for a real credit card and invisible on a screen.
//
// VARIANTS (the same script, three cards)
//   card-1.6     the defaults — ISO/IEC 7810 ID-1 footprint
//   tag          widthMM 50, heightMM 50, marginMM 3, thickMM 2 — a square fob
//   die          mode "cut", depthMM 0.8, thickMM 3 — the stamping die alone
// ---------------------------------------------------------------------------

double widthMM  = ParamF("widthMM", 85.6f);
double heightMM = ParamF("heightMM", 54f);
double thickMM  = ParamF("thickMM", 1.6f);
double cornerMM = ParamF("cornerMM", 3f);
double edgeMM   = ParamF("edgeMM", 0.3f);
double depthMM  = ParamF("depthMM", 0.8f);
double marginMM = ParamF("marginMM", 4f);
string image    = ParamS("image", "emboss-sample.png");
string mode     = ParamS("mode", "both").Trim().ToLowerInvariant();

if (mode != "both" && mode != "raise" && mode != "cut")
    throw new ArgumentException($"mode must be \"both\", \"raise\" or \"cut\" (got '{mode}')");
if (2 * cornerMM >= Math.Min(widthMM, heightMM))
    throw new ArgumentException($"cornerMM {cornerMM} is too big for a {widthMM} x {heightMM} mm card");
if (2 * edgeMM >= thickMM)
    throw new ArgumentException($"edgeMM {edgeMM} is too big for a {thickMM} mm card: keep 2 x edgeMM under thickMM");
if (depthMM >= thickMM)
    throw new ArgumentException($"depthMM {depthMM} must be less than the {thickMM} mm card thickness");
if (2 * marginMM >= Math.Min(widthMM, heightMM))
    throw new ArgumentException($"marginMM {marginMM} leaves no room for the emblem");
if (depthMM < 3 * VoxelSizeMM)
    Log($"WARNING: a {depthMM} mm relief is under three voxels at {VoxelSizeMM} mm — the emblem will read as a step, not a shape. Drop voxelSizeMM to {depthMM / 4:0.###} or below.");

Log($"embossed card: {widthMM:0.##} x {heightMM:0.##} x {thickMM:0.##} mm, corner r{cornerMM:0.##} mm, edge break {edgeMM:0.##} mm, " +
    $"relief {depthMM:0.##} mm, margin {marginMM:0.##} mm, mode {mode}, voxel {VoxelSizeMM} mm");

// ---------------------------------------------------------------------------
// 1. The outline. Two overlapping slabs give the straight edges; four cylinders
//    give the corner radii. This keeps the two big faces perfectly flat and the
//    thickness exactly thickMM, which a global Smooth could not.
//
//    The card LIES ON THE PLATE: everything is centred at z = thickMM/2, so the
//    blank spans z in [0, thickMM] and the raised emblem grows upward from there.
// ---------------------------------------------------------------------------
double cx = widthMM * 0.5 - cornerMM, cy = heightMM * 0.5 - cornerMM, cz = thickMM * 0.5;

Shape card = Union(
    Box(widthMM - 2 * cornerMM, heightMM, thickMM, at: V(0, 0, cz)),
    Box(widthMM, heightMM - 2 * cornerMM, thickMM, at: V(0, 0, cz)),
    Cylinder(2 * cornerMM, thickMM, at: V( cx,  cy, cz), axis: "z"),
    Cylinder(2 * cornerMM, thickMM, at: V(-cx,  cy, cz), axis: "z"),
    Cylinder(2 * cornerMM, thickMM, at: V( cx, -cy, cz), axis: "z"),
    Cylinder(2 * cornerMM, thickMM, at: V(-cx, -cy, cz), axis: "z"));

// ---------------------------------------------------------------------------
// 2. Break the edges. Small, because Smooth rounds the faces too.
// ---------------------------------------------------------------------------
card = Smooth(card, edgeMM);
double vBlank = Volume(card);
Bounds bbBlank = BBox(card);
Log($"blank: {vBlank:0.#} mm3, {bbBlank.Size.x:0.##} x {bbBlank.Size.y:0.##} mm, " +
    $"finished thickness {bbBlank.Size.z:0.###} mm (asked for {thickMM:0.###})");

// ---------------------------------------------------------------------------
// 3. Bake the map. "+z" is the top face, "-z" the underside.
// ---------------------------------------------------------------------------
Shape result = card;

if (mode == "both" || mode == "raise")
{
    result = Emboss(result, image, face: "+z", depth: depthMM, mode: "raise", marginMM: marginMM);
    Log($"front raised: +{Volume(result) - vBlank:0.#} mm3 of relief");
}

if (mode == "both" || mode == "cut")
{
    double before = Volume(result);
    result = Emboss(result, image, face: "-z", depth: depthMM, mode: "cut", marginMM: marginMM);
    Log($"back engraved: -{before - Volume(result):0.#} mm3 removed");
}

// ---------------------------------------------------------------------------
// 4. Register it.
// ---------------------------------------------------------------------------
Bounds bb = BBox(result);
Log($"card: {Volume(result):0.#} mm3, bbox {bb.Size}, lying on the plate from z = {bb.Min.z:0.###} to {bb.Max.z:0.###} mm, " +
    $"stack height {bb.Size.z:0.###} mm ({bbBlank.Size.z:0.###} mm card + {depthMM:0.##} mm relief)");
SavePart("embossed_card", result);
