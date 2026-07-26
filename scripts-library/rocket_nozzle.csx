// rocket_nozzle.csx
// ---------------------------------------------------------------------------
// A REGENERATIVELY-COOLED bell nozzle: a Rao contour, a radius-graded hot-gas
// wall, and a set of helical cooling channels that wrap the whole bell and are
// closed out by their own jacket. Twenty engineering numbers in, one monolithic
// printable part out.
//
// WHAT THIS DEMONSTRATES
//   Beams        the batch beam primitive, and the reason this script finishes
//                in under a minute. The cooling circuit is ~7,000 tapered
//                beams; each is rendered natively over its own tight box. The
//                same geometry as one implicit field (Pipe / Capsule) would be
//                sampled once per voxel of the WHOLE 56 M-voxel bounding box,
//                per segment — hours instead of seconds.
//   Loft(axis)   the contour, as a radius function r(z) evaluated by ordinary
//                C# arithmetic. Nothing is drawn; everything is derived.
//   Torus(axis)  the inlet and outlet manifold rings that gather all N channels.
//   Capsule      the radial coolant ports and their bosses.
//   Offset       the closeout jacket, GROWN from the coolant volume rather than
//                drawn around it — so the jacket cannot miss a channel.
//   SmoothUnion  the flange fillet, so load flows through the joint.
//   ArrayRadial  the flange bolt pattern (about +Z).
//
// THE ENGINEERING CONTENT (what makes this a part and not a shape)
//
//   1. ORIENTATION. z = 0 is the EXIT PLANE and it sits on the plate; the
//      injector flange is at the top. Radius therefore decreases monotonically
//      from the exit up to the throat, so the outer wall leans INWARD the whole
//      way and nothing overhangs. The convergent section flares back out at
//      about 30 degrees from vertical, still inside the 45-degree rule. Printed
//      this way the part needs no supports.
//
//   2. WALL THICKNESS VARIES, FOR A REASON. The hot-gas wall is thickest at the
//      throat, where both the heat flux and the pressure peak, and thins toward
//      the exit. Grading on RADIUS rather than on height is deliberate: the
//      convergent section, which climbs back out to the chamber radius, picks up
//      an intermediate thickness automatically, and the rule stays true for any
//      contour. (LEAP 71 state exactly this for TKL-200; their published floor
//      for a channel wall is 0.8 mm.)
//
//   3. CONSTANT PERPENDICULAR PITCH. The helix angle is not a constant, it is
//      solved for. Holding the perpendicular spacing between adjacent channel
//      centrelines at pitchMM gives
//          cos(alpha) = pitchMM * N / (2*pi*rho)
//      so at the throat, where rho is smallest, the channels run nearly straight
//      and are tightly packed — maximum cooling exactly where the engine needs
//      it. Down the bell rho grows, alpha grows with it, and the channels wrap
//      harder and harder until alpha saturates at helixMaxDeg. Total wrap at the
//      defaults is about 200 degrees: a clearly visible spiral, not a rat's nest.
//      Channel DIAMETER falls out of the same equation, so the land between
//      channels stays at landMM everywhere.
//
//   4. SELF-SUPPORTING CHANNEL ROOFS. Each channel cross-section grows a tapered
//      cone RADIALLY OUTWARD, turning a round bore into a teardrop whose apex is
//      self-supporting. The unsupported face of a channel is its outboard one —
//      the part is built bottom-up and the bell leans inward — so that is the
//      face that needs the point. In Beams terms it costs one extra beam per
//      sample. This is HelixHeatX's riser trick applied to a cone.
//
//   5. THE JACKET IS DERIVED FROM THE COOLANT. closeout "tubes" offsets the
//      coolant volume outward by closeoutMM. Because 2 x closeoutMM exceeds the
//      land, adjacent skins overlap and the jacket closes itself into one
//      continuous surface with the spiral tubes still legible from outside.
//      closeout "smooth" lofts a plain conical skin over them instead.
//
//   6. A PERIOD-REGULAR INTERFACE ON AN ORGANIC BODY. Bolted flange, bolt
//      circle, port bosses. This is what separates hardware from sculpture.
//
// CONTOUR MATHS
//   Divergent: a quadratic Bezier from the throat (wall angle thetaN) to the
//   exit (wall angle thetaE), with the control point at the intersection of
//   those two tangents — the usual "80 percent bell" construction. thetaN and
//   thetaE come from a smooth fit to the published Rao charts as a function of
//   area ratio, corrected for a bell longer or shorter than the 80% reference.
//   Convergent: a raised cosine with zero slope at both ends, so the throat has
//   no crease and the flange face is square. This is a SHAPING approximation,
//   not a method-of-characteristics contour: a demonstration part.
//
// PARAMETERS (all optional)
//   throatDiaMM   throat diameter                              (default 24)
//   exitDiaMM     exit-plane diameter (area ratio 14.1)        (default 90)
//   chamberDiaMM  chamber / injector-face diameter             (default 54)
//   convLenMM     convergent length, throat to flange face     (default 34)
//   bellFraction  bell length / 15 degree cone length          (default 0.8)
//   wallThroatMM  hot-gas wall at the throat                   (default 1.4)
//   wallExitMM    hot-gas wall at the exit plane               (default 0.9)
//   channelStarts number of helical starts                     (default 22)
//   pitchMM       target perpendicular pitch between channels  (default 4.0)
//   landMM        metal land between adjacent channels         (default 1.2)
//   chMinMM       channel diameter floor                       (default 2.4)
//   chMaxMM       channel diameter ceiling                     (default 5.0)
//   helixMaxDeg   maximum helix angle from the meridian        (default 60)
//   teardropMM    self-supporting roof height past the bore    (default 1.2)
//   closeoutMM    jacket thickness over the channels           (default 0.9)
//   closeout      "tubes" (visible spiral) or "smooth"         (default tubes)
//   manifoldRingMM  tube diameter of the manifold tori         (default 9)
//   portDiaMM     coolant port bore                            (default 8)
//   portLenMM     port stick-out past the jacket               (default 9)
//   flangeODMM    injector flange outside diameter             (default 82)
//   flangeTMM     injector flange thickness                    (default 6)
//   boltCount     flange bolt holes, 0 = none                  (default 8)
//   boltDiaMM     flange bolt hole diameter                    (default 5.5)
//   stepMM        channel path arc-length step                 (default 1.0)
//
// RESOLUTION AND RUNTIME
//   Stated default voxelSizeMM 0.3 — about 40-60 s, roughly 1.6 M triangles.
//   0.4 while you are still moving the numbers (15-25 s); 0.2 for the final
//   bake (4-6 min, ~3.6 M triangles). wallExitMM 0.9 is exactly three voxels at
//   0.3 mm, which is the floor for anything leak-critical.
//
// VARIANTS (the same script, three engines)
//   bench-2kN     throatDiaMM 16, exitDiaMM 58, chamberDiaMM 36,
//                 channelStarts 16, pitchMM 3.6
//   demo-5kN      the defaults below
//   display-half  every diameter and length x 0.5, voxelSizeMM 0.2,
//                 closeout "tubes" — the photogenic one
//
// NOTE ON Log
//   Log(...) is the script logger and it HIDES System.Math.Log. Natural
//   logarithms are written Math.Log(...) in full.
// ---------------------------------------------------------------------------

