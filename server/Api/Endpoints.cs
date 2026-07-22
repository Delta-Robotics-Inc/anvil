//
// Endpoints — all /api routes for the Infill App (plan's API table).
//
using InfillServer.Jobs;
using InfillServer.Sidecar;
using InfillServer.Stl;

namespace InfillServer.Api;

/// <summary>Resolved absolute paths for the running server (DI singleton).</summary>
public sealed record AppPaths(
    string RepoRoot, string DataDir, string PartsDir, string JobsDir,
    string ServerDir, string WwwRoot);

public static class Endpoints
{
    private static readonly string[] Patterns =
        { "gyroid", "schwarzp", "schwarzd", "lidinoid", "neovius" };

    // Resolution guard thresholds (plan).
    private const double MaxDimVoxelRatio = 2000.0;
    private const double VoxelCountWarn = 2e9;

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

                var part = new PartInfo
                {
                    id = id,
                    name = name,
                    sourceFormat = "step",
                    stlUrl = $"/api/parts/{id}/mesh.stl",
                    triangles = conv.Triangles,
                    bbox = BboxDto.From(conv.BboxMin, conv.BboxMax),
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

    // ---- POST /jobs --------------------------------------------------------

    private static IResult CreateJob(JobRequestDto reqBody, PartStore parts, JobManager jobs)
    {
        if (reqBody is null)
            return Results.BadRequest(new { error = "missing job request body" });

        string mode = (reqBody.mode ?? "").Trim().ToLowerInvariant();
        if (mode is not ("single" or "fuse"))
            return Results.BadRequest(new { error = $"invalid mode '{reqBody.mode}' (expected 'single' or 'fuse')" });

        string pattern = (reqBody.pattern ?? "").Trim().ToLowerInvariant();
        if (Array.IndexOf(Patterns, pattern) < 0)
            return Results.BadRequest(new { error = $"invalid pattern '{reqBody.pattern}' (expected gyroid|schwarzP|schwarzD|lidinoid|neovius)" });

        if (reqBody.voxelSizeMM <= 0 || reqBody.cellSizeMM <= 0 || reqBody.wallThicknessMM <= 0)
            return Results.BadRequest(new { error = "cellSizeMM, wallThicknessMM and voxelSizeMM must be > 0" });

        // Resolve referenced parts.
        var referenced = new List<PartInfo>();
        JobManager.WorkerInputs inputs;
        if (mode == "single")
        {
            if (string.IsNullOrEmpty(reqBody.partId))
                return Results.BadRequest(new { error = "single mode requires 'partId'" });
            if (!parts.TryGet(reqBody.partId, out var p))
                return Results.BadRequest(new { error = $"part not found: {reqBody.partId}" });
            referenced.Add(p);
            inputs = new JobManager.WorkerInputs("single", p.StlPath, null, null);
        }
        else // fuse
        {
            if (string.IsNullOrEmpty(reqBody.positiveId) || string.IsNullOrEmpty(reqBody.negativeId))
                return Results.BadRequest(new { error = "fuse mode requires 'positiveId' and 'negativeId'" });
            if (!parts.TryGet(reqBody.positiveId, out var pos))
                return Results.BadRequest(new { error = $"positive part not found: {reqBody.positiveId}" });
            if (!parts.TryGet(reqBody.negativeId, out var neg))
                return Results.BadRequest(new { error = $"negative part not found: {reqBody.negativeId}" });
            referenced.Add(pos);
            referenced.Add(neg);
            inputs = new JobManager.WorkerInputs("fuse", null, pos.StlPath, neg.StlPath);
        }

        // Resolution guard.
        double maxDim = referenced.Max(p => p.bbox.MaxDim());
        if (maxDim / reqBody.voxelSizeMM > MaxDimVoxelRatio)
            return Results.BadRequest(new
            {
                error = $"resolution too high: largest part dimension {maxDim:0.##} mm / voxel {reqBody.voxelSizeMM} mm " +
                        $"= {maxDim / reqBody.voxelSizeMM:0} voxels across (limit {MaxDimVoxelRatio:0}). " +
                        "Increase voxelSizeMM."
            });

        double voxelCount = referenced.Max(p => p.bbox.VoxelCount(reqBody.voxelSizeMM));
        string? warning = voxelCount > VoxelCountWarn
            ? $"large job: ~{voxelCount:0.##e0} effective voxels (> {VoxelCountWarn:0.##e0}); may be slow and memory-heavy"
            : null;

        string jobId = jobs.Submit(reqBody, inputs, warning);
        return Results.Accepted($"/api/jobs/{jobId}", new { jobId, warning });
    }

    private static void Cleanup(string dir)
    {
        try { if (Directory.Exists(dir)) Directory.Delete(dir, recursive: true); } catch { }
    }
}
