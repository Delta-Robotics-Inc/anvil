// compliant_wheel.csx
// ---------------------------------------------------------------------------
// An airless O180 mm rover wheel: a bolted hub, three concentric bands of
// logarithmic-spiral ribs, a rim, and a chevron tread. The suspension is the
// structure — there is no air in it, and there is nothing to puncture.
//
// WHAT THIS DEMONSTRATES
//   Writing your own IImplicit. This is the deepest thing an Anvil script can
//   do and the one that stops the Forge command list from being a ceiling. The
//   ribs here are not modelled one at a time and unioned; they are the LEVEL
//   SETS of a field you write in about fifteen lines:
//
//       phi + b*ln(r) = 2*pi*k/n
//
//   is a family of n logarithmic spirals. Measure the perpendicular distance to
//   the nearest one, subtract half a (graded) thickness, and you have a signed
//   distance field whose zero set is every rib in the band. One render, n ribs,
//   any n. Anvil clips it to an envelope with voxIntersectImplicit, which walks
//   only the voxels the envelope already occupies — so a thin band costs the
//   band, not the bounding box.
//
//   Fillet      the finishing pass. Concave edges only, so a 1.5 mm rib is
//               untouched. Do NOT reach for Smooth here: Smooth is a triple
//               offset and it would erase every rib in band 3.
//   Cylinder(axis) / ArrayRadial(axis)   the hub, rim, bolt circle and tread,
//               all about +Z.
//   Pipe        the chevron tread lug: three points, so it stays a cheap exact
//               field rather than a lattice.
//
// THE DESIGN LANGUAGE (lifted from LEAP 71's RoverWheel)
//   Concentric bands, and across them two rules run in opposite directions:
//     * SYMMETRY RISES outward   — 12 ribs, then 24, then 48. Element size
//       stays roughly constant as circumference grows, so the outer bands do
//       not turn into billboards.
//     * THICKNESS FALLS outward  — 3.4 mm down to 1.5 mm. Load per rib falls
//       as the count rises, and the outer bands are the compliant ones.
//     * HANDEDNESS ALTERNATES    — band 2 spirals the other way, band 3 back
//       again, and harder each time. Counter-handed neighbours CROSS at the
//       band interfaces and form a shear-stiff diamond network. That crossing
//       is why this reads as engineered rather than as a pinwheel.
//   Identical repetition is texture. Graded repetition is engineering.
//
// ORIENTATION AND PRINTABILITY
//   The wheel lies FLAT on the plate, axle along +Z, z in [0, widthMM]. Every
//   rib is therefore a vertical wall: nothing overhangs, nothing needs support,
//   and the ribs are loaded in their strong direction. Print it in TPU 95A and
//   it is a working wheel.
//
// PARAMETERS (all optional)
//   odMM         diameter over the rim; the tread adds about lugHMM  (default 180)
//   widthMM      wheel width, along the axle (+Z)                    (default 45)
//   hubOdMM      hub outside diameter                                (default 46)
//   axleBoreMM   axle bore                                           (default 25)
//   boltCount    hub bolt holes, 0 = none                            (default 6)
//   boltDiaMM    hub bolt hole diameter                              (default 4.4)
//   boltCircleMM hub bolt circle diameter                            (default 35)
//   r1MM r2MM    outer radius of bands 1 and 2                       (default 52, 74)
//   n1 n2 n3     rib count per band, rising outward                  (default 12, 24, 48)
//   t1aMM t1bMM  band 1 rib thickness, inner -> outer                (default 3.4, 2.6)
//   t2aMM t2bMM  band 2 rib thickness                                (default 2.4, 1.9)
//   t3aMM t3bMM  band 3 rib thickness                                (default 1.8, 1.5)
//   bSpiral      spiral tightness of band 1; 0 = straight spokes     (default 0.55)
//   bandLapMM    overlap between neighbouring bands                  (default 1.5)
//   rimTMM       rim band thickness                                  (default 3.0)
//   treadLugs    chevron tread lugs                                  (default 30)
//   lugDMM lugHMM lugSpanMM lugWMM   tread lug section, height,
//                span across the width, chevron offset      (default 6, 3.5, 26, 9)
//   filletMM     global concave fillet                               (default 0.6)
//
// RESOLUTION AND RUNTIME
//   Stated default voxelSizeMM 0.35 — about 35-55 s, roughly 2.4 M triangles.
//   The thinnest rib (t3bMM 1.5 mm) is four voxels at 0.35, which is the floor.
//   0.5 while tuning; 0.25 for the print (4-6 min).
//
// VARIANTS (the same script, three wheels)
//   rover-180   the defaults
//   soft        every t*MM x 0.7 and n1 8 — a visibly squishier wheel
//   caster-90   odMM 90, r1MM 26, r2MM 37, hubOdMM 23, axleBoreMM 12,
//               boltCircleMM 17, widthMM 24, treadLugs 18 — proves it scales
// ---------------------------------------------------------------------------

