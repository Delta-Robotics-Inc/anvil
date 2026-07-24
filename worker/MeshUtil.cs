//
// Anvil.Worker — MeshUtil
//
// Shared mesh helpers for Wave-1 "Objects & Ops":
//   * LoadMesh(path, TransformDto?)  — FORCE-MM load + the ONE canonical TRS
//     matrix (scale -> rotX -> rotY -> rotZ -> translate). A null transform is
//     byte-identical to the legacy Mesh.mshFromStlFile(path, MM, 1f) load.
//   * MirrorWindingFixed(src, planePt, planeN) — mirror with SWAPPED triangle
//     winding (B,A,C). PicoGK's mshCreateMirrored does NOT flip winding, so its
//     output voxelizes inside-out; this reimplementation restores outward
//     normals so the mirrored mesh re-voxelizes correctly.
//   * MeshMassProps(mesh, out vol, out area, out cog) — divergence-theorem mass
//     properties (signed volume, surface area, centre of gravity) for mesh-only
//     ops that never touch the voxel kernel.
//
// Coordinates are NEVER silently recentred: the canonical matrix is the ONLY
// transform applied, and it matches the viewer's column-vector chain 1:1.
//

using System.Numerics;
using PicoGK;

namespace Anvil.Worker
{
    /// <summary>
    /// Per-part non-destructive TRS. Composition is fixed and canonical:
    /// scale -> rotX -> rotY -> rotZ -> translate. Scale is reserved (defaults
    /// to 1 on every axis); rotation is in DEGREES; translation is in mm.
    /// </summary>
    public class TransformDto
    {
        public Vec3? translateMM { get; set; }   // mm
        public Vec3? rotateDeg   { get; set; }   // degrees, X/Y/Z
        public Vec3? scale       { get; set; }   // reserved; default (1,1,1)
    }

    /// <summary>An input/zone mesh reference: an STL path plus its current TRS.</summary>
    public class MeshRef
    {
        public string?       path      { get; set; }
        public TransformDto? transform { get; set; }
    }

    public static class MeshUtil
    {
        /// <summary>
        /// The ONE canonical composition, in System.Numerics row-vector form
        /// (Vector3.Transform(v, M) = v·M): M = Scale · RotX · RotY · RotZ · Translate.
        /// Applying to a point yields scale first, then X/Y/Z rotation about the
        /// origin, then translation — matching the viewer's premultiplied
        /// column-vector chain exactly. Returns identity for a null transform.
        /// </summary>
        public static Matrix4x4 BuildMatrix(TransformDto? t)
        {
            if (t is null) return Matrix4x4.Identity;

            Vector3 s = Vector3.One;
            if (t.scale is Vec3 sc)
            {
                s = new Vector3(sc.x != 0f ? sc.x : 1f,
                                sc.y != 0f ? sc.y : 1f,
                                sc.z != 0f ? sc.z : 1f);
            }

            Vector3 r  = t.rotateDeg?.ToVector3()   ?? Vector3.Zero;
            Vector3 tr = t.translateMM?.ToVector3() ?? Vector3.Zero;

            float rx = r.X * MathF.PI / 180f;
            float ry = r.Y * MathF.PI / 180f;
            float rz = r.Z * MathF.PI / 180f;

            return Matrix4x4.CreateScale(s)
                 * Matrix4x4.CreateRotationX(rx)
                 * Matrix4x4.CreateRotationY(ry)
                 * Matrix4x4.CreateRotationZ(rz)
                 * Matrix4x4.CreateTranslation(tr);
        }

