// rocket_nozzle.csx
// ---------------------------------------------------------------------------
// A parametric bell nozzle: six engineering numbers in, a printable part out.
// This is the flagship "math in, part out" demo for the Forge API.
//
// WHAT THIS DEMONSTRATES
//   Loft         the solid-of-revolution primitive. You hand it a radius
//                function r(y) and it revolves that function about +Y, so the
//                whole nozzle contour is ordinary C# arithmetic rather than a
//                pile of sketches. Here r(y) is a cosine convergent section
//                joined to a quadratic-Bezier Rao bell.
//   Subtract     the wall. Loft the OUTER surface, loft the bore over-length
//                so both ends stay open, and subtract. That is the correct
//                constant-wall move for a duct; Shell(solid, wall) would give
//                a sealed vessel here, because Loft caps its own ends.
//   Cylinder     the chamber flange disc.
//   Torus        a rolled bead around the flange rim.
//   Union        fusing the disc and the bead into one flange.
//   SmoothUnion  fusing the flange to the nozzle with a fillet, so load flows
//                through the joint instead of stopping at a sharp corner.
//   ArrayRadial  twice, and both directions: subtracting a ring of bolt holes,
//                and adding a ring of regenerative cooling tubes.
//   Pipe         one cooling tube, swept along a polyline that follows the
//                outer contour. Every corner rounds itself and every joint is
//                watertight.
//   Volume/BBox  reporting the finished part.
//
// THE CONTOUR
//   y = 0 is the chamber flange face. y = lengthMM is the exit plane.
//
//     0 .. convLen        convergent: a raised-cosine blend from the chamber
//                         radius down to the throat radius, which lands on the
//                         throat with zero slope (a rounded throat, no crease).
//     convLen .. length   divergent: the Rao bell, a quadratic Bezier that
//                         leaves the throat at the initial wall angle thetaN
//                         and arrives at the exit plane at thetaE. The control
//                         point is the intersection of those two tangents.
//
//   The bell length is bellFraction of the length of a 15 degree conical
//   nozzle with the same area ratio, which is the usual definition of an
//   "80 percent bell". thetaN and thetaE come from a smooth fit to the
//   published Rao charts as a function of area ratio; this is a shaping
//   approximation, NOT a method-of-characteristics contour, so treat the
//   result as a demonstration part rather than flight hardware.
//
// PARAMETERS (all optional)
//   throatDiaMM    throat diameter                                (default 12)
//   exitDiaMM      exit-plane diameter                            (default 40)
//   chamberDiaMM   chamber (inlet) diameter                       (default 30)
//   lengthMM       overall axial length, flange face to exit      (default 60)
//   wallMM         constant wall thickness                        (default 1.6)
//   bellFraction   bell length / 15 degree cone length, 0.6 .. 1  (default 0.8)
//   coolingTubes   cooling tubes around the outside, 0 = none     (default 12)
//   tubeDiaMM      cooling tube outside diameter                  (default 3)
//   boltHoles      flange bolt holes, 0 = none                    (default 6)
//   boltDiaMM      flange bolt hole diameter                      (default 4.5)
//
// RUNTIME
//   About 12 s at voxelSizeMM 0.3 (the API default), producing roughly 610k
//   triangles. Raise the voxel size to 0.4 mm while you are still tuning the
//   numbers, or drop to 0.2 mm for a print-ready throat.
//
// NOTE ON Log
//   Log(...) is the script logger, and it HIDES System.Math.Log inside a
//   script. Natural logarithms below are written Math.Log(...) in full.
// ---------------------------------------------------------------------------

double throatDiaMM  = ParamF("throatDiaMM", 12f);
double exitDiaMM    = ParamF("exitDiaMM", 40f);
double chamberDiaMM = ParamF("chamberDiaMM", 30f);
double lengthMM     = ParamF("lengthMM", 60f);
double wallMM       = ParamF("wallMM", 1.6f);
double bellFraction = ParamF("bellFraction", 0.8f);
int    coolingTubes = (int)Math.Round(ParamF("coolingTubes", 12f));
double tubeDiaMM    = ParamF("tubeDiaMM", 3f);
int    boltHoles    = (int)Math.Round(ParamF("boltHoles", 6f));
double boltDiaMM    = ParamF("boltDiaMM", 4.5f);

if (exitDiaMM <= throatDiaMM)
    throw new ArgumentException($"exitDiaMM ({exitDiaMM}) must exceed throatDiaMM ({throatDiaMM}): a bell has to expand");
