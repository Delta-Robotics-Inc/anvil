//
// Anvil.Worker — Forge (the ANVIL Forge API)
//
// A flat, modular COMMAND layer over the PicoGK voxel kernel, auto-imported into
// every Anvil .csx script. The mental model is deliberately simple: a big list of
// commands, each with named modifiers, that snap together like LEGO.
//
//     Shape plate  = Box(60, 4, 40);
//     Shape boss   = Cylinder(d: 12, h: 8, at: V(0, 6, 0));
//     Shape body   = SmoothUnion(plate, boss, radius: 2);
//     Shape holes  = ArrayRadial(Cylinder(4, 20), count: 6, radius: 20);
//     SavePart("bracket", Subtract(body, holes));
//
// CONVENTIONS (all commands, no exceptions)
//   * Units are MILLIMETRES. Angles are DEGREES.
//   * The up axis is +Y (the Onshape/SolidWorks convention), so Cylinder / Cone
//     / Loft / Torus / ArrayRadial revolve about +Y by default. Every one of
//     those five takes an `axis` modifier — axis: "z" builds the same shape
//     standing along +Z instead, which is what a part destined for a +Z-up
//     viewer or a +Z build plate wants. Nothing else in the command set has an
//     up axis: Box takes three extents, Capsule / Pipe / Beams take points, and
//     Emboss takes any of the six faces.
//   * Scripts are COORDINATE-EXPLICIT: nothing is auto-dropped onto a build
//     plate. Every builder's `at` modifier is the shape's CENTRE and defaults to
//     the world origin (0, 0, 0). To stand a 20 mm cylinder on the XZ plane, say
//     so: Cylinder(10, 20, at: V(0, 10, 0)).
//   * Commands NEVER mutate their inputs. Every one returns a new Shape, so an
//     input can be reused as many times as you like.
//
// RESOLUTION
//   Everything runs inside the job's single PicoGK Library at the job's
//   voxelSizeMM, so that one number sets the resolution of every voxel operation
//   in the script. Booleans, offsets, shells and lattices are accurate to about
//   half a voxel. Fine detail (crisp Emboss lettering, thin lattice walls, small
//   fillets) needs a SMALLER voxelSizeMM — and memory/time grow with its cube.
//
// ERRORS
//   Bad modifiers raise ArgumentException with a message naming the command and
//   the offending value; the worker reports it on the script error channel with
//   the rest of the run's log, so a script failure reads like a compiler error
//   rather than a stack trace.
//

using System.Numerics;
using PicoGK;

namespace Anvil.Worker
{
    /// <summary>
    /// An axis-aligned bounding box in millimetres, as returned by
    /// <see cref="Forge.BBox(Shape)"/>.
    /// </summary>
    public sealed class Bounds
    {
        /// <summary>Corner with the smallest X, Y and Z (mm).</summary>
        public Vec3 Min { get; }
        /// <summary>Corner with the largest X, Y and Z (mm).</summary>
        public Vec3 Max { get; }
        /// <summary>Full extent on each axis (Max - Min, mm).</summary>
        public Vec3 Size { get; }
        /// <summary>Midpoint of the box (mm).</summary>
        public Vec3 Center { get; }

        internal Bounds(Vector3 min, Vector3 max)
        {
            Min = new Vec3(min.X, min.Y, min.Z);
            Max = new Vec3(max.X, max.Y, max.Z);
            Vector3 s = max - min;
            Size = new Vec3(s.X, s.Y, s.Z);
            Vector3 c = (max + min) * 0.5f;
            Center = new Vec3(c.X, c.Y, c.Z);
        }

        /// <summary>Largest of the three extents (mm).</summary>
        public double MaxSize => Math.Max(Size.x, Math.Max(Size.y, Size.z));

        public override string ToString()
            => $"[{Min} .. {Max}] size {Size}";
    }

    /// <summary>
    /// A solid, the single value every Forge command consumes and produces.
    /// A Shape wraps a PicoGK voxel field, so it converts to and from
    /// <see cref="PicoGK.Voxels"/> implicitly: raw PicoGK code and Forge commands
    /// mix freely in the same script, and SavePart takes either.
    /// </summary>
    public sealed class Shape
    {
        private readonly Voxels _vox;

        internal Shape(Voxels vox)
            => _vox = vox ?? throw new ArgumentNullException(nameof(vox));

        /// <summary>The underlying PicoGK voxel field (for raw kernel calls).</summary>
        public Voxels Voxels => _vox;

        /// <summary>Mesh this shape (marching cubes over the voxel field).</summary>
        public Mesh ToMesh() => new Mesh(_vox);

        /// <summary>Solid volume in cubic millimetres. Same as Forge.Volume(shape).</summary>
        public double Volume => Forge.Volume(this);

        /// <summary>Axis-aligned bounding box in mm. Same as Forge.BBox(shape).</summary>
        public Bounds Bounds => Forge.BBox(this);

        /// <summary>Use a Shape anywhere a PicoGK Voxels field is expected.</summary>
        public static implicit operator Voxels(Shape s)
            => s is null ? throw new ArgumentException("Forge: shape is null") : s._vox;

        /// <summary>Use a PicoGK Voxels field anywhere a Shape is expected.</summary>
        public static implicit operator Shape(Voxels v) => new Shape(v);

        /// <summary>Boolean union. Same as Forge.Union(a, b).</summary>
        public static Shape operator +(Shape a, Shape b) => Forge.Union(a, b);

        /// <summary>Boolean subtraction. Same as Forge.Subtract(a, b).</summary>
        public static Shape operator -(Shape a, Shape b) => Forge.Subtract(a, b);

        /// <summary>Boolean intersection. Same as Forge.Intersect(a, b).</summary>
        public static Shape operator &(Shape a, Shape b) => Forge.Intersect(a, b);

        public override string ToString()
        {
            Bounds b = Bounds;
            return $"Shape({Volume:0.##} mm3, bbox {b.Size})";
        }
    }

    /// <summary>
    /// The Forge command set. Every member is auto-imported into Anvil scripts,
    /// so a .csx calls <c>Box(...)</c> / <c>Subtract(...)</c> / <c>Emboss(...)</c>
    /// without qualification.
    /// </summary>
    public static class Forge
    {
        // ---- per-job context (set once by ScriptJob before the script runs) ----

        private static float s_voxelMM = 0.3f;
        private static string[] s_searchDirs = Array.Empty<string>();

        // The job's voxel size. Scripts read it as ScriptGlobals.VoxelSizeMM (in
        // scope unqualified); this stays internal so the two never collide in a
        // script's name lookup.
        internal static float VoxelSizeMM => s_voxelMM;

        /// <summary>
        /// Bind the Forge to a job. Called by ScriptJob before the script runs;
        /// scripts never call this. <paramref name="searchDirs"/> is the ordered
        /// list of folders a bare filename is resolved against (job output dir,
        /// then scripts-library\assets, then the repo root).
        /// </summary>
        internal static void Configure(float voxelSizeMM, IEnumerable<string> searchDirs)
        {
            s_voxelMM = voxelSizeMM > 0f ? voxelSizeMM : 0.3f;
            s_searchDirs = searchDirs.Where(d => !string.IsNullOrWhiteSpace(d)).ToArray();
        }

