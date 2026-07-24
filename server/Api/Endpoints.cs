//
// Endpoints — all /api routes for the Infill App (plan's API table).
//
using Anvil.Server.Jobs;
using Anvil.Server.Sidecar;
using Anvil.Server.Stl;

namespace Anvil.Server.Api;

/// <summary>Resolved absolute paths for the running server (DI singleton).</summary>
public sealed record AppPaths(
    string RepoRoot, string DataDir, string PartsDir, string JobsDir,
    string ServerDir, string WwwRoot);

public static class Endpoints
{
    private static readonly string[] Patterns =
        { "gyroid", "schwarzp", "schwarzd", "lidinoid", "neovius" };
    private static readonly string[] LatticeTypes = { "sheet", "skeletal" };
    private static readonly string[] FlowAxes = { "x", "y", "z" };

    // Resolution guard thresholds (plan). internal so OpsEndpoints reuses them.
    internal const double MaxDimVoxelRatio = 2000.0;
    internal const double VoxelCountWarn = 2e9;

    /// <summary>
    /// Shared resolution-guard error: rejects a voxel size that would put more
    /// than MaxDimVoxelRatio voxels across the largest dimension. Returns null
    /// when the resolution is acceptable.
    /// </summary>
    internal static string? ResolutionError(double maxDim, double voxel)
    {
        if (voxel <= 0) return "voxelSizeMM must be > 0";
        double across = maxDim / voxel;
        if (across > MaxDimVoxelRatio)
            return $"resolution too high: largest dimension {maxDim:0.##} mm / voxel {voxel} mm " +
                   $"= {across:0} voxels across (limit {MaxDimVoxelRatio:0}). Increase voxelSizeMM.";
        return null;
    }

    /// <summary>Shared large-job warning (null when under the voxel-count threshold).</summary>
    internal static string? ResolutionWarning(double voxelCount)
        => voxelCount > VoxelCountWarn
            ? $"large job: ~{voxelCount:0.##e0} effective voxels (> {VoxelCountWarn:0.##e0}); may be slow and memory-heavy"
            : null;

