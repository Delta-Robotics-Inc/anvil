//
// Anvil.Worker — MeshClean
//
// Mesh hygiene before export. PicoGK meshes are vertex soup (nAddTriangle never
// dedups) and voxel booleans can leave disconnected "floating island" shells.
// One pass does the whole job:
//
//   weld vertices (quantized position hash, weldTol 1e-4 mm)
//     -> union-find over triangles sharing a welded vertex id
//     -> per-component signed volume (the SAME divergence-theorem tetra term
//        MeshMassProps sums — factored into MeshUtil.TetraSignedVolume)
//     -> drop below-threshold islands (the LARGEST component is always kept)
//     -> rebuild the Mesh via nAddTriangle (original coordinates preserved)
//     -> directed-edge watertight check on the rebuild (every directed edge
//        (u,v) matched by exactly one (v,u)).
//
// Coordinates are NEVER moved: welding only merges vertices already within
// weldTol of each other, and kept triangles are re-added with their ORIGINAL
// positions. Capacity-hinted dictionaries + array-backed union-find keep this
// ~1-3 s at 2M triangles.
//

using System.Collections.Generic;
using System.Numerics;
using PicoGK;

namespace Anvil.Worker
{
    /// <summary>Options for MeshClean.Clean (every field has a safe default).</summary>
    class MeshCleanOptions
    {
        public bool  removeIslands   = true;    // drop sub-threshold components
        public bool  keepLargestOnly = false;   // keep ONLY the largest component
        public float minVolumeMM3    = 0f;       // 0 -> auto (see Clean)
        public float weldTolMM       = 1e-4f;    // position-weld quantization
    }

    /// <summary>Full report from MeshClean.Clean.</summary>
    class MeshCleanResult
    {
        public int   components        { get; set; }   // total connected components found
        public int   removedComponents { get; set; }   // islands dropped
        public float removedVolumeMM3  { get; set; }   // Σ |vol| of dropped islands
        public bool  watertight        { get; set; }   // rebuilt mesh directed-edge closed
        public int   openEdges         { get; set; }   // unmatched directed edges (0 == watertight)
    }

    /// <summary>Compact cleanup summary attached to done-stats + emitted as a Note.</summary>
    class CleanupInfo
    {
        public int   components        { get; set; }
        public int   removedComponents { get; set; }
        public float removedVolumeMM3  { get; set; }
    }

    static class MeshClean
    {
        // Quantized-position key (round(p/weldTol) per axis). A struct key avoids
        // packing three ~23-bit coordinates into one 64-bit value (which overflows
        // for parts larger than ~200 mm at a 1e-4 mm tolerance).
        readonly struct VKey : IEquatable<VKey>
        {
            public readonly int X, Y, Z;
            public VKey(int x, int y, int z) { X = x; Y = y; Z = z; }
            public bool Equals(VKey o) => X == o.X && Y == o.Y && Z == o.Z;
            public override bool Equals(object? o) => o is VKey k && Equals(k);
            public override int GetHashCode() => HashCode.Combine(X, Y, Z);
        }

        // Nearest-quantum rounding in double so large coordinates don't lose the
        // last quantum; -0.0 and +0.0 both round to 0.
        static VKey Quantize(in Vector3 p, float tol) => new VKey(
            (int)Math.Round((double)p.X / tol),
            (int)Math.Round((double)p.Y / tol),
            (int)Math.Round((double)p.Z / tol));

        // Directed edges are packed as ((long)u << 32) | (uint)v. The built-in
        // long hash is hi ^ lo == u ^ v, which COLLIDES catastrophically on the
        // grid-structured vertex ids of voxel-meshed parts (O(n²) dictionary
        // meltdown). This comparer runs the packed key through the splitmix64
        // finalizer for full avalanche, restoring O(1) edge inserts.
        sealed class EdgeHash : IEqualityComparer<long>
        {
            public bool Equals(long x, long y) => x == y;
            public int GetHashCode(long v)
            {
                ulong z = (ulong)v;
                z = (z ^ (z >> 30)) * 0xBF58476D1CE4E5B9UL;
                z = (z ^ (z >> 27)) * 0x94D049BB133111EBUL;
                z ^= z >> 31;
                return (int)z;
            }
        }
        static readonly EdgeHash EdgeCmp = new EdgeHash();

        // ── union-find (array-backed, path-compression + union-by-rank) ────
        static int Find(int[] parent, int i)
        {
            while (parent[i] != i) { parent[i] = parent[parent[i]]; i = parent[i]; }
            return i;
        }
        static void Union(int[] parent, byte[] rank, int a, int b)
        {
            int ra = Find(parent, a), rb = Find(parent, b);
            if (ra == rb) return;
            if (rank[ra] < rank[rb]) (ra, rb) = (rb, ra);
            parent[rb] = ra;
            if (rank[ra] == rank[rb]) rank[ra]++;
        }

