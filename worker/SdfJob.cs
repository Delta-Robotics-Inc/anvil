//
// Anvil.Worker — SdfJob
//
// Bakes a per-part signed distance field the browser can upload as a 3D texture
// (R8, linear-filterable in WebGL2 without extensions) and raymarch/evaluate a
// lattice preview against. Dispatched from GyroidJob.Run on mode == "sdf".
//
// The field is PART-LOCAL: the mesh is loaded FORCE-MM with NO transform, so a
// part that is merely MOVED never needs a re-bake — the frontend applies the
// part's TRS to the sampling ray itself.
//
// Grid rule (the frontend codes against this exactly):
//   cellMM   = longestBboxAxis / resolution           (resolution 64..192)
//   core_a   = max(8, ceil(size_a / cellMM))          (other axes proportional)
//   n_a      = core_a + 2*PadCells                    (2 cells of outside space
//                                                      on EVERY side)
//   originMM = centre of voxel (0,0,0) in part-local mm
//   bandMM   = 4 * cellMM
//   byte     = clamp(d / bandMM, -1, 1) * 127 + 128   (128 = surface,
//                                                      <128 inside, >128 outside)
//   ordering = x-fastest, index = x + nx*(y + ny*z)
//
// Lattice alignment: PicoGK voxel grids are WORLD-ANCHORED, so our grid origin
// generally falls between two PicoGK voxel centres. Rather than resample (which
// would smear the occupancy by up to half a cell) the mesh is TRANSLATED by that
// sub-voxel delta before voxelization, which lands our voxel (0,0,0) exactly on
// a PicoGK lattice point. Occupancy then transfers by pure integer index
// arithmetic, and originMM is reported in the ORIGINAL (un-shifted) part frame.
//
// Distance: exact Euclidean, via a two-pass separable Felzenszwalb squared
// distance transform (O(n) per axis). Pass 1 runs on the INSIDE set to give the
// exterior distances, pass 2 on the OUTSIDE set to give the interior ones. Both
// are corrected by half a cell, because the discrete surface lies halfway
// between an inside and an outside voxel centre — so a boundary voxel reads
// ±0.5·cellMM and a trilinear fetch crosses 128 exactly on the surface.
//

using System.Diagnostics;
using System.Numerics;
using System.Text.Json;
using PicoGK;

namespace Anvil.Worker
{
    /// <summary>sdf.json — grid metadata written next to sdf.bin (the server adds "url").</summary>
    class SdfMeta
    {
        public int    nx         { get; set; }
        public int    ny         { get; set; }
        public int    nz         { get; set; }
        public Vec3   originMM   { get; set; } = new();
        public float  cellMM     { get; set; }
        public float  bandMM     { get; set; }
        public string encoding   { get; set; } = "r8";
        public string sign       { get; set; } = "negative-inside";
        public int    resolution { get; set; }
    }

    /// <summary>SDF done-stats contract (distinct from the flow-metrics / op stats).</summary>
    class SdfStats
    {
        public int   nx         { get; set; }
        public int   ny         { get; set; }
        public int   nz         { get; set; }
        public long  cells      { get; set; }
        public float cellMM     { get; set; }
        public float bandMM     { get; set; }
        public int   resolution { get; set; }
        public long  insideCells { get; set; }
        public long  bakeMs     { get; set; }   // total worker wall time
        public long  voxelizeMs { get; set; }   // mesh load + voxelize + occupancy read
        public long  distanceMs { get; set; }   // the two Felzenszwalb passes
    }

    static class SdfJob
    {
        const int   PadCells       = 2;      // outside-space border on EVERY side
        const float BandCells      = 4f;     // bandMM = BandCells * cellMM
        const int   MinCore        = 8;      // minimum core cells on a short axis
        const int   MinResolution  = 64;
        const int   MaxResolution  = 192;
        const int   DefResolution  = 128;
        const float Inf            = 1e20f;  // "unreachable" seed for the EDT