    public static void MapInfillApi(this WebApplication app)
    {
        var api = app.MapGroup("/api");

        // ---- Parts ---------------------------------------------------------

        api.MapPost("/parts", UploadPart)
           .DisableAntiforgery();

        api.MapGet("/parts/{id}/mesh.stl", (string id, PartStore parts) =>
        {
            if (!parts.TryGet(id, out var p) || !File.Exists(p.StlPath))
                return Results.NotFound(new { error = $"part not found: {id}" });
            return Results.File(p.StlPath, "application/octet-stream", "mesh.stl");
        });

        api.MapDelete("/parts/{id}", (string id, PartStore parts) =>
        {
            if (!parts.Remove(id, out var p))
                return Results.NotFound(new { error = $"part not found: {id}" });
            try { if (p != null && Directory.Exists(p.Dir)) Directory.Delete(p.Dir, recursive: true); }
            catch { /* best effort */ }
            return Results.NoContent();
        });

        // ---- Jobs ----------------------------------------------------------

        api.MapPost("/jobs", CreateJob);

        api.MapGet("/jobs/{id}", (string id, JobManager jobs) =>
        {
            var st = jobs.Status(id);
            return st is null ? Results.NotFound(new { error = $"job not found: {id}" }) : Results.Ok(st);
        });

        api.MapPost("/jobs/{id}/cancel", (string id, JobManager jobs) =>
        {
            if (!jobs.Cancel(id)) return Results.NotFound(new { error = $"job not found: {id}" });
            return Results.Ok(jobs.Status(id));
        });

        api.MapGet("/jobs/{id}/preview.stl", (string id, JobManager jobs, HttpRequest req) =>
        {
            var rec = jobs.Get(id);
            if (rec is null) return Results.NotFound(new { error = $"job not found: {id}" });
            if (!File.Exists(rec.ResultStlPath))
                return Results.Problem(
                    detail: $"result STL not available (job state: {rec.Snapshot().state})",
                    statusCode: StatusCodes.Status409Conflict);
            bool download = req.Query.ContainsKey("download") && req.Query["download"] != "0";
            return Results.File(rec.ResultStlPath, "application/octet-stream",
                fileDownloadName: download ? $"{id}_infill.stl" : null);
        });

        api.MapPost("/jobs/{id}/step", async (string id, JobManager jobs, HttpRequest req) =>
        {
            var rec = jobs.Get(id);
            if (rec is null) return Results.NotFound(new { error = $"job not found: {id}" });

            int? target = null;
            if (req.ContentLength is > 0)
            {
                try
                {
                    var body = await req.ReadFromJsonAsync<StepRequestDto>();
                    target = body?.targetTriangles;
                }
                catch { /* empty/invalid body → no override */ }
            }

            if (!jobs.StartStepExport(id, target))
                return Results.Problem(
                    detail: $"job not finished (state: {rec.Snapshot().state}); STEP export requires a completed job",
                    statusCode: StatusCodes.Status409Conflict);

            return Results.Accepted($"/api/jobs/{id}", jobs.Status(id));
        });

        api.MapGet("/jobs/{id}/result.step", (string id, JobManager jobs, HttpRequest req) =>
        {
            var rec = jobs.Get(id);
            if (rec is null) return Results.NotFound(new { error = $"job not found: {id}" });
            if (!File.Exists(rec.ResultStepPath))
                return Results.Problem(
                    detail: $"result STEP not available (step state: {rec.Snapshot().step.state}); POST /jobs/{id}/step first",
                    statusCode: StatusCodes.Status409Conflict);
            bool download = req.Query.ContainsKey("download") && req.Query["download"] != "0";
            return Results.File(rec.ResultStepPath, "application/step",
                fileDownloadName: download ? $"{id}_infill.step" : $"{id}.step");
        });
    }

    // ---- POST /parts -------------------------------------------------------

