//
// InfillWorker — GyroidJob
//
// Implements the gyroid-cavity pipeline (Workflow A single / Workflow B fuse)
// exactly per the Infill App plan's "Gyroid core (worker)" section, plus a
// standalone "coarseOnly" fallback mode for a server-spawned second invocation.
//
// Coordinates are NEVER recentered or transformed: STLs are loaded FORCE-MM and
// saved MM, and TPMS fields are world-anchored, so export frame == import frame
// (± half a voxel). That is what makes CAD insert-in-place work.
//

using System.Numerics;
using System.Text.Json;
using PicoGK;

namespace InfillWorker
{
    // ---- Job model (JobRequest schema from the plan) ----
    class JobRequest
    {
        public string mode { get; set; } = "single";        // single | fuse | coarseOnly

        // Resolved STL FILE PATHS (server resolves part ids -> paths before spawning).
        public string? stlPath { get; set; }                 // single / coarseOnly input
        public string? positiveStlPath { get; set; }         // fuse
        public string? negativeStlPath { get; set; }         // fuse

        public string pattern { get; set; } = "gyroid";      // gyroid|schwarzP|schwarzD|lidinoid|neovius
        public float cellSizeMM { get; set; } = 8.0f;
        public float wallThicknessMM { get; set; } = 1.2f;
        public float voxelSizeMM { get; set; } = 0.2f;
        public float overlapMM { get; set; } = 0.3f;         // fuse
        public float smoothOffsetMM { get; set; } = 0f;
        public string outputPath { get; set; } = "";
        public StepExport? stepExport { get; set; }

        public static readonly JsonSerializerOptions JsonOptions = new()
        {
            PropertyNameCaseInsensitive = true,
            ReadCommentHandling = JsonCommentHandling.Skip,
            AllowTrailingCommas = true,
        };
    }

    class StepExport
    {
        public bool enabled { get; set; }
        public int targetTriangles { get; set; } = 60000;
        public string? coarseStlPath { get; set; }
    }

    class Stats
    {
        public float volumeMM3 { get; set; }
        public float envelopeVolumeMM3 { get; set; }
        public float infillPct { get; set; }
        public int triangles { get; set; }
    }

    // ---- Progress protocol: one JSON line per stage on stdout, auto-flushed ----
    static class Progress
    {
        public static string CurrentStage = "init";

        public static void Report(string stage, double progress)
        {
            CurrentStage = stage;
            Console.WriteLine(JsonSerializer.Serialize(new { stage, progress }));
            Console.Out.Flush();
        }

        public static void Done(Stats stats)
        {
            CurrentStage = "done";
            Console.WriteLine(JsonSerializer.Serialize(new { stage = "done", stats }));
            Console.Out.Flush();
        }
    }

    static class GyroidJob
    {
        public static void Run(JobRequest job)
        {
            switch ((job.mode ?? "").Trim().ToLowerInvariant())
            {
                case "single":     RunSingle(job); break;
                case "fuse":       RunFuse(job); break;
                case "coarseonly": RunCoarseOnly(job); break;
                default: throw new ArgumentException($"unknown mode: '{job.mode}' (expected single|fuse|coarseOnly)");
            }
        }

        static TPMSWall.EFn ParsePattern(string p) => (p ?? "").Trim().ToLowerInvariant() switch
        {
            "gyroid"   => TPMSWall.EFn.Gyroid,
            "schwarzp" => TPMSWall.EFn.SchwarzP,
            "schwarzd" => TPMSWall.EFn.SchwarzD,
            "lidinoid" => TPMSWall.EFn.Lidinoid,
            "neovius"  => TPMSWall.EFn.Neovius,
            _ => throw new ArgumentException($"unknown pattern: '{p}'"),
        };

        static BBox3 PadBox(BBox3 box, float cellSizeMM, float wallThicknessMM)
        {
            // Pad the TPMS render bbox so the periodic field fully covers the
            // envelope plus a cell/wall margin (avoids clipped boundary cells).
            float pad = MathF.Max(2f, cellSizeMM * 0.5f + wallThicknessMM);
            return new BBox3(
                box.vecMin - new Vector3(pad, pad, pad),
                box.vecMax + new Vector3(pad, pad, pad));
        }

