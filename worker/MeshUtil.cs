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
    class TransformDto
    {
        public Vec3? translateMM { get; set; }   // mm
        public Vec3? rotateDeg   { get; set; }   // degrees, X/Y/Z
        public Vec3? scale       { get; set; }   // reserved; default (1,1,1)
    }

    /// <summary>An input/zone mesh reference: an STL path plus its current TRS.</summary>
    class MeshRef
    {
        public string?       path      { get; set; }
        public TransformDto? transform { get; set; }
    }

    static class MeshUtil
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

                // b × c
                double crX = by * czz - bz * cyy;
                double crY = bz * cxx - bx * czz;
                double crZ = bx * cyy - by * cxx;

                // dv = a · (b × c) / 6
                double dv = (ax * crX + ay * crY + az * crZ) / 6.0;
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
    }
}