        // =====================================================================
        //  POINTS
        // =====================================================================

        /// <summary>
        /// A point / offset / direction in millimetres. The short name is
        /// deliberate: scripts read best as <c>V(10, 0, 4)</c>.
        /// </summary>
        /// <param name="x">X coordinate (mm).</param>
        /// <param name="y">Y coordinate (mm) — the UP axis.</param>
        /// <param name="z">Z coordinate (mm).</param>
        public static Vec3 V(double x, double y, double z) => new Vec3((float)x, (float)y, (float)z);

        /// <summary>The world origin, V(0, 0, 0).</summary>
        public static Vec3 Origin => new Vec3(0, 0, 0);

        // =====================================================================
        //  BUILDERS — every one returns a solid centred on `at` (default origin)
        // =====================================================================

        /// <summary>
        /// Axis-aligned rectangular block.
        /// </summary>
        /// <param name="x">Full extent along X (mm). Must be &gt; 0.</param>
        /// <param name="y">Full extent along Y (mm). Must be &gt; 0.</param>
        /// <param name="z">Full extent along Z (mm). Must be &gt; 0.</param>
        /// <param name="at">Centre of the box (mm). Default: the world origin.</param>
        public static Shape Box(double x, double y, double z, Vec3? at = null)
        {
            Positive(x, "Box", "x"); Positive(y, "Box", "y"); Positive(z, "Box", "z");
            Vector3 size = new((float)x, (float)y, (float)z);
            return Voxelize(MeshUtil.CreateBox(size, Pt(at)));
        }

        /// <summary>
        /// Circular cylinder standing along the +Y axis, or along +Z with
        /// <c>axis: "z"</c>.
        /// </summary>
        /// <param name="d">Diameter (mm). Must be &gt; 0.</param>
        /// <param name="h">Height along the chosen axis (mm). Must be &gt; 0.</param>
        /// <param name="at">Centre of the cylinder (mm) — it spans at ± h/2 along the axis. Default: the world origin.</param>
        /// <param name="axis">Axis to stand along: "y" (default) or "z".</param>
        public static Shape Cylinder(double d, double h, Vec3? at = null, string axis = "y")
        {
            Positive(d, "Cylinder", "d"); Positive(h, "Cylinder", "h");
            int seg = MeshUtil.Segments((float)d, s_voxelMM);
            if (!AxisZ(axis, "Cylinder"))
                return Voxelize(MeshUtil.CreateCylinder((float)d, (float)d, (float)h, Pt(at), seg));
            return StandOnZ(MeshUtil.CreateCylinder((float)d, (float)d, (float)h, Vector3.Zero, seg), Pt(at));
        }

        /// <summary>
        /// Circular cone standing along the +Y axis (base at at.y - h/2, apex at
        /// at.y + h/2), or along +Z with <c>axis: "z"</c>.
        /// </summary>
        /// <param name="d">Base diameter (mm). Must be &gt; 0.</param>
        /// <param name="h">Height along the chosen axis (mm). Must be &gt; 0.</param>
        /// <param name="at">Centre of the cone's bounding box (mm). Default: the world origin.</param>
        /// <param name="axis">Axis to stand along: "y" (default) or "z".</param>
        public static Shape Cone(double d, double h, Vec3? at = null, string axis = "y")
        {
            Positive(d, "Cone", "d"); Positive(h, "Cone", "h");
            int seg = MeshUtil.Segments((float)d, s_voxelMM);
            if (!AxisZ(axis, "Cone"))
                return Voxelize(MeshUtil.CreateCone((float)d, (float)d, (float)h, Pt(at), seg));
            return StandOnZ(MeshUtil.CreateCone((float)d, (float)d, (float)h, Vector3.Zero, seg), Pt(at));
        }

        /// <summary>
        /// Sphere.
        /// </summary>
        /// <param name="d">Diameter (mm). Must be &gt; 0.</param>
        /// <param name="at">Centre of the sphere (mm). Default: the world origin.</param>
        public static Shape Sphere(double d, Vec3? at = null)
        {
            Positive(d, "Sphere", "d");
            int seg = MeshUtil.Segments((float)d, s_voxelMM);
            Vector3 dia = new((float)d, (float)d, (float)d);
            return Voxelize(MeshUtil.CreateSphere(dia, Pt(at), seg));
        }

        /// <summary>
        /// Capsule: a sphere of diameter <paramref name="d"/> swept along the
        /// straight line from <paramref name="a"/> to <paramref name="b"/>
        /// (a rod with hemispherical ends). The workhorse for beams and struts.
        /// </summary>
        /// <param name="a">Start point of the sweep axis (mm).</param>
        /// <param name="b">End point of the sweep axis (mm).</param>
        /// <param name="d">Diameter of the swept sphere (mm). Must be &gt; 0.</param>
        public static Shape Capsule(Vec3 a, Vec3 b, double d)
        {
            if (a is null || b is null) throw new ArgumentException("Forge.Capsule: a and b are required points");
            Positive(d, "Capsule", "d");
            Vector3 va = a, vb = b;
            float r = (float)d * 0.5f;
            BBox3 box = Pad(new BBox3(Vector3.Min(va, vb) - new Vector3(r, r, r),
                                      Vector3.Max(va, vb) + new Vector3(r, r, r)));
            return Render(new SdCapsule(va, vb, r), box);
        }

        /// <summary>
        /// Torus lying in the XZ plane (its axis of revolution is +Y), i.e. a ring
        /// you look through from above — or in the XY plane with <c>axis: "z"</c>.
        /// </summary>
        /// <param name="d">Diameter of the ring's CENTRE circle (mm). The outer diameter is d + ring. Must be &gt; 0.</param>
        /// <param name="ring">Diameter of the tube itself (mm). Must be &gt; 0.</param>
        /// <param name="at">Centre of the torus (mm). Default: the world origin.</param>
        /// <param name="axis">Axis of revolution: "y" (default) or "z".</param>
        public static Shape Torus(double d, double ring, Vec3? at = null, string axis = "y")
        {
            Positive(d, "Torus", "d"); Positive(ring, "Torus", "ring");
            bool z = AxisZ(axis, "Torus");
            Vector3 c = Pt(at);
            float bigR = (float)d * 0.5f, tubeR = (float)ring * 0.5f;
            float ext = bigR + tubeR;
            Vector3 half = z ? new Vector3(ext, ext, tubeR) : new Vector3(ext, tubeR, ext);
            BBox3 box = Pad(new BBox3(c - half, c + half));
            return Render(new SdTorus(c, bigR, tubeR, z), box);
        }

        /// <summary>
        /// Load a solid from a binary STL file, FORCING millimetres (an STL carries
        /// no units, and every part in Anvil is mm).
        /// </summary>
        /// <param name="path">
        /// Absolute path, or a bare filename resolved against the job's output
        /// folder, then scripts-library\assets, then the repo root.
        /// </param>
        public static Shape FromFile(string path)
        {
            string file = Resolve(path, "FromFile");
            Mesh msh = Mesh.mshFromStlFile(file, Mesh.EStlUnit.MM, 1f);   // FORCE MM
            if (msh.nTriangleCount() == 0)
                throw new ArgumentException($"Forge.FromFile: '{file}' contains no triangles");
            return Voxelize(msh);
        }