        // ---- Workflow A: single part -> gyroidize the whole solid ----
        static void RunSingle(JobRequest job)
        {
            if (string.IsNullOrEmpty(job.stlPath))    throw new ArgumentException("single mode requires stlPath");
            if (string.IsNullOrEmpty(job.outputPath)) throw new ArgumentException("outputPath required");

            TPMSWall.EFn eFn = ParsePattern(job.pattern);
            Stats stats = new();

            using (var lib = new PicoGK.Library(job.voxelSizeMM)) // headless, per-job voxel size
            {
                Progress.Report("loadMesh", 0.05);
                Mesh mshPart = Mesh.mshFromStlFile(job.stlPath, Mesh.EStlUnit.MM, 1f); // FORCE MM, never AUTO
                BBox3 bbox = mshPart.oBoundingBox();

                Progress.Report("voxelize", 0.2);
                Voxels voxPart = new Voxels(mshPart);

                Progress.Report("renderPattern", 0.4);
                BBox3 bboxRender = PadBox(bbox, job.cellSizeMM, job.wallThicknessMM);
                Voxels voxPattern = new Voxels(
                    new TPMSWall(job.cellSizeMM, job.wallThicknessMM, eFn), bboxRender);

                Progress.Report("boolean", 0.6);
                Voxels voxResult = voxPattern & voxPart; // intersect lattice with the solid

                if (job.smoothOffsetMM > 0f)
                    voxResult.TripleOffset(job.smoothOffsetMM);

                voxResult.CalculateProperties(out float fVol, out _);
                voxPart.CalculateProperties(out float fEnv, out _);
                stats.volumeMM3 = fVol;
                stats.envelopeVolumeMM3 = fEnv;
                stats.infillPct = fEnv > 0f ? 100f * fVol / fEnv : 0f;

                Progress.Report("meshing", 0.8);
                Mesh mshResult = new Mesh(voxResult);
                stats.triangles = mshResult.nTriangleCount();

                Progress.Report("saving", 0.95);
                mshResult.SaveToStlFile(job.outputPath, Mesh.EStlUnit.MM);
            } // first Library disposed here -> native run-once guard released

            MaybeCoarsePass(job, stats);
            Progress.Done(stats);
        }

        // ---- Workflow B: positive + negative -> gyroidize cavity, fuse into positive ----
        static void RunFuse(JobRequest job)
        {
            if (string.IsNullOrEmpty(job.positiveStlPath)) throw new ArgumentException("fuse mode requires positiveStlPath");
            if (string.IsNullOrEmpty(job.negativeStlPath)) throw new ArgumentException("fuse mode requires negativeStlPath");
            if (string.IsNullOrEmpty(job.outputPath))      throw new ArgumentException("outputPath required");

            TPMSWall.EFn eFn = ParsePattern(job.pattern);
            Stats stats = new();

            using (var lib = new PicoGK.Library(job.voxelSizeMM))
            {
                Progress.Report("loadMesh", 0.05);
                Mesh mshPos = Mesh.mshFromStlFile(job.positiveStlPath, Mesh.EStlUnit.MM, 1f); // FORCE MM
                Mesh mshNeg = Mesh.mshFromStlFile(job.negativeStlPath, Mesh.EStlUnit.MM, 1f); // FORCE MM
                BBox3 bboxNeg = mshNeg.oBoundingBox();

                Progress.Report("voxelize", 0.2);
                Voxels voxPos = new Voxels(mshPos);
                Voxels voxNeg = new Voxels(mshNeg);

                Progress.Report("renderPattern", 0.4);
                BBox3 bboxRender = PadBox(bboxNeg, job.cellSizeMM, job.wallThicknessMM); // pad NEGATIVE bbox
                Voxels voxPattern = new Voxels(
                    new TPMSWall(job.cellSizeMM, job.wallThicknessMM, eFn), bboxRender);

                Progress.Report("boolean", 0.6);
                // Lattice = pattern clipped to the cavity, grown overlapMM past the
                // cavity boundary into the positive for a robust watertight joint.
                Voxels voxLattice = voxPattern & voxNeg.voxOffset(job.overlapMM);
                Voxels voxResult  = voxPos.voxBoolAdd(voxLattice);

                if (job.smoothOffsetMM > 0f)
                    voxResult.TripleOffset(job.smoothOffsetMM);

                voxResult.CalculateProperties(out float fVol, out _);
                voxNeg.CalculateProperties(out float fCavity, out _);
                voxLattice.CalculateProperties(out float fLattice, out _);
                stats.volumeMM3 = fVol;
                stats.envelopeVolumeMM3 = fCavity;
                stats.infillPct = fCavity > 0f ? 100f * fLattice / fCavity : 0f;

                Progress.Report("meshing", 0.8);
                Mesh mshResult = new Mesh(voxResult);
                stats.triangles = mshResult.nTriangleCount();

                Progress.Report("saving", 0.95);
                mshResult.SaveToStlFile(job.outputPath, Mesh.EStlUnit.MM);
            }

            MaybeCoarsePass(job, stats);
            Progress.Done(stats);
        }

