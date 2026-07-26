// forge_smoke.csx
// ---------------------------------------------------------------------------
// Forge API self-test. Exercises EVERY Forge command once and checks the result
// against the analytic answer, so a regression anywhere in the command layer
// shows up as a failed assertion rather than a quietly wrong part.
//
// Every check emits one line:
//     FORGE-ASSERT PASS|FAIL <name> <detail>
// and the run ends with:
//     FORGE-SMOKE total=<n> pass=<n> fail=<n>
// scripts\test_scripts.ps1 parses those lines; keep the format stable.
//
// TOLERANCES. A voxel field's surface sits within about half a voxel of the true
// one, so a measured volume differs from the analytic answer by roughly
// (surface area x half a voxel) — a 20 mm cube at a 0.5 mm voxel measures about
// 8615 mm3, not 8000. Volume checks therefore compare against the analytic
// volume with that physical band allowed, which stays tight without being
// resolution-dependent. Runs in well under a minute at voxelSizeMM 0.5.
// ---------------------------------------------------------------------------

int nPass = 0, nFail = 0;

void Check(string name, bool ok, string detail)
{
    if (ok) nPass++; else nFail++;
    Log($"FORGE-ASSERT {(ok ? "PASS" : "FAIL")} {name} {detail}");
}

// Volume check: analytic volume, plus the half-voxel skin over the given surface
// area, plus 2% for facetting.
void NearVox(string name, double got, double wantMM3, double areaMM2)
{
    double band = areaMM2 * VoxelSizeMM * 0.55 + Math.Abs(wantMM3) * 0.02;
    Check(name, Math.Abs(got - wantMM3) <= band,
          $"got={got:0.##} want={wantMM3:0.##} band=+/-{band:0.##}");
}

// Length / position check in mm.
void NearAbs(string name, double got, double want, double tolAbs)
    => Check(name, Math.Abs(got - want) <= tolAbs,
             $"got={got:0.###} want={want:0.###} tol={tolAbs:0.###}mm");

void True(string name, bool ok, string detail) => Check(name, ok, detail);

Log($"forge smoke starting at voxel {VoxelSizeMM} mm");

// ===========================================================================
// BUILDERS
// ===========================================================================
Shape box = Box(20, 20, 20);
NearVox("Box.volume", Volume(box), 8000, 2400);
Bounds bbBox = BBox(box);
NearAbs("Box.bbox.size.x", bbBox.Size.x, 20, 1.0);
NearAbs("Box.center.y", Center(box).y, 0, 0.5);

Shape cyl = Cylinder(d: 20, h: 20);
NearVox("Cylinder.volume", Volume(cyl), Math.PI * 100 * 20, 2 * Math.PI * 100 + 2 * Math.PI * 10 * 20);
NearAbs("Cylinder.height", BBox(cyl).Size.y, 20, 1.0);

Shape cone = Cone(d: 20, h: 20);
NearVox("Cone.volume", Volume(cone), Math.PI * 100 * 20 / 3.0,
        Math.PI * 100 + Math.PI * 10 * Math.Sqrt(100 + 400));

Shape ball = Sphere(d: 20);
NearVox("Sphere.volume", Volume(ball), 4.0 / 3.0 * Math.PI * 1000, 4 * Math.PI * 100);

Shape cap = Capsule(V(-10, 0, 0), V(10, 0, 0), d: 8);
NearVox("Capsule.volume", Volume(cap), Math.PI * 16 * 20 + 4.0 / 3.0 * Math.PI * 64,
        2 * Math.PI * 4 * 20 + 4 * Math.PI * 16);
NearAbs("Capsule.bbox.size.x", BBox(cap).Size.x, 28, 1.5);

Shape ring = Torus(d: 30, ring: 8);
NearVox("Torus.volume", Volume(ring), 2 * Math.PI * Math.PI * 15 * 16,
        4 * Math.PI * Math.PI * 15 * 4);
NearAbs("Torus.bbox.size.x", BBox(ring).Size.x, 38, 1.5);

// Truncated cone of revolution: r 10 at y=0 tapering to r 5 at y=20.
Shape lofted = Loft(y => 10 - 5 * (y / 20.0), 0, 20);
double loftSlant = Math.Sqrt(25 + 400);
NearVox("Loft.volume", Volume(lofted), Math.PI * 20 / 3.0 * (100 + 50 + 25),
        Math.PI * 100 + Math.PI * 25 + Math.PI * 15 * loftSlant);