if (chamberDiaMM <= throatDiaMM)
    throw new ArgumentException($"chamberDiaMM ({chamberDiaMM}) must exceed throatDiaMM ({throatDiaMM}): a nozzle has to converge");
if (bellFraction < 0.5 || bellFraction > 1.2)
    throw new ArgumentException($"bellFraction {bellFraction} is outside 0.5 .. 1.2");
if (wallMM < 2 * VoxelSizeMM)
    throw new ArgumentException($"wallMM {wallMM} is under two voxels at {VoxelSizeMM} mm: the wall will not resolve");

// ---------------------------------------------------------------------------
// 1. Engineering numbers. All of the design lives in these eight lines.
// ---------------------------------------------------------------------------
double rThroat  = throatDiaMM * 0.5;
double rExit    = exitDiaMM * 0.5;
double rChamber = chamberDiaMM * 0.5;

double areaRatio = (rExit / rThroat) * (rExit / rThroat);          // exit area / throat area
double coneLen   = (rExit - rThroat) / Math.Tan(15.0 * Math.PI / 180.0);
double bellLen   = bellFraction * coneLen;

// The convergent section gets whatever length the bell leaves. Keep at least
// 15 percent of the part for it, and shorten the bell if the caller asked for
// a length that cannot hold both.
double convLen = lengthMM - bellLen;
if (convLen < 0.15 * lengthMM)
{
    bellLen = 0.85 * lengthMM;
    convLen = 0.15 * lengthMM;
    Log($"bell shortened to {bellLen:0.##} mm: lengthMM {lengthMM} cannot hold a " +
        $"{bellFraction:0.##} bell ({bellFraction * coneLen:0.##} mm) plus a convergent section");
}

// Rao wall angles from the area ratio, then a mild correction for a bell that
// is shorter or longer than the 80 percent reference (shorter bells turn the
// flow harder at the throat and leave more residual swirl at the exit).
double bellCorr = Math.Pow(0.8 / bellFraction, 0.35);
double thetaN   = Math.Clamp((17.0 + 2.6 * Math.Log(areaRatio)) * bellCorr, 12.0, 35.0);
double thetaE   = Math.Clamp((18.0 - 2.5 * Math.Log(areaRatio)) * bellCorr, 3.0, 22.0);
if (thetaN <= thetaE + 1.0) thetaN = thetaE + 1.0;   // the two tangents must cross

Log($"nozzle: throat dia {throatDiaMM:0.##} exit dia {exitDiaMM:0.##} chamber dia {chamberDiaMM:0.##}, " +
    $"area ratio {areaRatio:0.##}, wall {wallMM:0.##} mm, voxel {VoxelSizeMM} mm");
Log($"contour: convergent {convLen:0.##} mm + {bellFraction:0.##} bell {bellLen:0.##} mm " +
    $"(15 deg cone would be {coneLen:0.##} mm), thetaN {thetaN:0.#} deg, thetaE {thetaE:0.#} deg");

// ---------------------------------------------------------------------------
// 2. The Bezier bell. P0 sits at the throat with slope tan(thetaN), P2 at the
//    exit with slope tan(thetaE), and P1 is where those two tangents cross.
// ---------------------------------------------------------------------------
double y0 = convLen,   r0 = rThroat;
double y2 = lengthMM,  r2 = rExit;
double m0 = Math.Tan(thetaN * Math.PI / 180.0);
double m2 = Math.Tan(thetaE * Math.PI / 180.0);
double y1 = (r2 - r0 - m2 * y2 + m0 * y0) / (m0 - m2);
double r1 = r0 + m0 * (y1 - y0);

// A control point outside the span would fold the curve back on itself.
y1 = Math.Clamp(y1, y0 + 1e-3, y2 - 1e-3);
r1 = Math.Clamp(r1, r0, r2);

// y(t) is monotonic because y0 < y1 < y2, so a bisection on t inverts it.
double BellRadius(double y)
{
    double lo = 0.0, hi = 1.0;
    for (int i = 0; i < 36; i++)
    {
        double t = 0.5 * (lo + hi);
        double yt = (1 - t) * (1 - t) * y0 + 2 * (1 - t) * t * y1 + t * t * y2;
        if (yt < y) lo = t; else hi = t;
    }
    double tf = 0.5 * (lo + hi);
    return (1 - tf) * (1 - tf) * r0 + 2 * (1 - tf) * tf * r1 + tf * tf * r2;
}

