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
// positions. Capacity-hinted dictionaries + array-backed union-find, an edge
// table keyed by the CANONICAL (min,max) pair (half the entries, and the
// open-edge test becomes a sequential walk instead of a probe per directed
// edge), and a parallel prepass for the per-triangle math keep this ~1 s at
// 1.8M triangles.
//

using System.Collections.Generic;
using System.Numerics;
using System.Runtime.InteropServices;
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

        // Pass-1 chunking: triangles per parallel batch (scratch = 3 VKeys each,
        // ~3 MB at 256k) and the batch size below which the batch stays serial.
        const int TriChunk             = 1 << 18;
        const int ParallelTriThreshold = 1 << 14;

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

            // One hash probe per vertex (miss path used to cost a second probe for
            // the insert). Identical ids: they are still handed out in first-seen
            // order.
            int GetId(in VKey k)
            {
                ref int slot = ref CollectionsMarshal.GetValueRefOrAddDefault(vmap, k, out bool bFound);
                if (bFound) return slot;
                int id = vCount++;
                slot = id;
                parent[id] = id;
                return id;
            }

            // Pass 1 runs CHUNKED: the pure per-triangle work (native vertex fetch,
            // position quantization, tetra volume) is order-independent, so it is
            // computed in parallel into a small reusable buffer; the hash/union-find
            // consume then runs SERIALLY over that buffer in ascending i, so welded
            // ids are handed out in exactly the same first-seen order as before.
            // Chunking keeps the scratch at a couple of MB instead of one 60 MB
            // array over the whole mesh.
            int nChunk = Math.Min(nTri, TriChunk);
            var akChunk = new VKey[nChunk * 3];
            for (int b0 = 0; b0 < nTri; b0 += TriChunk)
            {
                int b1 = Math.Min(nTri, b0 + TriChunk);
                int cnt = b1 - b0;

                if (cnt >= ParallelTriThreshold)
                {
                    Parallel.ForEach(System.Collections.Concurrent.Partitioner.Create(0, cnt), rng =>
                    {
                        for (int j = rng.Item1; j < rng.Item2; j++)
                        {
                            mesh!.GetTriangle(b0 + j, out Vector3 a, out Vector3 b, out Vector3 c);
                            akChunk[j * 3]     = Quantize(a, tol);
                            akChunk[j * 3 + 1] = Quantize(b, tol);
                            akChunk[j * 3 + 2] = Quantize(c, tol);
                            triDv[b0 + j] = MeshUtil.TetraSignedVolume(a.X, a.Y, a.Z, b.X, b.Y, b.Z, c.X, c.Y, c.Z);
                        }
                    });
                }
                else
                {
                    for (int j = 0; j < cnt; j++)
                    {
                        mesh!.GetTriangle(b0 + j, out Vector3 a, out Vector3 b, out Vector3 c);
                        akChunk[j * 3]     = Quantize(a, tol);
                        akChunk[j * 3 + 1] = Quantize(b, tol);
                        akChunk[j * 3 + 2] = Quantize(c, tol);
                        triDv[b0 + j] = MeshUtil.TetraSignedVolume(a.X, a.Y, a.Z, b.X, b.Y, b.Z, c.X, c.Y, c.Z);
                    }
                }

                for (int j = 0; j < cnt; j++)
                {
                    int i = b0 + j;
                    int ia = GetId(akChunk[j * 3]), ib = GetId(akChunk[j * 3 + 1]), ic = GetId(akChunk[j * 3 + 2]);
                    Union(parent, rank, ia, ib);
                    Union(parent, rank, ia, ic);
                    triV[i * 3] = ia; triV[i * 3 + 1] = ib; triV[i * 3 + 2] = ic;
                }
            }

            // Per-component signed-volume accumulation (keyed by union-find root).
            var compVol = new Dictionary<int, double>(64);
            for (int i = 0; i < nTri; i++)
            {
                int root = Find(parent, triV[i * 3]);
                ref double v = ref CollectionsMarshal.GetValueRefOrAddDefault(compVol, root, out _);
                v += triDv[i];   // same ascending-i order -> same rounding
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
            // A closed mesh has exactly 3·nTri/2 undirected edges; sizing to that
            // avoids every rehash on the (overwhelmingly common) closed case.
            var edge = new Dictionary<long, EdgeCount>(nTri * 3 / 2 + 16, EdgeCmp);
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
            var edge = new Dictionary<long, EdgeCount>(nTri * 3 / 2 + 16, EdgeCmp);
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
        //
        // The multiset is keyed by the CANONICAL (min,max) pair, with the two
        // directed counts held side by side. That is exactly equivalent to the
        // per-direction map it replaces — see CountOpenEdges — but it halves the
        // table (3·nTri/2 entries instead of 3·nTri) and, more importantly, turns
        // the open-edge test into a pure sequential walk instead of one random
        // probe per directed edge.
        struct EdgeCount
        {
            public int Fwd;   // occurrences of (min -> max)
            public int Rev;   // occurrences of (max -> min)
        }

        static void AddEdge(Dictionary<long, EdgeCount> edge, int a, int b)
        {
            bool bFwd = a <= b;
            long k = bFwd ? (((long)a << 32) | (uint)b) : (((long)b << 32) | (uint)a);
            // One hash probe per edge instead of two (TryGetValue + indexer set).
            ref EdgeCount e = ref CollectionsMarshal.GetValueRefOrAddDefault(edge, k, out _);
            if (a == b)
            {
                // Degenerate edge: its own reverse. The per-direction map matched
                // it against itself and never called it open, so keep the counts
                // balanced here too.
                e.Fwd++; e.Rev++;
            }
            else if (bFwd) e.Fwd++;
            else           e.Rev++;
        }

        /// <summary>
        /// An edge is OPEN where the forward count differs from the reverse count.
        /// Per undirected pair with counts (F,R): the per-direction map enumerated
        /// the (min,max) slot iff F&gt;0 and the (max,min) slot iff R&gt;0, and marked
        /// each open iff F != R — so the pair contributes (F&gt;0) + (R&gt;0) when the
        /// counts differ and 0 when they match. Same total, no reverse probe.
        /// </summary>
        static int CountOpenEdges(Dictionary<long, EdgeCount> edge)
        {
            int open = 0;
            foreach (var kv in edge)
            {
                EdgeCount e = kv.Value;
                if (e.Fwd == e.Rev) continue;
                if (e.Fwd > 0) open++;
                if (e.Rev > 0) open++;
            }
            return open;
        }
    }
}
