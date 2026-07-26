// embossed_card.csx
// ---------------------------------------------------------------------------
// The Hyperganic classic: a rounded card with a depth map baked into both
// faces. Raised on the front, engraved on the back, from one grayscale image.
//
// WHAT THIS DEMONSTRATES
//   Box            a plain rectangular blank, centred on the origin.
//   Smooth         one call rounds every edge of the blank at once, so the
//                  card gets its corner radius without a single fillet call.
//   Emboss         the finishing tool. It projects a grayscale image along a
//                  bounding-box face normal: WHITE is full effect, BLACK is
//                  none, greys ramp smoothly between. mode "raise" adds
//                  material outward, mode "cut" engraves inward, and the same
//                  map therefore gives you a stamp and its die.
//   BBox / Volume  measure the result and report it through Log.
//
// The image keeps its aspect ratio and is centred on the face, so a square
// 512 x 512 map on an 85.6 x 54 mm card lands as a square emblem. marginMM
// insets the mapped region from the edges of the face.
//
// PARAMETERS (all optional)
//   widthMM      card width, along X                        (default 85.6)
//   heightMM     card height, along Z                       (default 54)
//   thickMM      card thickness, along Y (the up axis)      (default 4)
//   cornerMM     edge rounding radius                       (default 1.5)
//   depthMM      relief height at pure white                (default 0.8)
//   marginMM     inset of the emblem from the card edges    (default 6)
//   image        depth map filename or absolute path        (default emboss-sample.png)
//   mode         both | raise | cut                         (default both)
//
// RESOLUTION
//   depthMM has to be worth several voxels or the relief turns into a step.
//   At the default 0.3 mm voxel a 0.8 mm relief is under three voxels deep,
//   which reads fine; drop to 0.15 mm for crisp lettering.
//   Smooth is a triple offset, so it also trims a voxel or so off the blank:
//   a 4 mm card measures about 3.6 mm thick at a 0.3 mm voxel. Add that back
//   in thickMM if you need the finished number on the nose.
//
// RUNTIME
//   About 12 s at voxelSizeMM 0.3 (the API default). Roughly 4x that at 0.15.
// ---------------------------------------------------------------------------

double widthMM  = ParamF("widthMM", 85.6f);
double heightMM = ParamF("heightMM", 54f);
double thickMM  = ParamF("thickMM", 4f);
double cornerMM = ParamF("cornerMM", 1.5f);
double depthMM  = ParamF("depthMM", 0.8f);
double marginMM = ParamF("marginMM", 6f);
string image    = ParamS("image", "emboss-sample.png");
string mode     = ParamS("mode", "both").Trim().ToLowerInvariant();

if (mode != "both" && mode != "raise" && mode != "cut")
    throw new ArgumentException($"mode must be \"both\", \"raise\" or \"cut\" (got '{mode}')");

// Smooth rounds EVERY edge, so a radius over half the thickness eats the card.
if (2 * cornerMM >= thickMM)
    throw new ArgumentException(
        $"cornerMM {cornerMM} is too big for a {thickMM} mm card: keep 2 x cornerMM under thickMM");

Log($"embossed card: {widthMM:0.##} x {heightMM:0.##} x {thickMM:0.##} mm, corner {cornerMM:0.##} mm, " +
    $"relief {depthMM:0.##} mm, margin {marginMM:0.##} mm, mode {mode}, voxel {VoxelSizeMM} mm");

// ---------------------------------------------------------------------------
// 1. The blank. Box is centred on the origin, so the card lies in the XZ plane
//    with its faces at y = +/- thickMM/2.
// ---------------------------------------------------------------------------
Shape blank = Box(widthMM, thickMM, heightMM);

// ---------------------------------------------------------------------------
// 2. Round it. One Smooth is the whole corner treatment: convex edges get the
//    radius, and because the card is a slab there are no concave ones.
// ---------------------------------------------------------------------------
Shape card = Smooth(blank, cornerMM);
double vBlank = Volume(card);
Log($"rounded blank: {vBlank:0.#} mm3, bbox {BBox(card).Size}");

// ---------------------------------------------------------------------------
// 3. Bake the map. +y is the top face of the card, -y the underside.
//    raise ADDS material along the face normal; cut REMOVES it.
// ---------------------------------------------------------------------------
Shape result = card;

if (mode == "both" || mode == "raise")
{
    result = Emboss(result, image, face: "+y", depth: depthMM, mode: "raise", marginMM: marginMM);
    Log($"front raised: +{Volume(result) - vBlank:0.#} mm3 of relief");
}

if (mode == "both" || mode == "cut")
{
    double before = Volume(result);
    result = Emboss(result, image, face: "-y", depth: depthMM, mode: "cut", marginMM: marginMM);
    Log($"back engraved: -{before - Volume(result):0.#} mm3 removed");
}

// ---------------------------------------------------------------------------
// 4. Register it. SavePart meshes the field, drops floating islands, checks
//    watertightness and lands the part in the canvas.
// ---------------------------------------------------------------------------
Bounds bb = BBox(result);
Log($"card: {Volume(result):0.#} mm3, bbox {bb.Size}, stack height {bb.Size.y:0.##} mm");
SavePart("embossed_card", result);