        /// <summary>
        /// Weld → union-find components → signed volume per component → drop
        /// islands (the largest component is always kept) → rebuild → directed-edge
        /// watertight check. Returns the rebuilt mesh; <paramref name="result"/>
        /// carries the component/island counts and watertightness.
        /// </summary>
        public static Mesh Clean(Mesh mesh, float voxelMM, MeshCleanOptions? opts, out MeshCleanResult result)
        {
            opts ??= new MeshCleanOptions();
            float tol = opts.weldTolMM > 0f ? opts.weldTolMM : 1e-4f;
            int nTri = mesh?.nTriangleCount() ?? 0;

            result = new MeshCleanResult();
            if (nTri == 0)
            {
                result.watertight = true;   // vacuously closed
                return new Mesh();
            }

            // Pass 1: weld vertices, seed union-find, accumulate per-triangle
            // welded ids + signed tetra volume.
            var vmap = new Dictionary<VKey, int>(nTri * 2);
            int[] parent = new int[nTri * 3];   // upper bound on distinct welded verts
            byte[] rank  = new byte[nTri * 3];
            int vCount = 0;

            int[]    triV  = new int[nTri * 3]; // 3 welded ids per triangle
            double[] triDv = new double[nTri];  // signed tetra volume per triangle

            int GetId(in Vector3 p)
            {
                var k = Quantize(p, tol);
                if (vmap.TryGetValue(k, out int id)) return id;
                id = vCount++;
                vmap[k] = id;
                parent[id] = id;
                return id;
            }

            for (int i = 0; i < nTri; i++)
            {
                mesh!.GetTriangle(i, out Vector3 a, out Vector3 b, out Vector3 c);
                int ia = GetId(a), ib = GetId(b), ic = GetId(c);
                Union(parent, rank, ia, ib);
                Union(parent, rank, ia, ic);
                triV[i * 3] = ia; triV[i * 3 + 1] = ib; triV[i * 3 + 2] = ic;
                triDv[i] = MeshUtil.TetraSignedVolume(a.X, a.Y, a.Z, b.X, b.Y, b.Z, c.X, c.Y, c.Z);
            }

            // Per-component signed-volume accumulation (keyed by union-find root).
            var compVol = new Dictionary<int, double>(64);
            for (int i = 0; i < nTri; i++)
            {
                int root = Find(parent, triV[i * 3]);
                compVol.TryGetValue(root, out double v);
                compVol[root] = v + triDv[i];
            }
            result.components = compVol.Count;

            // Largest component by |volume| — ALWAYS kept.
            int largestRoot = -1;
            double largestAbs = -1.0;
            foreach (var kv in compVol)
            {
                double av = Math.Abs(kv.Value);
                if (av > largestAbs) { largestAbs = av; largestRoot = kv.Key; }
            }

            // Threshold: explicit minVolumeMM3, else auto = max(27·voxel³, 0.1%·largest).
            double voxel = voxelMM > 0f ? voxelMM : 0.0;
            double threshold = opts.minVolumeMM3 > 0f
                ? opts.minVolumeMM3
                : Math.Max(27.0 * voxel * voxel * voxel, 0.001 * largestAbs);

            // Decide which roots to keep.
            var kept = new HashSet<int>(compVol.Count);
            double removedVol = 0.0;
            int removed = 0;
            foreach (var kv in compVol)
            {
                bool keep;
                if (kv.Key == largestRoot)     keep = true;
                else if (opts.keepLargestOnly) keep = false;
                else if (!opts.removeIslands)  keep = true;
                else                            keep = Math.Abs(kv.Value) >= threshold;

                if (keep) kept.Add(kv.Key);
                else { removed++; removedVol += Math.Abs(kv.Value); }
            }
            result.removedComponents = removed;
            result.removedVolumeMM3  = (float)removedVol;

            // Watertight check runs on the KEPT triangles' welded edges. Distinct
            // components never share a welded vertex (union-find would have merged
            // them), so the kept ids form a self-contained edge set.
            var edge = new Dictionary<long, int>(nTri * 3, EdgeCmp);
            Mesh outMesh;
            if (removed == 0)
            {
                // FAST PATH: nothing dropped -> the cleaned mesh IS the input.
                // Skip the (native, per-triangle) rebuild entirely; just tally the
                // edges of every triangle for the watertight test.
                for (int i = 0; i < nTri; i++)
                {
                    AddEdge(edge, triV[i * 3],     triV[i * 3 + 1]);
                    AddEdge(edge, triV[i * 3 + 1], triV[i * 3 + 2]);
                    AddEdge(edge, triV[i * 3 + 2], triV[i * 3]);
                }
                outMesh = mesh!;
            }
            else
            {
                // Rebuild from kept triangles only (original coordinates preserved).
                outMesh = new Mesh();
                for (int i = 0; i < nTri; i++)
                {
                    if (!kept.Contains(Find(parent, triV[i * 3]))) continue;
                    mesh!.GetTriangle(i, out Vector3 a, out Vector3 b, out Vector3 c);
                    outMesh.nAddTriangle(a, b, c);
                    int ia = triV[i * 3], ib = triV[i * 3 + 1], ic = triV[i * 3 + 2];
                    AddEdge(edge, ia, ib);
                    AddEdge(edge, ib, ic);
                    AddEdge(edge, ic, ia);
                }
            }

            int open = CountOpenEdges(edge);
            result.openEdges  = open;
            result.watertight = open == 0;
            return outMesh;
        }

