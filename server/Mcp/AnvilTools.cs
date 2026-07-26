//
// AnvilTools — the MCP tool surface (Stage 5).
//
// An [McpServerToolType] whose tools drive the SAME pipeline as the HTTP API:
// they build the exact DTOs the endpoints use and call the shared cores
// (OpsEndpoints.SubmitOpCore, Endpoints.SubmitGenerateCore/RegisterPartFromLocalFile,
// ScriptsEndpoints.SubmitRun) plus JobManager / PartStore / ScriptLibrary
// directly. Job-spawning tools POLL the job to completion (250 ms, ~10 min cap)
// and return the terminal status as a JSON string, so an agent sees synchronous
// semantics. Structured worker errors — including a script's scriptError[]
// diagnostics — pass straight through in the returned JSON.
//
// This class (and the whole server) references NEITHER PicoGK NOR the worker:
// every geometry op still runs in a spawned AnvilWorker.exe.
//
// SECURITY: these tools run arbitrary geometry ops AND arbitrary C# (run_script)
// with the user's privileges, in loopback-only processes, with no sandbox. See
// the README SECURITY section. Connecting an agent means the agent can run code
// on this machine.
//
using System.ComponentModel;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using Anvil.Server.Api;
using Anvil.Server.Jobs;
using Anvil.Server.Sidecar;
using ModelContextProtocol.Server;

namespace Anvil.Server.Mcp;

[McpServerToolType]
public sealed class AnvilTools
{
    private readonly JobManager _jobs;
    private readonly PartStore _parts;
    private readonly AppPaths _paths;
    private readonly ScriptLibrary _scripts;
    private readonly PythonSidecar _sidecar;
    private readonly ILogger<AnvilTools> _log;

    private static readonly TimeSpan JobTimeout = TimeSpan.FromMinutes(10);

