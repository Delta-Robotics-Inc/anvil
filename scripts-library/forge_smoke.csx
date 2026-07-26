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