    private static async Task<IResult> UploadPart(
        HttpRequest req, PartStore parts, PythonSidecar sidecar, AppPaths paths, ILoggerFactory lf)
    {
        var log = lf.CreateLogger("Parts");
        if (!req.HasFormContentType)
            return Results.BadRequest(new { error = "expected multipart/form-data with a 'file' field" });

        var form = await req.ReadFormAsync();
        var file = form.Files["file"] ?? (form.Files.Count > 0 ? form.Files[0] : null);
        if (file is null || file.Length == 0)
            return Results.BadRequest(new { error = "no file uploaded (multipart field 'file')" });

        string name = Path.GetFileName(file.FileName);
        string ext = Path.GetExtension(name).ToLowerInvariant();
        if (ext is not (".stl" or ".step" or ".stp"))
            return Results.BadRequest(new { error = $"unsupported file type '{ext}'; expected .stl, .step, or .stp" });

        string id = "p_" + Token.New();
        string dir = Path.Combine(paths.PartsDir, id);
        Directory.CreateDirectory(dir);
        string meshStl = Path.Combine(dir, "mesh.stl");

        try
        {
            if (ext == ".stl")
            {
                await using (var fs = File.Create(meshStl))
                    await file.CopyToAsync(fs);

                var kind = StlInfo.Detect(meshStl);
                if (kind == StlKind.Ascii)
                {
                    Cleanup(dir);
                    return Results.BadRequest(new
                    {
                        error = "ASCII STL is not supported. PicoGK reads binary STL only — " +
                                "re-export as BINARY STL (or upload STEP) and try again."
                    });
                }
                if (kind == StlKind.Invalid)
                {
                    Cleanup(dir);
                    return Results.BadRequest(new { error = "file is not a valid binary STL" });
                }

                var info = StlInfo.ReadBinary(meshStl);
                var part = new PartInfo
                {
                    id = id,
                    name = name,
                    sourceFormat = "stl",
                    stlUrl = $"/api/parts/{id}/mesh.stl",
                    triangles = info.Triangles,
                    bbox = BboxDto.From(info.Bbox),
                    volumeMM3 = info.VolumeMM3,
                    surfaceAreaMM2 = info.SurfaceAreaMM2,
                    cogMM = info.CogMM,
                    StlPath = meshStl,
                    Dir = dir,
                };
                parts.Add(part);
                log.LogInformation("uploaded STL part {Id} '{Name}' ({Tris} tris)", id, name, info.Triangles);
                return Results.Ok(part);
            }
            else // .step / .stp
            {
                string srcStep = Path.Combine(dir, "source" + ext);
                await using (var fs = File.Create(srcStep))
                    await file.CopyToAsync(fs);

                Step2StlResult conv;
                try
                {
                    conv = await sidecar.Step2StlAsync(srcStep, meshStl);
                }
                catch (SidecarException se)
                {
                    Cleanup(dir);
                    return Results.BadRequest(new { error = $"STEP conversion failed: {se.Message}", detail = se.Detail });
                }

                // Mass props from the converted binary mesh.stl (same single pass as
                // uploads/derived). Fall back to the sidecar's tris/bbox if the reader
                // trips on the produced STL.
                int tris = conv.Triangles;
                var bbox = BboxDto.From(conv.BboxMin, conv.BboxMax);
                double vol = 0, area = 0; double[] cog = new double[3];
                try
                {
                    var info = StlInfo.ReadBinary(meshStl);
                    tris = info.Triangles;
                    bbox = BboxDto.From(info.Bbox);
                    vol = info.VolumeMM3; area = info.SurfaceAreaMM2; cog = info.CogMM;
                }
                catch (Exception ex) { log.LogWarning(ex, "mass-props read failed for STEP part {Id}; using sidecar bbox", id); }

                var part = new PartInfo
                {
                    id = id,
                    name = name,
                    sourceFormat = "step",
                    stlUrl = $"/api/parts/{id}/mesh.stl",
                    triangles = tris,
                    bbox = bbox,
                    volumeMM3 = vol,
                    surfaceAreaMM2 = area,
                    cogMM = cog,
                    StlPath = meshStl,
                    Dir = dir,
                };
                parts.Add(part);
                log.LogInformation("uploaded STEP part {Id} '{Name}' ({Tris} tris)", id, name, conv.Triangles);
                return Results.Ok(part);
            }
        }
        catch (Exception ex)
        {
            Cleanup(dir);
            log.LogError(ex, "part upload failed");
            return Results.Problem(detail: ex.Message, statusCode: 500);
        }
    }

