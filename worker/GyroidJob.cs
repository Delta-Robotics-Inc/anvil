//
// Anvil.Worker — GyroidJob
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

namespace Anvil.Worker
{
    // ---- Job model (JobRequest schema from the plan) ----
    class Vec3
    {
        public float x { get; set; }
        public float y { get; set; }
        public float z { get; set; }
        public Vec3() { }
        public Vec3(float x, float y, float z) { this.x = x; this.y = y; this.z = z; }
        public Vector3 ToVector3() => new(x, y, z);
    }

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

        // ---- flow metrics v1 additions (all optional; defaults preserve behavior) ----
        public string latticeType { get; set; } = "sheet";   // sheet | skeletal
        public float biasMM { get; set; } = 0f;               // skeletal bias
        public Vec3? cellSizeXYZ { get; set; }                // null -> scalar cellSizeMM
        public Vec3 rotationDeg { get; set; } = new();        // {0,0,0}
        public Vec3 phaseOffset { get; set; } = new();        // {0,0,0} cell fractions
        public string flowAxis { get; set; } = "z";           // x | y | z
        public float refFlowLpm { get; set; } = 10f;

        // ==== Wave-1 "Objects & Ops" (all optional; defaults preserve behavior) ====

        // ---- op fields (mode == "op"; dispatched to OpJob) ----
        public string? opKind { get; set; }                    // boolean|merge|shell|offset|transform|mirror|primitive
        public MeshRef[]? inputs { get; set; }                 // op inputs [{path, transform}]
        public string? booleanKind { get; set; }               // union|difference|intersection
        public float filletMM { get; set; } = 1.0f;            // merge blend radius
        public string? shellDirection { get; set; }            // inside|outside|centered
        public float shellThicknessMM { get; set; }            // shell wall thickness
        public float offsetDistMM { get; set; }                // offset (signed mm)
        public bool bake { get; set; }                         // transform-bake marker (informational)
        public MirrorDto? mirror { get; set; }                 // mirror plane
        public PrimitiveDto? primitive { get; set; }           // primitive descriptor

        // ---- zoned generate (single/fuse) ----
        public MeshRef[]? zoneLattice { get; set; }            // blue: lattice-only regions
        public MeshRef[]? zoneKeep { get; set; }               // green: stay-solid regions
        public MeshRef[]? zoneVoid { get; set; }               // red: never-enter regions
        public float skinThicknessMM { get; set; }             // inward skin off the part surface (single only)
        public float transitionMM { get; set; }                // accepted + validated >= 0 but UNUSED in v1 (hard edge)
        public float keepOutGrowMM { get; set; }               // outward growth of void zones

        // ---- base part transforms (applied at STL load, before voxelization) ----
        public TransformDto? stlTransform { get; set; }        // single / coarseOnly
        public TransformDto? positiveTransform { get; set; }   // fuse positive
        public TransformDto? negativeTransform { get; set; }   // fuse negative

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
        // ---- existing fields (unchanged) ----
        public float volumeMM3 { get; set; }
        public float envelopeVolumeMM3 { get; set; }
        public float infillPct { get; set; }
        public int triangles { get; set; }

        // ---- zoned generate (0 on the legacy no-zone path) ----
        public float latticeRegionVolumeMM3 { get; set; }

        // ---- flow metrics v1 ----
        public float airVolumeMM3 { get; set; }
        public float porosityPct { get; set; }
        public float minOpenAreaMM2 { get; set; }
        public float minAtMM { get; set; }
        public float chokeRatio { get; set; }
        public float grossAreaMM2 { get; set; }
        public float flowLengthMM { get; set; }
        public float surfaceAreaMM2 { get; set; }
        public float specificSurfaceInvMM { get; set; }
        public float hydraulicDiameterMM { get; set; }
        public float permeabilityM2 { get; set; }
        public float deltaPKPa { get; set; }
        public string? flowAxis { get; set; }
        public string[]? warnings { get; set; }
        public ProfileDto? profile { get; set; }