double throatDiaMM   = ParamF("throatDiaMM", 24f);
double exitDiaMM     = ParamF("exitDiaMM", 90f);
double chamberDiaMM  = ParamF("chamberDiaMM", 54f);
double convLenMM     = ParamF("convLenMM", 34f);
double bellFraction  = ParamF("bellFraction", 0.8f);
double wallThroatMM  = ParamF("wallThroatMM", 1.4f);
double wallExitMM    = ParamF("wallExitMM", 0.9f);
int    channelStarts = (int)Math.Round(ParamF("channelStarts", 22f));
double pitchMM       = ParamF("pitchMM", 4.0f);
double landMM        = ParamF("landMM", 1.2f);
double chMinMM       = ParamF("chMinMM", 2.4f);
double chMaxMM       = ParamF("chMaxMM", 5.0f);
double helixMaxDeg   = ParamF("helixMaxDeg", 60f);
double teardropMM    = ParamF("teardropMM", 1.2f);
double closeoutMM    = ParamF("closeoutMM", 0.9f);
string closeout      = ParamS("closeout", "tubes").Trim().ToLowerInvariant();
double manifoldRingMM= ParamF("manifoldRingMM", 9f);
double portDiaMM     = ParamF("portDiaMM", 8f);
double portLenMM     = ParamF("portLenMM", 9f);
double flangeODMM    = ParamF("flangeODMM", 82f);
double flangeTMM     = ParamF("flangeTMM", 6f);
int    boltCount     = (int)Math.Round(ParamF("boltCount", 8f));
double boltDiaMM     = ParamF("boltDiaMM", 5.5f);
double stepMM        = ParamF("stepMM", 1.0f);