        /// <summary>
        /// Solid of revolution about the +Y axis, built from a radius function —
        /// the rocket-nozzle / vase / trumpet-bell primitive. The profile is
        /// sampled finely enough for the job's voxel size and capped flat at both
        /// ends, and steep profiles stay accurate (the field is slope-corrected).
        /// </summary>
        /// <param name="radiusAtY">
        /// Radius in mm at a given height y in mm, e.g.
        /// <c>y =&gt; 5 + 10 * Math.Pow(y / 40.0, 2)</c>. Negative returns clamp to 0.
        /// </param>
        /// <param name="y0">Height where the solid starts (mm).</param>
        /// <param name="y1">Height where the solid ends (mm). Must differ from y0.</param>
        /// <param name="axis">
        /// Axis of revolution: "y" (default — y0/y1 are heights along Y) or "z"
        /// (the same profile stood up along +Z, so y0/y1 read as z0/z1).
        /// </param>
        public static Shape Loft(Func<double, double> radiusAtY, double y0, double y1, string axis = "y")
        {
            if (radiusAtY is null) throw new ArgumentException("Forge.Loft: radiusAtY function is required");
            if (Math.Abs(y1 - y0) < 1e-6) throw new ArgumentException($"Forge.Loft: y0 and y1 must differ (both {y0})");
            bool z = AxisZ(axis, "Loft");
            double lo = Math.Min(y0, y1), hi = Math.Max(y0, y1);

            // 4 profile samples per voxel, so the table never limits the result.
            int n = (int)Math.Clamp(Math.Ceiling((hi - lo) / s_voxelMM * 4.0), 256, 8192);
            var sdf = new SdLoft(radiusAtY, lo, hi, n);
            if (sdf.MaxRadius <= 0f)
                throw new ArgumentException("Forge.Loft: radiusAtY returned 0 or less everywhere — the result would be empty");

            float r = sdf.MaxRadius;
            BBox3 box = z
                ? Pad(new BBox3(new Vector3(-r, -r, (float)lo), new Vector3(r, r, (float)hi)))
                : Pad(new BBox3(new Vector3(-r, (float)lo, -r), new Vector3(r, (float)hi, r)));
            return Render(z ? new SdAxisZ(sdf) : sdf, box);
        }

        /// <summary>
        /// Round pipe following a polyline: the union of a capsule per segment, so
        /// corners are automatically rounded and every joint is watertight.
        ///
        /// A short run is evaluated as ONE implicit field (an exact distance, one
        /// render). Above <see cref="PipeSegmentLimit"/> segments that scan turns
        /// quadratic, so a long path is handed to <see cref="Beams(IEnumerable{Vec3}, double, double?, bool)"/>
        /// instead, which renders each segment natively over its own tight box.
        /// The result is the same shape; only the cost changes. For thousands of
        /// segments — a helix, a strut network — call Beams directly.
        /// </summary>
        /// <param name="path">Two or more points along the pipe's centreline (mm).</param>
        /// <param name="d">Outside diameter of the pipe (mm). Must be &gt; 0. Use Shell() afterwards to hollow it.</param>
        public static Shape Pipe(IEnumerable<Vec3> path, double d)
        {
            if (path is null) throw new ArgumentException("Forge.Pipe: path is required");
            Positive(d, "Pipe", "d");

            var pts = new List<Vector3>();
            foreach (Vec3 p in path)
            {
                if (p is null) throw new ArgumentException("Forge.Pipe: path contains a null point");
                pts.Add(p);
            }
            if (pts.Count < 2)
                throw new ArgumentException($"Forge.Pipe: path needs at least 2 points (got {pts.Count})");

            float r = (float)d * 0.5f;

            // Long runs: one native beam render per segment beats one managed
            // callback per voxel that scans every segment.
            if (pts.Count - 1 > PipeSegmentLimit)
                return BeamLattice(pts, r, r, true, "Pipe");

            Vector3 min = pts[0], max = pts[0];
            foreach (Vector3 p in pts) { min = Vector3.Min(min, p); max = Vector3.Max(max, p); }
            BBox3 box = Pad(new BBox3(min - new Vector3(r, r, r), max + new Vector3(r, r, r)));
            return Render(new SdPolyPipe(pts, r), box);
        }

        /// <summary>
        /// Segment count above which <see cref="Pipe"/> switches from one implicit
        /// field to a beam lattice. The implicit scans every segment per voxel, so
        /// its cost is (voxels in the whole bounding box) x (segments); a lattice
        /// costs (voxels near each beam) x 1, in native code.
        /// </summary>
        public const int PipeSegmentLimit = 16;

        /// <summary>
        /// Build a solid from a batch of straight beams, each with its OWN diameter
        /// at each end, in a single render — the primitive behind strut lattices,
        /// helical cooling channels, spiral ribs and pipe networks.
        ///
        /// Every beam is rendered natively over its own tight bounding box, so
        /// thousands of them cost about as much as the material they cover. That is
        /// the difference between seconds and hours: an implicit field (Pipe,
        /// Capsule) is sampled once per voxel of the WHOLE bounding box and has to
        /// consider every segment each time.
        ///
        /// A per-end diameter is free, which is what makes tapered struts, graded
        /// lattices and self-supporting teardrop channel roofs cheap.
        /// </summary>
        /// <param name="beams">
        /// The beams, as (start point, end point, diameter at the start,
        /// diameter at the end). All four are required and both diameters must be
        /// &gt; 0.
        /// </param>
        /// <param name="roundCap">
        /// true (default) caps each beam with a hemisphere, so beams meeting at a
        /// shared point join smoothly. false gives flat ends.
        /// </param>
        public static Shape Beams(IEnumerable<(Vec3 a, Vec3 b, double dA, double dB)> beams, bool roundCap = true)
        {
            if (beams is null) throw new ArgumentException("Forge.Beams: beams is required");

            var lat = new PicoGK.Lattice();
            int n = 0;
            foreach ((Vec3 a, Vec3 b, double dA, double dB) in beams)
            {
                if (a is null || b is null)
                    throw new ArgumentException($"Forge.Beams: beam {n} has a null end point");
                BeamDia(dA, n, "a"); BeamDia(dB, n, "b");
                Vector3 va = a, vb = b;
                lat.AddBeam(va, (float)dA * 0.5f, vb, (float)dB * 0.5f, roundCap);
                n++;
            }
            if (n == 0) throw new ArgumentException("Forge.Beams: the beam list is empty — there is nothing to build");

            return Collapsed(new Voxels(lat),
                $"Forge.Beams: {n} beam(s) rendered to nothing — every diameter is below the {s_voxelMM:0.###} mm voxel size");
        }

