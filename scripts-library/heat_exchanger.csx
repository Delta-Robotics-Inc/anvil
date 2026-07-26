// heat_exchanger.csx
// ---------------------------------------------------------------------------
// A TWO-DOMAIN counterflow heat exchanger: one printable metal part carrying two
// fluid circuits that are proven, in this script, never to touch.
//
// WHAT THIS DEMONSTRATES
//   The fluid-first recipe. You do NOT model a pipe and hope. You model the
//   two fluid VOLUMES, push them apart by a wall thickness, and then DEFINE the
//   metal as the complement of the fluid inside an offset skin:
//
//       metal = Subtract(envelope, fluidA, fluidB)
//
//   Because the metal is derived from the fluid rather than drawn around it, it
//   is automatically watertight, automatically encloses both circuits, and
//   cannot leak. Subtract the fluid LAST so no later addition can re-block a
//   channel. (LEAP 71 build this way in HelixHeatX; it is the single most
//   transferable idea in the whole computational-engineering toolkit.)
//
//   Lattice     a sheet gyroid is the separating WALL; a skeletal gyroid at
//               bias 0 is the f < 0 half-space. Subtracting one from the other
//               gives the two interpenetrating domains in three calls.
//   Loft(axis)  the trumpet plenums that collect circuit A.
//   Capsule     the radial port bores and their bosses — direction-free, so no
//               rotation is needed to point a port outward.
//   Intersect   used as an ASSERTION, not as geometry: the script measures the
//               overlap of the two circuits and refuses to save a part if it is
//               anything but empty.
//   Area        the headline number a heat exchanger is actually bought on.
//
// TOPOLOGY — how each circuit gets its own headers without ever meeting
//   A gyroid splits the core into two interpenetrating domains separated by one
//   continuous sheet. Both run the full height, so headers cannot simply be
//   "one at each end". Instead each domain is SEALED against a different
//   boundary of the core:
//
//     A (axial)   sealed against the cylindrical side by a solid annular band,
//                 so it can only enter and leave through the end faces.
//                 -> a coaxial trumpet plenum and an axial port at each end.
//     B (radial)  sealed against the end faces by two solid slabs, so it can
//                 only enter and leave through the side.
//                 -> an annular jacket, BLOCKED by a solid ring at mid-height
//                    so B cannot short-circuit up the annulus and has to travel
//                    through the core instead.
//
//   A therefore flows bottom -> top axially and B bottom -> top through the
//   core interior: genuine counterflow, four ports, two circuits, one part.
//   Every seal is a boolean against a primitive. Nothing here is clever.
//
// THE OBJECTION, ANSWERED
//   Lin Kayser (PicoGK's author) is publicly sceptical of TPMS heat exchangers:
//   "gyroids ... usually create dead ends, and their very curvy nature creates
//   high pressure drops". This design answers the DEAD-END half head on: both
//   domains are open, both are headered at two ends, both are proven separated,
//   and neither is a blind pocket — the assertions below would fail if either
//   circuit were closed off. It does NOT answer the pressure-drop half. cellMM
//   is the knob: a bigger cell trades surface area for a lower dP.
//
// ORIENTATION
//   The part STANDS on the plate: z in [0, height], flange face at z = 0. Every
//   revolved builder is called with axis: "z". Printed in this orientation the
//   gyroid is self-supporting (a TPMS has no horizontal overhang), the ports
//   are the only features needing attention, and the flange is the first layer.
//
// PARAMETERS (all optional)
//   coreDiaMM    gyroid core diameter                          (default 56)
//   coreHMM      gyroid core height                            (default 70)
//   cellMM       gyroid unit cell — the pressure-drop knob     (default 12)
//   wallMM       separating sheet = the wall between circuits  (default 1.5)
//   skinMM       outer shell and the sealing bands             (default 1.6)
//   jacketGapMM  annular gap for circuit B                     (default 5)
//   headerHMM    height of each of A's trumpet plenums         (default 18)
//   portDiaMM    bore of all four ports                        (default 12)
//   portLenMM    port stick-out past the shell                 (default 10)
//   flangeODMM   base mounting flange outside diameter         (default 84)
//   flangeTMM    base flange thickness                         (default 4)
//   boltCount    flange bolt holes, 0 = none                   (default 8)
//   boltDiaMM    flange bolt hole diameter                     (default 5.5)
//   emitFluids   also save the two fluid volumes as parts      (default true)
//
// RESOLUTION AND RUNTIME
//   Stated default voxelSizeMM 0.4 — about 45 s for all three parts, ~2.7 M
//   triangles for the metal. 0.5 while tuning; 0.3 for a print-ready bake.
//   Meshing, not field maths, is the ceiling: the script logs the predicted
//   triangle count from Area / (0.5 * voxel^2) before it saves anything.
//   emitFluids: false saves only the metal and cuts the run to about a third —
//   the fluid volumes exist to LOOK at the two circuits, not to print them.
//
// VARIANTS (the same script, three parts)
//   bench       the defaults. O84 x 120 mm, ~1.0 kg in 316L if fully dense.
//   coarse      cellMM 16, wallMM 2.0, voxel 0.5 — the 25-second iteration.
//   reference   coreDiaMM 170, coreHMM 220, cellMM 16, voxel 0.5 — LEAP 71's
//               published O200 x 300 mm HeatX envelope. About 8 min.
//
// NOT IMPLEMENTED (deliberately)
//   An interstitial "tell-tale" vent inside the separating sheet, vented to
//   atmosphere so a wall crack shows up outside instead of mixing the fluids
//   (LEAP 71 do this with a nitrogen purge layer in their injector heads). It
//   is left out because its vent port cannot reach the sheet without crossing
//   circuit B's jacket: it needs a thickened mid-height blocker and a third
//   separation proof of its own. That is a design problem worth solving, not a
//   line of code, so it is not faked here.
// ---------------------------------------------------------------------------