double odMM         = ParamF("odMM", 180f);
double widthMM      = ParamF("widthMM", 45f);
double hubOdMM      = ParamF("hubOdMM", 46f);
double axleBoreMM   = ParamF("axleBoreMM", 25f);
int    boltCount    = (int)Math.Round(ParamF("boltCount", 6f));
double boltDiaMM    = ParamF("boltDiaMM", 4.4f);
double boltCircleMM = ParamF("boltCircleMM", 35f);
double r1MM         = ParamF("r1MM", 52f);
double r2MM         = ParamF("r2MM", 74f);
int    n1           = (int)Math.Round(ParamF("n1", 12f));
int    n2           = (int)Math.Round(ParamF("n2", 24f));
int    n3           = (int)Math.Round(ParamF("n3", 48f));
double t1aMM        = ParamF("t1aMM", 3.4f);
double t1bMM        = ParamF("t1bMM", 2.6f);
double t2aMM        = ParamF("t2aMM", 2.4f);
double t2bMM        = ParamF("t2bMM", 1.9f);
double t3aMM        = ParamF("t3aMM", 1.8f);
double t3bMM        = ParamF("t3bMM", 1.5f);
double bSpiral      = ParamF("bSpiral", 0.55f);
double bandLapMM    = ParamF("bandLapMM", 1.5f);
double rimTMM       = ParamF("rimTMM", 3.0f);
int    treadLugs    = (int)Math.Round(ParamF("treadLugs", 30f));
double lugDMM       = ParamF("lugDMM", 6f);
double lugHMM       = ParamF("lugHMM", 3.5f);
double lugSpanMM    = ParamF("lugSpanMM", 26f);
double lugWMM       = ParamF("lugWMM", 9f);
double filletMM     = ParamF("filletMM", 0.6f);

// ---------------------------------------------------------------------------
// The rib field. n logarithmic spirals of graded thickness, as one signed
// distance function. b = 0 gives straight radial spokes; the sign of b sets the
// handedness. The wheel lies flat, so the pattern lives in the XY plane and is
// constant along Z — which is exactly what makes every rib a printable wall.
// ---------------------------------------------------------------------------
sealed class SpiralRibs : IImplicit
{
    readonly float m_n, m_b, m_r0, m_r1, m_t0, m_t1, m_phi0;

    public SpiralRibs(int n, float b, float r0, float r1, float t0, float t1, float phi0)
    { m_n = n; m_b = b; m_r0 = r0; m_r1 = r1; m_t0 = t0; m_t1 = t1; m_phi0 = phi0; }

    public float fSignedDistance(in Vector3 v)
    {
        float r = MathF.Sqrt(v.X * v.X + v.Y * v.Y);
        if (r < 1e-3f) return 1e3f;                       // the axle line is never inside a rib

        // theta is constant along one spiral of the family, and the ribs are the
        // level sets where n*theta/(2*pi) is an integer.
        float theta = MathF.Atan2(v.Y, v.X) + m_b * MathF.Log(r) - m_phi0;
        float g     = m_n * theta / (2f * MathF.PI);
        float frac  = g - MathF.Round(g);                 // signed, in [-0.5, 0.5]

        // |grad theta| = sqrt(1 + b^2)/r, so this converts the angular offset
        // into a real perpendicular distance to the nearest rib mid-surface.
        float dPerp = MathF.Abs(frac) * (2f * MathF.PI / m_n) * r / MathF.Sqrt(1f + m_b * m_b);

        float u = Math.Clamp((r - m_r0) / MathF.Max(1e-3f, m_r1 - m_r0), 0f, 1f);
        float t = m_t0 + (m_t1 - m_t0) * u;               // thickness graded across the band
        return 0.95f * (dPerp - 0.5f * t);                // 0.95 keeps the field band-safe
    }
}