// Raised cosine from the chamber to the throat: zero slope at both ends, so
// the inlet meets the flange square and the throat has no crease.
double ConvergentRadius(double y)
{
    double u = Math.Clamp(y / convLen, 0.0, 1.0);
    return rThroat + (rChamber - rThroat) * 0.5 * (1.0 + Math.Cos(Math.PI * u));
}

Func<double, double> innerRadius = y =>
{
    double yc = Math.Clamp(y, 0.0, lengthMM);
    return yc <= convLen ? ConvergentRadius(yc) : BellRadius(yc);
};

// ---------------------------------------------------------------------------
// 3. The wall: loft the outside, loft an over-length bore, subtract.
//    The bore runs past both ends so the nozzle is a tube, not a bottle.
// ---------------------------------------------------------------------------
double overrun = 2.0 * wallMM + 1.0;

Shape outerSolid = Loft(y => innerRadius(y) + wallMM, 0, lengthMM);
Shape bore       = Loft(innerRadius, -overrun, lengthMM + overrun);
Log($"lofted: outer {Volume(outerSolid):0.#} mm3 solid, bore {Volume(bore):0.#} mm3");

// ---------------------------------------------------------------------------
// 4. The chamber flange: a disc with a rolled bead around its rim, fused to
//    the nozzle with a fillet.
// ---------------------------------------------------------------------------
double flangeT  = Math.Max(3.0, 2.0 * wallMM);
double flangeOD = chamberDiaMM + 2.0 * wallMM + 20.0;

Shape flangeDisc = Cylinder(d: flangeOD, h: flangeT, at: V(0, flangeT * 0.5, 0));
Shape flangeBead = Torus(d: flangeOD, ring: flangeT, at: V(0, flangeT * 0.5, 0));
Shape flange     = Union(flangeDisc, flangeBead);

Shape body = SmoothUnion(outerSolid, flange, radius: Math.Max(wallMM, 1.0));
body = Subtract(body, bore);
Log($"flange: dia {flangeOD + flangeT:0.##} x {flangeT:0.##} mm, blended at r{Math.Max(wallMM, 1.0):0.##} mm");

// ---------------------------------------------------------------------------
// 5. Bolt holes: ArrayRadial as a CUTTER. Each copy is pushed out to the bolt
//    circle and then rotated into place around +Y.
// ---------------------------------------------------------------------------
if (boltHoles >= 1)
{
    double boltCircleR = flangeOD * 0.5 - boltDiaMM * 0.5 - 2.0;
    Shape onePin  = Cylinder(d: boltDiaMM, h: flangeT * 4.0, at: V(0, flangeT * 0.5, 0));
    Shape pinRing = ArrayRadial(onePin, boltHoles, radius: boltCircleR);
    body = Subtract(body, pinRing);
    Log($"{boltHoles} bolt holes dia {boltDiaMM:0.##} on a dia {2 * boltCircleR:0.##} mm circle");
}

// ---------------------------------------------------------------------------
// 6. Regenerative cooling tubes: one Pipe swept along the outer contour, then
//    ArrayRadial as an ADDER. radius 0 spins the copies about the world +Y
//    axis, which is exactly what a tube-wall nozzle needs.
// ---------------------------------------------------------------------------
if (coolingTubes >= 1 && tubeDiaMM > 2 * VoxelSizeMM)
{
    double tubeStartY = flangeT;                       // tubes land on the flange
    int    nPts       = Math.Max(12, (int)((lengthMM - tubeStartY) / 2.5));
    var    tubePath   = new List<Vec3>();
    for (int i = 0; i <= nPts; i++)
    {
        double y = tubeStartY + (lengthMM - tubeStartY) * i / (double)nPts;
        double x = innerRadius(y) + wallMM + tubeDiaMM * 0.5;
        tubePath.Add(V(x, y, 0));
    }

    Shape oneTube = Pipe(tubePath, tubeDiaMM);
    Shape tubeRing = ArrayRadial(oneTube, coolingTubes, radius: 0);
    body = Union(body, tubeRing);
    Log($"{coolingTubes} cooling tubes dia {tubeDiaMM:0.##} along the contour, {nPts + 1} path points each");
}

// ---------------------------------------------------------------------------
// 7. Register it.
// ---------------------------------------------------------------------------
Bounds bb = BBox(body);
Log($"nozzle: {Volume(body):0.#} mm3, bbox {bb.Size}, exit plane at y = {bb.Max.y:0.##} mm");
SavePart("rocket_nozzle", body);