        public static void Run(JobRequest job)
        {
            if (string.IsNullOrEmpty(job.stlPath))
                throw new ArgumentException("sdf mode requires stlPath");
            if (string.IsNullOrEmpty(job.outputDir))
                throw new ArgumentException("sdf mode requires outputDir");

            var swTotal = Stopwatch.StartNew();
            string outDir = job.outputDir!;
            Directory.CreateDirectory(outDir);

            int resolution = job.resolution <= 0 ? DefResolution : job.resolution;
            resolution = Math.Clamp(resolution, MinResolution, MaxResolution);

            // ---- mesh (FORCE MM, NO transform — the field is part-local) ------
            Progress.Report("loadMesh", 0.05);
            Mesh msh = Mesh.mshFromStlFile(job.stlPath!, Mesh.EStlUnit.MM, 1f);
            BBox3 bbox = msh.oBoundingBox();
            if (bbox.bIsEmpty())
                throw new Exception("mesh bounding box is empty — nothing to bake");

            Vector3 vecMin  = bbox.vecMin;
            Vector3 vecSize = bbox.vecMax - bbox.vecMin;
            float fMaxDim = MathF.Max(vecSize.X, MathF.Max(vecSize.Y, vecSize.Z));
            if (fMaxDim <= 0f)
                throw new Exception("mesh has zero extent — nothing to bake");

            float fCell = fMaxDim / resolution;
            float fBand = BandCells * fCell;

            // Core cell counts: the LONGEST axis lands on exactly `resolution`
            // (the epsilon absorbs float noise in maxDim/cell); the others are
            // proportional with a floor of MinCore.
            int[] anCore = new int[3];
            int[] anTotal = new int[3];
            float[] afSize = { vecSize.X, vecSize.Y, vecSize.Z };
            float[] afMin  = { vecMin.X,  vecMin.Y,  vecMin.Z  };
            float[] afOrigin = new float[3];
            for (int a = 0; a < 3; a++)
            {
                anCore[a]  = Math.Max(MinCore, (int)MathF.Ceiling(afSize[a] / fCell - 1e-4f));
                anTotal[a] = anCore[a] + 2 * PadCells;
                // Centre the core span on the bbox, then step out over the pad
                // border; origin is the CENTRE of voxel 0 (hence +half a cell).
                float fExtra   = anCore[a] * fCell - afSize[a];
                float fCoreLow = afMin[a] - fExtra * 0.5f;
                afOrigin[a]    = fCoreLow - PadCells * fCell + 0.5f * fCell;
            }

            int nx = anTotal[0], ny = anTotal[1], nz = anTotal[2];
            long lCells = (long)nx * ny * nz;
            if (lCells > 64_000_000L)   // 192-cubed-ish is ~7.5M; this can never trip normally
                throw new Exception($"sdf grid too large: {nx}x{ny}x{nz} = {lCells} cells");

            var stats = new SdfStats
            {
                nx = nx, ny = ny, nz = nz, cells = lCells,
                cellMM = fCell, bandMM = fBand, resolution = resolution,
            };

            byte[] abyOut;
            var swVox = Stopwatch.StartNew();
            long lInside;

            using (var lib = new PicoGK.Library(fCell))
            {
                // ---- align our grid to the world-anchored PicoGK lattice -------
                // The lattice mapping is queried (not assumed): index -> mm is
                // affine, so one origin sample plus one unit-step sample fixes it.
                Vector3 vecLat0 = Library.vecVoxelsToMm(0, 0, 0);
                Vector3 vecLat1 = Library.vecVoxelsToMm(1, 1, 1);
                Vector3 vecStep = vecLat1 - vecLat0;
                if (MathF.Abs(vecStep.X) < 1e-9f || MathF.Abs(vecStep.Y) < 1e-9f || MathF.Abs(vecStep.Z) < 1e-9f)
                    throw new Exception("degenerate PicoGK voxel lattice step");

                float[] afLat0 = { vecLat0.X, vecLat0.Y, vecLat0.Z };
                float[] afStep = { vecStep.X, vecStep.Y, vecStep.Z };
                int[] anBase = new int[3];      // lattice index of OUR voxel (0,0,0)
                float[] afDelta = new float[3]; // sub-voxel mesh shift (|d| <= cell/2)
                for (int a = 0; a < 3; a++)
                {
                    anBase[a] = (int)MathF.Round((afOrigin[a] - afLat0[a]) / afStep[a]);
                    afDelta[a] = (afLat0[a] + anBase[a] * afStep[a]) - afOrigin[a];
                }
                Vector3 vecDelta = new(afDelta[0], afDelta[1], afDelta[2]);

                Progress.Report("voxelize", 0.25);
                Mesh mshGrid = vecDelta.LengthSquared() > 0f
                    ? msh.mshCreateTransformed(Matrix4x4.CreateTranslation(vecDelta))
                    : msh;
                Voxels vox = new Voxels(mshGrid);

                // ---- occupancy: our grid indices are lattice indices + anBase --
                Progress.Report("occupancy", 0.45);
                lInside = ReadOccupancy(vox, anBase[0], anBase[1], anBase[2], nx, ny, nz, out byte[] abyInside);
                swVox.Stop();

                // ---- exact signed Euclidean distance --------------------------
                Progress.Report("distance", 0.6);
                var swDist = Stopwatch.StartNew();
                abyOut = SignedDistanceBytes(abyInside, nx, ny, nz, fCell, fBand);
                swDist.Stop();
                stats.distanceMs = swDist.ElapsedMilliseconds;
            } // Library disposed -> native run-once guard released

            stats.voxelizeMs = swVox.ElapsedMilliseconds;
            stats.insideCells = lInside;

            // ---- write sdf.bin then sdf.json (json LAST: it is the ready marker)
            Progress.Report("saving", 0.9);
            var meta = new SdfMeta
            {
                nx = nx, ny = ny, nz = nz,
                originMM = new Vec3(afOrigin[0], afOrigin[1], afOrigin[2]),
                cellMM = fCell,
                bandMM = fBand,
                resolution = resolution,
            };

            string strBin  = Path.Combine(outDir, "sdf.bin");
            string strJson = Path.Combine(outDir, "sdf.json");
            WriteAtomic(strBin, abyOut);
            WriteAtomic(strJson, System.Text.Encoding.UTF8.GetBytes(
                JsonSerializer.Serialize(meta, new JsonSerializerOptions { WriteIndented = true })));

            swTotal.Stop();
            stats.bakeMs = swTotal.ElapsedMilliseconds;
            Progress.Done(stats);
        }