// ---------------------------------------------------------------------------
// The wheel, as one noun.
// ---------------------------------------------------------------------------
sealed class CompliantWheel
{
    public Shape Part { get; }
    public double SolidFractionPct { get; }
    public double SweptMM3 { get; }

    readonly double _w;

    public CompliantWheel(
        double od, double width, double hubOd, double axleBore,
        int boltCount, double boltDia, double boltCircle,
        double r1, double r2, int n1, int n2, int n3,
        double t1a, double t1b, double t2a, double t2b, double t3a, double t3b,
        double bSpiral, double bandLap, double rimT,
        int treadLugs, double lugD, double lugH, double lugSpan, double lugW,
        double fillet, float voxelMM, Action<string> log)
    {
        _w = width;
        double rOut = od * 0.5, rRimIn = rOut - rimT, rHub = hubOd * 0.5;
        double tMin = Math.Min(Math.Min(t1b, t2b), t3b);

        // ---- validation ------------------------------------------------------
        // eps absorbs the float round-trip through ParamF, so "exactly four
        // voxels" passes instead of failing by half an ulp.
        const double eps = 1e-3;
        if (tMin < 4 * voxelMM - eps)
            throw new ArgumentException($"the thinnest rib ({tMin:0.###} mm) is under four voxels at {voxelMM} mm — it would come out as a rag, not a wall");
        if (2 * fillet > tMin)
            throw new ArgumentException($"filletMM {fillet} is too big for a {tMin} mm rib: keep 2 x filletMM at or under the thinnest rib");
        if (!(rHub < r1 && r1 < r2 && r2 < rRimIn))
            throw new ArgumentException($"the radii must climb: hub {rHub} < r1 {r1} < r2 {r2} < rim inner {rRimIn} (= odMM/2 - rimTMM)");
        if (axleBore >= hubOd - 4 * voxelMM + eps)
            throw new ArgumentException($"axleBoreMM {axleBore} leaves no hub wall inside hubOdMM {hubOd}");
        if (boltCount >= 1)
        {
            if (boltCircle * 0.5 + boltDia * 0.5 >= rHub)
                throw new ArgumentException($"the bolt circle O{boltCircle} + bolt O{boltDia} breaks out of the hub O{hubOd}");
            if (boltCircle * 0.5 - boltDia * 0.5 <= axleBore * 0.5)
                throw new ArgumentException($"the bolt circle O{boltCircle} - bolt O{boltDia} breaks into the axle bore O{axleBore}");
        }
        if (bandLap < 2 * voxelMM - eps)
            throw new ArgumentException($"bandLapMM {bandLap} is too small to fuse neighbouring bands at {voxelMM} mm");

        // Rib pitch has to leave a gap, or a band silts up into a solid disc.
        CheckPitch("band 1", rHub - bandLap, n1, t1a, log);
        CheckPitch("band 2", r1 - bandLap, n2, t2a, log);
        CheckPitch("band 3", r2 - bandLap, n3, t3a, log);

        log($"wheel: O{od:0.#} x {width:0.#} mm on a O{axleBore:0.#} axle, bands {n1}/{n2}/{n3} ribs, " +
            $"ribs {t1a:0.##}->{t3b:0.##} mm, spiral b {bSpiral:0.##}/{-1.5 * bSpiral:0.##}/{2.5 * bSpiral:0.##} at voxel {voxelMM} mm");

        // ---- hub: a bolted flange with an axle bore --------------------------
        Shape hub = Subtract(
            Cyl(hubOd), Cyl(axleBore, over: true));
        if (boltCount >= 1)
            hub = Subtract(hub, ArrayRadial(Cyl(boltDia, over: true), boltCount, radius: boltCircle * 0.5, axis: "z"));

        // ---- three counter-handed bands --------------------------------------
        Shape b1 = Band(rHub - bandLap, r1, n1, +bSpiral, t1a, t1b, 0);
        Shape b2 = Band(r1 - bandLap, r2, n2, -1.5 * bSpiral, t2a, t2b, 0);
        Shape b3 = Band(r2 - bandLap, rRimIn + bandLap, n3, +2.5 * bSpiral, t3a, t3b, 0);

        // ---- rim + chevron tread ---------------------------------------------
        Shape rim = Subtract(Cyl(od), Cyl(od - 2 * rimT, over: true));

        var vee = new List<Vec3> {
            V(0,    -lugW * 0.5, -lugSpan * 0.5),   // arm tip, one side of the width
            V(lugH,  0,           0),               // apex, mid-width, radially proud
            V(0,    -lugW * 0.5,  lugSpan * 0.5),   // arm tip, the other side
        };
        Shape lug   = Move(Pipe(vee, d: lugD), rOut - lugD * 0.25, 0, width * 0.5);
        Shape tread = ArrayRadial(lug, treadLugs, radius: 0, axis: "z");

        Shape wheel = Union(hub, b1, b2, b3, rim, tread);

        // Concave-only, so every rib survives at full thickness. Smooth would not.
        wheel = Fillet(wheel, fillet);

        SweptMM3 = Math.PI * rOut * rOut * width;
        SolidFractionPct = 100.0 * Volume(wheel) / SweptMM3;
        Part = wheel;

        log($"tread: {treadLugs} chevron lugs O{lugD:0.##} spanning {lugSpan:0.#} mm of the {width:0.#} mm width, " +
            $"{2 * Math.PI * rOut / treadLugs:0.##} mm apart on the rim; rim band {rimT:0.##} mm");
    }