        /// <summary>
        /// Chain a polyline into beams — the batch equivalent of <see cref="Pipe"/>,
        /// with an optional linear taper from one end of the run to the other.
        /// </summary>
        /// <param name="path">Two or more points; each consecutive pair becomes one beam (mm).</param>
        /// <param name="d">Diameter at the first point (mm). Must be &gt; 0.</param>
        /// <param name="dEnd">Diameter at the last point (mm), tapering linearly along the run. Default: the same as <paramref name="d"/>.</param>
        /// <param name="roundCap">true (default) rounds every joint and both ends.</param>
        public static Shape Beams(IEnumerable<Vec3> path, double d, double? dEnd = null, bool roundCap = true)
        {
            if (path is null) throw new ArgumentException("Forge.Beams: path is required");
            Positive(d, "Beams", "d");
            double d1 = dEnd ?? d;
            if (dEnd is not null) Positive(d1, "Beams", "dEnd");

            var pts = new List<Vector3>();
            foreach (Vec3 p in path)
            {
                if (p is null) throw new ArgumentException("Forge.Beams: path contains a null point");
                pts.Add(p);
            }
            if (pts.Count < 2)
                throw new ArgumentException($"Forge.Beams: path needs at least 2 points (got {pts.Count})");

            return BeamLattice(pts, (float)d * 0.5f, (float)d1 * 0.5f, roundCap, "Beams");
        }

        /// <summary>
        /// A batch of spheres in one render — the point-cloud companion to
        /// <see cref="Beams(IEnumerable{Vec3}, double, double?, bool)"/>, for
        /// lattice nodes and seeded packings.
        /// </summary>
        /// <param name="points">Sphere centres (mm).</param>
        /// <param name="d">Diameter of every sphere (mm). Must be &gt; 0.</param>
        public static Shape Spheres(IEnumerable<Vec3> points, double d)
        {
            if (points is null) throw new ArgumentException("Forge.Spheres: points is required");
            Positive(d, "Spheres", "d");

            var lat = new PicoGK.Lattice();
            int n = 0;
            foreach (Vec3 p in points)
            {
                if (p is null) throw new ArgumentException("Forge.Spheres: points contains a null point");
                Vector3 v = p;
                lat.AddSphere(v, (float)d * 0.5f);
                n++;
            }
            if (n == 0) throw new ArgumentException("Forge.Spheres: the point list is empty — there is nothing to build");

            return Collapsed(new Voxels(lat),
                $"Forge.Spheres: {n} sphere(s) of {d:0.###} mm rendered to nothing at a {s_voxelMM:0.###} mm voxel size");
        }

        // =====================================================================
        //  COMBINATORS — fuse shapes together; inputs are never modified
        // =====================================================================

        /// <summary>
        /// Boolean union: everything that is solid in ANY input.
        /// </summary>
        /// <param name="shapes">Two or more shapes to fuse (one is returned unchanged).</param>
        public static Shape Union(params Shape[] shapes)
        {
            if (shapes is null || shapes.Length == 0)
                throw new ArgumentException("Forge.Union: needs at least one shape");
            Voxels acc = new Voxels(Vox(shapes[0], "Union"));   // copy: never mutate the input
            for (int i = 1; i < shapes.Length; i++)
                acc.BoolAdd(Vox(shapes[i], "Union"));
            return new Shape(acc);
        }

        /// <summary>
        /// Boolean subtraction: <paramref name="a"/> with every cutting shape removed.
        /// </summary>
        /// <param name="a">The shape to cut into.</param>
        /// <param name="cuts">One or more shapes to remove from it.</param>
        public static Shape Subtract(Shape a, params Shape[] cuts)
        {
            Voxels acc = new Voxels(Vox(a, "Subtract"));        // copy: never mutate the input
            if (cuts is null || cuts.Length == 0)
                throw new ArgumentException("Forge.Subtract: needs at least one shape to cut with");
            foreach (Shape c in cuts)
                acc.BoolSubtract(Vox(c, "Subtract"));
            return new Shape(acc);
        }

        /// <summary>
        /// Boolean intersection: only what is solid in BOTH shapes.
        /// </summary>
        /// <param name="a">First shape.</param>
        /// <param name="b">Second shape.</param>
        public static Shape Intersect(Shape a, Shape b)
        {
            Voxels acc = new Voxels(Vox(a, "Intersect"));
            acc.BoolIntersect(Vox(b, "Intersect"));
            return new Shape(acc);
        }

        /// <summary>
        /// Union with a blend: the two shapes are fused and the seam between them
        /// is filleted, so load flows through the joint instead of stopping at a
        /// sharp internal corner. Only ever ADDS material — the original faces of
        /// both inputs survive untouched.
        /// </summary>
        /// <param name="a">First shape.</param>
        /// <param name="b">Second shape.</param>
        /// <param name="radius">Blend radius in mm. Must be &gt; 0; a few voxels or more, or the fillet cannot be resolved.</param>
        public static Shape SmoothUnion(Shape a, Shape b, double radius)
        {
            Positive(radius, "SmoothUnion", "radius");
            Voxels sum = new Voxels(Vox(a, "SmoothUnion"));
            sum.BoolAdd(Vox(b, "SmoothUnion"));

            // The fillet is an offset out-and-back (a morphological closing): it
            // fills concave seams, but at practical voxel sizes the return trip
            // also shaves a fraction of a voxel off convex edges. Re-uniting with
            // the plain sum keeps the blend and gives back the original faces, so
            // SmoothUnion only ever ADDS material.
            Voxels blended = sum.voxFillet((float)radius);
            blended.BoolAdd(sum);
            return new Shape(blended);
        }

        // =====================================================================
        //  MODIFIERS — reshape one solid into a new one
        // =====================================================================

        /// <summary>
        /// Translate a shape.
        /// </summary>
        /// <param name="shape">Shape to move.</param>
        /// <param name="x">Distance along X (mm).</param>
        /// <param name="y">Distance along Y (mm).</param>
        /// <param name="z">Distance along Z (mm).</param>
        public static Shape Move(Shape shape, double x, double y, double z)
            => Transform(shape, "Move",
                Matrix4x4.CreateTranslation((float)x, (float)y, (float)z));

        /// <summary>
        /// Rotate a shape about an axis parallel to X.
        /// </summary>
        /// <param name="shape">Shape to rotate.</param>
        /// <param name="deg">Rotation in DEGREES, right-handed about +X.</param>
        /// <param name="about">Point the axis passes through (mm). Default: the shape's bounding-box centre, so it spins in place.</param>
        public static Shape RotateX(Shape shape, double deg, Vec3? about = null)
            => Spin(shape, "RotateX", Matrix4x4.CreateRotationX(Rad(deg)), about);

        /// <summary>
        /// Rotate a shape about an axis parallel to Y (the up axis).
        /// </summary>
        /// <param name="shape">Shape to rotate.</param>
        /// <param name="deg">Rotation in DEGREES, right-handed about +Y.</param>
        /// <param name="about">Point the axis passes through (mm). Default: the shape's bounding-box centre, so it spins in place.</param>
        public static Shape RotateY(Shape shape, double deg, Vec3? about = null)
            => Spin(shape, "RotateY", Matrix4x4.CreateRotationY(Rad(deg)), about);

        /// <summary>
        /// Rotate a shape about an axis parallel to Z.
        /// </summary>
        /// <param name="shape">Shape to rotate.</param>
        /// <param name="deg">Rotation in DEGREES, right-handed about +Z.</param>
        /// <param name="about">Point the axis passes through (mm). Default: the shape's bounding-box centre, so it spins in place.</param>
        public static Shape RotateZ(Shape shape, double deg, Vec3? about = null)
            => Spin(shape, "RotateZ", Matrix4x4.CreateRotationZ(Rad(deg)), about);