double coreDiaMM   = ParamF("coreDiaMM", 56f);
double coreHMM     = ParamF("coreHMM", 70f);
double cellMM      = ParamF("cellMM", 12f);
double wallMM      = ParamF("wallMM", 1.5f);
double skinMM      = ParamF("skinMM", 1.6f);
double jacketGapMM = ParamF("jacketGapMM", 5f);
double headerHMM   = ParamF("headerHMM", 18f);
double portDiaMM   = ParamF("portDiaMM", 12f);
double portLenMM   = ParamF("portLenMM", 10f);
double flangeODMM  = ParamF("flangeODMM", 84f);
double flangeTMM   = ParamF("flangeTMM", 4f);
int    boltCount   = (int)Math.Round(ParamF("boltCount", 8f));
double boltDiaMM   = ParamF("boltDiaMM", 5.5f);
bool   emitFluids  = ParamB("emitFluids", true);

// ---------------------------------------------------------------------------
// The part, as one noun. Everything is validated and built in the constructor;
// the script body below is four lines. A script-declared class cannot see the
// script's own Log / VoxelSizeMM, so both are handed in.
// ---------------------------------------------------------------------------
sealed class TwoDomainHX
{
    /// <summary>The printable metal part.</summary>
    public Shape Metal { get; }
    /// <summary>Circuit A's fluid volume (axial): plenums, ports and its gyroid domain.</summary>
    public Shape FluidA { get; }
    /// <summary>Circuit B's fluid volume (radial): jacket, ports and its gyroid domain.</summary>
    public Shape FluidB { get; }

    /// <summary>Measured overlap of the two circuits (mm3). Zero is the whole point.</summary>
    public double TouchMM3 { get; }
    /// <summary>Distance A was grown by for the clearance proof (mm).</summary>
    public double ProbeGapMM { get; }
    /// <summary>Overlap after growing A by ProbeGapMM (mm3). Also zero.</summary>
    public double ProbeMM3 { get; }

    public double HeightMM { get; }
    public double OuterDiaMM { get; }
    public double FluidAMM3 { get; }
    public double FluidBMM3 { get; }
    public double CoreMM3 { get; }