    /// <summary>A cylinder about +Z spanning the wheel width (or 1 mm past both faces).</summary>
    Shape Cyl(double dia, bool over = false)
        => Cylinder(dia, over ? _w + 2 : _w, at: V(0, 0, _w * 0.5), axis: "z");

    /// <summary>One radial band of n counter-handed spiral ribs, clipped to an annulus.</summary>
    Shape Band(double r0, double r1, int n, double b, double t0, double t1, double phase)
    {
        Shape env = Subtract(Cylinder(2 * r1, _w, at: V(0, 0, _w * 0.5), axis: "z"),
                             Cylinder(2 * r0, _w + 2, at: V(0, 0, _w * 0.5), axis: "z"));
        var field = new SpiralRibs(n, (float)b, (float)r0, (float)r1, (float)t0, (float)t1, (float)phase);
        return ((Voxels)env).voxIntersectImplicit(field);
    }

    static void CheckPitch(string name, double r0, int n, double t0, Action<string> log)
    {
        double pitch = 2 * Math.PI * r0 / n;
        if (pitch <= 2 * t0)
            throw new ArgumentException(
                $"{name}: {n} ribs of {t0} mm at r {r0:0.#} mm leave a {pitch:0.##} mm pitch — the ribs merge into a solid disc");
        log($"{name}: {n} ribs, {pitch:0.##} mm pitch at r {r0:0.#} mm against a {t0:0.##} mm rib = {100 * t0 / pitch:0.#}% fill");
    }
}

// ---------------------------------------------------------------------------
// Build it, report the numbers, register the part.
// ---------------------------------------------------------------------------
var wheel = new CompliantWheel(
    odMM, widthMM, hubOdMM, axleBoreMM, boltCount, boltDiaMM, boltCircleMM,
    r1MM, r2MM, n1, n2, n3, t1aMM, t1bMM, t2aMM, t2bMM, t3aMM, t3bMM,
    bSpiral, bandLapMM, rimTMM, treadLugs, lugDMM, lugHMM, lugSpanMM, lugWMM,
    filletMM, VoxelSizeMM, Log);

// Area(shape) meshes the shape to measure it — the same work SavePart is about
// to do — so it is not called here; see heat_exchanger.csx, where surface area
// is the number the part is actually bought on.
Bounds bb = BBox(wheel.Part);
double volMM3 = Volume(wheel.Part);
Log($"wheel {volMM3:0.#} mm3 = {volMM3 * 1.21e-3:0.#} g in TPU 95A, {wheel.SolidFractionPct:0.#}% of the swept volume, " +
    $"bbox {bb.Size}, lying flat from z = {bb.Min.z:0.##} to {bb.Max.z:0.##} mm");

SavePart("compliant_wheel", wheel.Part);