        /// <summary>
        /// Scale a shape uniformly.
        /// </summary>
        /// <param name="shape">Shape to scale.</param>
        /// <param name="f">Scale factor (1 = unchanged). Must be &gt; 0.</param>
        /// <param name="about">Fixed point of the scaling (mm). Default: the shape's bounding-box centre, so it grows in place.</param>
        public static Shape Scale(Shape shape, double f, Vec3? about = null)
            => Scale(shape, f, f, f, about);

        /// <summary>
        /// Scale a shape by a different factor on each axis.
        /// </summary>
        /// <param name="shape">Shape to scale.</param>
        /// <param name="fx">Scale factor along X. Must be &gt; 0.</param>
        /// <param name="fy">Scale factor along Y. Must be &gt; 0.</param>
        /// <param name="fz">Scale factor along Z. Must be &gt; 0.</param>
        /// <param name="about">Fixed point of the scaling (mm). Default: the shape's bounding-box centre, so it grows in place.</param>
        public static Shape Scale(Shape shape, double fx, double fy, double fz, Vec3? about = null)
        {
            Positive(fx, "Scale", "fx"); Positive(fy, "Scale", "fy"); Positive(fz, "Scale", "fz");
            return Spin(shape, "Scale",
                Matrix4x4.CreateScale((float)fx, (float)fy, (float)fz), about);
        }

        /// <summary>
        /// Mirror a shape across a world plane through a point, flipping triangle
        /// winding so the result re-voxelises as a solid rather than inside-out.
        /// </summary>
        /// <param name="shape">Shape to mirror.</param>
        /// <param name="plane">"XY" (the z = 0 plane), "YZ" (x = 0) or "XZ" (y = 0). Case-insensitive.</param>
        /// <param name="through">A point the mirror plane passes through (mm). Default: the world origin.</param>
        public static Shape Mirror(Shape shape, string plane, Vec3? through = null)
        {
            Vector3 n = (plane ?? "").Trim().ToUpperInvariant() switch
            {
                "XY" or "YX" => new Vector3(0, 0, 1),
                "YZ" or "ZY" => new Vector3(1, 0, 0),
                "XZ" or "ZX" => new Vector3(0, 1, 0),
                _ => throw new ArgumentException(
                    $"Forge.Mirror: unknown plane '{plane}' (expected \"XY\", \"YZ\" or \"XZ\")"),
            };
            Mesh src = new Mesh(Vox(shape, "Mirror"));
            return Voxelize(MeshUtil.MirrorWindingFixed(src, Pt(through), n));
        }

        /// <summary>
        /// Hollow a solid out into a wall of constant thickness.
        /// </summary>
        /// <param name="shape">Solid to hollow.</param>
        /// <param name="wall">Wall thickness in mm. Must be &gt; 0 and at least a couple of voxels.</param>
        /// <param name="dir">
        /// Where the wall sits relative to the original surface:
        /// "in" (default, wall grows inward, outer size unchanged),
        /// "out" (wall grows outward, inner cavity unchanged) or
        /// "center" (wall straddles the surface, half each way).
        /// </param>
        public static Shape Shell(Shape shape, double wall, string dir = "in")
        {
            Positive(wall, "Shell", "wall");
            Voxels v = Vox(shape, "Shell");
            float t = (float)wall;
            Voxels result = (dir ?? "in").Trim().ToLowerInvariant() switch
            {
                "in" or "inside" => v.voxBoolSubtract(v.voxOffset(-t)),
                "out" or "outside" => v.voxOffset(t).voxBoolSubtract(v),
                "center" or "centre" or "centered" or "centred"
                    => v.voxOffset(t * 0.5f).voxBoolSubtract(v.voxOffset(-t * 0.5f)),
                _ => throw new ArgumentException(
                    $"Forge.Shell: unknown dir '{dir}' (expected \"in\", \"out\" or \"center\")"),
            };
            return Collapsed(result, $"Forge.Shell: a {wall:0.###} mm wall collapsed the shape (too thick, or the voxel size is too coarse to resolve it)");
        }

        /// <summary>
        /// Grow or shrink a solid by moving every surface point along its normal.
        /// A positive distance rounds convex edges; a negative one rounds concave
        /// ones, which is how you deburr a part or add clearance to a mating face.
        /// </summary>
        /// <param name="shape">Shape to offset.</param>
        /// <param name="d">Signed distance in mm: positive grows, negative shrinks. 0 is rejected.</param>
        public static Shape Offset(Shape shape, double d)
        {
            if (Math.Abs(d) < 1e-9) throw new ArgumentException("Forge.Offset: d must be non-zero (mm)");
            Voxels v = Vox(shape, "Offset").voxOffset((float)d);
            return Collapsed(v, $"Forge.Offset: an offset of {d:0.###} mm collapsed the shape to nothing");
        }

        /// <summary>
        /// Round every edge of a solid — convex AND concave — by a radius, using a
        /// triple offset. The cheap way to take the 3D-print edge off a part or to
        /// blend a lattice into its skin.
        /// </summary>
        /// <param name="shape">Shape to smooth.</param>
        /// <param name="r">Rounding radius in mm. Must be &gt; 0; features thinner than 2r disappear.</param>
        public static Shape Smooth(Shape shape, double r)
        {
            Positive(r, "Smooth", "r");
            Voxels v = Vox(shape, "Smooth").voxTripleOffset((float)r);
            return Collapsed(v, $"Forge.Smooth: a radius of {r:0.###} mm smoothed the shape away entirely");
        }

        /// <summary>
        /// Fillet the CONCAVE edges of a solid — every internal corner where two
        /// faces meet gets a radius, and nothing else moves. This is the finishing
        /// pass for a ribbed or latticed part: it only ever ADDS material, so a
        /// 1.5 mm rib survives a 0.9 mm fillet untouched.
        ///
        /// Reach for Smooth instead only when you want the convex edges rounded
        /// too — Smooth is a triple offset and it deletes anything thinner than
        /// twice its radius.
        /// </summary>
        /// <param name="shape">Shape to fillet.</param>
        /// <param name="r">Fillet radius in mm. Must be &gt; 0 and worth a couple of voxels.</param>
        public static Shape Fillet(Shape shape, double r)
        {
            Positive(r, "Fillet", "r");
            Voxels v = Vox(shape, "Fillet");

            // voxFillet is a morphological closing (offset out r, then back in r):
            // it fills concave seams, but at practical voxel sizes the return trip
            // also shaves a fraction of a voxel off convex edges. Re-uniting with
            // the original gives those faces back, so Fillet is strictly additive.
            Voxels filleted = v.voxFillet((float)r);
            filleted.BoolAdd(v);
            return new Shape(filleted);
        }

        /// <summary>
        /// Repeat a shape along a straight line and fuse the copies.
        /// </summary>
        /// <param name="shape">Shape to repeat. Copy 0 is the shape where it already is.</param>
        /// <param name="count">Total number of copies including the original. Must be &gt;= 1.</param>
        /// <param name="step">Offset from one copy to the next (mm).</param>
        public static Shape ArrayLinear(Shape shape, int count, Vec3 step)
        {
            if (count < 1) throw new ArgumentException($"Forge.ArrayLinear: count must be >= 1 (got {count})");
            if (step is null) throw new ArgumentException("Forge.ArrayLinear: step is required");
            Vector3 s = step;
            if (count > 1 && s.Length() < 1e-6f)
                throw new ArgumentException("Forge.ArrayLinear: step is zero — every copy would land on top of the first");

            Voxels acc = new Voxels(Vox(shape, "ArrayLinear"));
            for (int i = 1; i < count; i++)
                acc.BoolAdd(Vox(Move(shape, s.X * i, s.Y * i, s.Z * i), "ArrayLinear"));
            return new Shape(acc);
        }