        /// <summary>
        /// Load an STL, FORCING millimetres (never AUTO), then apply the canonical
        /// TRS matrix if a transform is supplied. A null transform returns the raw
        /// loaded mesh unchanged — byte-identical to the legacy load path. An
        /// effectively-identity transform is also returned unchanged.
        /// </summary>
        public static Mesh LoadMesh(string strPath, TransformDto? t)
        {
            Mesh msh = Mesh.mshFromStlFile(strPath, Mesh.EStlUnit.MM, 1f); // FORCE MM
            if (t is null) return msh;                                     // legacy-identical

            Matrix4x4 mat = BuildMatrix(t);
            if (mat == Matrix4x4.Identity) return msh;                     // no-op transform
            return msh.mshCreateTransformed(mat);                          // Matrix4x4 overload ONLY
        }

        /// <summary>
        /// Mirror a mesh across the plane (point, normal), reflecting every vertex
        /// AND swapping triangle winding to (B, A, C). The reflection alone flips
        /// handedness (normals point inward); the winding swap restores outward
        /// normals so the result voxelizes as a solid rather than inside-out.
        /// </summary>
        public static Mesh MirrorWindingFixed(Mesh mshSrc, Vector3 vecPlanePoint, Vector3 vecPlaneNormal)
        {
            Vector3 n = vecPlaneNormal.vecNormalized();
            Mesh mshOut = new Mesh();

            int nTri = mshSrc.nTriangleCount();
            for (int i = 0; i < nTri; i++)
            {
                mshSrc.GetTriangle(i, out Vector3 a, out Vector3 b, out Vector3 c);

                Vector3 am = a.vecMirrored(vecPlanePoint, n);
                Vector3 bm = b.vecMirrored(vecPlanePoint, n);
                Vector3 cm = c.vecMirrored(vecPlanePoint, n);

                // Swap winding (B, A, C) to flip the handedness back to outward.
                mshOut.nAddTriangle(bm, am, cm);
            }

            return mshOut;
        }

        /// <summary>
        /// Mass properties by the divergence theorem over the signed tetrahedra
        /// (origin, A, B, C):
        ///   V     = |Σ  a · (b × c) / 6|                       (abs taken at end)
        ///   CoG   = (1/Σdv) Σ ((a + b + c) / 4) · dv           (signed sum; sign cancels)
        ///   area  = Σ |(b − a) × (c − a)| / 2
        /// Accumulated in double precision for accuracy. Mesh-only ops report
        /// these instead of touching the voxel kernel, so results are exact.
        /// </summary>
        public static void MeshMassProps(Mesh msh, out float volumeMM3, out float surfaceAreaMM2, out Vector3 cogMM)
        {
            double vSigned = 0.0;   // Σ dv  (signed)
            double cx = 0.0, cy = 0.0, cz = 0.0;
            double area = 0.0;

            int nTri = msh?.nTriangleCount() ?? 0;
            for (int i = 0; i < nTri; i++)
            {
                msh!.GetTriangle(i, out Vector3 a, out Vector3 b, out Vector3 c);

                double ax = a.X, ay = a.Y, az = a.Z;
                double bx = b.X, by = b.Y, bz = b.Z;
                double cxx = c.X, cyy = c.Y, czz = c.Z;

                // dv = a · (b × c) / 6 — shared with MeshClean's per-component
                // accumulation so both sum the SAME divergence-theorem term.
                double dv = TetraSignedVolume(ax, ay, az, bx, by, bz, cxx, cyy, czz);
                vSigned += dv;

                // centroid of tetra (origin,a,b,c) = (a+b+c)/4, weighted by dv
                cx += (ax + bx + cxx) * 0.25 * dv;
                cy += (ay + by + cyy) * 0.25 * dv;
                cz += (az + bz + czz) * 0.25 * dv;

                // triangle area = |(b−a) × (c−a)| / 2
                double e1x = bx - ax, e1y = by - ay, e1z = bz - az;
                double e2x = cxx - ax, e2y = cyy - ay, e2z = czz - az;
                double nx = e1y * e2z - e1z * e2y;
                double ny = e1z * e2x - e1x * e2z;
                double nz = e1x * e2y - e1y * e2x;
                area += 0.5 * Math.Sqrt(nx * nx + ny * ny + nz * nz);
            }

            volumeMM3      = (float)Math.Abs(vSigned);
            surfaceAreaMM2 = (float)area;

            if (Math.Abs(vSigned) > 1e-9)
                cogMM = new Vector3((float)(cx / vSigned), (float)(cy / vSigned), (float)(cz / vSigned));
            else
                cogMM = Vector3.Zero;
        }

