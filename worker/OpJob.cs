//
// Anvil.Worker — OpJob
//
// Wave-1 "Objects & Ops": each tool op is a SHORT worker job that produces a
// NEW mesh (data/parts/{id}/mesh.stl). Dispatched from GyroidJob.Run on
// mode == "op". opKind selects the operation:
//
//   MESH-ONLY (exact, no voxelization):
//     primitive  — MeshUtil.CreateBox/Cylinder/Cone/Sphere (hand-rolled, watertight
//                  by construction; curved shapes facet via MeshUtil.Segments)
//     transform  — LoadMesh bakes the input's TRS matrix
//     mirror     — MeshUtil.MirrorWindingFixed (winding-corrected reflection)
//
//   VOXEL (± half voxel):
//     boolean    — voxBoolAdd / voxBoolSubtract / voxBoolIntersect
//     merge      — voxBoolAdd + voxFillet(filletMM)
//     shell      — inside/outside/centered from voxOffset
//     offset     — voxOffset(signed); errors if the result collapses
//
// Every op runs inside `using var lib = new Library(voxelSizeMM)`. Primitives no
// longer need it (they facet from the job's own voxel size via MeshUtil.Segments),
// but the voxel ops (boolean/merge/shell/offset) and every `new Voxels(mesh)`
// require an initialised Library, so it is created unconditionally. Progress is
// one JSON line per stage on stdout; the done stats are {volumeMM3, triangles,
// surfaceAreaMM2, cogMM:[x,y,z]}. Errors throw and are emitted by Program.cs as
// a single JSON object on stderr with a non-zero exit.
//

using System.Numerics;
using PicoGK;

namespace Anvil.Worker
{
    /// <summary>Mirror plane for the mirror op.</summary>
    class MirrorDto
    {
        public Vec3? planePoint  { get; set; }   // mm; defaults to origin
        public Vec3? planeNormal { get; set; }   // required, any length
    }

    /// <summary>Primitive descriptor for the primitive op.</summary>
    class PrimitiveDto
    {
        public string? kind   { get; set; }      // cube|box|cylinder|sphere|cone
        public Vec3?   sizeMM { get; set; }       // full dimensions (X,Y,Z)
        public Vec3?   centerMM { get; set; }     // center (defaults to origin)
        public int     sides  { get; set; }       // legacy/ignored — facet count now
                                                  // derives from MeshUtil.Segments(dia, voxel)
    }

    /// <summary>Op done-stats contract (distinct from the flow-metrics Stats).</summary>
    class OpStats
    {
        public float   volumeMM3      { get; set; }
        public int     triangles      { get; set; }
        public float   surfaceAreaMM2 { get; set; }
        public float[] cogMM          { get; set; } = new float[3];

        // ---- mesh hygiene (Stage 3) ----
        public bool         watertight { get; set; }   // export mesh directed-edge closed
        public int          openEdges  { get; set; }   // unmatched directed edges (0 == watertight)
        public CleanupInfo? cleanup    { get; set; }   // island-removal summary (null for mesh-only ops / cleanup off)
    }

    static class OpJob
    {
        public static void Run(JobRequest job)
        {
            string kind = (job.opKind ?? "").Trim().ToLowerInvariant();
            if (string.IsNullOrEmpty(job.outputPath))
                throw new ArgumentException("op mode requires outputPath");

            float voxel = job.voxelSizeMM > 0f ? job.voxelSizeMM : 0.3f;

            // A Library MUST exist before any VOXEL op and before `new Voxels(mesh)`.
            // Hand-rolled primitives no longer read it (they facet from `voxel`
            // directly), but it is created unconditionally so the voxel path is
            // always ready.
            using var lib = new PicoGK.Library(voxel);

            switch (kind)
            {
                // ---- mesh-only ----
                case "primitive": RunPrimitive(job, voxel); break;
                case "transform": RunTransformBake(job);   break;
                case "mirror":    RunMirror(job);          break;
                // ---- voxel ----
                case "boolean":   RunBoolean(job, voxel);  break;
                case "merge":     RunMerge(job, voxel);    break;
                case "shell":     RunShell(job, voxel);    break;
                case "offset":    RunOffset(job, voxel);   break;
                default:
                    throw new ArgumentException(
                        $"unknown opKind: '{job.opKind}' (expected boolean|merge|shell|offset|transform|mirror|primitive)");
            }
        }