        /// <summary>Write via a .tmp sibling + atomic move, so a reader never sees a partial file.</summary>
        static void WriteAtomic(string strPath, byte[] abyData)
        {
            string strTmp = strPath + ".tmp";
            File.WriteAllBytes(strTmp, abyData);
            File.Move(strTmp, strPath, overwrite: true);
        }

        /// <summary>
        /// Copy the voxel field's solid/void mask into OUR grid. PicoGK slice
        /// polarity is INVERTED in ESliceMode.BlackWhite: solid (SDF &lt;= 0) is
        /// written as 0.0 and outside as 1.0, so "solid" is value &lt; 0.5 (same
        /// convention FlowMetrics.AccumulateProfiles relies on). Anything outside
        /// the field's own index window is void, which is exactly what the pad
        /// border wants.
        /// </summary>
        static long ReadOccupancy(
            Voxels vox, int iBaseX, int iBaseY, int iBaseZ,
            int nx, int ny, int nz, out byte[] abyInside)
        {
            abyInside = new byte[(long)nx * ny * nz];
            vox.GetVoxelDimensions(out int xo, out int yo, out int zo,
                                   out int xs, out int ys, out int zs);
            if (xs <= 0 || ys <= 0 || zs <= 0) return 0;   // empty field -> all outside

            var img = new ImageGrayScale(xs, ys);
            float[] px = img.m_afValues;   // row-major (x + y*width)
            long lInside = 0;

            for (int z = 0; z < nz; z++)
            {
                int fz = iBaseZ + z - zo;
                if (fz < 0 || fz >= zs) continue;
                vox.GetVoxelSlice(fz, ref img, Voxels.ESliceMode.BlackWhite);

                for (int y = 0; y < ny; y++)
                {
                    int fy = iBaseY + y - yo;
                    if (fy < 0 || fy >= ys) continue;

                    int iSrcRow = fy * xs;
                    int iDstRow = nx * (y + ny * z);
                    // Clip the x span once instead of testing per pixel.
                    int xLo = Math.Max(0, xo - iBaseX);
                    int xHi = Math.Min(nx, xo + xs - iBaseX);
                    for (int x = xLo; x < xHi; x++)
                    {
                        if (px[iSrcRow + (iBaseX + x - xo)] < 0.5f)
                        {
                            abyInside[iDstRow + x] = 1;
                            lInside++;
                        }
                    }
                }
            }
            return lInside;
        }