        public void Apply(FlowMetricsResult m)
        {
            airVolumeMM3         = m.airVolumeMM3;
            porosityPct          = m.porosityPct;
            minOpenAreaMM2       = m.minOpenAreaMM2;
            minAtMM              = m.minAtMM;
            chokeRatio           = m.chokeRatio;
            grossAreaMM2         = m.grossAreaMM2;
            flowLengthMM         = m.flowLengthMM;
            surfaceAreaMM2       = m.surfaceAreaMM2;
            specificSurfaceInvMM = m.specificSurfaceInvMM;
            hydraulicDiameterMM  = m.hydraulicDiameterMM;
            permeabilityM2       = m.permeabilityM2;
            deltaPKPa            = m.deltaPKPa;
            flowAxis             = m.flowAxis;
            warnings             = m.warnings.ToArray();
            profile              = m.profile;
        }
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

        /// <summary>Op done-line: {volumeMM3, triangles, surfaceAreaMM2, cogMM}.</summary>
        public static void Done(OpStats stats)
        {
            CurrentStage = "done";
            Console.WriteLine(JsonSerializer.Serialize(new { stage = "done", stats }));
            Console.Out.Flush();
        }

        /// <summary>Diagnostic line ignored by the server (no "stage"/"stats" key).</summary>
        public static void Note(object o)
        {
            Console.WriteLine(JsonSerializer.Serialize(o));
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
                case "op":         OpJob.Run(job); break;
                default: throw new ArgumentException($"unknown mode: '{job.mode}' (expected single|fuse|coarseOnly|op)");
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

        static TPMSWall.ELattice ParseLattice(string s) =>
            string.Equals((s ?? "").Trim(), "skeletal", StringComparison.OrdinalIgnoreCase)
                ? TPMSWall.ELattice.Skeletal
                : TPMSWall.ELattice.Sheet;

        // Per-axis cell size, falling back to scalar cellSizeMM where absent/invalid.
        static Vector3 CellVec(JobRequest job)
        {
            if (job.cellSizeXYZ is Vec3 c)
            {
                float x = c.x > 0 ? c.x : job.cellSizeMM;
                float y = c.y > 0 ? c.y : job.cellSizeMM;
                float z = c.z > 0 ? c.z : job.cellSizeMM;
                return new Vector3(x, y, z);
            }
            return new Vector3(job.cellSizeMM, job.cellSizeMM, job.cellSizeMM);
        }

        static Vector3 PhaseVec(JobRequest job)
        {
            Vec3 p = job.phaseOffset ?? new Vec3();
            return new Vector3(Math.Clamp(p.x, 0f, 1f),
                               Math.Clamp(p.y, 0f, 1f),
                               Math.Clamp(p.z, 0f, 1f));
        }

        static BBox3 PadBox(BBox3 box, Vector3 vecCell, float wallThicknessMM)
        {
            // Pad the TPMS render bbox so the periodic field fully covers the
            // envelope plus a cell/wall margin (avoids clipped boundary cells).
            float maxCell = MathF.Max(vecCell.X, MathF.Max(vecCell.Y, vecCell.Z));
            float pad = MathF.Max(2f, maxCell * 0.5f + MathF.Max(0f, wallThicknessMM));
            return new BBox3(
                box.vecMin - new Vector3(pad, pad, pad),
                box.vecMax + new Vector3(pad, pad, pad));
        }

        static void EmitAssert(FlowMetricsResult m, float envelopeVolumeMM3)
        {
            Progress.Note(new
            {
                note = "profileAssert",
                pass = m.profileAssertPass,
                profileIntegralMM3 = m.profileIntegralMM3,
                envelopeVolumeMM3,
                relErr = envelopeVolumeMM3 > 0f
                    ? MathF.Abs(m.profileIntegralMM3 - envelopeVolumeMM3) / envelopeVolumeMM3
                    : 0f,
            });
        }

        // ---- Zone helpers ----

        static bool HasAny(MeshRef[]? zones)
        {
            if (zones is null) return false;
            foreach (var z in zones)
                if (!string.IsNullOrEmpty(z.path)) return true;
            return false;
        }

        // Incremental boolean union of every referenced zone mesh (null if none).
        static Voxels? BuildZoneUnion(MeshRef[]? zones)
        {
            if (zones is null) return null;
            Voxels? acc = null;
            foreach (var z in zones)
            {
                if (string.IsNullOrEmpty(z.path)) continue;
                Voxels v = new Voxels(MeshUtil.LoadMesh(z.path!, z.transform));
                if (acc is null) acc = v;
                else acc.BoolAdd(v);
            }
            return acc;
        }

        // The offset params must never be negative (transitionMM is accepted and
        // validated but intentionally UNUSED in v1 — hard edge).
        static void ValidateZoneParams(JobRequest job)
        {
            if (job.skinThicknessMM < 0f) throw new ArgumentException("skinThicknessMM must be >= 0");
            if (job.transitionMM    < 0f) throw new ArgumentException("transitionMM must be >= 0");
            if (job.keepOutGrowMM   < 0f) throw new ArgumentException("keepOutGrowMM must be >= 0");
        }

        // ---- Workflow A: single part -> gyroidize the whole solid ----
        static void RunSingle(JobRequest job)
        {
            if (string.IsNullOrEmpty(job.stlPath))    throw new ArgumentException("single mode requires stlPath");
            if (string.IsNullOrEmpty(job.outputPath)) throw new ArgumentException("outputPath required");
            ValidateZoneParams(job);

            bool hasZones = HasAny(job.zoneLattice) || HasAny(job.zoneKeep) || HasAny(job.zoneVoid);

            // Short-circuit to the legacy code path VERBATIM when no zones AND no
            // skin -> bit-identical back-compat (a base stlTransform still applies,
            // since it only changes the loaded mesh, not the algebra).
            if (!hasZones && job.skinThicknessMM <= 0f)
                RunSingleLegacy(job);
            else
                RunSingleZoned(job);
        }

        static void RunSingleLegacy(JobRequest job)
        {
            TPMSWall.EFn eFn         = ParsePattern(job.pattern);
            TPMSWall.ELattice eLat   = ParseLattice(job.latticeType);
            Vector3 vecCell          = CellVec(job);
            Vector3 vecPhase         = PhaseVec(job);
            Stats stats = new();

            using (var lib = new PicoGK.Library(job.voxelSizeMM)) // headless, per-job voxel size
            {
                Progress.Report("loadMesh", 0.05);
                Mesh mshPart = MeshUtil.LoadMesh(job.stlPath!, job.stlTransform); // FORCE MM (null transform = legacy-identical)
                BBox3 bbox = mshPart.oBoundingBox();
                Vector3 vecCenter = bbox.vecCenter();

                Progress.Report("voxelize", 0.2);
                Voxels voxPart = new Voxels(mshPart);

                Progress.Report("renderPattern", 0.4);
                BBox3 bboxRender = PadBox(bbox, vecCell, job.wallThicknessMM);
                Voxels voxPattern = new Voxels(
                    new TPMSWall(vecCell, job.wallThicknessMM, eFn, eLat, job.biasMM,
                                 vecCenter, job.rotationDeg.ToVector3(), vecPhase),
                    bboxRender);

                Progress.Report("boolean", 0.6);
                // Metrics lattice = TPMS clipped to the part (this is also the result
                // when no smoothing is applied).
                Voxels voxLattice = voxPattern & voxPart;
                Voxels voxResult  = voxLattice;
                if (job.smoothOffsetMM > 0f)
                    voxResult = voxLattice.voxTripleOffset(job.smoothOffsetMM); // keep voxLattice pristine

                voxResult.CalculateProperties(out float fVol, out _);
                voxPart.CalculateProperties(out float fEnv, out _);
                stats.volumeMM3 = fVol;
                stats.envelopeVolumeMM3 = fEnv;
                stats.infillPct = fEnv > 0f ? 100f * fVol / fEnv : 0f;

                Progress.Report("meshing", 0.8);
                Mesh mshResult = new Mesh(voxResult);
                stats.triangles = mshResult.nTriangleCount();

                // ---- flow metrics (Feature 2) ----
                Progress.Report("metrics", 0.88);
                Voxels voxAir = voxPart.voxBoolSubtract(voxLattice);
                voxAir.CalculateProperties(out float fAir, out _);
                Mesh mshLattice = (job.smoothOffsetMM > 0f) ? new Mesh(voxLattice) : mshResult;

                var metrics = FlowMetrics.Compute(
                    voxPart, voxLattice, voxAir, mshLattice,
                    fEnv, fAir, job.voxelSizeMM,
                    job.flowAxis, job.pattern, job.latticeType, job.wallThicknessMM, job.refFlowLpm);
                stats.Apply(metrics);
                EmitAssert(metrics, fEnv);

                Progress.Report("saving", 0.95);
                mshResult.SaveToStlFile(job.outputPath, Mesh.EStlUnit.MM);
            } // first Library disposed here -> native run-once guard released

            MaybeCoarsePass(job, stats);
            Progress.Done(stats);
        }

        // ---- Workflow A + zones/skin: scope the lattice to blue zones, hold a
        //      skin off the surface, keep green solid, carve red voids LAST. ----
        static void RunSingleZoned(JobRequest job)
        {
            TPMSWall.EFn eFn         = ParsePattern(job.pattern);
            TPMSWall.ELattice eLat   = ParseLattice(job.latticeType);
            Vector3 vecCell          = CellVec(job);
            Vector3 vecPhase         = PhaseVec(job);
            Stats stats = new();
            var zoneWarnings = new List<string>();
            float fVoxelVol = job.voxelSizeMM * job.voxelSizeMM * job.voxelSizeMM;

            using (var lib = new PicoGK.Library(job.voxelSizeMM))
            {
                Progress.Report("loadMesh", 0.05);
                Mesh mshPart = MeshUtil.LoadMesh(job.stlPath!, job.stlTransform); // FORCE MM
                BBox3 bboxPart = mshPart.oBoundingBox();
                // Rotation pivot stays the FULL part bbox center (NOT the region center).
                Vector3 vecCenter = bboxPart.vecCenter();

                Progress.Report("voxelize", 0.2);
                Voxels voxBody = new Voxels(mshPart);

                // (1) incremental unions of each zone class (null if absent).
                Voxels? voxZL = BuildZoneUnion(job.zoneLattice);
                Voxels? voxZK = BuildZoneUnion(job.zoneKeep);
                Voxels? voxZV = BuildZoneUnion(job.zoneVoid);

                Progress.Report("zones", 0.32);
                // (2) latticeRegion = (voxZL ∩ body) | body.
                Voxels latticeRegion = voxZL is not null
                    ? voxZL.voxBoolIntersect(voxBody)
                    : voxBody.voxDuplicate();
                // (3) skin > 0 -> keep the lattice skin-mm off the part surface.
                if (job.skinThicknessMM > 0f)
                    latticeRegion.BoolIntersect(voxBody.voxOffset(-job.skinThicknessMM));
                // (4) latticeRegion −= keep zones; warn (not fail) if it vanishes.
                if (voxZK is not null)
                    latticeRegion.BoolSubtract(voxZK);

                latticeRegion.CalculateProperties(out float fRegionVol, out BBox3 bboxRegion);
                bool bRegionEmpty = fRegionVol <= 0f || bboxRegion.bIsEmpty();
                if (bRegionEmpty)
                    zoneWarnings.Add("lattice region is empty after skin/keep — no lattice generated");

                // (5) voxLattice = pattern ∩ latticeRegion. Pattern render bbox is
                //     the PADDED latticeRegion bbox; rotation pivot stays the full
                //     part center (set above).
                Progress.Report("renderPattern", 0.45);
                Voxels voxLattice;
                if (!bRegionEmpty)
                {
                    BBox3 bboxRender = PadBox(bboxRegion, vecCell, job.wallThicknessMM);
                    Voxels voxPattern = new Voxels(
                        new TPMSWall(vecCell, job.wallThicknessMM, eFn, eLat, job.biasMM,
                                     vecCenter, job.rotationDeg.ToVector3(), vecPhase),
                        bboxRender);
                    voxLattice = voxPattern.voxBoolIntersect(latticeRegion);
                }
                else
                {
                    voxLattice = new Voxels(); // empty
                }

                // (6) result = (body − latticeRegion) + lattice; optional smoothing.
                Progress.Report("boolean", 0.6);
                Voxels voxResult = voxBody.voxBoolSubtract(latticeRegion);
                voxResult.BoolAdd(voxLattice);
                if (job.smoothOffsetMM > 0f)
                    voxResult.TripleOffset(job.smoothOffsetMM);

                // (7) Voids LAST — void always wins: result −= voxZV.voxOffset(grow).
                Progress.Report("voids", 0.68);
                Voxels? grownZV = null;
                if (voxZV is not null)
                {
                    grownZV = voxZV.voxOffset(job.keepOutGrowMM);
                    voxResult.BoolSubtract(grownZV);
                }

                // ---- stats: envelope/infill are relative to the LATTICE REGION ----
                voxResult.CalculateProperties(out float fVol, out _);
                voxLattice.CalculateProperties(out float fLatVol, out _);
                stats.volumeMM3 = fVol;
                stats.envelopeVolumeMM3 = fRegionVol;
                stats.latticeRegionVolumeMM3 = fRegionVol;
                stats.infillPct = fRegionVol > 0f ? 100f * fLatVol / fRegionVol : 0f;

                Progress.Report("meshing", 0.8);
                Mesh mshResult = new Mesh(voxResult);
                stats.triangles = mshResult.nTriangleCount();

                // (8) Self-check: result ∩ grownZV ≈ 0 -> voidClear note.
                if (grownZV is not null)
                {
                    Voxels resid = voxResult.voxBoolIntersect(grownZV);
                    resid.CalculateProperties(out float fResid, out _);
                    bool bClear = fResid <= 10f * fVoxelVol;
                    Progress.Note(new
                    {
                        note = "voidClear",
                        pass = bClear,
                        residualMM3 = fResid,
                        voxelVolumeMM3 = fVoxelVol,
                    });
                    if (!bClear)
                        zoneWarnings.Add($"void residual {fResid:0.###} mm³ > 10 voxel-volumes — void not fully cleared");
                }

                // ---- flow metrics: envelope = latticeRegion (pre-TPMS) ----
                Progress.Report("metrics", 0.88);
                Voxels voxAir = latticeRegion.voxBoolSubtract(voxLattice);
                voxAir.CalculateProperties(out float fAir, out _);
                Mesh mshLattice = new Mesh(voxLattice);

                var metrics = FlowMetrics.Compute(
                    latticeRegion, voxLattice, voxAir, mshLattice,
                    fRegionVol, fAir, job.voxelSizeMM,
                    job.flowAxis, job.pattern, job.latticeType, job.wallThicknessMM, job.refFlowLpm);
                stats.Apply(metrics);
                // Merge our zone warnings ahead of the metric warnings.
                stats.warnings = zoneWarnings.Concat(metrics.warnings).ToArray();
                EmitAssert(metrics, fRegionVol);

                Progress.Report("saving", 0.95);
                mshResult.SaveToStlFile(job.outputPath, Mesh.EStlUnit.MM);
            }

            MaybeCoarsePass(job, stats);
            Progress.Done(stats);
        }

        // ---- Workflow B: positive + negative -> gyroidize cavity, fuse into positive ----
        static void RunFuse(JobRequest job)
        {
            if (string.IsNullOrEmpty(job.positiveStlPath)) throw new ArgumentException("fuse mode requires positiveStlPath");
            if (string.IsNullOrEmpty(job.negativeStlPath)) throw new ArgumentException("fuse mode requires negativeStlPath");
            if (string.IsNullOrEmpty(job.outputPath))      throw new ArgumentException("outputPath required");
            ValidateZoneParams(job);

            bool hasZones = HasAny(job.zoneLattice) || HasAny(job.zoneKeep) || HasAny(job.zoneVoid);

            // skinThicknessMM is ignored in fuse (server zeroes + warns). Zones are
            // the only trigger; no zones -> legacy fuse path VERBATIM.
            if (!hasZones)
                RunFuseLegacy(job);
            else
                RunFuseZoned(job);
        }

        static void RunFuseLegacy(JobRequest job)
        {
            TPMSWall.EFn eFn         = ParsePattern(job.pattern);
            TPMSWall.ELattice eLat   = ParseLattice(job.latticeType);
            Vector3 vecCell          = CellVec(job);
            Vector3 vecPhase         = PhaseVec(job);
            Stats stats = new();

            using (var lib = new PicoGK.Library(job.voxelSizeMM))
            {
                Progress.Report("loadMesh", 0.05);
                Mesh mshPos = MeshUtil.LoadMesh(job.positiveStlPath!, job.positiveTransform); // FORCE MM
                Mesh mshNeg = MeshUtil.LoadMesh(job.negativeStlPath!, job.negativeTransform); // FORCE MM
                BBox3 bboxNeg = mshNeg.oBoundingBox();
                Vector3 vecCenter = bboxNeg.vecCenter();

                Progress.Report("voxelize", 0.2);
                Voxels voxPos = new Voxels(mshPos);
                Voxels voxNeg = new Voxels(mshNeg);

                Progress.Report("renderPattern", 0.4);
                BBox3 bboxRender = PadBox(bboxNeg, vecCell, job.wallThicknessMM); // pad NEGATIVE bbox
                Voxels voxPattern = new Voxels(
                    new TPMSWall(vecCell, job.wallThicknessMM, eFn, eLat, job.biasMM,
                                 vecCenter, job.rotationDeg.ToVector3(), vecPhase),
                    bboxRender);

                Progress.Report("boolean", 0.6);
                // Output lattice grown overlapMM past the cavity boundary for a robust
                // watertight joint into the positive.
                Voxels voxLatticeOut = voxPattern & voxNeg.voxOffset(job.overlapMM);
                Voxels voxResult     = voxPos.voxBoolAdd(voxLatticeOut);

                if (job.smoothOffsetMM > 0f)
                    voxResult.TripleOffset(job.smoothOffsetMM);

                voxResult.CalculateProperties(out float fVol, out _);
                voxNeg.CalculateProperties(out float fCavity, out _);
                voxLatticeOut.CalculateProperties(out float fLatticeOut, out _);
                stats.volumeMM3 = fVol;
                stats.envelopeVolumeMM3 = fCavity;
                stats.infillPct = fCavity > 0f ? 100f * fLatticeOut / fCavity : 0f;

                Progress.Report("meshing", 0.8);
                Mesh mshResult = new Mesh(voxResult);
                stats.triangles = mshResult.nTriangleCount();

                // ---- flow metrics (Feature 2) ----
                // Metrics describe the CAVITY itself: use the lattice clipped to the
                // UN-offset negative (not the overlap-grown output lattice).
                Progress.Report("metrics", 0.88);
                Voxels voxLatticeMetrics = voxPattern & voxNeg;
                Voxels voxAir = voxNeg.voxBoolSubtract(voxLatticeMetrics);
                voxAir.CalculateProperties(out float fAir, out _);
                Mesh mshLattice = new Mesh(voxLatticeMetrics);

                var metrics = FlowMetrics.Compute(
                    voxNeg, voxLatticeMetrics, voxAir, mshLattice,
                    fCavity, fAir, job.voxelSizeMM,
                    job.flowAxis, job.pattern, job.latticeType, job.wallThicknessMM, job.refFlowLpm);
                stats.Apply(metrics);
                EmitAssert(metrics, fCavity);

                Progress.Report("saving", 0.95);
                mshResult.SaveToStlFile(job.outputPath, Mesh.EStlUnit.MM);
            }

            MaybeCoarsePass(job, stats);
            Progress.Done(stats);
        }

        // ---- Workflow B + zones: scope the cavity lattice to blue zones, re-add
        //      green keep-zones SOLID, carve red voids LAST (may carve the positive
        //      — intended). skinThicknessMM is IGNORED here. ----
        static void RunFuseZoned(JobRequest job)
        {
            TPMSWall.EFn eFn         = ParsePattern(job.pattern);
            TPMSWall.ELattice eLat   = ParseLattice(job.latticeType);
            Vector3 vecCell          = CellVec(job);
            Vector3 vecPhase         = PhaseVec(job);
            Stats stats = new();
            var zoneWarnings = new List<string>();
            float fVoxelVol = job.voxelSizeMM * job.voxelSizeMM * job.voxelSizeMM;

            if (job.skinThicknessMM > 0f)
                zoneWarnings.Add("skinThicknessMM is ignored in fuse mode");

            using (var lib = new PicoGK.Library(job.voxelSizeMM))
            {
                Progress.Report("loadMesh", 0.05);
                Mesh mshPos = MeshUtil.LoadMesh(job.positiveStlPath!, job.positiveTransform);
                Mesh mshNeg = MeshUtil.LoadMesh(job.negativeStlPath!, job.negativeTransform);
                BBox3 bboxNeg = mshNeg.oBoundingBox();
                Vector3 vecCenter = bboxNeg.vecCenter(); // pivot = full cavity center

                Progress.Report("voxelize", 0.2);
                Voxels voxPos = new Voxels(mshPos);
                Voxels voxNeg = new Voxels(mshNeg);

                Voxels? voxZL = BuildZoneUnion(job.zoneLattice);
                Voxels? voxZK = BuildZoneUnion(job.zoneKeep);
                Voxels? voxZV = BuildZoneUnion(job.zoneVoid);

                Progress.Report("zones", 0.32);
                // latticeRegion = (voxNeg ∩ voxZL | voxNeg) − voxZK.
                Voxels latticeRegion = voxZL is not null
                    ? voxNeg.voxBoolIntersect(voxZL)
                    : voxNeg.voxDuplicate();
                if (voxZK is not null)
                    latticeRegion.BoolSubtract(voxZK);

                latticeRegion.CalculateProperties(out float fRegionVol, out BBox3 bboxRegion);
                bool bRegionEmpty = fRegionVol <= 0f || bboxRegion.bIsEmpty();
                if (bRegionEmpty)
                    zoneWarnings.Add("lattice region is empty after zone/keep — no lattice generated");

                Progress.Report("renderPattern", 0.45);
                Voxels? voxPattern = null;
                Voxels voxLatticeOut; // overlap-grown, fused into the positive
                if (!bRegionEmpty)
                {
                    BBox3 bboxRender = PadBox(bboxRegion, vecCell, job.wallThicknessMM);
                    voxPattern = new Voxels(
                        new TPMSWall(vecCell, job.wallThicknessMM, eFn, eLat, job.biasMM,
                                     vecCenter, job.rotationDeg.ToVector3(), vecPhase),
                        bboxRender);
                    // lattice = pattern ∩ latticeRegion.voxOffset(overlap).
                    voxLatticeOut = voxPattern.voxBoolIntersect(latticeRegion.voxOffset(job.overlapMM));
                }
                else
                {
                    voxLatticeOut = new Voxels();
                }

                Progress.Report("boolean", 0.6);
                // result = voxPos + lattice.
                Voxels voxResult = voxPos.voxBoolAdd(voxLatticeOut);
                // Keep zones inside the cavity re-added SOLID (+ voxNeg ∩ voxZK).
                if (voxZK is not null)
                    voxResult.BoolAdd(voxNeg.voxBoolIntersect(voxZK));
                if (job.smoothOffsetMM > 0f)
                    voxResult.TripleOffset(job.smoothOffsetMM);

                // Voids LAST — may carve the positive (intended).
                Progress.Report("voids", 0.68);
                Voxels? grownZV = null;
                if (voxZV is not null)
                {
                    grownZV = voxZV.voxOffset(job.keepOutGrowMM);
                    voxResult.BoolSubtract(grownZV);
                }

                // ---- metrics lattice = pattern ∩ latticeRegion (UN-offset) ----
                Voxels voxLatticeMetrics = (!bRegionEmpty && voxPattern is not null)
                    ? voxPattern.voxBoolIntersect(latticeRegion)
                    : new Voxels();

                voxResult.CalculateProperties(out float fVol, out _);
                voxLatticeMetrics.CalculateProperties(out float fLatVol, out _);
                stats.volumeMM3 = fVol;
                stats.envelopeVolumeMM3 = fRegionVol;
                stats.latticeRegionVolumeMM3 = fRegionVol;
                stats.infillPct = fRegionVol > 0f ? 100f * fLatVol / fRegionVol : 0f;

                Progress.Report("meshing", 0.8);
                Mesh mshResult = new Mesh(voxResult);
                stats.triangles = mshResult.nTriangleCount();

                if (grownZV is not null)
                {
                    Voxels resid = voxResult.voxBoolIntersect(grownZV);
                    resid.CalculateProperties(out float fResid, out _);
                    bool bClear = fResid <= 10f * fVoxelVol;
                    Progress.Note(new
                    {
                        note = "voidClear",
                        pass = bClear,
                        residualMM3 = fResid,
                        voxelVolumeMM3 = fVoxelVol,
                    });
                    if (!bClear)
                        zoneWarnings.Add($"void residual {fResid:0.###} mm³ > 10 voxel-volumes — void not fully cleared");
                }

                Progress.Report("metrics", 0.88);
                Voxels voxAir = latticeRegion.voxBoolSubtract(voxLatticeMetrics);
                voxAir.CalculateProperties(out float fAir, out _);
                Mesh mshLattice = new Mesh(voxLatticeMetrics);

                var metrics = FlowMetrics.Compute(
                    latticeRegion, voxLatticeMetrics, voxAir, mshLattice,
                    fRegionVol, fAir, job.voxelSizeMM,
                    job.flowAxis, job.pattern, job.latticeType, job.wallThicknessMM, job.refFlowLpm);
                stats.Apply(metrics);
                stats.warnings = zoneWarnings.Concat(metrics.warnings).ToArray();
                EmitAssert(metrics, fRegionVol);

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