        /// <summary>
        /// Repeat a shape evenly around the +Y axis (or +Z with <c>axis: "z"</c>)
        /// and fuse the copies. Each copy is first pushed out along +X by
        /// <paramref name="radius"/>, then rotated into place, so a radius of 0
        /// spins copies about their own centre.
        /// </summary>
        /// <param name="shape">Shape to repeat.</param>
        /// <param name="count">Number of copies around the full 360 degrees. Must be &gt;= 1.</param>
        /// <param name="radius">Distance from the axis to each copy (mm). May be 0.</param>
        /// <param name="about">Point the axis passes through (mm). Default: the world origin.</param>
        /// <param name="axis">Axis to array around: "y" (default) or "z".</param>
        public static Shape ArrayRadial(Shape shape, int count, double radius, Vec3? about = null, string axis = "y")
        {
            if (count < 1) throw new ArgumentException($"Forge.ArrayRadial: count must be >= 1 (got {count})");
            if (radius < 0) throw new ArgumentException($"Forge.ArrayRadial: radius must be >= 0 mm (got {radius})");
            bool z = AxisZ(axis, "ArrayRadial");

            Vec3 pivot = about ?? Origin;
            Shape seed = radius > 0 ? Move(shape, radius, 0, 0) : shape;

            Voxels acc = new Voxels(Vox(seed, "ArrayRadial"));
            for (int i = 1; i < count; i++)
            {
                double deg = 360.0 * i / count;
                acc.BoolAdd(Vox(z ? RotateZ(seed, deg, pivot) : RotateY(seed, deg, pivot), "ArrayRadial"));
            }
            return new Shape(acc);
        }

        /// <summary>
        /// Fill a solid with a triply-periodic minimal surface (TPMS) lattice,
        /// clipped exactly to the shape. This is the infill engine: a sheet gyroid
        /// splits the interior into two interpenetrating channels that never touch,
        /// a skeletal one leaves a single connected strut network.
        /// </summary>
        /// <param name="shape">The envelope to fill. Only the lattice inside it survives.</param>
        /// <param name="pattern">"gyroid" (default), "schwarzP", "schwarzD", "lidinoid" or "neovius". Case-insensitive.</param>
        /// <param name="cell">Unit cell size in mm (default 8). Smaller = finer lattice, more triangles.</param>
        /// <param name="wall">Wall thickness in mm for sheet lattices (default 1.2). Ignored when type is "skeletal".</param>
        /// <param name="type">"sheet" (default, a wall around the surface) or "skeletal" (a solid strut network).</param>
        /// <param name="bias">Skeletal solid-fraction bias in mm (default 0 ~= 50% solid; negative = less solid). Ignored for "sheet".</param>
        /// <param name="rotDeg">Rotation of the lattice FIELD about the shape's bbox centre, in degrees X/Y/Z (default none). The part itself never moves.</param>
        /// <param name="phase">Phase shift of the lattice field in cell FRACTIONS, 0..1 per axis (default none). Use it to align cells with a wall.</param>
        /// <param name="cellXYZ">Per-axis cell size in mm, overriding <paramref name="cell"/> where an entry is &gt; 0 — the way to make a stretched, directional lattice.</param>
        public static Shape Lattice(
            Shape shape,
            string pattern = "gyroid",
            double cell = 8,
            double wall = 1.2,
            string type = "sheet",
            double bias = 0,
            Vec3? rotDeg = null,
            Vec3? phase = null,
            Vec3? cellXYZ = null)
        {
            Positive(cell, "Lattice", "cell");
            bool sheet = !string.Equals((type ?? "sheet").Trim(), "skeletal", StringComparison.OrdinalIgnoreCase);
            if (sheet) Positive(wall, "Lattice", "wall");

            TPMSWall.EFn fn = (pattern ?? "gyroid").Trim().ToLowerInvariant() switch
            {
                "gyroid" => TPMSWall.EFn.Gyroid,
                "schwarzp" => TPMSWall.EFn.SchwarzP,
                "schwarzd" => TPMSWall.EFn.SchwarzD,
                "lidinoid" => TPMSWall.EFn.Lidinoid,
                "neovius" => TPMSWall.EFn.Neovius,
                _ => throw new ArgumentException(
                    $"Forge.Lattice: unknown pattern '{pattern}' (expected gyroid|schwarzP|schwarzD|lidinoid|neovius)"),
            };

            float c = (float)cell;
            Vector3 vecCell = new(c, c, c);
            if (cellXYZ is Vec3 cx)
                vecCell = new Vector3(cx.x > 0 ? cx.x : c, cx.y > 0 ? cx.y : c, cx.z > 0 ? cx.z : c);

            Vector3 vecPhase = Vector3.Zero;
            if (phase is Vec3 ph)
                vecPhase = new Vector3(Math.Clamp(ph.x, 0f, 1f), Math.Clamp(ph.y, 0f, 1f), Math.Clamp(ph.z, 0f, 1f));

            Voxels envelope = Vox(shape, "Lattice");
            envelope.CalculateProperties(out float envVol, out BBox3 bbox);
            if (envVol <= 0f || bbox.bIsEmpty())
                throw new ArgumentException("Forge.Lattice: the shape is empty — there is nothing to fill");

            float wallT = sheet ? (float)wall : 0f;
            var field = new TPMSWall(
                vecCell, wallT, fn,
                sheet ? TPMSWall.ELattice.Sheet : TPMSWall.ELattice.Skeletal,
                (float)bias,
                bbox.vecCenter(),
                rotDeg is null ? Vector3.Zero : (Vector3)rotDeg,
                vecPhase);

            // Render the periodic field over a padded envelope box (so boundary
            // cells are never clipped), then clip it to the shape.
            float maxCell = MathF.Max(vecCell.X, MathF.Max(vecCell.Y, vecCell.Z));
            float pad = MathF.Max(2f, maxCell * 0.5f + MathF.Max(0f, wallT));
            var render = new BBox3(bbox.vecMin - new Vector3(pad, pad, pad),
                                   bbox.vecMax + new Vector3(pad, pad, pad));

            Voxels lattice = new Voxels(field, render);
            lattice.BoolIntersect(envelope);
            return Collapsed(lattice,
                $"Forge.Lattice: the {pattern} lattice came out empty — cell {cell:0.###} mm / wall {wall:0.###} mm is too fine for a {s_voxelMM:0.###} mm voxel, or the shape is smaller than one cell");
        }