// ---------------------------------------------------------------------------
// The part, as one noun: validated and built in the constructor. A script-
// declared class cannot see the script's own Log / VoxelSizeMM, so both are
// handed in (the logger as `note`, because `Log` here means Math.Log).
// ---------------------------------------------------------------------------
sealed class RegenBellNozzle
{
    public Shape Part { get; }
    /// <summary>The coolant volume on its own — useful to save for inspection.</summary>
    public Shape Coolant { get; }

    public double ThroatZMM { get; }
    public double TopZMM { get; }
    public double AreaRatio { get; }
    public double ThetaNDeg { get; }
    public double ThetaEDeg { get; }
    public double WrapDeg { get; }
    public int    BeamCount { get; }
    public double ChannelMM3 { get; }

    readonly double _rT, _rE, _rC, _bellLen, _convLen, _zT;
    readonly double _x1, _R1, _m0, _m2;
    readonly double _wallT, _wallE;
    readonly int    _n;
    readonly double _pitch, _land, _chMin, _chMax, _cosMax;

    public RegenBellNozzle(
        double throatDia, double exitDia, double chamberDia, double convLen,
        double bellFraction, double wallThroat, double wallExit,
        int starts, double pitch, double land, double chMin, double chMax,
        double helixMaxDeg, double teardrop, double closeoutT, string closeoutMode,
        double manifoldRing, double portDia, double portLen,
        double flangeOD, double flangeT, int boltCount, double boltDia,
        double step, float voxelMM, Action<string> note)
    {
        // ---- validation ------------------------------------------------------
        // eps absorbs the float round-trip through ParamF, so "exactly three
        // voxels" passes instead of failing by half an ulp.
        const double eps = 1e-3;
        if (exitDia <= throatDia)
            throw new ArgumentException($"exitDiaMM {exitDia} must exceed throatDiaMM {throatDia}: a bell has to expand");
        if (chamberDia <= throatDia)
            throw new ArgumentException($"chamberDiaMM {chamberDia} must exceed throatDiaMM {throatDia}: a nozzle has to converge");
        if (bellFraction < 0.5 || bellFraction > 1.2)
            throw new ArgumentException($"bellFraction {bellFraction} is outside 0.5 .. 1.2");
        if (Math.Min(wallThroat, wallExit) < 3 * voxelMM - eps)
            throw new ArgumentException($"the thinnest hot-gas wall ({Math.Min(wallThroat, wallExit):0.###} mm) is under three voxels at {voxelMM} mm — a leak-critical wall needs three");
        if (chMin < 4 * voxelMM - eps)
            throw new ArgumentException($"chMinMM {chMin} is under four voxels at {voxelMM} mm — the channel bore would not resolve");
        if (land < 3 * voxelMM - eps)
            throw new ArgumentException($"landMM {land} is under three voxels at {voxelMM} mm");
        if (chMax <= chMin)
            throw new ArgumentException($"chMaxMM {chMax} must exceed chMinMM {chMin}");
        if (starts < 3)
            throw new ArgumentException($"channelStarts {starts} is too few to be a regen circuit");
        if (teardrop < 0 || teardrop > chMax)
            throw new ArgumentException($"teardropMM {teardrop} must be between 0 and chMaxMM {chMax}, or the roof breaks through the closeout");
        if (closeoutMode != "tubes" && closeoutMode != "smooth")
            throw new ArgumentException($"closeout must be \"tubes\" or \"smooth\" (got '{closeoutMode}')");
        if (closeoutMode == "tubes" && 2 * closeoutT <= land)
            throw new ArgumentException($"closeout \"tubes\" needs 2 x closeoutMM ({2 * closeoutT}) to exceed landMM {land}, or the jacket has gaps between the channels");
        if (step <= 0 || step > 4)
            throw new ArgumentException($"stepMM {step} must be between 0 and 4 mm");

        _rT = throatDia * 0.5; _rE = exitDia * 0.5; _rC = chamberDia * 0.5;
        _wallT = wallThroat; _wallE = wallExit;
        _n = starts; _pitch = pitch; _land = land; _chMin = chMin; _chMax = chMax;
        _cosMax = Math.Cos(helixMaxDeg * Math.PI / 180.0);

        // ---- contour ---------------------------------------------------------
        AreaRatio = (_rE / _rT) * (_rE / _rT);
        double coneLen = (_rE - _rT) / Math.Tan(15.0 * Math.PI / 180.0);
        _bellLen = bellFraction * coneLen;
        _convLen = convLen;
        _zT = _bellLen;                       // throat height above the exit plane
        ThroatZMM = _zT;
        TopZMM = _bellLen + _convLen;

        double bellCorr = Math.Pow(0.8 / bellFraction, 0.35);
        double thetaN = Math.Clamp((17.0 + 2.6 * Math.Log(AreaRatio)) * bellCorr, 12.0, 35.0);
        double thetaE = Math.Clamp((18.0 - 2.5 * Math.Log(AreaRatio)) * bellCorr, 3.0, 22.0);
        if (thetaN <= thetaE + 1.0) thetaN = thetaE + 1.0;
        ThetaNDeg = thetaN; ThetaEDeg = thetaE;

        _m0 = Math.Tan(thetaN * Math.PI / 180.0);
        _m2 = Math.Tan(thetaE * Math.PI / 180.0);
        _x1 = Math.Clamp((_rE - _rT - _m2 * _bellLen) / (_m0 - _m2), 1e-3, _bellLen - 1e-3);
        _R1 = Math.Clamp(_rT + _m0 * _x1, _rT, _rE);

        note($"nozzle: throat O{throatDia:0.##} exit O{exitDia:0.##} chamber O{chamberDia:0.##}, area ratio {AreaRatio:0.##}, " +
             $"{bellFraction:0.##} bell {_bellLen:0.#} mm (15 deg cone {coneLen:0.#} mm) + convergent {_convLen:0.#} mm = {TopZMM:0.#} mm tall");
        note($"Rao angles: thetaN {thetaN:0.#} deg at the throat, thetaE {thetaE:0.#} deg at the exit; " +
             $"hot-gas wall graded {wallThroat:0.##} mm at the throat -> {wallExit:0.##} mm at the exit plane");

        // ---- channel circuit as a VOID (model the fluid, derive the metal) ----
        double zIn  = manifoldRing * 0.75;
        double zOut = TopZMM - flangeT - manifoldRing;
        if (zOut <= zIn + 4 * step)
            throw new ArgumentException($"the coolant run from z {zIn:0.#} to {zOut:0.#} mm is too short — raise convLenMM or lower manifoldRingMM");

        double rhoIn = Rho(zIn), rhoOut = Rho(zOut);
        if (_pitch * _n > 2 * Math.PI * Rho(_zT))
            throw new ArgumentException(
                $"{_n} starts at {_pitch} mm pitch need {_pitch * _n:0.#} mm of circumference, but the throat only offers " +
                $"{2 * Math.PI * Rho(_zT):0.#} mm — lower channelStarts or pitchMM");

        var beams = new List<(Vec3 a, Vec3 b, double dA, double dB)>();
        double wrapMax = 0;
        for (int k = 0; k < _n; k++)
        {
            var pts = new List<Vec3>();
            var rad = new List<double>();
            double z = zIn, phi = 2 * Math.PI * k / _n, phi0 = phi;

            while (z < zOut)
            {
                double rr = Rho(z), dch = ChannelDia(z);
                pts.Add(V(rr * Math.Cos(phi), rr * Math.Sin(phi), z));
                rad.Add(dch * 0.5);
                double cosA = CosAlpha(rr);
                double sinA = Math.Sqrt(Math.Max(0.0, 1.0 - cosA * cosA));
                z += step * cosA;                     // axial advance
                phi += step * sinA / rr;              // circumferential advance, exact on the surface
            }
            pts.Add(V(rhoOut * Math.Cos(phi), rhoOut * Math.Sin(phi), zOut));
            rad.Add(ChannelDia(zOut) * 0.5);
            wrapMax = Math.Max(wrapMax, Math.Abs(phi - phi0) * 180.0 / Math.PI);

            for (int i = 0; i < pts.Count - 1; i++)
                beams.Add((pts[i], pts[i + 1], 2 * rad[i], 2 * rad[i + 1]));

            // The self-supporting roof: a cone from the bore centre out to
            // teardrop past the bore wall, on the OUTBOARD side.
            if (teardrop > 0)
                for (int i = 0; i < pts.Count; i++)
                {
                    double len = Math.Sqrt(pts[i].x * pts[i].x + pts[i].y * pts[i].y);
                    double ux = pts[i].x / len, uy = pts[i].y / len;
                    double tip = rad[i] + teardrop;
                    beams.Add((pts[i], V(pts[i].x + tip * ux, pts[i].y + tip * uy, pts[i].z), 2 * rad[i], 0.4));
                }
        }
        WrapDeg = wrapMax;
        BeamCount = beams.Count;
        note($"{_n} helical starts, {beams.Count} beams, wrap {wrapMax:0.#} deg, helix angle {Math.Acos(CosAlpha(Rho(_zT))) * 180 / Math.PI:0.#} deg " +
             $"at the throat -> {Math.Acos(CosAlpha(rhoIn)) * 180 / Math.PI:0.#} deg at the exit, " +
             $"channel O{ChannelDia(_zT):0.##} -> O{ChannelDia(zIn):0.##} mm on a {_land:0.##} mm land");

        Shape channels = Beams(beams);

        // The manifold rings sit ON the hot-gas wall, like the channels: their
        // centre circle is one ring-radius outboard of R + wall, so a ring is a
        // fat D-section groove that swallows every channel end.
        double ringRIn  = R(zIn)  + Wall(zIn)  + manifoldRing * 0.5;
        double ringROut = R(zOut) + Wall(zOut) + manifoldRing * 0.5;
        Shape ringIn  = Torus(d: 2 * ringRIn,  ring: manifoldRing, at: V(0, 0, zIn),  axis: "z");
        Shape ringOut = Torus(d: 2 * ringROut, ring: manifoldRing, at: V(0, 0, zOut), axis: "z");

        double bossWall = Math.Max(1.5, 2 * closeoutT);
        double boreEndIn  = ringRIn  + manifoldRing * 0.5 + portLen + closeoutT;
        double boreEndOut = ringROut + manifoldRing * 0.5 + portLen + closeoutT;
        Shape portIn  = Capsule(V( ringRIn,  0, zIn),  V( boreEndIn,  0, zIn),  portDia);
        Shape portOut = Capsule(V(-ringROut, 0, zOut), V(-boreEndOut, 0, zOut), portDia);

        // Clip the whole coolant volume out of the hot-gas wall. The contour
        // flares below each ring, so a ring of fixed radius would otherwise bite
        // into the wall and vent the circuit straight into the bore. This one
        // subtraction makes the wall thickness a guarantee rather than a hope.
        double over = 2 * _wallT + 1.0;
        Shape wallSolid = Loft(z => R(z) + Wall(z), -over, TopZMM + over, axis: "z");
        Coolant = Subtract(Union(channels, ringIn, ringOut, portIn, portOut), wallSolid);
        ChannelMM3 = Volume(Coolant);
        note($"coolant volume {ChannelMM3:0.#} mm3, inlet manifold at z {zIn:0.#} mm (exit end, cold), " +
             $"outlet manifold at z {zOut:0.#} mm (throat end, hot) — counter to the exhaust, as a regen circuit runs");

        // ---- the metal -------------------------------------------------------
        Shape bore = Loft(R, -over, TopZMM + over, axis: "z");

        // hotWall is wallSolid clipped to the part, which is one cheap boolean
        // instead of a second identical loft over a 56 M-voxel box.
        Shape hotWall = Intersect(wallSolid,
            Box(4 * _rE, 4 * _rE, TopZMM, at: V(0, 0, TopZMM * 0.5)));

        Shape jacket = closeoutMode == "tubes"
            ? Offset(Coolant, closeoutT)
            : Loft(z => R(z) + Wall(z) + ChannelDia(z) + teardrop + closeoutT, 0, TopZMM, axis: "z");

        Shape bossIn  = Capsule(V( ringRIn,  0, zIn),  V( boreEndIn  - bossWall - 1.0, 0, zIn),  portDia + 2 * bossWall);
        Shape bossOut = Capsule(V(-ringROut, 0, zOut), V(-(boreEndOut - bossWall - 1.0), 0, zOut), portDia + 2 * bossWall);

        Shape flange = Cylinder(flangeOD, flangeT, at: V(0, 0, TopZMM - flangeT * 0.5), axis: "z");

        // Blend the flange onto the CHAMBER WALL, not onto the finished body.
        // SmoothUnion is a double offset, and its cost tracks the surface area it
        // is given: run it on the smooth conical wall (a few seconds) rather than
        // on the corrugated jacket (half a minute). The seam being filleted is
        // the same one either way — the channels stop well below the flange.
        Shape body = Union(SmoothUnion(hotWall, flange, radius: 2.0), jacket, bossIn, bossOut);
        body = Subtract(body, bore, Coolant);

        if (boltCount >= 1)
        {
            double boltCircleR = flangeOD * 0.5 - boltDia * 0.5 - 3.5;
            double wallAtFlange = R(TopZMM) + Wall(TopZMM) + 1.0;
            if (boltCircleR - boltDia * 0.5 < wallAtFlange)
                throw new ArgumentException(
                    $"the {boltCount} bolts sit at r {boltCircleR - boltDia * 0.5:0.#} mm but the chamber wall reaches r {wallAtFlange:0.#} mm — raise flangeODMM");
            Shape pins = ArrayRadial(
                Cylinder(boltDia, flangeT + 2 * closeoutT, at: V(0, 0, TopZMM - flangeT * 0.5), axis: "z"),
                boltCount, radius: boltCircleR, axis: "z");
            body = Subtract(body, pins);
            note($"flange O{flangeOD:0.#} x {flangeT:0.#} mm with {boltCount} bolts O{boltDia:0.##} on a O{2 * boltCircleR:0.#} mm circle");
        }

        Part = body;
    }