        /// <summary>
        /// Signed volume of the tetrahedron (origin, A, B, C) = A · (B × C) / 6,
        /// in double precision. This is the exact per-triangle term the
        /// divergence-theorem volume sums. Components are passed as doubles
        /// (already widened from the mesh's float positions) so the arithmetic
        /// order is byte-identical to the original inlined MeshMassProps math;
        /// MeshClean reuses it for its per-component volume accumulation.
        /// </summary>
        internal static double TetraSignedVolume(
            double ax, double ay, double az,
            double bx, double by, double bz,
            double cx, double cy, double cz)
        {
            double crX = by * cz - bz * cy;
            double crY = bz * cx - bx * cz;
            double crZ = bx * cy - by * cx;
            return (ax * crX + ay * crY + az * crZ) / 6.0;
        }

        // ── Hand-rolled primitive builders ─────────────────────────────────
        //
        // These REPLACE PicoGK's Utils.mshCreate* (which are never exercised
        // upstream and whose GeoSphere projects subdivision midpoints toward the
        // WORLD ORIGIN — spheres are perfect at the origin and shatter anywhere
        // else). Every builder here is watertight BY CONSTRUCTION: shared
        // vertices are added ONCE via nAddVertex and referenced by index, so no
        // crack can open between adjacent triangles. Winding is CONSISTENTLY
        // outward (standard normal (v1−v0)×(v2−v0) points away from the solid),
        // matching PicoGK's own cube/cylinder/cone winding so the meshes
        // re-voxelize as solids rather than inside-out.

        /// <summary>
        /// Segments (facets around a curved primitive) from the maximum diameter
        /// and voxel size: enough facets that a chord spans ~4 voxels, clamped to
        /// [32, 128]. Curved primitives call this so their tessellation tracks the
        /// resolution the part will actually be voxelized at.
        /// </summary>
        public static int Segments(float maxDiaMM, float voxelMM)
            => Math.Clamp((int)Math.Ceiling(Math.PI * maxDiaMM / (4.0 * voxelMM)), 32, 128);

        // Round a facet count UP to a multiple of 4 (min 4). This lands ring
        // vertices exactly on the ±X and ±Y axes, so a curved primitive's bounding
        // box hits the true diameter on all four cardinal points — its bbox size
        // equals the requested diameter and its bbox centre equals the requested
        // centre exactly, rather than drifting inward with an odd, off-axis polygon.
        static int SnapToQuad(int s) => Math.Max(4, ((s + 3) / 4) * 4);