        // ---- input helpers -------------------------------------------------

        static MeshRef Input(JobRequest job, int idx, string strOp)
        {
            if (job.inputs is null || job.inputs.Length <= idx ||
                string.IsNullOrEmpty(job.inputs[idx].path))
                throw new ArgumentException($"{strOp} op requires inputs[{idx}] with a path");
            return job.inputs[idx];
        }

        // ---- mesh-only ops -------------------------------------------------

        static void RunPrimitive(JobRequest job, float voxel)
        {
            if (job.primitive is null)
                throw new ArgumentException("primitive op requires a primitive descriptor");

            PrimitiveDto p = job.primitive;
            if (p.sizeMM is null)
                throw new ArgumentException("primitive op requires sizeMM");

            Vector3 size   = p.sizeMM.ToVector3();
            Vector3 center = p.centerMM?.ToVector3() ?? Vector3.Zero;
            if (size.X <= 0f || size.Y <= 0f || size.Z <= 0f)
                throw new ArgumentException("primitive sizeMM must be > 0 on all axes");

            Progress.Report("op", 0.4);
            string pk = (p.kind ?? "").Trim().ToLowerInvariant();
            // Curved primitives facet from the job's voxel size (p.sides is legacy /
            // ignored). Cylinder & cone STAND IN Y (the up axis of the Y-up display
            // convention): sizeMM.X/.Z are their diameters and sizeMM.Y is the
            // height, so they use the larger of the X/Z diameters. The sphere is
            // axis-symmetric and uses the largest of its three axes.
            int segRound = MeshUtil.Segments(MathF.Max(size.X, size.Z), voxel);
            int segSphere = MeshUtil.Segments(MathF.Max(size.X, MathF.Max(size.Y, size.Z)), voxel);
            Mesh msh = pk switch
            {
                "cube" or "box"          => MeshUtil.CreateBox(size, center),
                "cylinder"               => MeshUtil.CreateCylinder(size.X, size.Z, size.Y, center, segRound),
                "cone"                   => MeshUtil.CreateCone(size.X, size.Z, size.Y, center, segRound),
                "sphere" or "geosphere"  => MeshUtil.CreateSphere(size, center, segSphere),
                _ => throw new ArgumentException($"unknown primitive kind: '{p.kind}' (cube|box|cylinder|sphere|cone)"),
            };

            FinishMeshOp(job, msh);
        }

        static void RunTransformBake(JobRequest job)
        {
            MeshRef mref = Input(job, 0, "transform");
            Progress.Report("loadMesh", 0.2);
            Mesh msh = MeshUtil.LoadMesh(mref.path!, mref.transform); // bakes the TRS
            Progress.Report("op", 0.6);
            FinishMeshOp(job, msh);
        }

        static void RunMirror(JobRequest job)
        {
            MeshRef mref = Input(job, 0, "mirror");
            if (job.mirror is null || job.mirror.planeNormal is null)
                throw new ArgumentException("mirror op requires mirror.planeNormal");

            Vector3 pt = job.mirror.planePoint?.ToVector3() ?? Vector3.Zero;
            Vector3 nrm = job.mirror.planeNormal.ToVector3();
            if (nrm.Length() < 1e-6f)
                throw new ArgumentException("mirror.planeNormal must be non-zero");

            Progress.Report("loadMesh", 0.2);
            Mesh src = MeshUtil.LoadMesh(mref.path!, mref.transform);
            Progress.Report("op", 0.6);
            Mesh msh = MeshUtil.MirrorWindingFixed(src, pt, nrm);
            FinishMeshOp(job, msh);
        }

        static void FinishMeshOp(JobRequest job, Mesh msh)
        {
            MeshUtil.MeshMassProps(msh, out float vol, out float area, out Vector3 cog);
            // Mesh-only ops (primitive/transform/mirror) are watertight BY
            // CONSTRUCTION — no island removal, just a directed-edge sanity check.
            MeshClean.CheckWatertight(msh, 1e-4, out bool bWatertight, out int nOpenEdges);
            var stats = new OpStats
            {
                volumeMM3      = vol,
                triangles      = msh.nTriangleCount(),
                surfaceAreaMM2 = area,
                cogMM          = new[] { cog.X, cog.Y, cog.Z },
                watertight     = bWatertight,
                openEdges      = nOpenEdges,
            };
            Progress.Report("saving", 0.9);
            msh.SaveToStlFile(job.outputPath, Mesh.EStlUnit.MM); // FORCE MM
            Progress.Done(stats);
        }