        /// <summary>
        /// Bake a grayscale depth map onto one face of a part — the flagship
        /// finishing tool. The image is projected along the chosen face's normal
        /// from that face of the shape's bounding box: WHITE is full effect, BLACK
        /// is none, and greys ramp smoothly between them (the map is sampled
        /// bilinearly, so the result is a smooth relief, not a staircase).
        ///
        /// The image keeps its aspect ratio and is centred on the face. Designed
        /// for flat or gently curved faces; raised material is trimmed back to
        /// within one depth of the real surface, so a map applied to a strongly
        /// curved face simply fades out where the surface drops away.
        /// </summary>
        /// <param name="shape">The part to decorate.</param>
        /// <param name="imagePath">Image file (PNG / JPG / BMP): absolute, or a bare filename resolved against the job folder, then scripts-library\assets.</param>
        /// <param name="face">Which bounding-box face to project onto: "+x", "-x", "+y" (default, the top), "-y", "+z" or "-z".</param>
        /// <param name="depth">Relief height in mm at pure white (default 1). Must be &gt; 0 and worth several voxels.</param>
        /// <param name="mode">"raise" (default) adds material outward; "cut" engraves inward.</param>
        /// <param name="marginMM">Inset of the mapped region from the edges of the face, in mm (default 0).</param>
        public static Shape Emboss(
            Shape shape,
            string imagePath,
            string face = "+y",
            double depth = 1,
            string mode = "raise",
            double marginMM = 0)
        {
            Positive(depth, "Emboss", "depth");
            if (marginMM < 0) throw new ArgumentException($"Forge.Emboss: marginMM must be >= 0 (got {marginMM})");

            string m = (mode ?? "raise").Trim().ToLowerInvariant();
            bool cut = m is "cut" or "engrave" or "subtract";
            if (!cut && m is not ("raise" or "emboss" or "add"))
                throw new ArgumentException($"Forge.Emboss: unknown mode '{mode}' (expected \"raise\" or \"cut\")");

            ForgeImage img = ForgeImage.Load(Resolve(imagePath, "Emboss"));

            Voxels baseVox = Vox(shape, "Emboss");
            baseVox.CalculateProperties(out float vol, out BBox3 bb);
            if (vol <= 0f || bb.bIsEmpty())
                throw new ArgumentException("Forge.Emboss: the shape is empty — there is nothing to emboss");

            // Face -> (normal axis & sign, in-plane u axis & sign, in-plane v axis
            // & sign). u is "right" and v is "up" as seen from OUTSIDE the face, so
            // the picture reads the right way round on every face.
            (int axN, float sgN, int axU, float sgU, int axV, float sgV) =
                (face ?? "+y").Trim().ToLowerInvariant() switch
                {
                    "+x" or "x" => (0, +1f, 2, -1f, 1, +1f),
                    "-x" => (0, -1f, 2, +1f, 1, +1f),
                    "+y" or "y" => (1, +1f, 0, +1f, 2, -1f),
                    "-y" => (1, -1f, 0, +1f, 2, +1f),
                    "+z" or "z" => (2, +1f, 0, +1f, 1, +1f),
                    "-z" => (2, -1f, 0, -1f, 1, +1f),
                    _ => throw new ArgumentException(
                        $"Forge.Emboss: unknown face '{face}' (expected \"+x\", \"-x\", \"+y\", \"-y\", \"+z\" or \"-z\")"),
                };

            // Signed extents: coordinates measured along each axis' chosen sign, so
            // Lo is always less than Hi regardless of direction.
            (float uLo, float uHi) = SignedSpan(bb, axU, sgU);
            (float vLo, float vHi) = SignedSpan(bb, axV, sgV);
            float planeC = sgN > 0 ? Comp(bb.vecMax, axN) : Comp(bb.vecMin, axN);

            float margin = (float)marginMM;
            uLo += margin; uHi -= margin;
            vLo += margin; vHi -= margin;
            if (uHi - uLo <= 0f || vHi - vLo <= 0f)
                throw new ArgumentException(
                    $"Forge.Emboss: marginMM {marginMM:0.###} leaves no room on the {face} face " +
                    $"(face is {Comp(bb.vecMax, axU) - Comp(bb.vecMin, axU):0.##} x {Comp(bb.vecMax, axV) - Comp(bb.vecMin, axV):0.##} mm)");

            // Fit the image inside the face rectangle without distorting it.
            float mmPerPx = MathF.Min((uHi - uLo) / img.Width, (vHi - vLo) / img.Height);
            float imgW = img.Width * mmPerPx, imgH = img.Height * mmPerPx;
            float uStart = uLo + ((uHi - uLo) - imgW) * 0.5f;
            float vTop = vLo + ((vHi - vLo) + imgH) * 0.5f;

            float d = (float)depth;
            float floorMM = MathF.Max(3f * s_voxelMM, 0.2f * d);   // how far the relief sinks into the part
            float ceilMM = d;                                       // cut lid, sits outside the part

            var slab = new SdEmbossSlab(img,
                axN, sgN, planeC, axU, sgU, uStart, axV, sgV, vTop,
                mmPerPx, d, floorMM, ceilMM, cut);

            // Render box: EXACTLY the shape's footprint in the two in-plane axes
            // (padding those would grow a skirt of relief past the edges of the
            // part), padded only along the face normal so the slab's own top and
            // bottom surfaces are never clipped by the box wall.
            float pad = MathF.Max(4f * s_voxelMM, 0.5f);
            float outward = (cut ? ceilMM : d) + pad;
            float inward = (cut ? d : floorMM) + pad;
            Vector3 lo = bb.vecMin, hi = bb.vecMax;
            if (sgN > 0) { hi = WithComp(hi, axN, planeC + outward); lo = WithComp(lo, axN, planeC - inward); }
            else { lo = WithComp(lo, axN, planeC - outward); hi = WithComp(hi, axN, planeC + inward); }

            Voxels relief = new Voxels(slab, new BBox3(lo, hi));

            if (cut)
            {
                Voxels result = baseVox.voxBoolSubtract(relief);
                return Collapsed(result, "Forge.Emboss: the cut removed the entire part — reduce depth");
            }

            // Trim the relief back to material that actually reaches the surface,
            // so a map on a curved face fades out instead of leaving a floating
            // plate over the bounding-box plane.
            Voxels reach = baseVox.voxOffset(d + MathF.Max(2f * s_voxelMM, 0.25f * d));
            relief.BoolIntersect(reach);
            Voxels raised = baseVox.voxBoolAdd(relief);
            return new Shape(raised);
        }

        // =====================================================================
        //  INFO — measure a shape without saving it
        // =====================================================================

        /// <summary>
        /// Solid volume in cubic millimetres, measured on the voxel field (so it
        /// includes the usual half-voxel discretisation error).
        /// </summary>
        /// <param name="shape">Shape to measure.</param>
        public static double Volume(Shape shape)
        {
            Vox(shape, "Volume").CalculateProperties(out float v, out _);
            return v;
        }

        /// <summary>
        /// Wetted surface area in square millimetres — the headline number for a
        /// heat exchanger, a lattice or anything else whose job is surface.
        ///
        /// This meshes the shape to measure it, so it is far from free (it costs
        /// about what SavePart costs). It also predicts the triangle count of the
        /// saved part: roughly Area / (0.5 * voxel^2). Above a few million,
        /// meshing is what your runtime is being spent on.
        /// </summary>
        /// <param name="shape">Shape to measure.</param>
        public static double Area(Shape shape)
        {
            MeshUtil.MeshMassProps(new Mesh(Vox(shape, "Area")), out _, out float area, out _);
            return area;
        }