    public TwoDomainHX(
        double coreDia, double coreH, double cell, double wall, double skin,
        double jacketGap, double headerH, double portDia, double portLen,
        double flangeOD, double flangeT, int boltCount, double boltDia,
        float voxelMM, Action<string> log)
    {
        // ---- validation: fail with a sentence, not a stack trace --------------
        // eps absorbs the float round-trip through ParamF, so "exactly three
        // voxels" passes instead of failing by half an ulp.
        const double eps = 1e-3;
        if (wall < 3 * voxelMM - eps)
            throw new ArgumentException($"wallMM {wall} is under three voxels at {voxelMM} mm — the wall between the two circuits would not resolve, and it is the only thing keeping them apart");
        if (cell < 6 * wall)
            throw new ArgumentException($"cellMM {cell} must be at least 6x wallMM {wall}: below that the gyroid domains pinch off and a circuit dead-ends");
        if (skin < wall)
            throw new ArgumentException($"skinMM {skin} must be at least wallMM {wall} so a sealing band always fully closes a gyroid gap");
        if (jacketGap < 3 * skin)
            throw new ArgumentException($"jacketGapMM {jacketGap} must be at least 3x skinMM {skin} to leave a flow area worth having");
        if (coreDia < 4 * cell)
            throw new ArgumentException($"coreDiaMM {coreDia} must hold at least 4 cells of {cell} mm");
        if (coreH < 5 * cell)
            throw new ArgumentException($"coreHMM {coreH} must hold at least 5 cells of {cell} mm");
        if (portDia < 4 * voxelMM - eps)
            throw new ArgumentException($"portDiaMM {portDia} is under four voxels at {voxelMM} mm");
        if (portDia * 0.5 + skin > coreDia * 0.5 - skin)
            throw new ArgumentException($"portDiaMM {portDia} does not fit inside the plenum throat");
        if (flangeOD < coreDia + 2 * jacketGap + 2 * skin + 4)
            throw new ArgumentException($"flangeODMM {flangeOD} must clear the outer shell diameter {coreDia + 2 * jacketGap + 2 * skin:0.##} mm");

        // ---- the axis: z = 0 is the flange face, on the plate -----------------
        double rCore     = coreDia * 0.5;
        double rPlenum   = rCore - skin;                       // A's plenum throat
        double rJacket   = rCore + jacketGap;                  // outside of B's annulus
        double rShell    = rJacket + skin;                     // outside of the metal shell
        double zc0       = flangeT + headerH;                  // core bottom
        double zc1       = zc0 + coreH;                        // core top
        double zMid      = 0.5 * (zc0 + zc1);
        HeightMM   = zc1 + headerH + portLen;
        OuterDiaMM = Math.Max(flangeOD, 2 * (rShell + portLen));

        log($"HX: core O{coreDia:0.#} x {coreH:0.#} mm, cell {cell:0.#} mm, separating wall {wall:0.##} mm, " +
            $"jacket {jacketGap:0.#} mm, shell {skin:0.##} mm -> envelope O{OuterDiaMM:0.#} x {HeightMM:0.#} mm at voxel {voxelMM} mm");

        // ---- 1. the core, the separating sheet, and the two raw domains -------
        Shape core = Cylinder(coreDia, coreH, at: V(0, 0, zMid), axis: "z");
        CoreMM3 = Volume(core);

        Shape sheet   = Lattice(core, "gyroid", cell: cell, wall: wall, type: "sheet");
        Shape negHalf = Lattice(core, "gyroid", cell: cell, type: "skeletal", bias: 0);

        Shape domB0 = Subtract(negHalf, sheet);        // f < -wall/2
        Shape domA0 = Subtract(core, negHalf, sheet);  // f > +wall/2
        log($"gyroid split: sheet {Volume(sheet):0.#} mm3, domain A {Volume(domA0):0.#} mm3, domain B {Volume(domB0):0.#} mm3 " +
            $"of a {CoreMM3:0.#} mm3 core");

        // ---- 2. seal each domain against a DIFFERENT boundary -----------------
        // A loses the outer annulus, so it can only breathe through the ends.
        // B loses the two end slabs, so it can only breathe through the side.
        //
        // Both cutters deliberately OVERSHOOT the core. A cutter whose face lands
        // exactly on the face it is cutting leaves a zero-thickness rind of
        // boundary voxels behind — which would show up, correctly, as the two
        // circuits touching. Overshooting by a couple of millimetres removes the
        // coincident surface and the separation comes out exactly empty.
        double lap = 2.0;
        Shape sideBand = Subtract(
            Cylinder(coreDia + 2 * lap, coreH + 2 * lap, at: V(0, 0, zMid), axis: "z"),
            Cylinder(coreDia - 2 * skin, coreH + 4 * lap, at: V(0, 0, zMid), axis: "z"));
        Shape endSlabs = Union(
            Box(coreDia + 4, coreDia + 4, skin + lap, at: V(0, 0, zc0 + skin * 0.5 - lap * 0.5)),
            Box(coreDia + 4, coreDia + 4, skin + lap, at: V(0, 0, zc1 - skin * 0.5 + lap * 0.5)));

        Shape domA = Subtract(domA0, sideBand);
        Shape domB = Subtract(domB0, endSlabs);

        // ---- 3. A's headers: a trumpet plenum and an axial port at each end ---
        Shape headLo = Loft(z => Lerp(portDia * 0.5, rPlenum, (z - flangeT) / headerH), flangeT, zc0, axis: "z");
        Shape headHi = Loft(z => Lerp(rPlenum, portDia * 0.5, (z - zc1) / headerH), zc1, zc1 + headerH, axis: "z");
        Shape portALo = Cylinder(portDia, flangeT + 2, at: V(0, 0, flangeT * 0.5), axis: "z");
        Shape portAHi = Cylinder(portDia, 2 * portLen, at: V(0, 0, zc1 + headerH), axis: "z");

        // ---- 4. B's jacket: an annulus BLOCKED at mid-height ------------------
        // Without the blocker, B would run straight up the annulus and never see
        // the core. With it, the only path from the lower jacket to the upper one
        // is through domain B.
        Shape jacket = Subtract(
            Cylinder(2 * rJacket, coreH, at: V(0, 0, zMid), axis: "z"),
            Cylinder(coreDia, coreH + 2, at: V(0, 0, zMid), axis: "z"),
            Box(4 * rJacket, 4 * rJacket, 2 * skin, at: V(0, 0, zMid)));

        // B's two ports sit a quarter turn apart rather than opposed: the annulus
        // is continuous so the angle is free, and staggering them keeps two
        // bosses off the same generatrix — better for the print and for getting a
        // wrench on either fitting.
        double zBLo = zc0 + 0.18 * coreH, zBHi = zc0 + 0.82 * coreH;
        double rBoreIn = rCore + portDia * 0.5;      // the inner cap lands on the jacket wall
        double rBoreOut = rShell + portLen;
        Shape portBLo = Capsule(V(rBoreIn, 0, zBLo), V(rBoreOut, 0, zBLo), portDia);
        Shape portBHi = Capsule(V(0, -rBoreIn, zBHi), V(0, -rBoreOut, zBHi), portDia);

        // ---- 5. the two fluid volumes, complete -------------------------------
        FluidA = Union(domA, headLo, headHi, portALo, portAHi);
        FluidB = Union(domB, jacket, portBLo, portBHi);
        FluidAMM3 = Volume(FluidA);
        FluidBMM3 = Volume(FluidB);

        // ---- 6. PROVE the separation -----------------------------------------
        // Two measurements, both of which must come out empty. The first says the
        // circuits do not touch. The second grows A by a probe distance and says
        // they are not merely touching-free but separated by metal.
        double voxCube = voxelMM * voxelMM * voxelMM;
        double tol = 8 * voxCube;                    // eight voxels of discretisation slop

        TouchMM3 = Volume(Intersect(FluidA, FluidB));
        if (TouchMM3 > tol)
            throw new ArgumentException(
                $"the two circuits overlap by {TouchMM3:0.###} mm3 (tolerance {tol:0.###}) — this part would mix its fluids");

        ProbeGapMM = 0.4 * wall;
        ProbeMM3 = Volume(Intersect(Offset(FluidA, ProbeGapMM), FluidB));
        if (ProbeMM3 > tol)
            throw new ArgumentException(
                $"growing circuit A by {ProbeGapMM:0.###} mm reaches circuit B ({ProbeMM3:0.###} mm3) — " +
                $"the wall is thinner than {ProbeGapMM:0.###} mm somewhere");

        log($"SEPARATION PROVEN  overlap={TouchMM3:0.####} mm3  overlap after growing A by {ProbeGapMM:0.##} mm={ProbeMM3:0.####} mm3  " +
            $"(tolerance {tol:0.####} mm3) -> circuit A and circuit B are nowhere closer than {ProbeGapMM:0.##} mm of solid metal");

        // ---- 7. the metal, defined as what the fluid is not -------------------
        Shape shell = Cylinder(2 * rShell, coreH + 2 * skin, at: V(0, 0, zMid), axis: "z");
        Shape flange = Cylinder(flangeOD, flangeT, at: V(0, 0, flangeT * 0.5), axis: "z");

        Shape bossAHi = Cylinder(portDia + 2 * skin, 2 * portLen, at: V(0, 0, zc1 + headerH), axis: "z");
        double rBossOut = rBoreOut - skin - 1.0;     // stops short of the bore, so the port opens
        Shape bossBLo = Capsule(V(rCore, 0, zBLo), V(rBossOut, 0, zBLo), portDia + 2 * skin);
        Shape bossBHi = Capsule(V(0, -rCore, zBHi), V(0, -rBossOut, zBHi), portDia + 2 * skin);

        Shape envelope = Union(
            core, shell, flange,
            Offset(headLo, skin), Offset(headHi, skin),
            bossAHi, bossBLo, bossBHi);

        Shape metal = Subtract(envelope, FluidA, FluidB);

        if (boltCount >= 1)
        {
            // The bolts only ever pass through the flange itself (z in [0, flangeT]),
            // where the only other metal is the neck of A's lower plenum.
            double boltCircle = flangeOD - 2 * boltDia - 6;
            double rNeck = portDia * 0.5 + skin + 1.0;
            if (boltCircle * 0.5 - boltDia * 0.5 <= rNeck)
                throw new ArgumentException($"the {boltCount} flange bolts would break into A's lower port neck (r {rNeck:0.#} mm) — raise flangeODMM");
            if (boltCircle * 0.5 + boltDia * 0.5 >= flangeOD * 0.5 - 2)
                throw new ArgumentException($"the {boltCount} flange bolts leave under 2 mm of land at the flange rim — raise flangeODMM");
            Shape bolts = ArrayRadial(
                Cylinder(boltDia, flangeT + 2, at: V(0, 0, flangeT * 0.5), axis: "z"),
                boltCount, radius: boltCircle * 0.5, axis: "z");
            metal = Subtract(metal, bolts);
            log($"{boltCount} flange bolts O{boltDia:0.##} on a O{boltCircle:0.#} mm circle");
        }

        Metal = metal;
    }