        // ---- voxel ops -----------------------------------------------------

        static void RunBoolean(JobRequest job, float voxel)
        {
            MeshRef a = Input(job, 0, "boolean");
            MeshRef b = Input(job, 1, "boolean");
            string bk = (job.booleanKind ?? "").Trim().ToLowerInvariant();

            Progress.Report("loadMesh", 0.1);
            Mesh mshA = MeshUtil.LoadMesh(a.path!, a.transform);
            Mesh mshB = MeshUtil.LoadMesh(b.path!, b.transform);

            Progress.Report("voxelize", 0.35);
            Voxels voxA = new Voxels(mshA);
            Voxels voxB = new Voxels(mshB);

            Progress.Report("op", 0.6);
            Voxels vox = bk switch
            {
                "union"        => voxA.voxBoolAdd(voxB),
                "difference"   => voxA.voxBoolSubtract(voxB),
                "intersection" => voxA.voxBoolIntersect(voxB),
                _ => throw new ArgumentException(
                    $"unknown booleanKind: '{job.booleanKind}' (union|difference|intersection)"),
            };

            // An intersection of non-overlapping inputs, or a difference where B
            // fully consumes A, leaves NOTHING. Without this guard the empty
            // result is meshed to a 0-triangle STL and registered as a real part
            // — and BOOL consumes its inputs, so the user silently loses both.
            // Fail loudly instead (same spirit as RunOffset's collapse guard).
            vox.CalculateProperties(out float fVol, out _);
            float fVoxelVol = voxel * voxel * voxel;
            if (fVol < fVoxelVol)
                throw new Exception(
                    $"boolean {bk} produced an empty result (volume {fVol:0.####} mm³ < one " +
                    $"voxel-volume {fVoxelVol:0.######} mm³) — the inputs do not overlap, or B " +
                    $"fully consumes A.");

            FinishVoxelOp(job, vox, fVol);
        }

        static void RunMerge(JobRequest job, float voxel)
        {
            MeshRef a = Input(job, 0, "merge");
            MeshRef b = Input(job, 1, "merge");

            Progress.Report("loadMesh", 0.1);
            Mesh mshA = MeshUtil.LoadMesh(a.path!, a.transform);
            Mesh mshB = MeshUtil.LoadMesh(b.path!, b.transform);

            Progress.Report("voxelize", 0.35);
            Voxels voxA = new Voxels(mshA);
            Voxels voxB = new Voxels(mshB);

            Progress.Report("op", 0.6);
            Voxels vox = voxA.voxBoolAdd(voxB);
            if (job.filletMM > 0f)
                vox = vox.voxFillet(job.filletMM); // smooth union (fallback: voxSmoothen)

            // A union can only empty out if BOTH inputs are sub-voxel; SMOOTH also
            // consumes its inputs, so guard it the same way rather than registering
            // a 0-triangle part.
            vox.CalculateProperties(out float fVol, out _);
            float fVoxelVol = voxel * voxel * voxel;
            if (fVol < fVoxelVol)
                throw new Exception(
                    $"merge produced an empty result (volume {fVol:0.####} mm³ < one voxel-volume " +
                    $"{fVoxelVol:0.######} mm³) — both inputs are smaller than one voxel.");

            FinishVoxelOp(job, vox, fVol);
        }