    private static readonly JsonSerializerOptions J = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        WriteIndented = false,
    };

    public AnvilTools(JobManager jobs, PartStore parts, AppPaths paths,
        ScriptLibrary scripts, PythonSidecar sidecar, ILogger<AnvilTools> log)
    {
        _jobs = jobs; _parts = parts; _paths = paths;
        _scripts = scripts; _sidecar = sidecar; _log = log;
    }

    // ---- Parts -------------------------------------------------------------

    [McpServerTool(Name = "list_parts"), Description(
        "List every registered part (uploads, derived op outputs, and script outputs) with id, name, mass properties, bbox and provenance.")]
    public string ListParts() => Json(new { parts = _parts.All() });

    [McpServerTool(Name = "add_part_from_file"), Description(
        "Register a part from a local CAD file already on disk. absolutePath must be an ABSOLUTE path to a binary .stl, .step or .stp (STEP is converted to a mesh via the sidecar). Returns the new part.")]
    public async Task<string> AddPartFromFile(
        [Description("Absolute path to a binary .stl / .step / .stp file on this machine.")] string absolutePath)
    {
        var (part, error) = await Endpoints.RegisterPartFromLocalFile(absolutePath, _parts, _sidecar, _paths, _log);
        return error is not null ? Err(error) : Json(new { ok = true, part });
    }

    [McpServerTool(Name = "delete_part"), Description(
        "Delete a registered part by id (removes its on-disk folder). Returns {ok:true} or an error if the id is unknown.")]
    public string DeletePart([Description("Part id, e.g. p_ab12cd34.")] string id)
    {
        if (!_parts.Remove(id, out var p)) return Err($"part not found: {id}");
        try { if (p != null && Directory.Exists(p.Dir)) Directory.Delete(p.Dir, recursive: true); } catch { }
        return Json(new { ok = true, id });
    }

    [McpServerTool(Name = "duplicate_part"), Description(
        "Duplicate a part (independent copy sharing the source geometry). Registers and returns the new part synchronously.")]
    public string DuplicatePart([Description("Source part id.")] string id)
    {
        var req = new OpRequestDto { op = "duplicate", inputs = OneInput(id) };
        return RunOpSync(req);
    }

    // ---- Primitives + ops (spawn a worker; polled to completion) ----------

    [McpServerTool(Name = "create_primitive"), Description(
        "Create a primitive solid part. kind: box|cube|cylinder|sphere|cone. sizeMM is the full [x,y,z] extent (cylinder/cone stand along Y: x,z are the base diameters and y is the height; sphere: the three diameters). centerMM defaults to the origin.")]
    public Task<string> CreatePrimitive(
        [Description("box|cube|cylinder|sphere|cone")] string kind,
        [Description("Full [x,y,z] size in mm.")] double[] sizeMM,
        [Description("Optional [x,y,z] center in mm (default origin).")] double[]? centerMM = null,
        [Description("Voxel size in mm (default 0.3).")] double? voxelSizeMM = null)
    {
        if (sizeMM is not { Length: 3 }) return Task.FromResult(Err("sizeMM must be [x,y,z]"));
        var req = new OpRequestDto
        {
            op = "primitive",
            voxelSizeMM = voxelSizeMM ?? 0.3,
            primitive = new PrimitiveDto { kind = kind, sizeMM = Vec(sizeMM), centerMM = Vec(centerMM) },
        };
        return RunOp(req);
    }

    [McpServerTool(Name = "boolean_op"), Description(
        "Boolean of two parts. kind: union|difference|intersection (difference = a − b). Produces a new derived part.")]
    public Task<string> BooleanOp(
        [Description("union|difference|intersection")] string kind,
        [Description("Part id A.")] string aId,
        [Description("Part id B.")] string bId,
        [Description("Voxel size in mm (default 0.3).")] double? voxelSizeMM = null)
    {
        var req = new OpRequestDto
        {
            op = "boolean", booleanKind = kind, voxelSizeMM = voxelSizeMM ?? 0.3,
            inputs = TwoInputs(aId, bId),
        };
        return RunOp(req);
    }

    [McpServerTool(Name = "merge_parts"), Description(
        "Union two parts with a smoothing fillet at the join (filletMM, default 1). Produces a new derived part.")]
    public Task<string> MergeParts(
        [Description("Part id A.")] string aId,
        [Description("Part id B.")] string bId,
        [Description("Fillet radius in mm (default 1).")] double filletMM = 1.0,
        [Description("Voxel size in mm (default 0.3).")] double? voxelSizeMM = null)
    {
        var req = new OpRequestDto
        {
            op = "merge", filletMM = filletMM, voxelSizeMM = voxelSizeMM ?? 0.3,
            inputs = TwoInputs(aId, bId),
        };
        return RunOp(req);
    }

    [McpServerTool(Name = "shell_part"), Description(
        "Hollow a part into a shell. direction: inside|outside|centered. thicknessMM is the wall thickness (must exceed 1.5×voxel).")]
    public Task<string> ShellPart(
        [Description("Source part id.")] string id,
        [Description("inside|outside|centered")] string direction,
        [Description("Wall thickness in mm.")] double thicknessMM,
        [Description("Voxel size in mm (default 0.3).")] double? voxelSizeMM = null)
    {
        var req = new OpRequestDto
        {
            op = "shell", shellDirection = direction, shellThicknessMM = thicknessMM,
            voxelSizeMM = voxelSizeMM ?? 0.3, inputs = OneInput(id),
        };
        return RunOp(req);
    }

    [McpServerTool(Name = "offset_part"), Description(
        "Grow (positive) or shrink (negative) a part by distMM (signed mm). |distMM| must exceed 1.5×voxel.")]
    public Task<string> OffsetPart(
        [Description("Source part id.")] string id,
        [Description("Signed offset distance in mm.")] double distMM,
        [Description("Voxel size in mm (default 0.3).")] double? voxelSizeMM = null)
    {
        var req = new OpRequestDto
        {
            op = "offset", offsetDistMM = distMM, voxelSizeMM = voxelSizeMM ?? 0.3, inputs = OneInput(id),
        };
        return RunOp(req);
    }

    [McpServerTool(Name = "transform_part"), Description(
        "Bake a transform into a NEW part: scale → rotateX → rotateY → rotateZ → translate. translateMM/rotateDeg/scale are [x,y,z]; rotation in degrees; scale defaults to [1,1,1].")]
    public Task<string> TransformPart(
        [Description("Source part id.")] string id,
        [Description("Optional [x,y,z] translation in mm.")] double[]? translateMM = null,
        [Description("Optional [x,y,z] rotation in degrees.")] double[]? rotateDeg = null,
        [Description("Optional [x,y,z] scale factors.")] double[]? scale = null,
        [Description("Voxel size in mm (default 0.3).")] double? voxelSizeMM = null)
    {
        var req = new OpRequestDto
        {
            op = "transform", bake = true, voxelSizeMM = voxelSizeMM ?? 0.3,
            inputs = new List<OpInputDto>
            {
                new() { partId = id, transform = new TransformDto
                {
                    translateMM = Vec(translateMM), rotateDeg = Vec(rotateDeg), scale = Vec(scale),
                }},
            },
        };
        return RunOp(req);
    }

    [McpServerTool(Name = "mirror_part"), Description(
        "Mirror a part across a plane (winding-corrected). planeNormal is [x,y,z] (any length); planePoint defaults to the origin.")]
    public Task<string> MirrorPart(
        [Description("Source part id.")] string id,
        [Description("Plane normal [x,y,z].")] double[] planeNormal,
        [Description("Optional plane point [x,y,z] (default origin).")] double[]? planePoint = null,
        [Description("Voxel size in mm (default 0.3).")] double? voxelSizeMM = null)
    {
        if (planeNormal is not { Length: 3 }) return Task.FromResult(Err("planeNormal must be [x,y,z]"));
        var req = new OpRequestDto
        {
            op = "mirror", voxelSizeMM = voxelSizeMM ?? 0.3, inputs = OneInput(id),
            mirror = new Anvil.Server.Jobs.MirrorDto { planeNormal = Vec(planeNormal), planePoint = Vec(planePoint) },
        };
        return RunOp(req);
    }

    // ---- Generate (zoned lattice) -----------------------------------------

    [McpServerTool(Name = "generate_infill"), Description(
        "Generate a TPMS lattice. mode 'single' gyroidizes partId; mode 'fuse' fills the cavity between positiveId and negativeId. Supports the full zoned schema (zones.latticeIds/keepIds/voidIds + skin/transition/keepOutGrow) and per-part transforms. Polls to completion and returns the job with its stats (volume, infill %, watertight, flow metrics).")]
    public async Task<string> GenerateInfill(
        [Description("single | fuse")] string mode,
        [Description("Part id for single mode.")] string? partId = null,
        [Description("Positive part id for fuse mode.")] string? positiveId = null,
        [Description("Negative (cavity) part id for fuse mode.")] string? negativeId = null,
        [Description("gyroid|schwarzP|schwarzD|lidinoid|neovius (default gyroid).")] string pattern = "gyroid",
        [Description("Unit cell size in mm (default 8).")] double cellSizeMM = 8.0,
        [Description("Wall thickness in mm (default 1.2).")] double wallThicknessMM = 1.2,
        [Description("Voxel size in mm (default 0.3).")] double voxelSizeMM = 0.3,
        [Description("sheet | skeletal (default sheet).")] string latticeType = "sheet",
        [Description("Skeletal bias in mm (default 0).")] double biasMM = 0.0,
        [Description("Fuse cavity overlap in mm (default 0.3).")] double overlapMM = 0.3,
        [Description("Smoothing triple-offset in mm (default 0).")] double smoothOffsetMM = 0.0,
        [Description("Flow axis x|y|z (default z).")] string flowAxis = "z",
        [Description("Reference flow L/min (default 10).")] double refFlowLpm = 10.0,
        [Description("Optional per-axis cell size [x,y,z].")] double[]? cellSizeXYZ = null,
        [Description("Optional field rotation [x,y,z] deg.")] double[]? rotationDeg = null,
        [Description("Optional phase offset [x,y,z] (cell fractions 0-1).")] double[]? phaseOffset = null,
        [Description("Optional blue lattice-only zone part ids.")] string[]? latticeIds = null,
        [Description("Optional green keep-solid zone part ids.")] string[]? keepIds = null,
        [Description("Optional red void zone part ids.")] string[]? voidIds = null,
        [Description("Inward skin off the surface in mm (single only).")] double skinThicknessMM = 0.0,
        [Description("Zone transition in mm (accepted; hard edge in v1).")] double transitionMM = 0.0,
        [Description("Outward growth of void zones in mm.")] double keepOutGrowMM = 0.0,
        [Description("Remove floating islands before export (default true).")] bool cleanup = true)
    {
        var req = new JobRequestDto
        {
            mode = mode, partId = partId, positiveId = positiveId, negativeId = negativeId,
            pattern = pattern, cellSizeMM = cellSizeMM, wallThicknessMM = wallThicknessMM,
            voxelSizeMM = voxelSizeMM, latticeType = latticeType, biasMM = biasMM,
            overlapMM = overlapMM, smoothOffsetMM = smoothOffsetMM,
            flowAxis = flowAxis, refFlowLpm = refFlowLpm,
            cellSizeXYZ = Vec(cellSizeXYZ), rotationDeg = Vec(rotationDeg), phaseOffset = Vec(phaseOffset),
            cleanup = cleanup,
        };
        if (latticeIds is not null || keepIds is not null || voidIds is not null ||
            skinThicknessMM > 0 || transitionMM > 0 || keepOutGrowMM > 0)
        {
            req.zones = new ZonesDto
            {
                latticeIds = latticeIds?.ToList(),
                keepIds = keepIds?.ToList(),
                voidIds = voidIds?.ToList(),
                skinThicknessMM = skinThicknessMM,
                transitionMM = transitionMM,
                keepOutGrowMM = keepOutGrowMM,
            };
        }

        var r = Endpoints.SubmitGenerateCore(req, _parts, _jobs);
        if (!r.Ok) return Err(r.Error!);
        var (st, timedOut) = await PollTerminal(r.JobId!);
        return Json(new { ok = st.state == "done", timedOut, warning = r.Warning, job = st });
    }

    // ---- Jobs --------------------------------------------------------------

    [McpServerTool(Name = "get_job"), Description(
        "Get a job's current status (state, stage, progress, stats, registered part(s), log, error).")]
    public string GetJob([Description("Job id, e.g. j_ab12cd34.")] string id)
    {
        var st = _jobs.Status(id);
        return st is null ? Err($"job not found: {id}") : Json(st);
    }

    [McpServerTool(Name = "cancel_job"), Description(
        "Request cancellation of a job (kills the worker if running). Returns the updated status.")]
    public string CancelJob([Description("Job id.")] string id)
    {
        if (!_jobs.Cancel(id)) return Err($"job not found: {id}");
        return Json(_jobs.Status(id));
    }

    [McpServerTool(Name = "export_step"), Description(
        "Export a completed job's result as a faceted STEP (via the sidecar). Optionally remesh to targetTriangles first. If outPath (absolute) is given, the .step is copied there. Polls to completion.")]
    public async Task<string> ExportStep(
        [Description("Job id of a completed generate/op job.")] string jobId,
        [Description("Optional triangle budget to remesh before STEP conversion.")] int? targetTriangles = null,
        [Description("Optional absolute output path to copy the .step to.")] string? outPath = null)
    {
        var rec = _jobs.Get(jobId);
        if (rec is null) return Err($"job not found: {jobId}");
        if (!_jobs.StartStepExport(jobId, targetTriangles))
            return Err($"job not finished (state: {_jobs.Status(jobId)?.state}); STEP export requires a completed job");

        var deadline = DateTime.UtcNow + JobTimeout;
        JobStatusDto st;
        while (true)
        {
            st = _jobs.Status(jobId)!;
            string ss = st.step.state;
            if (ss is "done" or "failed") break;
            if (DateTime.UtcNow > deadline) return Json(new { ok = false, timedOut = true, job = st });
            await Task.Delay(250);
        }

        string? copied = null;
        if (st.step.state == "done" && !string.IsNullOrWhiteSpace(outPath))
        {
            if (!Path.IsPathRooted(outPath)) return Err($"outPath must be absolute: {outPath}");
            Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(outPath))!);
            File.Copy(rec.ResultStepPath, outPath!, overwrite: true);
            copied = outPath;
        }
        return Json(new { ok = st.step.state == "done", step = st.step, outPath = copied });
    }

    [McpServerTool(Name = "get_result_stl"), Description(
        "Copy a job's result STL to an absolute outPath on this machine. Works for generate jobs (result.stl) and op/script jobs (the produced mesh).")]
    public string GetResultStl(
        [Description("Job id.")] string jobId,
        [Description("Absolute output path for the .stl.")] string outPath)
    {
        var rec = _jobs.Get(jobId);
        if (rec is null) return Err($"job not found: {jobId}");
        if (string.IsNullOrWhiteSpace(outPath) || !Path.IsPathRooted(outPath))
            return Err($"outPath must be absolute: {outPath}");
        if (!File.Exists(rec.ResultStlPath))
            return Err($"result STL not available (job state: {_jobs.Status(jobId)?.state})");
        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(outPath))!);
        File.Copy(rec.ResultStlPath, outPath, overwrite: true);
        long bytes = new FileInfo(outPath).Length;
        return Json(new { ok = true, outPath, bytes });
    }

    // ---- Scripting ---------------------------------------------------------

    [McpServerTool(Name = "run_script"), Description(
        "Compile and run C# geometry code (LEAP71-style code-to-geometry) in a worker. Scripts are written against the FORGE API, a flat command set auto-imported into every script: builders Box/Cylinder/Cone/Sphere/Capsule/Torus/Loft/Pipe/FromFile, combinators Union/Subtract/Intersect/SmoothUnion, modifiers Move/RotateX/RotateY/RotateZ/Scale/Mirror/Shell/Offset/Smooth/ArrayLinear/ArrayRadial/Lattice/Emboss, info Volume/BBox/Center, and V(x,y,z) for points. " +
        "Units are mm, angles degrees, +Y is up, and every builder's 'at' is the shape's CENTRE and defaults to the origin. For example: " +
        "Shape body = SmoothUnion(Box(60,4,40), Cylinder(d:12, h:8, at:V(0,6,0)), radius:2); " +
        "Shape holes = ArrayRadial(Cylinder(d:4, h:20), count:6, radius:20); " +
        "SavePart(\"bracket\", Subtract(body, holes)); " +
        "CALL get_forge_reference FIRST for the full command reference with every modifier, unit and default. " +
        "The script also talks to the app via globals: Params, VoxelSizeMM, SavePart(name, Shape|Voxels|Mesh), Log(msg), plus helpers ParamF/ParamS/ParamB. Raw PicoGK (Voxels, Mesh, IImplicit, BBox3) and Anvil.Worker (MeshUtil, TPMSWall) are in scope too and mix freely with Forge. Polls to completion; returns registered parts + log, or a scriptError on compile failure. SECURITY: runs arbitrary code with your privileges, no sandbox.")]
    public async Task<string> RunScript(
        [Description("The C# script (.csx) source.")] string code,
        [Description("Optional display name for the SCRIPT · label.")] string? name = null,
        [Description("Optional JSON object of parameters (read via Params / ParamF).")] JsonElement? parameters = null,
        [Description("Voxel size in mm (default 0.3).")] double? voxelSizeMM = null)
    {
        JsonObject? paramObj = null;
        if (parameters is JsonElement pe && pe.ValueKind == JsonValueKind.Object)
            paramObj = JsonNode.Parse(pe.GetRawText()) as JsonObject;

        if (!ScriptsEndpoints.SubmitRun(code, name, paramObj, voxelSizeMM, _jobs, out string? jobId, out string? error))
            return Err(error!);

        var (st, timedOut) = await PollTerminal(jobId!);
        return Json(new { ok = st.state == "done", timedOut, job = st });
    }

    [McpServerTool(Name = "list_scripts"), Description(
        "List all scripts (versioned library seeds + user-saved), newest first, with id/name/source/savedUtc.")]
    public string ListScripts() => Json(new { scripts = _scripts.List() });

    [McpServerTool(Name = "get_script"), Description(
        "Get a script's source by id (e.g. 'library:heat_exchanger_core' or 'user:my_part').")]
    public string GetScript([Description("Script id from list_scripts.")] string id)
    {
        var c = _scripts.Get(id);
        return c is null ? Err($"script not found: {id}") : Json(new { c.id, c.name, c.code, c.source });
    }

    [McpServerTool(Name = "save_script"), Description(
        "Save a C# script to the user library (name is slugified to a filename). It then shows up in the app's SCRIPTS template picker and in list_scripts. Write it against the FORGE API, the same command set run_script uses, for example: " +
        "Shape tube = Shell(Cylinder(d:20, h:40, at:V(0,20,0)), wall:2); " +
        "Shape ported = Subtract(tube, ArrayRadial(Cylinder(d:4, h:30), count:8, radius:0)); " +
        "SavePart(\"port_ring\", Lattice(ported, cell:6, wall:1)); " +
        "Call get_forge_reference first if you have not already. Returns the saved descriptor.")]
    public string SaveScript(
        [Description("Script name (slugified to a filename).")] string name,
        [Description("The C# script source, written against the Forge API (see get_forge_reference).")] string code)
    {
        try { return Json(_scripts.Save(name, code)); }
        catch (ArgumentException ex) { return Err(ex.Message); }
    }

    [McpServerTool(Name = "get_forge_reference"), Description(
        "The Forge API reference: every geometry command available inside an Anvil C# script, with its signature, a one-line description, and a table of modifiers giving units, defaults and meaning, plus the script globals, the coordinate conventions and the voxel-size rule. " +
        "CALL THIS BEFORE WRITING OR EDITING A SCRIPT for run_script or save_script: it is the authoritative vocabulary, and guessing at command names or argument order wastes a compile round trip. " +
        "Returns GitHub-flavored markdown read from docs/scripting.md in the repo. By default the worked example and the example-script table are trimmed; pass full=true for the whole document.")]
    public string GetForgeReference(
        [Description("Return the entire document, including the worked example and the example-script table (default false).")] bool full = false)
    {
        string? path = FindForgeReference();
        if (path is null)
            return Err($"Forge reference not found: expected docs\\scripting.md under the repo root ({_paths.RepoRoot}).");

        string text;
        try { text = File.ReadAllText(path); }
        catch (Exception ex) { return Err($"could not read {path}: {ex.Message}"); }

        if (!full)
        {
            int worked = text.IndexOf("\n## Worked example", StringComparison.Ordinal);
            int gotchas = text.IndexOf("\n## Gotchas", StringComparison.Ordinal);
            if (worked > 0 && gotchas > worked)
                text = text[..worked]
                     + "\n\n> The worked example and the example-script table were trimmed here. "
                     + "Call get_forge_reference with full=true for the whole document.\n"
                     + text[gotchas..];
        }
        return text;
    }

    /// <summary>
    /// Locate docs\scripting.md: the resolved repo root first, then a walk up
    /// from the server executable (so a relocated build still finds the doc).
    /// </summary>
    private string? FindForgeReference()
    {
        string primary = Path.Combine(_paths.RepoRoot, "docs", "scripting.md");
        if (File.Exists(primary)) return primary;

        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        for (int i = 0; i < 8 && dir is not null; i++, dir = dir.Parent)
        {
            string candidate = Path.Combine(dir.FullName, "docs", "scripting.md");
            if (File.Exists(candidate)) return candidate;
        }
        return null;
    }

    // ---- shared op run + polling ------------------------------------------

    private Task<string> RunOp(OpRequestDto req)
    {
        var r = OpsEndpoints.SubmitOpCore(req, _parts, _jobs, _paths, _log);
        if (!r.Ok) return Task.FromResult(Err(r.Error!));
        if (r.SyncPart is not null) return Task.FromResult(Json(new { ok = true, part = r.SyncPart }));
        return PollOp(r.JobId!, r.PartId, r.Warning);
    }

    /// <summary>Synchronous op (duplicate): register-and-return, no polling.</summary>
    private string RunOpSync(OpRequestDto req)
    {
        var r = OpsEndpoints.SubmitOpCore(req, _parts, _jobs, _paths, _log);
        if (!r.Ok) return Err(r.Error!);
        if (r.SyncPart is not null) return Json(new { ok = true, part = r.SyncPart });
        // Shouldn't happen for duplicate, but fall through to polling if async.
        return PollOp(r.JobId!, r.PartId, r.Warning).GetAwaiter().GetResult();
    }

    private async Task<string> PollOp(string jobId, string? partId, string? warning)
    {
        var (st, timedOut) = await PollTerminal(jobId);
        return Json(new { ok = st.state == "done", timedOut, partId, warning, job = st });
    }

    private async Task<(JobStatusDto st, bool timedOut)> PollTerminal(string jobId)
    {
        var deadline = DateTime.UtcNow + JobTimeout;
        while (true)
        {
            var st = _jobs.Status(jobId);
            if (st is null) return (new JobStatusDto { id = jobId, state = "notfound", error = "job not found" }, false);
            if (st.state is "done" or "failed" or "cancelled") return (st, false);
            if (DateTime.UtcNow > deadline) return (st, true);
            await Task.Delay(250);
        }
    }

    // ---- helpers -----------------------------------------------------------

    private static List<OpInputDto> OneInput(string id) => new() { new OpInputDto { partId = id } };
    private static List<OpInputDto> TwoInputs(string a, string b) =>
        new() { new OpInputDto { partId = a }, new OpInputDto { partId = b } };

    private static Vec3Dto? Vec(double[]? a) =>
        a is { Length: 3 } ? new Vec3Dto { x = a[0], y = a[1], z = a[2] } : null;

    private static string Json(object? o) => JsonSerializer.Serialize(o, J);
    private static string Err(string message) => JsonSerializer.Serialize(new { ok = false, error = message }, J);
}