        /// <summary>
        /// Axis-aligned box: 8 shared corners, 12 triangles, outward winding.
        /// sizeMM is the FULL X/Y/Z extent; centerMM is the box centre.
        /// </summary>
        public static Mesh CreateBox(Vector3 sizeMM, Vector3 centerMM)
        {
            float hx = sizeMM.X * 0.5f, hy = sizeMM.Y * 0.5f, hz = sizeMM.Z * 0.5f;
            Mesh msh = new Mesh();

            // Corner index = sign bits (bit0 = +X, bit1 = +Y, bit2 = +Z); layout
            // and per-face winding match PicoGK's (verified-correct) cube.
            int v0 = msh.nAddVertex(new Vector3(centerMM.X - hx, centerMM.Y - hy, centerMM.Z - hz));
            int v1 = msh.nAddVertex(new Vector3(centerMM.X - hx, centerMM.Y - hy, centerMM.Z + hz));
            int v2 = msh.nAddVertex(new Vector3(centerMM.X - hx, centerMM.Y + hy, centerMM.Z - hz));
            int v3 = msh.nAddVertex(new Vector3(centerMM.X - hx, centerMM.Y + hy, centerMM.Z + hz));
            int v4 = msh.nAddVertex(new Vector3(centerMM.X + hx, centerMM.Y - hy, centerMM.Z - hz));
            int v5 = msh.nAddVertex(new Vector3(centerMM.X + hx, centerMM.Y - hy, centerMM.Z + hz));
            int v6 = msh.nAddVertex(new Vector3(centerMM.X + hx, centerMM.Y + hy, centerMM.Z - hz));
            int v7 = msh.nAddVertex(new Vector3(centerMM.X + hx, centerMM.Y + hy, centerMM.Z + hz));

            msh.nAddTriangle(v0, v1, v3); msh.nAddTriangle(v0, v3, v2); // −X
            msh.nAddTriangle(v4, v6, v7); msh.nAddTriangle(v4, v7, v5); // +X
            msh.nAddTriangle(v0, v2, v6); msh.nAddTriangle(v0, v6, v4); // −Z
            msh.nAddTriangle(v1, v5, v7); msh.nAddTriangle(v1, v7, v3); // +Z
            msh.nAddTriangle(v2, v3, v7); msh.nAddTriangle(v2, v7, v6); // +Y
            msh.nAddTriangle(v0, v4, v5); msh.nAddTriangle(v0, v5, v1); // −Y

            return msh;
        }

        /// <summary>
        /// Elliptical cylinder: X/Y are full DIAMETERS, height is along Z centred
        /// on centerMM. Caps are fan-triangulated from a single centre vertex on
        /// each end; side quads and both caps share the ring vertices (welded).
        /// </summary>
        public static Mesh CreateCylinder(float diaX, float diaY, float heightMM, Vector3 centerMM, int segments)
        {
            int n = SnapToQuad(segments);
            float fA = diaX * 0.5f, fB = diaY * 0.5f;
            float zB = centerMM.Z - heightMM * 0.5f;
            float zT = centerMM.Z + heightMM * 0.5f;

            Mesh msh = new Mesh();
            int iBotC = msh.nAddVertex(new Vector3(centerMM.X, centerMM.Y, zB));
            int iTopC = msh.nAddVertex(new Vector3(centerMM.X, centerMM.Y, zT));

            int[] bot = new int[n], top = new int[n];
            for (int i = 0; i < n; i++)
            {
                float a = 2f * MathF.PI * i / n;
                float x = centerMM.X + MathF.Cos(a) * fA;
                float y = centerMM.Y + MathF.Sin(a) * fB;
                bot[i] = msh.nAddVertex(new Vector3(x, y, zB));
                top[i] = msh.nAddVertex(new Vector3(x, y, zT));
            }

            for (int i = 0; i < n; i++)
            {
                int j = (i + 1) % n;
                msh.nAddTriangle(bot[i], bot[j], top[i]);   // side (outward)
                msh.nAddTriangle(bot[j], top[j], top[i]);
                msh.nAddTriangle(iTopC, top[i], top[j]);    // top cap (+Z)
                msh.nAddTriangle(iBotC, bot[j], bot[i]);    // bottom cap (−Z)
            }

            return msh;
        }