        static void RunShell(JobRequest job, float voxel)
        {
            MeshRef a = Input(job, 0, "shell");
            float t = job.shellThicknessMM;
            if (t <= 0f)
                throw new ArgumentException("shell op requires shellThicknessMM > 0");

            string dir = (job.shellDirection ?? "inside").Trim().ToLowerInvariant();

            Progress.Report("loadMesh", 0.1);
            Mesh mshA = MeshUtil.LoadMesh(a.path!, a.transform);

            Progress.Report("voxelize", 0.35);
            Voxels vox = new Voxels(mshA);

            Progress.Report("op", 0.6);
            Voxels shell = dir switch
            {
                "inside"   => vox.voxBoolSubtract(vox.voxOffset(-t)),
                "outside"  => vox.voxOffset(t).voxBoolSubtract(vox),
                "centered" => vox.voxOffset(t * 0.5f).voxBoolSubtract(vox.voxOffset(-t * 0.5f)),
                _ => throw new ArgumentException(
                    $"unknown shellDirection: '{job.shellDirection}' (inside|outside|centered)"),
            };

            shell.CalculateProperties(out float fShellVol, out _);
            float fVoxelVol = voxel * voxel * voxel;
            if (fShellVol < fVoxelVol)
                throw new Exception(
                    $"shell {t:0.###} mm ({dir}) collapsed the part (result volume {fShellVol:0.####} mm³ " +
                    $"< one voxel-volume {fVoxelVol:0.######} mm³)");

            // A wall thicker than the part itself is a silent NO-OP: the inward
            // offset vanishes, so `solid − nothing` returns the WHOLE solid rather
            // than a shell. The API-side check only compares the thickness to the
            // voxel size, so this is the only place the part's real thickness is
            // known. (An OUTSIDE shell always grows past the solid, so it cannot
            // degenerate this way.)
            if (dir != "outside")
            {
                vox.CalculateProperties(out float fSolidVol, out _);
                if (fShellVol >= fSolidVol - fVoxelVol)
                    throw new Exception(
                        $"shell {t:0.###} mm ({dir}) is thicker than the part itself — the inward " +
                        $"offset vanished, so the result would be the whole solid ({fShellVol:0.##} mm³), " +
                        $"not a wall. Use a smaller shellThicknessMM.");
            }

            FinishVoxelOp(job, shell, fShellVol);
        }

        static void RunOffset(JobRequest job, float voxel)
        {
            MeshRef a = Input(job, 0, "offset");
            float d = job.offsetDistMM;

            Progress.Report("loadMesh", 0.1);
            Mesh mshA = MeshUtil.LoadMesh(a.path!, a.transform);

            Progress.Report("voxelize", 0.35);
            Voxels vox = new Voxels(mshA);

            Progress.Report("op", 0.6);
            Voxels result = vox.voxOffset(d);

            result.CalculateProperties(out float fVol, out _);
            float fVoxelVol = voxel * voxel * voxel;
            if (fVol < fVoxelVol)
                throw new Exception(
                    $"offset {d:0.###} mm collapsed the part (result volume {fVol:0.####} mm³ " +
                    $"< one voxel-volume {fVoxelVol:0.######} mm³)");

            FinishVoxelOp(job, result, fVol);
        }

        // Voxel-op finish: volume from CalculateProperties (voxel truth), triangles
        // from the meshed result, surface area + CoG from mesh mass props.
        static void FinishVoxelOp(JobRequest job, Voxels vox, float? fVolKnown = null)
        {
            float fVol;
            if (fVolKnown is float fv) fVol = fv;
            else vox.CalculateProperties(out fVol, out _);   // voxel truth (pre-cleanup)

            Progress.Report("meshing", 0.8);
            Mesh msh = new Mesh(vox);

            // ---- mesh hygiene: island removal + watertight check (cleanup ON
            //      for ops unless the caller explicitly set cleanup:false) ----
            float voxel = job.voxelSizeMM > 0f ? job.voxelSizeMM : 0.3f;
            Progress.Report("cleanup", 0.88);
            msh = MeshClean.CleanAndReport(msh, job.cleanup ?? true, voxel,
                out bool bWatertight, out int nOpenEdges, out CleanupInfo? cleanupInfo);

            // Surface area + CoG + triangle count reflect the CLEANED export mesh;
            // volume stays the voxel-truth figure (matches legacy op semantics).
            MeshUtil.MeshMassProps(msh, out _, out float area, out Vector3 cog);

            var stats = new OpStats
            {
                volumeMM3      = fVol,
                triangles      = msh.nTriangleCount(),
                surfaceAreaMM2 = area,
                cogMM          = new[] { cog.X, cog.Y, cog.Z },
                watertight     = bWatertight,
                openEdges      = nOpenEdges,
                cleanup        = cleanupInfo,
            };

            Progress.Report("saving", 0.95);
            msh.SaveToStlFile(job.outputPath, Mesh.EStlUnit.MM); // FORCE MM
            Progress.Done(stats);
        }
    }
}