NearAbs("Loft.bbox.size.y", BBox(lofted).Size.y, 20, 1.0);

Shape pipe = Pipe(new[] { V(-15, 0, 0), V(0, 0, 0), V(0, 15, 0) }, d: 6);
True("Pipe.volume>0", Volume(pipe) > 0, $"got={Volume(pipe):0.##}");
NearAbs("Pipe.bbox.size.y", BBox(pipe).Size.y, 21, 1.5);
NearAbs("Pipe.bbox.size.x", BBox(pipe).Size.x, 21, 1.5);

// Above PipeSegmentLimit segments Pipe hands the run to a beam lattice. Same
// straight line, 2 points vs 40: the two routes must agree.
var straight2 = new[] { V(-20, 0, 0), V(20, 0, 0) };
var straight40 = new List<Vec3>();
for (int i = 0; i <= 40; i++) straight40.Add(V(-20 + 40.0 * i / 40.0, 0, 0));
double vShortRoute = Volume(Pipe(straight2, d: 6));
double vLongRoute = Volume(Pipe(straight40, d: 6));
True("Pipe.longPath.matchesImplicit",
     Math.Abs(vLongRoute - vShortRoute) < 0.03 * vShortRoute,
     $"implicit={vShortRoute:0.##} lattice={vLongRoute:0.##} segs={straight40.Count - 1} limit={Forge.PipeSegmentLimit}");

// ---------------------------------------------------------------------------
// BEAMS / SPHERES — the batch lattice primitives
// ---------------------------------------------------------------------------
// Five parallel, well-separated capsules: volume and area are the analytic sum.
var beamList = new List<(Vec3 a, Vec3 b, double dA, double dB)>();
for (int i = 0; i < 5; i++) beamList.Add((V(-10, 12.0 * i, 0), V(10, 12.0 * i, 0), 4.0, 4.0));
Shape beams5 = Beams(beamList);
double capsuleVol = Math.PI * 4 * 20 + 4.0 / 3.0 * Math.PI * 8;      // cylinder + two hemispheres
double capsuleArea = 2 * Math.PI * 2 * 20 + 4 * Math.PI * 4;
NearVox("Beams.volume.vsCapsuleSum", Volume(beams5), 5 * capsuleVol, 5 * capsuleArea);
NearAbs("Beams.bbox.size.x", BBox(beams5).Size.x, 24, 1.5);
NearAbs("Beams.bbox.size.y", BBox(beams5).Size.y, 52, 1.5);

// One beam is exactly one Capsule of the same diameter.
Shape oneBeam = Beams(new[] { (V(-10, 0, 0), V(10, 0, 0), 8.0, 8.0) });
double vCapsuleCmd = Volume(Capsule(V(-10, 0, 0), V(10, 0, 0), d: 8));
True("Beams.oneBeam==Capsule", Math.Abs(Volume(oneBeam) - vCapsuleCmd) < 0.03 * vCapsuleCmd,
     $"beam={Volume(oneBeam):0.##} capsule={vCapsuleCmd:0.##}");

// A per-end diameter is free: the taper sits between the two constant-diameter
// beams it interpolates, and the bbox knows about both end radii.
Shape tapered = Beams(new[] { (V(0, 0, 0), V(0, 20, 0), 8.0, 2.0) });
double vFat = Volume(Beams(new[] { (V(0, 0, 0), V(0, 20, 0), 8.0, 8.0) }));
double vThin = Volume(Beams(new[] { (V(0, 0, 0), V(0, 20, 0), 2.0, 2.0) }));
True("Beams.taper.betweenEnds", Volume(tapered) > vThin && Volume(tapered) < vFat,
     $"thin={vThin:0.##} taper={Volume(tapered):0.##} fat={vFat:0.##}");
NearAbs("Beams.taper.bbox.y", BBox(tapered).Size.y, 25, 1.5);

// The polyline overload chains points, exactly like Pipe.
Shape beamRun = Beams(new[] { V(-15, 0, 0), V(0, 0, 0), V(0, 15, 0) }, d: 6);
NearAbs("Beams.polyline.bbox.x", BBox(beamRun).Size.x, 21, 1.5);
NearAbs("Beams.polyline.bbox.y", BBox(beamRun).Size.y, 21, 1.5);