        /// <summary>
        /// Two Felzenszwalb passes -> quantized signed distance. Pass 1 seeds the
        /// INSIDE set (giving every outside voxel its distance to solid), pass 2
        /// seeds the OUTSIDE set (giving every inside voxel its distance to void).
        /// Both subtract half a cell, because the surface sits midway between the
        /// two straddling voxel centres.
        /// </summary>
        static byte[] SignedDistanceBytes(byte[] abyInside, int nx, int ny, int nz, float fCell, float fBand)
        {
            int n = abyInside.Length;
            byte[] abyOut = new byte[n];
            float[] af = new float[n];

            // ---- exterior: distance to the nearest INSIDE voxel ----
            for (int i = 0; i < n; i++) af[i] = abyInside[i] != 0 ? 0f : Inf;
            Edt3D(af, nx, ny, nz);
            for (int i = 0; i < n; i++)
            {
                if (abyInside[i] != 0) continue;
                float d = (MathF.Sqrt(af[i]) - 0.5f) * fCell;
                abyOut[i] = Quantize(d, fBand);
            }

            // ---- interior: distance to the nearest OUTSIDE voxel ----
            for (int i = 0; i < n; i++) af[i] = abyInside[i] == 0 ? 0f : Inf;
            Edt3D(af, nx, ny, nz);
            for (int i = 0; i < n; i++)
            {
                if (abyInside[i] == 0) continue;
                float d = -(MathF.Sqrt(af[i]) - 0.5f) * fCell;
                abyOut[i] = Quantize(d, fBand);
            }

            return abyOut;
        }

        /// <summary>byte = clamp(d / bandMM, -1, 1) * 127 + 128 (128 == surface).</summary>
        static byte Quantize(float d, float fBand)
        {
            float t = fBand > 0f ? d / fBand : 0f;
            if (t < -1f) t = -1f; else if (t > 1f) t = 1f;
            int q = (int)MathF.Round(t * 127f + 128f);
            return (byte)Math.Clamp(q, 0, 255);
        }

        // ---- Felzenszwalb & Huttenlocher separable squared EDT ----------------

        /// <summary>
        /// In-place 3D squared distance transform of a seeded field (0 on the
        /// seed set, Inf elsewhere). Separable: one O(n) sweep per axis.
        /// Index layout is x-fastest: i = x + nx*(y + ny*z).
        /// </summary>
        static void Edt3D(float[] f, int nx, int ny, int nz)
        {
            int nMax = Math.Max(nx, Math.Max(ny, nz));
            float[] afSrc = new float[nMax];
            float[] afDst = new float[nMax];
            float[] afZ   = new float[nMax + 1];
            int[]   anV   = new int[nMax];

            // X — contiguous rows.
            for (int z = 0; z < nz; z++)
                for (int y = 0; y < ny; y++)
                {
                    int b = nx * (y + ny * z);
                    Array.Copy(f, b, afSrc, 0, nx);
                    Edt1D(afSrc, nx, afDst, anV, afZ);
                    Array.Copy(afDst, 0, f, b, nx);
                }

            // Y — stride nx.
            for (int z = 0; z < nz; z++)
                for (int x = 0; x < nx; x++)
                {
                    int b = x + nx * ny * z;
                    for (int y = 0; y < ny; y++) afSrc[y] = f[b + y * nx];
                    Edt1D(afSrc, ny, afDst, anV, afZ);
                    for (int y = 0; y < ny; y++) f[b + y * nx] = afDst[y];
                }

            // Z — stride nx*ny.
            int nSlice = nx * ny;
            for (int y = 0; y < ny; y++)
                for (int x = 0; x < nx; x++)
                {
                    int b = x + nx * y;
                    for (int z = 0; z < nz; z++) afSrc[z] = f[b + z * nSlice];
                    Edt1D(afSrc, nz, afDst, anV, afZ);
                    for (int z = 0; z < nz; z++) f[b + z * nSlice] = afDst[z];
                }
        }

        /// <summary>
        /// 1D squared distance transform of a sampled function (lower envelope of
        /// parabolas). afZ must hold n+1 entries and anV n entries.
        /// </summary>
        static void Edt1D(float[] f, int n, float[] d, int[] v, float[] z)
        {
            if (n <= 0) return;
            int k = 0;
            v[0] = 0;
            z[0] = -Inf;
            z[1] = +Inf;

            for (int q = 1; q < n; q++)
            {
                float s = Intersect(f, q, v[k]);
                while (s <= z[k])
                {
                    k--;
                    s = Intersect(f, q, v[k]);
                }
                k++;
                v[k] = q;
                z[k] = s;
                z[k + 1] = +Inf;
            }

            k = 0;
            for (int q = 0; q < n; q++)
            {
                while (z[k + 1] < q) k++;
                float dx = q - v[k];
                d[q] = dx * dx + f[v[k]];
            }
        }

        /// <summary>Abscissa where the parabolas rooted at q and p intersect.</summary>
        static float Intersect(float[] f, int q, int p)
            => ((f[q] + (float)q * q) - (f[p] + (float)p * p)) / (2f * q - 2f * p);
    }
}