        /// <summary>
        /// Directed-edge watertight test on the mesh AS-IS (weld → every directed
        /// edge (u,v) must be matched by exactly one (v,u)). Used by mesh-only ops
        /// that never voxelize (primitive/transform/mirror).
        /// </summary>
        public static void CheckWatertight(Mesh mesh, double weldTolMM, out bool watertight, out int openEdges)
        {
            int nTri = mesh?.nTriangleCount() ?? 0;
            float tol = weldTolMM > 0 ? (float)weldTolMM : 1e-4f;
            if (nTri == 0) { watertight = true; openEdges = 0; return; }

            var vmap = new Dictionary<VKey, int>(nTri * 2);
            var edge = new Dictionary<long, int>(nTri * 3, EdgeCmp);
            int vCount = 0;

            int GetId(in Vector3 p)
            {
                var k = Quantize(p, tol);
                if (vmap.TryGetValue(k, out int id)) return id;
                id = vCount++; vmap[k] = id; return id;
            }

            for (int i = 0; i < nTri; i++)
            {
                mesh!.GetTriangle(i, out Vector3 a, out Vector3 b, out Vector3 c);
                int ia = GetId(a), ib = GetId(b), ic = GetId(c);
                AddEdge(edge, ia, ib);
                AddEdge(edge, ib, ic);
                AddEdge(edge, ic, ia);
            }

            openEdges  = CountOpenEdges(edge);
            watertight = openEdges == 0;
        }

        /// <summary>
        /// Run cleanup (or just the watertight check) on a FINAL mesh and package
        /// the report. When cleanup runs it also emits a Progress.Note carrying the
        /// island counts. Returns the mesh to save (cleaned when cleanup, else the
        /// input unchanged).
        /// </summary>
        public static Mesh CleanAndReport(Mesh mesh, bool cleanup, float voxelMM,
            out bool watertight, out int openEdges, out CleanupInfo? cleanupInfo)
        {
            if (cleanup)
            {
                Mesh cleaned = Clean(mesh, voxelMM, new MeshCleanOptions(), out MeshCleanResult r);
                watertight  = r.watertight;
                openEdges   = r.openEdges;
                cleanupInfo = new CleanupInfo
                {
                    components        = r.components,
                    removedComponents = r.removedComponents,
                    removedVolumeMM3  = r.removedVolumeMM3,
                };
                Progress.Note(new { cleanup = cleanupInfo });
                return cleaned;
            }

            CheckWatertight(mesh, 1e-4, out bool wt, out int oe);
            watertight  = wt;
            openEdges   = oe;
            cleanupInfo = null;
            return mesh;
        }

        // ── directed-edge multiset helpers ─────────────────────────────────
        static void AddEdge(Dictionary<long, int> edge, int a, int b)
        {
            long k = ((long)a << 32) | (uint)b;
            edge.TryGetValue(k, out int c);
            edge[k] = c + 1;
        }

        // An edge is OPEN where the forward count differs from the reverse count.
        static int CountOpenEdges(Dictionary<long, int> edge)
        {
            int open = 0;
            foreach (var kv in edge)
            {
                long k = kv.Key;
                int u = (int)(k >> 32);
                int w = (int)(k & 0xffffffffL);
                long rev = ((long)w << 32) | (uint)u;
                edge.TryGetValue(rev, out int cRev);
                if (cRev != kv.Value) open++;
            }
            return open;
        }
    }
}