var ballPts = new List<Vec3>();
for (int i = 0; i < 4; i++) ballPts.Add(V(20.0 * i, 0, 0));
Shape balls = Spheres(ballPts, d: 10);
NearVox("Spheres.volume", Volume(balls), 4 * (4.0 / 3.0 * Math.PI * 125), 4 * 4 * Math.PI * 25);
NearAbs("Spheres.bbox.size.x", BBox(balls).Size.x, 70, 1.5);

// FromFile: write a solid out as STL, read it straight back.
string tmpStl = System.IO.Path.Combine(System.IO.Path.GetTempPath(),
    "forge_smoke_" + Guid.NewGuid().ToString("N") + ".stl");
Box(12, 12, 12).ToMesh().SaveToStlFile(tmpStl, Mesh.EStlUnit.MM);
Shape reloaded = FromFile(tmpStl);
NearVox("FromFile.volume", Volume(reloaded), 1728, 864);
try { System.IO.File.Delete(tmpStl); } catch { }

// ===========================================================================
// COMBINATORS
// ===========================================================================
Shape a = Box(20, 20, 20, at: V(-6, 0, 0));
Shape b = Box(20, 20, 20, at: V(6, 0, 0));
double vBefore = Volume(a);

double vUnion = Volume(Union(a, b));
NearVox("Union.volume", vUnion, 32 * 20 * 20, 2 * (32 * 20 + 32 * 20 + 20 * 20));

NearVox("Subtract.volume", Volume(Subtract(a, b)), 12 * 20 * 20,
        2 * (12 * 20 + 12 * 20 + 20 * 20));

NearVox("Intersect.volume", Volume(Intersect(a, b)), 8 * 20 * 20,
        2 * (8 * 20 + 8 * 20 + 20 * 20));

Shape blended = SmoothUnion(a, b, radius: 2);
double vSmooth = Volume(blended);
True("SmoothUnion.neverRemoves", vSmooth >= vUnion,
     $"got={vSmooth:0.##} union={vUnion:0.##}");
NearAbs("SmoothUnion.bbox.x", BBox(blended).Size.x, 32, 1.5);

// Every combinator above took `a` as an input; none may have altered it.
True("Combinators.inputs.immutable", Math.Abs(Volume(a) - vBefore) < 1e-6,
     $"before={vBefore:0.####} after={Volume(a):0.####}");

// ===========================================================================
// MODIFIERS
// ===========================================================================
Shape moved = Move(box, 10, 5, -3);
NearAbs("Move.center.x", Center(moved).x, 10, 0.6);
NearAbs("Move.center.y", Center(moved).y, 5, 0.6);
NearAbs("Move.center.z", Center(moved).z, -3, 0.6);

Shape bar = Box(30, 10, 10);
Bounds rx = BBox(RotateX(bar, 90));
NearAbs("RotateX.bbox.y", rx.Size.y, 10, 1.2);
NearAbs("RotateX.bbox.z", rx.Size.z, 10, 1.2);
Bounds ry = BBox(RotateY(bar, 90));
NearAbs("RotateY.bbox.z", ry.Size.z, 30, 1.2);
Bounds rz = BBox(RotateZ(bar, 90));
NearAbs("RotateZ.bbox.y", rz.Size.y, 30, 1.2);
NearAbs("RotateZ.spinsInPlace", rz.Center.x, 0, 0.6);
NearAbs("RotateZ.about.pivot", Center(RotateZ(bar, 90, about: V(0, 0, 0))).x, 0, 0.6);

NearVox("Scale.uniform.volume", Volume(Scale(box, 2)), 64000, 9600);
NearVox("Scale.perAxis.volume", Volume(Scale(box, 2, 1, 1)), 16000, 2 * (800 + 800 + 400));

Shape offCentre = Box(10, 10, 10, at: V(15, 0, 0));
NearAbs("Mirror.YZ.center.x", Center(Mirror(offCentre, "YZ")).x, -15, 0.6);
NearAbs("Mirror.XZ.center.x", Center(Mirror(offCentre, "XZ")).x, 15, 0.6);
NearAbs("Mirror.XY.center.x", Center(Mirror(offCentre, "XY")).x, 15, 0.6);