        /// <summary>
        /// Axis-aligned bounding box of a shape, in mm.
        /// </summary>
        /// <param name="shape">Shape to measure.</param>
        public static Bounds BBox(Shape shape)
        {
            Vox(shape, "BBox").CalculateProperties(out _, out BBox3 bb);
            if (bb.bIsEmpty()) return new Bounds(Vector3.Zero, Vector3.Zero);
            return new Bounds(bb.vecMin, bb.vecMax);
        }

        /// <summary>
        /// Centre of a shape's bounding box, in mm. Handy as the <c>about</c>
        /// modifier of a rotation, or as the <c>at</c> of the next feature.
        /// </summary>
        /// <param name="shape">Shape to measure.</param>
        public static Vec3 Center(Shape shape) => BBox(shape).Center;

        // =====================================================================
        //  internals
        // =====================================================================

        private static float Rad(double deg) => (float)(deg * Math.PI / 180.0);

        private static Vector3 Pt(Vec3? v) => v is null ? Vector3.Zero : (Vector3)v;

        private static void Positive(double v, string cmd, string name)
        {
            if (double.IsNaN(v) || double.IsInfinity(v) || v <= 0)
                throw new ArgumentException($"Forge.{cmd}: {name} must be greater than 0 (got {v})");
        }

        private static void BeamDia(double d, int index, string end)
        {
            if (double.IsNaN(d) || double.IsInfinity(d) || d <= 0)
                throw new ArgumentException(
                    $"Forge.Beams: beam {index} has a diameter of {d} at end {end} — both ends must be greater than 0 mm");
        }

        /// <summary>
        /// Parse an `axis` modifier. "y" (the Forge up axis) is the default and
        /// keeps every builder's historical behaviour; "z" stands the same shape
        /// up along +Z. A leading "+" is accepted so "+z" reads naturally.
        /// </summary>
        private static bool AxisZ(string? axis, string cmd)
            => (axis ?? "y").Trim().TrimStart('+').ToLowerInvariant() switch
            {
                "y" => false,
                "z" => true,
                _ => throw new ArgumentException(
                    $"Forge.{cmd}: unknown axis '{axis}' (expected \"y\" or \"z\")"),
            };

        /// <summary>
        /// Voxelise a +Y-axis mesh built at the ORIGIN, first rotating it onto +Z
        /// and then moving it to its centre. The rotation is applied to the MESH,
        /// before voxelisation, so it is exact — no re-discretisation.
        /// </summary>
        private static Shape StandOnZ(Mesh msh, Vector3 at)
            => Voxelize(msh.mshCreateTransformed(
                   Matrix4x4.CreateRotationX(MathF.PI * 0.5f) * Matrix4x4.CreateTranslation(at)));

        /// <summary>
        /// Chain a point list into a beam lattice, tapering linearly from rA at the
        /// first point to rB at the last, and render it in one native pass.
        /// </summary>
        private static Shape BeamLattice(IReadOnlyList<Vector3> pts, float rA, float rB, bool roundCap, string cmd)
        {
            var lat = new PicoGK.Lattice();
            int segs = pts.Count - 1;
            for (int i = 0; i < segs; i++)
            {
                float t0 = segs > 1 ? i / (float)segs : 0f;
                float t1 = segs > 1 ? (i + 1) / (float)segs : 1f;
                lat.AddBeam(pts[i], rA + (rB - rA) * t0, pts[i + 1], rA + (rB - rA) * t1, roundCap);
            }
            return Collapsed(new Voxels(lat),
                $"Forge.{cmd}: the run rendered to nothing — the diameter is below the {s_voxelMM:0.###} mm voxel size");
        }

        private static Voxels Vox(Shape? s, string cmd)
            => s is null ? throw new ArgumentException($"Forge.{cmd}: a shape argument was null") : s.Voxels;

        private static Shape Voxelize(Mesh msh) => new Shape(new Voxels(msh));

        private static Shape Render(IImplicit sdf, BBox3 box) => new Shape(new Voxels(sdf, box));

        /// <summary>
        /// Grow a render box so the surface never touches its wall (a level set
        /// clipped by its own box meshes with a hole).
        /// </summary>
        private static BBox3 Pad(BBox3 box)
        {
            float p = MathF.Max(4f * s_voxelMM, 0.5f);
            return new BBox3(box.vecMin - new Vector3(p, p, p), box.vecMax + new Vector3(p, p, p));
        }

        private static float Comp(in Vector3 v, int axis) => axis == 0 ? v.X : (axis == 1 ? v.Y : v.Z);

        private static Vector3 WithComp(Vector3 v, int axis, float value)
        {
            if (axis == 0) v.X = value; else if (axis == 1) v.Y = value; else v.Z = value;
            return v;
        }

        /// <summary>The bbox extent along an axis, measured in the axis' SIGNED direction (Lo &lt; Hi always).</summary>
        private static (float lo, float hi) SignedSpan(in BBox3 bb, int axis, float sign)
        {
            float a = sign * Comp(bb.vecMin, axis);
            float b = sign * Comp(bb.vecMax, axis);
            return a <= b ? (a, b) : (b, a);
        }

        /// <summary>Fail loudly when an operation empties the field, instead of silently saving nothing.</summary>
        private static Shape Collapsed(Voxels v, string message)
        {
            v.CalculateProperties(out float vol, out _);
            float oneVoxel = s_voxelMM * s_voxelMM * s_voxelMM;
            if (vol < oneVoxel) throw new ArgumentException(message);
            return new Shape(v);
        }

        /// <summary>Rotate/scale about a pivot: translate to the origin, apply, translate back.</summary>
        private static Shape Spin(Shape shape, string cmd, Matrix4x4 core, Vec3? about)
        {
            Vector3 pivot = about is null ? (Vector3)Center(shape) : (Vector3)about;
            Matrix4x4 m = Matrix4x4.CreateTranslation(-pivot) * core * Matrix4x4.CreateTranslation(pivot);
            return Transform(shape, cmd, m);
        }

        /// <summary>
        /// Apply a matrix through a mesh round-trip (mesh -> transform -> re-voxelise).
        /// The voxel kernel has no rigid-body operator, so this is the canonical
        /// route, at the usual cost of half a voxel of re-discretisation.
        /// </summary>
        private static Shape Transform(Shape shape, string cmd, Matrix4x4 m)
        {
            Mesh msh = new Mesh(Vox(shape, cmd));
            return Voxelize(msh.mshCreateTransformed(m));   // Matrix4x4 overload ONLY
        }

        /// <summary>
        /// Resolve a file argument: an absolute path is used as-is, a bare name is
        /// searched through the job folder, scripts-library\assets and the repo root.
        /// </summary>
        private static string Resolve(string path, string cmd)
        {
            if (string.IsNullOrWhiteSpace(path))
                throw new ArgumentException($"Forge.{cmd}: a file path is required");

            if (Path.IsPathRooted(path))
            {
                if (!File.Exists(path)) throw new ArgumentException($"Forge.{cmd}: file not found: {path}");
                return path;
            }

            foreach (string dir in s_searchDirs)
            {
                string candidate = Path.GetFullPath(Path.Combine(dir, path));
                if (File.Exists(candidate)) return candidate;
            }
            throw new ArgumentException(
                $"Forge.{cmd}: file not found: '{path}' (searched {string.Join("; ", s_searchDirs)})");
        }
    }
}