        // ---- STEP coarse pass (in-process dispose -> re-init at coarser voxel) ----
        static void MaybeCoarsePass(JobRequest job, Stats stats)
        {
            if (job.stepExport is null || !job.stepExport.enabled) return;
            if (stats.triangles <= job.stepExport.targetTriangles) return;
            if (string.IsNullOrEmpty(job.stepExport.coarseStlPath))
                throw new ArgumentException("stepExport.enabled but coarseStlPath missing");

            Progress.Report("coarseRemesh", 0.9);

            float ratio = (float)stats.triangles / job.stepExport.targetTriangles;
            float coarseVoxel = job.voxelSizeMM * MathF.Sqrt(ratio);

            // Dispose of the first Library happened at end of the workflow's using
            // block, so the native run-once guard is released and we can re-init.
            using var lib = new PicoGK.Library(coarseVoxel);
            Mesh mshFine = Mesh.mshFromStlFile(job.outputPath, Mesh.EStlUnit.MM, 1f);
            Voxels vox = new Voxels(mshFine);
            new Mesh(vox).SaveToStlFile(job.stepExport.coarseStlPath, Mesh.EStlUnit.MM);
        }

        // ---- Fallback: standalone coarse remesh as a separate worker invocation ----
        // The server passes the already-computed coarse voxel size as voxelSizeMM,
        // stlPath = the fine result STL, outputPath = the coarse STL to write.
        static void RunCoarseOnly(JobRequest job)
        {
            if (string.IsNullOrEmpty(job.stlPath))    throw new ArgumentException("coarseOnly mode requires stlPath (the fine result STL)");
            if (string.IsNullOrEmpty(job.outputPath)) throw new ArgumentException("outputPath required");

            Stats stats = new();
            using (var lib = new PicoGK.Library(job.voxelSizeMM))
            {
                Progress.Report("loadMesh", 0.2);
                Mesh mshFine = Mesh.mshFromStlFile(job.stlPath, Mesh.EStlUnit.MM, 1f);

                Progress.Report("voxelize", 0.5);
                Voxels vox = new Voxels(mshFine);
                vox.CalculateProperties(out float fVol, out _);
                stats.volumeMM3 = fVol;
                stats.envelopeVolumeMM3 = fVol;
                stats.infillPct = 100f;

                Progress.Report("meshing", 0.8);
                Mesh mshCoarse = new Mesh(vox);
                stats.triangles = mshCoarse.nTriangleCount();

                Progress.Report("saving", 0.95);
                mshCoarse.SaveToStlFile(job.outputPath, Mesh.EStlUnit.MM);
            }
            Progress.Done(stats);
        }
    }
}