Shape cube30 = Box(30, 30, 30);
double cubeSpan = BBox(cube30).Size.x;
Shape shellIn = Shell(cube30, 2, "in");
Shape shellOut = Shell(cube30, 2, "out");
Shape shellMid = Shell(cube30, 2, "center");
NearVox("Shell.in.volume", Volume(shellIn), 30.0 * 30 * 30 - 26.0 * 26 * 26,
        6 * 900 + 6 * 676);
NearAbs("Shell.in.keepsOuterSize", BBox(shellIn).Size.x, cubeSpan, 0.6);
True("Shell.out.growsOutward", BBox(shellOut).Size.x > cubeSpan + 1.0,
     $"outer={BBox(shellOut).Size.x:0.##} vs solid={cubeSpan:0.##}");
True("Shell.center.straddles",
     BBox(shellMid).Size.x > cubeSpan && BBox(shellMid).Size.x < BBox(shellOut).Size.x + 0.6,
     $"center={BBox(shellMid).Size.x:0.##} solid={cubeSpan:0.##} out={BBox(shellOut).Size.x:0.##}");

// Offset grows the cube and rounds its edges: a^3 + 6a^2 d + 3*pi*a*d^2 + 4/3*pi*d^3
double wantOffset = 8000 + 6 * 400 * 2 + 3 * Math.PI * 20 * 4 + 4.0 / 3.0 * Math.PI * 8;
NearVox("Offset.plus2.volume", Volume(Offset(box, 2)), wantOffset,
        2400 + 12 * Math.PI * 20 + 4 * Math.PI * 4);
True("Offset.minus.shrinks", Volume(Offset(box, -2)) < Volume(box),
     "negative offset removes material");

double vBox = Volume(box);
double vRounded = Volume(Smooth(box, 2));
True("Smooth.rounds.corners", vRounded < vBox && vRounded > 0.85 * vBox,
     $"got={vRounded:0.##} solid={vBox:0.##}");

// ---------------------------------------------------------------------------
// FILLET — concave only, strictly additive, and NOT Smooth
// ---------------------------------------------------------------------------
// An L: two slabs meeting at a right angle, so there is exactly one concave
// seam to fill and plenty of convex edges that must not move.
Shape ell = Union(Box(30, 6, 20, at: V(0, 3, 0)), Box(6, 30, 20, at: V(-12, 15, 0)));
double vEll = Volume(ell);
Bounds bbEll = BBox(ell);
Shape ellFilleted = Fillet(ell, 3);
double vEllF = Volume(ellFilleted);
True("Fillet.onlyAdds", vEllF >= vEll - 1e-6, $"before={vEll:0.##} after={vEllF:0.##}");

// A fillet of radius r along a right-angle seam adds r^2 (1 - pi/4) per mm of
// seam. The seam here runs the L's full 20 mm z extent. A voxel closing at a
// 6-voxel radius under-fills the ends, so bracket it rather than nail it.
double filletVol = 20.0 * 9.0 * (1.0 - Math.PI / 4.0);
double filletAdded = vEllF - vEll;
True("Fillet.fillsConcaveSeam",
     filletAdded > 0.4 * filletVol && filletAdded < 2.5 * filletVol,
     $"added={filletAdded:0.##} analytic={filletVol:0.##} band={0.4 * filletVol:0.##}..{2.5 * filletVol:0.##}");
NearAbs("Fillet.keepsBBox.x", BBox(ellFilleted).Size.x, bbEll.Size.x, 0.6);
NearAbs("Fillet.keepsBBox.y", BBox(ellFilleted).Size.y, bbEll.Size.y, 0.6);

// A plain box has no concave edge at all, so Fillet is a no-op on it while
// Smooth eats its corners. That difference is the whole reason Fillet exists.
double vBoxFillet = Volume(Fillet(box, 2));
True("Fillet.noConcave.isNoOp", Math.Abs(vBoxFillet - vBox) < 0.01 * vBox,
     $"box={vBox:0.##} filleted={vBoxFillet:0.##}");
True("Fillet.keepsWhatSmoothEats", vBoxFillet > vRounded,
     $"fillet={vBoxFillet:0.##} smooth={vRounded:0.##}");

// A thin rib survives Fillet and does not survive Smooth intact.
Shape rib = Box(40, 2, 20);
double vRib = Volume(rib);
True("Fillet.keepsThinRib", Volume(Fillet(rib, 0.8)) >= vRib - 1e-6,
     $"rib={vRib:0.##} filleted={Volume(Fillet(rib, 0.8)):0.##} smoothed={Volume(Smooth(rib, 0.8)):0.##}");