    // ---- contour and derived fields (all pure functions of z) ----------------

    /// <summary>Hot-gas wall radius at height z (mm), clamped outside the part.</summary>
    public double R(double z)
    {
        double zc = Math.Clamp(z, 0.0, TopZMM);
        if (zc <= _zT)
        {
            // Divergent: invert the Bezier x(t) by bisection (monotone because
            // 0 < x1 < bellLen), then read R(t).
            double x = _zT - zc;
            double lo = 0.0, hi = 1.0;
            for (int i = 0; i < 36; i++)
            {
                double t = 0.5 * (lo + hi);
                double xt = 2 * (1 - t) * t * _x1 + t * t * _bellLen;
                if (xt < x) lo = t; else hi = t;
            }
            double tf = 0.5 * (lo + hi);
            return (1 - tf) * (1 - tf) * _rT + 2 * (1 - tf) * tf * _R1 + tf * tf * _rE;
        }
        double u = Math.Clamp((zc - _zT) / _convLen, 0.0, 1.0);
        return _rT + (_rC - _rT) * 0.5 * (1.0 - Math.Cos(Math.PI * u));
    }

    /// <summary>Hot-gas wall thickness at height z (mm): graded on RADIUS, thickest at the throat.</summary>
    public double Wall(double z)
    {
        double t = Math.Clamp((R(z) - _rT) / (_rE - _rT), 0.0, 1.0);
        return _wallT + (_wallE - _wallT) * t;
    }