    /// <summary>
    /// Register a part from an EXISTING local file (the MCP add_part_from_file
    /// tool). Same pipeline as the upload endpoint — binary-STL only for .stl,
    /// STEP-via-sidecar for .step/.stp — but the source is a path already on
    /// disk (copied into the new part dir). Returns (part, null) on success or
    /// (null, error) on any validation/conversion failure.
    /// </summary>
    public static async Task<(PartInfo? part, string? error)> RegisterPartFromLocalFile(
        string srcPath, PartStore parts, PythonSidecar sidecar, AppPaths paths, ILogger log)
    {
        if (string.IsNullOrWhiteSpace(srcPath))
            return (null, "absolutePath is required");
        if (!Path.IsPathRooted(srcPath))
            return (null, $"path must be absolute: {srcPath}");
        if (!File.Exists(srcPath))
            return (null, $"file not found: {srcPath}");

        string name = Path.GetFileName(srcPath);
        string ext = Path.GetExtension(name).ToLowerInvariant();
        if (ext is not (".stl" or ".step" or ".stp"))
            return (null, $"unsupported file type '{ext}'; expected .stl, .step, or .stp");

        string id = "p_" + Token.New();
        string dir = Path.Combine(paths.PartsDir, id);
        Directory.CreateDirectory(dir);
        string meshStl = Path.Combine(dir, "mesh.stl");

        try
        {
            if (ext == ".stl")
            {
                File.Copy(srcPath, meshStl, overwrite: true);
                var kind = StlInfo.Detect(meshStl);
                if (kind == StlKind.Ascii)
                {
                    Cleanup(dir);
                    return (null, "ASCII STL is not supported. PicoGK reads binary STL only — re-export as BINARY STL (or use STEP).");
                }
                if (kind == StlKind.Invalid)
                {
                    Cleanup(dir);
                    return (null, "file is not a valid binary STL");
                }
                var info = StlInfo.ReadBinary(meshStl);
                var part = new PartInfo
                {
                    id = id, name = name, sourceFormat = "stl",
                    stlUrl = $"/api/parts/{id}/mesh.stl",
                    triangles = info.Triangles, bbox = BboxDto.From(info.Bbox),
                    volumeMM3 = info.VolumeMM3, surfaceAreaMM2 = info.SurfaceAreaMM2, cogMM = info.CogMM,
                    StlPath = meshStl, Dir = dir,
                };
                parts.Add(part);
                log.LogInformation("add_part_from_file STL {Id} '{Name}' ({Tris} tris)", id, name, info.Triangles);
                return (part, null);
            }
            else // .step / .stp
            {
                string srcStep = Path.Combine(dir, "source" + ext);
                File.Copy(srcPath, srcStep, overwrite: true);
                Step2StlResult conv;
                try { conv = await sidecar.Step2StlAsync(srcStep, meshStl); }
                catch (SidecarException se)
                {
                    Cleanup(dir);
                    return (null, $"STEP conversion failed: {se.Message}");
                }
                int tris = conv.Triangles;
                var bbox = BboxDto.From(conv.BboxMin, conv.BboxMax);
                double vol = 0, area = 0; double[] cog = new double[3];
                try
                {
                    var info = StlInfo.ReadBinary(meshStl);
                    tris = info.Triangles; bbox = BboxDto.From(info.Bbox);
                    vol = info.VolumeMM3; area = info.SurfaceAreaMM2; cog = info.CogMM;
                }
                catch (Exception ex) { log.LogWarning(ex, "mass-props read failed for STEP part {Id}", id); }

                var part = new PartInfo
                {
                    id = id, name = name, sourceFormat = "step",
                    stlUrl = $"/api/parts/{id}/mesh.stl",
                    triangles = tris, bbox = bbox,
                    volumeMM3 = vol, surfaceAreaMM2 = area, cogMM = cog,
                    StlPath = meshStl, Dir = dir,
                };
                parts.Add(part);
                log.LogInformation("add_part_from_file STEP {Id} '{Name}' ({Tris} tris)", id, name, conv.Triangles);
                return (part, null);
            }
        }
        catch (Exception ex)
        {
            Cleanup(dir);
            log.LogError(ex, "add_part_from_file failed");
            return (null, ex.Message);
        }
    }

    // ---- POST /jobs --------------------------------------------------------

    /// <summary>Outcome of SubmitGenerateCore (all failures are 400).</summary>
    public sealed record GenCoreResult(bool Ok, string? Error, string? JobId, string? Warning);

    private static GenCoreResult GenErr(string msg) => new(false, msg, null, null);
    private static GenCoreResult GenOk(string jobId, string? warning) => new(true, null, jobId, warning);

    private static IResult CreateJob(JobRequestDto reqBody, PartStore parts, JobManager jobs)
    {
        var r = SubmitGenerateCore(reqBody, parts, jobs);
        if (!r.Ok) return Results.BadRequest(new { error = r.Error });
        return Results.Accepted($"/api/jobs/{r.JobId}", new { jobId = r.JobId, warning = r.Warning });
    }