Shape unit = Box(10, 10, 10);
Shape rowOf4 = ArrayLinear(unit, 4, V(15, 0, 0));
NearVox("ArrayLinear.volume", Volume(rowOf4), 4000, 4 * 600);
NearAbs("ArrayLinear.bbox.x", BBox(rowOf4).Size.x, 55, 1.5);
NearAbs("ArrayLinear.count1.isNoOp", Volume(ArrayLinear(unit, 1, V(15, 0, 0))), Volume(unit), 0.01);

Shape spoke = Cylinder(d: 6, h: 10);
Shape wheel = ArrayRadial(spoke, 6, radius: 15);
NearVox("ArrayRadial.volume", Volume(wheel), 6 * Math.PI * 9 * 10,
        6 * (2 * Math.PI * 9 + 2 * Math.PI * 3 * 10));
NearAbs("ArrayRadial.bbox.x", BBox(wheel).Size.x, 36, 2.0);

// Lattice: a gyroid sheet inside a 30 mm cube fills a sensible fraction of it.
Shape latticed = Lattice(cube30, pattern: "gyroid", cell: 8, wall: 1.2);
double fill = 100.0 * Volume(latticed) / Volume(cube30);
True("Lattice.gyroid.fillPct", fill > 5 && fill < 90, $"got={fill:0.##}% of the envelope");
True("Lattice.staysInsideEnvelope", BBox(latticed).Size.x <= BBox(cube30).Size.x + 0.6,
     $"lattice={BBox(latticed).Size.x:0.##} envelope={BBox(cube30).Size.x:0.##}");
Shape skeletal = Lattice(cube30, pattern: "schwarzP", cell: 10, type: "skeletal", bias: 0);
True("Lattice.skeletal.volume>0", Volume(skeletal) > 0, $"got={Volume(skeletal):0.##}");
Shape tuned = Lattice(cube30, cell: 8, wall: 1.5, rotDeg: V(0, 30, 0), phase: V(0.25, 0, 0),
                      cellXYZ: V(8, 12, 8));
True("Lattice.modifiers.volume>0", Volume(tuned) > 0, $"got={Volume(tuned):0.##}");

// ===========================================================================
// AXIS — the same builders stood up along +Z
// ===========================================================================
// Default is unchanged (+Y), axis:"z" gives the identical solid rotated onto +Z:
// same volume, swapped bbox.
Bounds bbCylY = BBox(Cylinder(d: 20, h: 30));
Shape cylZ = Cylinder(d: 20, h: 30, axis: "z");
Bounds bbCylZ = BBox(cylZ);
NearAbs("Cylinder.axis.default.isY", bbCylY.Size.y, 30, 1.0);
NearAbs("Cylinder.axis.z.height", bbCylZ.Size.z, 30, 1.0);
NearAbs("Cylinder.axis.z.width", bbCylZ.Size.x, 20, 1.0);
NearVox("Cylinder.axis.z.volume", Volume(cylZ), Math.PI * 100 * 30,
        2 * Math.PI * 100 + 2 * Math.PI * 10 * 30);
NearAbs("Cylinder.axis.z.at", Center(Cylinder(d: 10, h: 20, at: V(3, -4, 7), axis: "z")).z, 7, 0.6);

Shape coneZ = Cone(d: 20, h: 30, axis: "z");
NearAbs("Cone.axis.z.height", BBox(coneZ).Size.z, 30, 1.0);
NearVox("Cone.axis.z.volume", Volume(coneZ), Math.PI * 100 * 30 / 3.0,
        Math.PI * 100 + Math.PI * 10 * Math.Sqrt(100 + 900));

Shape loftZ = Loft(t => 10 - 5 * (t / 20.0), 0, 20, axis: "z");
NearAbs("Loft.axis.z.height", BBox(loftZ).Size.z, 20, 1.0);
NearAbs("Loft.axis.z.width", BBox(loftZ).Size.x, 20, 1.0);
NearVox("Loft.axis.z.volume", Volume(loftZ), Math.PI * 20 / 3.0 * (100 + 50 + 25),
        Math.PI * 100 + Math.PI * 25 + Math.PI * 15 * loftSlant);