    double CosAlpha(double rho) => Math.Clamp(_pitch * _n / (2 * Math.PI * rho), _cosMax, 1.0);

    /// <summary>Channel diameter at height z (mm) — whatever leaves exactly landMM of metal between neighbours.</summary>
    public double ChannelDia(double z)
    {
        double rho = Rho(z);
        return Math.Clamp(2 * Math.PI * rho * CosAlpha(rho) / _n - _land, _chMin, _chMax);
    }

    /// <summary>Channel centreline radius at height z (mm). One fixed-point pass resolves rho &lt;-&gt; diameter.</summary>
    public double Rho(double z)
    {
        double baseR = R(z) + Wall(z);
        double rho = baseR + 0.5 * (_chMin + _chMax) * 0.5;          // seed
        double dch = Math.Clamp(2 * Math.PI * rho * CosAlpha(rho) / _n - _land, _chMin, _chMax);
        return baseR + 0.5 * dch;
    }
}

// ---------------------------------------------------------------------------
// Build it, report the numbers, register the part.
// ---------------------------------------------------------------------------
var nozzle = new RegenBellNozzle(
    throatDiaMM, exitDiaMM, chamberDiaMM, convLenMM, bellFraction,
    wallThroatMM, wallExitMM, channelStarts, pitchMM, landMM, chMinMM, chMaxMM,
    helixMaxDeg, teardropMM, closeoutMM, closeout, manifoldRingMM,
    portDiaMM, portLenMM, flangeODMM, flangeTMM, boltCount, boltDiaMM,
    stepMM, VoxelSizeMM, Log);

// Area(shape) would give the wetted area, but it meshes the whole part to do it
// — the same work SavePart is about to do — and on a 130 mm nozzle that is
// another 15 seconds for a number the nozzle is not sold on. See
// heat_exchanger.csx, where surface area IS the product spec, for the other call.
Bounds bb = BBox(nozzle.Part);
double volMM3 = Volume(nozzle.Part);
Log($"nozzle {volMM3:0.#} mm3 = {volMM3 * 8.96e-3:0.#} g in CuCrZr, bbox {bb.Size}, " +
    $"exit plane on the plate at z = {bb.Min.z:0.##} mm, flange face at z = {bb.Max.z:0.##} mm");

SavePart("rocket_nozzle", nozzle.Part);