    static double Lerp(double a, double b, double t) => a + (b - a) * Math.Clamp(t, 0.0, 1.0);
}

// ---------------------------------------------------------------------------
// Build it, report the numbers that matter, register the parts.
// ---------------------------------------------------------------------------
var hx = new TwoDomainHX(
    coreDiaMM, coreHMM, cellMM, wallMM, skinMM, jacketGapMM, headerHMM,
    portDiaMM, portLenMM, flangeODMM, flangeTMM, boltCount, boltDiaMM,
    VoxelSizeMM, Log);

double wetted = Area(hx.Metal);
double tris   = wetted / (0.5 * VoxelSizeMM * VoxelSizeMM);
Log($"wetted area {wetted:0.#} mm2 ({wetted / 100.0:0.##} cm2) -> about {tris / 1e6:0.##} M triangles at a {VoxelSizeMM} mm voxel");
if (tris > 4e6) Log($"WARNING: over 4 M triangles — meshing will dominate the runtime; raise voxelSizeMM or cellMM");

Bounds bb = BBox(hx.Metal);
double volMM3 = Volume(hx.Metal);
Log($"metal {volMM3:0.#} mm3 = {volMM3 * 7.99e-3:0.#} g in 316L, bbox {bb.Size}, standing on z = {bb.Min.z:0.##} mm");
Log($"circuit A {hx.FluidAMM3:0.#} mm3 (axial, 2 ports) | circuit B {hx.FluidBMM3:0.#} mm3 (radial, 2 ports) | " +
    $"solid fraction {100.0 * volMM3 / (hx.FluidAMM3 + hx.FluidBMM3 + volMM3):0.#}%");

SavePart("hx_core", hx.Metal);
if (emitFluids)
{
    SavePart("hx_fluid_A", hx.FluidA);
    SavePart("hx_fluid_B", hx.FluidB);
}