True("Loft.axis.z.matchesY", Math.Abs(Volume(loftZ) - Volume(lofted)) < 0.02 * Volume(lofted),
     $"y={Volume(lofted):0.##} z={Volume(loftZ):0.##}");

Shape ringZ = Torus(d: 30, ring: 8, axis: "z");
NearAbs("Torus.axis.z.thickness", BBox(ringZ).Size.z, 8, 1.5);
NearAbs("Torus.axis.z.span", BBox(ringZ).Size.x, 38, 1.5);
True("Torus.axis.z.matchesY", Math.Abs(Volume(ringZ) - Volume(ring)) < 0.02 * Volume(ring),
     $"y={Volume(ring):0.##} z={Volume(ringZ):0.##}");

Shape wheelZ = ArrayRadial(Cylinder(d: 6, h: 10, axis: "z"), 6, radius: 15, axis: "z");
NearAbs("ArrayRadial.axis.z.span", BBox(wheelZ).Size.x, 36, 2.0);
NearAbs("ArrayRadial.axis.z.height", BBox(wheelZ).Size.z, 10, 1.0);
NearVox("ArrayRadial.axis.z.volume", Volume(wheelZ), 6 * Math.PI * 9 * 10,
        6 * (2 * Math.PI * 9 + 2 * Math.PI * 3 * 10));

// ===========================================================================
// AREA — surface area, and the triangle-count prediction it buys
// ===========================================================================
NearAbs("Area.box20", Area(box), 2400, 240);
NearAbs("Area.sphere20", Area(ball), 4 * Math.PI * 100, 120);
True("Area.cube.growsWithSize", Area(Box(40, 40, 40)) > 3.5 * Area(box),
     $"box20={Area(box):0.##} box40={Area(Box(40, 40, 40)):0.##}");

// ===========================================================================
// EMBOSS — the bundled anvil depth map, raised and cut
// ===========================================================================
Shape plate = Box(40, 4, 40);
double vPlate = Volume(plate);
double plateSpanX = BBox(plate).Size.x;

Shape raised = Emboss(plate, "emboss-sample.png", face: "+y", depth: 1.2, mode: "raise", marginMM: 2);
double vRaised = Volume(raised);
double dRaise = vRaised - vPlate;
True("Emboss.raise.addsMaterial", dRaise > 0,
     $"got={vRaised:0.##} plate={vPlate:0.##} delta=+{dRaise:0.##}");
NearAbs("Emboss.raise.bbox.y", BBox(raised).Size.y, 4 + 1.2, 1.0);
NearAbs("Emboss.raise.noSkirt", BBox(raised).Size.x, plateSpanX, 0.6);

Shape engraved = Emboss(plate, "emboss-sample.png", face: "+y", depth: 1.2, mode: "cut", marginMM: 2);
double vCut = Volume(engraved);
double dCut = vPlate - vCut;
True("Emboss.cut.removesMaterial", dCut > 0,
     $"got={vCut:0.##} plate={vPlate:0.##} delta=-{dCut:0.##}");

// Raising and cutting the same map to the same depth must move a comparable
// amount of material — the sharpest guard against a projection that leaks past
// the mapped region.
True("Emboss.raise~cut.symmetry", dRaise > 0.4 * dCut && dRaise < 2.5 * dCut,
     $"raise=+{dRaise:0.##} cut=-{dCut:0.##}");

Shape sideEmboss = Emboss(Box(30, 30, 5), "emboss-sample.png", face: "+z", depth: 1.0, marginMM: 2);
True("Emboss.face.+z", Volume(sideEmboss) > Volume(Box(30, 30, 5)),
     $"got={Volume(sideEmboss):0.##}");

// ===========================================================================
// RESULTS — two parts worth looking at
// ===========================================================================
SavePart("forge_smoke_emboss", raised);

// A little of everything, stacked: a blended hub drilled with a radial array.
Shape hub = SmoothUnion(Cylinder(d: 30, h: 10), Sphere(d: 18, at: V(0, 8, 0)), radius: 2);
Shape drilled = Subtract(hub, ArrayRadial(Cylinder(d: 4, h: 40), 5, radius: 10));
SavePart("forge_smoke_stack", drilled);

Log($"FORGE-SMOKE total={nPass + nFail} pass={nPass} fail={nFail}");
if (nFail > 0) throw new Exception($"forge smoke: {nFail} assertion(s) failed");