    /// <summary>
    /// Validate + submit a generate (single/fuse, optionally zoned) job. Shared by
    /// the HTTP endpoint and the MCP generate_infill tool.
    /// </summary>
    public static GenCoreResult SubmitGenerateCore(JobRequestDto reqBody, PartStore parts, JobManager jobs)
    {
        if (reqBody is null)
            return GenErr("missing job request body");

        string mode = (reqBody.mode ?? "").Trim().ToLowerInvariant();
        if (mode is not ("single" or "fuse"))
            return GenErr($"invalid mode '{reqBody.mode}' (expected 'single' or 'fuse')");

        string pattern = (reqBody.pattern ?? "").Trim().ToLowerInvariant();
        if (Array.IndexOf(Patterns, pattern) < 0)
            return GenErr($"invalid pattern '{reqBody.pattern}' (expected gyroid|schwarzP|schwarzD|lidinoid|neovius)");

        if (reqBody.voxelSizeMM <= 0 || reqBody.cellSizeMM <= 0 || reqBody.wallThicknessMM <= 0)
            return GenErr("cellSizeMM, wallThicknessMM and voxelSizeMM must be > 0");

        // ---- flow metrics v1 validation ------------------------------------
        string latticeType = (reqBody.latticeType ?? "sheet").Trim().ToLowerInvariant();
        if (Array.IndexOf(LatticeTypes, latticeType) < 0)
            return GenErr($"invalid latticeType '{reqBody.latticeType}' (expected 'sheet' or 'skeletal')");
        reqBody.latticeType = latticeType;

        string flowAxis = (reqBody.flowAxis ?? "z").Trim().ToLowerInvariant();
        if (Array.IndexOf(FlowAxes, flowAxis) < 0)
            return GenErr($"invalid flowAxis '{reqBody.flowAxis}' (expected 'x', 'y' or 'z')");
        reqBody.flowAxis = flowAxis;

        if (reqBody.cellSizeXYZ is Vec3Dto cxyz &&
            (cxyz.x <= 0 || cxyz.y <= 0 || cxyz.z <= 0))
            return GenErr("cellSizeXYZ components must each be > 0");

        if (reqBody.refFlowLpm < 1 || reqBody.refFlowLpm > 1000)
            return GenErr("refFlowLpm must be between 1 and 1000 L/min");

        // Clamp phase offset to cell fractions [0,1] (never reject — just normalize).
        if (reqBody.phaseOffset is Vec3Dto ph)
        {
            ph.x = Math.Clamp(ph.x, 0, 1);
            ph.y = Math.Clamp(ph.y, 0, 1);
            ph.z = Math.Clamp(ph.z, 0, 1);
        }

        // Resolve referenced parts.
        var referenced = new List<PartInfo>();
        JobManager.WorkerInputs inputs;
        if (mode == "single")
        {
            if (string.IsNullOrEmpty(reqBody.partId))
                return GenErr("single mode requires 'partId'");
            if (!parts.TryGet(reqBody.partId, out var p))
                return GenErr($"part not found: {reqBody.partId}");
            referenced.Add(p);
            inputs = new JobManager.WorkerInputs("single", p.StlPath, null, null);
        }
        else // fuse
        {
            if (string.IsNullOrEmpty(reqBody.positiveId) || string.IsNullOrEmpty(reqBody.negativeId))
                return GenErr("fuse mode requires 'positiveId' and 'negativeId'");
            if (!parts.TryGet(reqBody.positiveId, out var pos))
                return GenErr($"positive part not found: {reqBody.positiveId}");
            if (!parts.TryGet(reqBody.negativeId, out var neg))
                return GenErr($"negative part not found: {reqBody.negativeId}");
            referenced.Add(pos);
            referenced.Add(neg);
            inputs = new JobManager.WorkerInputs("fuse", null, pos.StlPath, neg.StlPath);
        }

        // ---- Wave-1 zones: validate + resolve (ids exist, zone != base, offsets
        //      >= 0, fuse+skin -> zero+warn) and fold each zone part's TRS in. ----
        var zoneParts = new List<PartInfo>();
        JobManager.ZonePayload? zonePayload = null;
        var warnings = new List<string>();

        if (reqBody.zones is ZonesDto z)
        {
            if (z.skinThicknessMM < 0 || z.transitionMM < 0 || z.keepOutGrowMM < 0)
                return GenErr("zone offsets must be >= 0 (skinThicknessMM, transitionMM, keepOutGrowMM)");

            double skin = z.skinThicknessMM, transition = z.transitionMM, keepOut = z.keepOutGrowMM;

            var baseIds = new HashSet<string>(StringComparer.Ordinal);
            if (mode == "single") baseIds.Add(reqBody.partId!);
            else { baseIds.Add(reqBody.positiveId!); baseIds.Add(reqBody.negativeId!); }

            var lattice = new List<JobManager.MeshRefPayload>();
            var keep = new List<JobManager.MeshRefPayload>();
            var voids = new List<JobManager.MeshRefPayload>();

            (List<string>? ids, List<JobManager.MeshRefPayload> bucket, string cls)[] classes =
            {
                (z.latticeIds, lattice, "lattice"),
                (z.keepIds,    keep,    "keep"),
                (z.voidIds,    voids,   "void"),
            };
            foreach (var (ids, bucket, cls) in classes)
            {
                if (ids is null) continue;
                foreach (var zid in ids)
                {
                    if (string.IsNullOrWhiteSpace(zid)) continue;
                    if (baseIds.Contains(zid))
                        return GenErr($"zone id '{zid}' ({cls}) cannot also be a base part id");
                    if (!parts.TryGet(zid, out var zp))
                        return GenErr($"zone part not found: {zid} ({cls})");
                    zoneParts.Add(zp);
                    bucket.Add(new JobManager.MeshRefPayload(zp.StlPath, GetTransform(reqBody.transforms, zid)));
                }
            }

            // skinThicknessMM is meaningless in fuse mode: zero it + warn.
            if (mode == "fuse" && skin > 0)
            {
                warnings.Add("skinThicknessMM is ignored in fuse mode (zeroed)");
                skin = 0;
            }

            zonePayload = new JobManager.ZonePayload(lattice, keep, voids, skin, transition, keepOut);
        }

        // Base-part transforms (from the transforms map keyed by part id).
        JobManager.BaseTransforms baseTransforms = mode == "single"
            ? new JobManager.BaseTransforms(GetTransform(reqBody.transforms, reqBody.partId!), null, null)
            : new JobManager.BaseTransforms(null,
                GetTransform(reqBody.transforms, reqBody.positiveId!),
                GetTransform(reqBody.transforms, reqBody.negativeId!));

        // Resolution guard — base parts AND zone parts join the guard (raw bboxes).
        var guardParts = referenced.Concat(zoneParts).ToList();
        double maxDim = guardParts.Max(p => p.bbox.MaxDim());
        if (ResolutionError(maxDim, reqBody.voxelSizeMM) is { } resErr)
            return GenErr(resErr);

        double voxelCount = guardParts.Max(p => p.bbox.VoxelCount(reqBody.voxelSizeMM));
        if (ResolutionWarning(voxelCount) is { } resWarn) warnings.Add(resWarn);
        string? warning = warnings.Count > 0 ? string.Join("; ", warnings) : null;

        string jobId = jobs.Submit(reqBody, inputs, warning, zonePayload, baseTransforms);
        return GenOk(jobId, warning);
    }

    /// <summary>Look up a part's TRS from the request transforms map (null if absent).</summary>
    private static TransformDto? GetTransform(Dictionary<string, TransformDto>? map, string id)
        => map != null && map.TryGetValue(id, out var t) ? t : null;

    private static void Cleanup(string dir)
    {
        try { if (Directory.Exists(dir)) Directory.Delete(dir, recursive: true); } catch { }
    }
}