        /// <summary>
        /// Elliptical cone: X/Y are full base DIAMETERS. Base sits at
        /// centerZ − h/2, apex at centerZ + h/2. Side triangles fan up to a single
        /// apex vertex; the base cap fans from a single centre vertex.
        /// </summary>
        public static Mesh CreateCone(float diaX, float diaY, float heightMM, Vector3 centerMM, int segments)
        {
            int n = SnapToQuad(segments);
            float fA = diaX * 0.5f, fB = diaY * 0.5f;
            float zB = centerMM.Z - heightMM * 0.5f;
            float zApex = centerMM.Z + heightMM * 0.5f;

            Mesh msh = new Mesh();
            int iBotC = msh.nAddVertex(new Vector3(centerMM.X, centerMM.Y, zB));
            int iApex = msh.nAddVertex(new Vector3(centerMM.X, centerMM.Y, zApex));

            int[] bot = new int[n];
            for (int i = 0; i < n; i++)
            {
                float a = 2f * MathF.PI * i / n;
                bot[i] = msh.nAddVertex(new Vector3(
                    centerMM.X + MathF.Cos(a) * fA,
                    centerMM.Y + MathF.Sin(a) * fB, zB));
            }

            for (int i = 0; i < n; i++)
            {
                int j = (i + 1) % n;
                msh.nAddTriangle(bot[i], bot[j], iApex);   // side (outward)
                msh.nAddTriangle(iBotC, bot[j], bot[i]);   // base cap (−Z)
            }

            return msh;
        }

        /// <summary>
        /// UV-sphere / ellipsoid: <paramref name="segments"/> longitudes ×
        /// max(segments/2, 8) latitude bands, per-axis radii from diaXYZ (an
        /// ellipsoid when the diameters differ). The two poles are SINGLE shared
        /// vertices so the cap rows are true triangles (no degenerate zero-area
        /// quads). Consistent outward winding.
        /// </summary>
        public static Mesh CreateSphere(Vector3 diaXYZ, Vector3 centerMM, int segments)
        {
            float rx = diaXYZ.X * 0.5f, ry = diaXYZ.Y * 0.5f, rz = diaXYZ.Z * 0.5f;
            int nLon = SnapToQuad(segments);          // ±X/±Y vertices → exact X/Y bbox
            int nLat = Math.Max(segments / 2, 8);
            if ((nLat & 1) == 1) nLat++;              // even → an equator ring exists,
                                                      // so the X/Y bbox reaches the full radius

            Mesh msh = new Mesh();
            int iNorth = msh.nAddVertex(new Vector3(centerMM.X, centerMM.Y, centerMM.Z + rz));
            int iSouth = msh.nAddVertex(new Vector3(centerMM.X, centerMM.Y, centerMM.Z - rz));

            // Interior latitude rings j = 1 .. nLat−1 (poles excluded).
            int[][] ring = new int[nLat][];
            for (int j = 1; j <= nLat - 1; j++)
            {
                float theta = MathF.PI * j / nLat;   // 0 (north) .. π (south)
                float st = MathF.Sin(theta), ct = MathF.Cos(theta);
                ring[j] = new int[nLon];
                for (int i = 0; i < nLon; i++)
                {
                    float phi = 2f * MathF.PI * i / nLon;
                    ring[j][i] = msh.nAddVertex(new Vector3(
                        centerMM.X + rx * st * MathF.Cos(phi),
                        centerMM.Y + ry * st * MathF.Sin(phi),
                        centerMM.Z + rz * ct));
                }
            }

            // North cap: pole → ring[1] (outward, +Z-ish).
            for (int i = 0; i < nLon; i++)
                msh.nAddTriangle(iNorth, ring[1][i], ring[1][(i + 1) % nLon]);

            // Middle bands: ring[j] (upper) → ring[j+1] (lower), outward radial.
            for (int j = 1; j <= nLat - 2; j++)
            {
                for (int i = 0; i < nLon; i++)
                {
                    int k = (i + 1) % nLon;
                    int aUp = ring[j][i], bUp = ring[j][k];
                    int aLo = ring[j + 1][i], bLo = ring[j + 1][k];
                    msh.nAddTriangle(aLo, bLo, aUp);
                    msh.nAddTriangle(bLo, bUp, aUp);
                }
            }

            // South cap: pole → ring[nLat−1] (outward, −Z-ish).
            int last = nLat - 1;
            for (int i = 0; i < nLon; i++)
                msh.nAddTriangle(iSouth, ring[last][(i + 1) % nLon], ring[last][i]);

            return msh;
        }
    }
}
