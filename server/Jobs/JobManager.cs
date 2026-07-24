//
// JobManager — spawns/tracks/kills AnvilWorker.exe processes.
//
// * FIFO queue via a Channel; a single dispatcher admits jobs in order and
//   runs up to MaxConcurrentJobs workers at once (SemaphoreSlim slots). The
//   same slot gate also throttles the auxiliary "coarseOnly" remesh used by
//   the STEP-export endpoint, so the total number of live workers never exceeds
//   MaxConcurrentJobs.
// * stdout is parsed line-by-line (JSON-lines progress from the worker); the
//   final {"stage":"done","stats":{...}} line carries the result stats.
// * stderr is captured; on non-zero exit its {"error"} is surfaced.
// * Cancel = Process.Kill(entireProcessTree) (or skip if still queued).
//
// The server never references PicoGK — all voxel work happens in the worker.
//
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading.Channels;
using Anvil.Server.Sidecar;
using Anvil.Server.Stl;

namespace Anvil.Server.Jobs;

public sealed class JobManager : IAsyncDisposable
{
    private readonly string _workerPath;   // abs AnvilWorker.exe
    private readonly string _jobsDir;      // abs {DataDir}/jobs
    private readonly string _partsDir;     // abs {DataDir}/parts (script parts land here)
    private readonly string _repoRoot;
    private readonly PythonSidecar _sidecar;
    private readonly PartStore _parts;     // derived-op outputs register here
    private readonly ILogger<JobManager> _log;

    private readonly ConcurrentDictionary<string, JobRecord> _jobs = new();
    private readonly Channel<JobRecord> _queue = Channel.CreateUnbounded<JobRecord>(
        new UnboundedChannelOptions { SingleReader = true, SingleWriter = false });
    private readonly SemaphoreSlim _slots;
    private readonly Task _dispatcher;
    private readonly CancellationTokenSource _shutdown = new();

    private static readonly JsonSerializerOptions CamelOut = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        WriteIndented = true,
    };

    public JobManager(string workerPath, string jobsDir, string partsDir, string repoRoot,
        int maxConcurrent, PythonSidecar sidecar, PartStore parts, ILogger<JobManager> log)
    {
        _workerPath = workerPath;
        _jobsDir = jobsDir;
        _partsDir = partsDir;
        _repoRoot = repoRoot;
        _sidecar = sidecar;
        _parts = parts;
        _log = log;
        _slots = new SemaphoreSlim(Math.Max(1, maxConcurrent), Math.Max(1, maxConcurrent));
        Directory.CreateDirectory(_jobsDir);
        Directory.CreateDirectory(_partsDir);
        _dispatcher = Task.Run(DispatchLoopAsync);

        if (!File.Exists(_workerPath))
            _log.LogWarning("WorkerPath does not exist yet: {Path} — jobs will fail until the worker is built", _workerPath);
    }

    public string WorkerPath => _workerPath;
    public bool WorkerExists => File.Exists(_workerPath);

    // ---- Submission --------------------------------------------------------

    public sealed record WorkerInputs(string Mode, string? StlPath, string? PositiveStlPath, string? NegativeStlPath);

    /// <summary>A resolved zone/op mesh reference: an abs STL path + its current TRS.</summary>
    public sealed record MeshRefPayload(string Path, TransformDto? Transform);

    /// <summary>Resolved zone MeshRefs by class + the zone offsets, for a generate job.</summary>
    public sealed record ZonePayload(
        IReadOnlyList<MeshRefPayload> Lattice,
        IReadOnlyList<MeshRefPayload> Keep,
        IReadOnlyList<MeshRefPayload> Void,
        double SkinThicknessMM, double TransitionMM, double KeepOutGrowMM);

    /// <summary>Base-part transforms folded into a generate job (single vs fuse).</summary>
    public sealed record BaseTransforms(TransformDto? Stl, TransformDto? Positive, TransformDto? Negative);

    /// <summary>Create a job folder, write job.json, enqueue. Returns the job id.</summary>
    public string Submit(JobRequestDto req, WorkerInputs inputs, string? warning,
        ZonePayload? zones = null, BaseTransforms? baseTransforms = null)
    {
        string id = "j_" + Token.New();
        string dir = Path.Combine(_jobsDir, id);
        Directory.CreateDirectory(dir);

        string resultStl = Path.Combine(dir, "result.stl");
        bool stepEnabled = req.stepExport?.enabled == true;
        string coarseStl = Path.Combine(dir, "coarse.stl");
        string resultStep = Path.Combine(dir, "result.step");
        string jobJson = Path.Combine(dir, "job.json");

        // Build the worker's job.json (its JobRequest schema). camelCase.
        var workerJob = new Dictionary<string, object?>
        {
            ["mode"] = inputs.Mode,
            ["pattern"] = req.pattern,
            ["cellSizeMM"] = req.cellSizeMM,
            ["wallThicknessMM"] = req.wallThicknessMM,
            ["voxelSizeMM"] = req.voxelSizeMM,
            ["overlapMM"] = req.overlapMM,
            ["smoothOffsetMM"] = req.smoothOffsetMM,
            ["outputPath"] = resultStl,
            // ---- flow metrics v1 passthrough ----
            ["latticeType"] = req.latticeType,
            ["biasMM"] = req.biasMM,
            ["rotationDeg"] = Vec(req.rotationDeg),
            ["phaseOffset"] = Vec(req.phaseOffset),
            ["flowAxis"] = req.flowAxis,
            ["refFlowLpm"] = req.refFlowLpm,
        };
        if (req.cellSizeXYZ is Vec3Dto cxyz)
            workerJob["cellSizeXYZ"] = Vec(cxyz);
        if (inputs.Mode == "fuse")
        {
            workerJob["positiveStlPath"] = inputs.PositiveStlPath;
            workerJob["negativeStlPath"] = inputs.NegativeStlPath;
        }
        else
        {
            workerJob["stlPath"] = inputs.StlPath;
        }
        if (stepEnabled)
        {
            workerJob["stepExport"] = new Dictionary<string, object?>
            {
                ["enabled"] = true,
                ["targetTriangles"] = req.stepExport!.targetTriangles,
                ["coarseStlPath"] = coarseStl,
            };
        }
        // Mesh cleanup passthrough (only when the caller set it -> legacy job.json
        // stays byte-identical when cleanup is absent; the worker defaults to on).
        if (req.cleanup is bool cleanup) workerJob["cleanup"] = cleanup;

        // ---- Wave-1 base transforms (only emitted when present -> legacy job.json
        //      is byte-identical when there are no transforms and no zones) ----
        if (baseTransforms is not null)
        {
            if (inputs.Mode == "fuse")
            {
                if (TrsDict(baseTransforms.Positive) is { } pt) workerJob["positiveTransform"] = pt;
                if (TrsDict(baseTransforms.Negative) is { } nt) workerJob["negativeTransform"] = nt;
            }
            else
            {
                if (TrsDict(baseTransforms.Stl) is { } st) workerJob["stlTransform"] = st;
            }
        }

        // ---- Wave-1 zones (zone MeshRefs carry each zone part's TRS) ----
        if (zones is not null)
        {
            if (zones.Lattice.Count > 0) workerJob["zoneLattice"] = zones.Lattice.Select(MeshRefDict).ToList();
            if (zones.Keep.Count > 0)    workerJob["zoneKeep"]    = zones.Keep.Select(MeshRefDict).ToList();
            if (zones.Void.Count > 0)    workerJob["zoneVoid"]    = zones.Void.Select(MeshRefDict).ToList();
            workerJob["skinThicknessMM"] = zones.SkinThicknessMM;
            workerJob["transitionMM"]    = zones.TransitionMM;
            workerJob["keepOutGrowMM"]   = zones.KeepOutGrowMM;
        }

        File.WriteAllText(jobJson, JsonSerializer.Serialize(workerJob, CamelOut));

        // ---- The lattice IS a part: reserve its id + provenance now, register the
        //      mesh in FinalizeGeneratePart (BEFORE the job flips to done, exactly
        //      like an op output). Source ids are base-first, then zones. ----
        var sourceIds = new List<string>();
        if (inputs.Mode == "fuse")
        {
            if (!string.IsNullOrWhiteSpace(req.positiveId)) sourceIds.Add(req.positiveId!);
            if (!string.IsNullOrWhiteSpace(req.negativeId)) sourceIds.Add(req.negativeId!);
        }
        else if (!string.IsNullOrWhiteSpace(req.partId)) sourceIds.Add(req.partId!);
        if (req.zones is ZonesDto zd)
        {
            foreach (var list in new[] { zd.latticeIds, zd.keepIds, zd.voidIds })
            {
                if (list is null) continue;
                foreach (var zid in list)
                    if (!string.IsNullOrWhiteSpace(zid) && !sourceIds.Contains(zid)) sourceIds.Add(zid);
            }
        }

        string patternLabel = PatternLabel(req.pattern);
        string stem = sourceIds.Count > 0 && _parts.TryGet(sourceIds[0], out var srcPart)
            ? NameStem(srcPart.name)
            : "LATTICE";
        string genPartId = "p_" + Token.New();

        var rec = new JobRecord
        {
            Id = id,
            Dir = dir,
            JobJsonPath = jobJson,
            ResultStlPath = resultStl,
            CoarseStlPath = stepEnabled ? coarseStl : null,
            ResultStepPath = resultStep,
            VoxelSizeMM = req.voxelSizeMM,
            Warning = warning,
            State = JobState.Queued,
            Stage = "queued",
            PendingPartId = genPartId,
            PendingPartDir = Path.Combine(_partsDir, genPartId),
            PendingPartName = $"{stem} · {patternLabel}",
            PendingDerived = new DerivedDto
            {
                op = "generate",
                label = $"TPMS · {patternLabel}",
                sourceIds = sourceIds,
                opParams = new JsonObject
                {
                    ["pattern"] = req.pattern,
                    ["latticeType"] = req.latticeType,
                    ["cellSizeMM"] = req.cellSizeMM,
                    ["wallThicknessMM"] = req.wallThicknessMM,
                    ["voxelSizeMM"] = req.voxelSizeMM,
                },
            },
        };
        _jobs[id] = rec;
        _queue.Writer.TryWrite(rec);
        _log.LogInformation("job {Id} submitted ({Mode})", id, inputs.Mode);
        return id;
    }

    /// <summary>
    /// Submit a derived-part op job (mode == "op"). The caller has already
    /// reserved the destination part id + dir (outputStl = {dir}/mesh.stl) and
    /// resolved every input id -> abs STL path (folding each input's current TRS
    /// into the MeshRef). Emits a worker op job.json, shares the same channel +
    /// slot gate as generate jobs, and returns the job id. On success the worker
    /// output is read (StlInfo mass props) into a PartInfo, registered in the
    /// PartStore and exposed via JobStatus.part; on failure/cancel the reserved
    /// dir is deleted.
    /// </summary>
    public string SubmitOp(
        OpRequestDto req, IReadOnlyList<MeshRefPayload> inputs,
        string reservedPartId, string reservedPartDir, string outputStl,
        string pendingName, DerivedDto derived, string? warning)
    {
        string id = "j_" + Token.New();
        string dir = Path.Combine(_jobsDir, id);
        Directory.CreateDirectory(dir);
        string jobJson = Path.Combine(dir, "job.json");

        string op = (req.op ?? "").Trim().ToLowerInvariant();
        var workerJob = new Dictionary<string, object?>
        {
            ["mode"] = "op",
            ["opKind"] = op,
            ["voxelSizeMM"] = req.voxelSizeMM,
            ["outputPath"] = outputStl,
            // Ops always run mesh cleanup (island removal + watertight) before
            // the derived part is registered.
            ["cleanup"] = true,
        };
        if (inputs.Count > 0)
            workerJob["inputs"] = inputs.Select(MeshRefDict).ToList();
        if (!string.IsNullOrWhiteSpace(req.booleanKind))
            workerJob["booleanKind"] = req.booleanKind!.Trim().ToLowerInvariant();
        workerJob["filletMM"] = req.filletMM;
        if (!string.IsNullOrWhiteSpace(req.shellDirection))
            workerJob["shellDirection"] = req.shellDirection!.Trim().ToLowerInvariant();
        workerJob["shellThicknessMM"] = req.shellThicknessMM;
        workerJob["offsetDistMM"] = req.offsetDistMM;
        workerJob["bake"] = req.bake;
        if (req.mirror is MirrorDto m)
            workerJob["mirror"] = new Dictionary<string, object?>
            {
                ["planePoint"] = Vec(m.planePoint),
                ["planeNormal"] = Vec(m.planeNormal),
            };
        if (req.primitive is PrimitiveDto p)
            workerJob["primitive"] = new Dictionary<string, object?>
            {
                ["kind"] = (p.kind ?? "").Trim().ToLowerInvariant(),
                ["sizeMM"] = Vec(p.sizeMM),
                ["centerMM"] = Vec(p.centerMM),
                ["sides"] = p.sides,
            };

        File.WriteAllText(jobJson, JsonSerializer.Serialize(workerJob, CamelOut));

        var rec = new JobRecord
        {
            Id = id,
            Dir = dir,
            JobJsonPath = jobJson,
            ResultStlPath = outputStl,        // the derived part's mesh.stl
            ResultStepPath = Path.Combine(dir, "result.step"),
            VoxelSizeMM = req.voxelSizeMM,
            Warning = warning,
            State = JobState.Queued,
            Stage = "queued",
            Kind = JobKind.Op,
            PendingPartId = reservedPartId,
            PendingPartDir = reservedPartDir,
            PendingPartName = pendingName,
            PendingDerived = derived,
        };
        _jobs[id] = rec;
        _queue.Writer.TryWrite(rec);
        _log.LogInformation("op job {Id} submitted ({Op} -> part {PartId})", id, op, reservedPartId);
        return id;
    }

    /// <summary>
    /// Submit a script job (mode == "script"). Writes the user code to
    /// &lt;jobDir&gt;\script.csx and a worker job.json pointing at it, then enqueues
    /// through the SAME channel + slot gate as generate/op jobs. On success each
    /// part the script SavePart-ed is registered in the PartStore (via
    /// FinalizeScriptParts) and exposed on JobStatus.parts. The script SOURCE is
    /// never stored in part provenance — only its SHA-256 + name + params.
    /// </summary>
    public string SubmitScript(string code, string? name, JsonNode? scriptParams, double voxelSizeMM)
    {
        string id = "j_" + Token.New();
        string dir = Path.Combine(_jobsDir, id);
        Directory.CreateDirectory(dir);
        string scriptPath = Path.Combine(dir, "script.csx");
        string outputDir = Path.Combine(dir, "parts");
        string jobJson = Path.Combine(dir, "job.json");

        File.WriteAllText(scriptPath, code);

        // scriptSha256 (hex) — stamped into every part's provenance instead of code.
        string sha = Convert.ToHexString(
            System.Security.Cryptography.SHA256.HashData(Encoding.UTF8.GetBytes(code))).ToLowerInvariant();

        var workerJob = new Dictionary<string, object?>
        {
            ["mode"] = "script",
            ["scriptPath"] = scriptPath,
            ["voxelSizeMM"] = voxelSizeMM,
            ["outputDir"] = outputDir,
            ["cleanup"] = true,
        };
        if (scriptParams is JsonObject po && po.Count > 0)
            workerJob["scriptParams"] = JsonNode.Parse(po.ToJsonString());

        File.WriteAllText(jobJson, JsonSerializer.Serialize(workerJob, CamelOut));

        string dispName = string.IsNullOrWhiteSpace(name) ? "script" : name!.Trim();
        var rec = new JobRecord
        {
            Id = id,
            Dir = dir,
            JobJsonPath = jobJson,
            ResultStlPath = Path.Combine(dir, "result.stl"), // unused for scripts
            ResultStepPath = Path.Combine(dir, "result.step"),
            VoxelSizeMM = voxelSizeMM,
            State = JobState.Queued,
            Stage = "queued",
            Kind = JobKind.Script,
            PendingScriptName = dispName,
            PendingScriptSha = sha,
            PendingScriptParams = scriptParams is JsonObject sp && sp.Count > 0
                ? (JsonNode)JsonNode.Parse(sp.ToJsonString())! : null,
        };
        _jobs[id] = rec;
        _queue.Writer.TryWrite(rec);
        _log.LogInformation("script job {Id} submitted ('{Name}', voxel {Voxel})", id, dispName, voxelSizeMM);
        return id;
    }

    public JobRecord? Get(string id) => _jobs.TryGetValue(id, out var r) ? r : null;

    public JobStatusDto? Status(string id) => _jobs.TryGetValue(id, out var r) ? r.Snapshot() : null;

    // ---- Dispatch + execution ---------------------------------------------

    private async Task DispatchLoopAsync()
    {
        try
        {
            while (await _queue.Reader.WaitToReadAsync(_shutdown.Token))
            {
                while (_queue.Reader.TryRead(out var rec))
                {
                    await _slots.WaitAsync(_shutdown.Token);
                    _ = Task.Run(async () =>
                    {
                        try { await ExecuteJobAsync(rec); }
                        catch (Exception ex)
                        {
                            _log.LogError(ex, "job {Id} crashed in executor", rec.Id);
                            lock (rec.Gate) { rec.State = JobState.Failed; rec.Error ??= ex.Message; }
                        }
                        finally { _slots.Release(); }
                    });
                }
            }
        }
        catch (OperationCanceledException) { /* shutting down */ }
    }

    private async Task ExecuteJobAsync(JobRecord rec)
    {
        Process proc;
        lock (rec.Gate)
        {
            if (rec.CancelRequested)
            {
                rec.State = JobState.Cancelled;
                rec.Stage = "cancelled";
                return;
            }

            if (!File.Exists(_workerPath))
            {
                rec.State = JobState.Failed;
                rec.Stage = "failed";
                rec.Error = $"worker executable not found: {_workerPath}. Build the worker project (worker/Anvil.Worker.csproj).";
                return;
            }

            var psi = new ProcessStartInfo
            {
                FileName = _workerPath,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
                WorkingDirectory = _repoRoot,
            };
            psi.ArgumentList.Add(rec.JobJsonPath);

            proc = new Process { StartInfo = psi, EnableRaisingEvents = true };
            proc.OutputDataReceived += (_, e) => OnWorkerStdout(rec, e.Data);
            proc.ErrorDataReceived += (_, e) => { if (e.Data != null) lock (rec.Gate) rec.Stderr.AppendLine(e.Data); };

            proc.Start();
            proc.BeginOutputReadLine();
            proc.BeginErrorReadLine();
            rec.Proc = proc;
            rec.State = JobState.Running;
            rec.Stage = "starting";
        }

        await proc.WaitForExitAsync();
        int exit = proc.ExitCode;
        proc.Dispose();

        bool cancelled;
        lock (rec.Gate) { rec.Proc = null; cancelled = rec.CancelRequested; }

        if (cancelled)
        {
            lock (rec.Gate) { rec.State = JobState.Cancelled; rec.Stage = "cancelled"; }
            if (rec.Kind == JobKind.Op) TryDeleteDir(rec.PendingPartDir);
        }
        else if (exit == 0)
        {
            // Register outputs BEFORE the job becomes observably "done", so any
            // client that sees state==done also sees the registered part(s) — no
            // finalize-after-done race. A registration failure flips it to Failed.
            bool registered = true;
            if (rec.Kind == JobKind.Op)
            {
                try { FinalizeOpPart(rec); }
                catch (Exception ex)
                {
                    registered = false;
                    _log.LogError(ex, "op job {Id} produced output but part registration failed", rec.Id);
                    lock (rec.Gate) { rec.State = JobState.Failed; rec.Stage = "failed"; rec.Error = $"op output registration failed: {ex.Message}"; }
                    TryDeleteDir(rec.PendingPartDir);
                }
            }
            else if (rec.Kind == JobKind.Script)
            {
                try { FinalizeScriptParts(rec); }
                catch (Exception ex)
                {
                    registered = false;
                    _log.LogError(ex, "script job {Id} produced output but part registration failed", rec.Id);
                    lock (rec.Gate) { rec.State = JobState.Failed; rec.Stage = "failed"; rec.Error = $"script part registration failed: {ex.Message}"; }
                }
            }
            else if (rec.Kind == JobKind.Generate && rec.PendingPartId is not null)
            {
                try { FinalizeGeneratePart(rec); }
                catch (Exception ex)
                {
                    registered = false;
                    _log.LogError(ex, "generate job {Id} produced output but lattice registration failed", rec.Id);
                    lock (rec.Gate) { rec.State = JobState.Failed; rec.Stage = "failed"; rec.Error = $"lattice part registration failed: {ex.Message}"; }
                    TryDeleteDir(rec.PendingPartDir);
                }
            }

            if (registered)
                lock (rec.Gate) { rec.State = JobState.Done; rec.Stage = "done"; rec.Progress = 1.0; }
        }
        else
        {
            lock (rec.Gate)
            {
                rec.State = JobState.Failed;
                rec.Stage = "failed";
                rec.Error = ParseWorkerError(rec.Stderr.ToString(), exit);
                rec.ErrorData = ParseWorkerErrorData(rec.Stderr.ToString());
            }
            if (rec.Kind == JobKind.Op) TryDeleteDir(rec.PendingPartDir);
        }

        _log.LogInformation("job {Id} finished: {State} (exit {Exit})", rec.Id, rec.State, exit);
    }

    /// <summary>
    /// Read the op worker's output STL (StlInfo mass props), build the derived
    /// PartInfo, register it in the PartStore, and expose it via JobStatus.part.
    /// </summary>
    private void FinalizeOpPart(JobRecord rec)
    {
        var info = StlInfo.ReadBinary(rec.ResultStlPath);
        // Watertightness comes from the worker's op stats (directed-edge check),
        // not the mass-props reader — carry it onto the registered part.
        bool? watertight = null;
        lock (rec.Gate)
        {
            if (rec.Stats is JsonObject so && so.TryGetPropertyValue("watertight", out var wtNode)
                && wtNode is JsonValue wtVal && wtVal.TryGetValue(out bool wt))
                watertight = wt;
        }
        var part = new PartInfo
        {
            id = rec.PendingPartId!,
            name = !string.IsNullOrWhiteSpace(rec.PendingPartName)
                ? rec.PendingPartName!
                : (rec.PendingDerived?.label ?? rec.PendingPartId!),
            sourceFormat = "derived",
            stlUrl = $"/api/parts/{rec.PendingPartId}/mesh.stl",
            triangles = info.Triangles,
            bbox = BboxDto.From(info.Bbox),
            volumeMM3 = info.VolumeMM3,
            surfaceAreaMM2 = info.SurfaceAreaMM2,
            cogMM = info.CogMM,
            watertight = watertight,
            derived = rec.PendingDerived,
            StlPath = rec.ResultStlPath,
            Dir = rec.PendingPartDir ?? Path.GetDirectoryName(rec.ResultStlPath)!,
        };
        _parts.Add(part);
        lock (rec.Gate) rec.ResultPart = part;
        _log.LogInformation("op job {Id} registered derived part {PartId} '{Name}' ({Tris} tris, {Vol:0.##} mm3)",
            rec.Id, part.id, part.name, part.triangles, part.volumeMM3);
    }

    /// <summary>
    /// Register a finished generate job's lattice as a derived part, so the result
    /// IS a part (selectable, movable, exportable) instead of a floating preview
    /// mesh. COPIES result.stl to {DataDir}\parts\{id}\mesh.stl — the job-dir copy
    /// STAYS, because the legacy preview.stl / result.step endpoints (and the MCP
    /// tools) read it from there. Exposed via JobStatus.part like an op output.
    /// </summary>
    private void FinalizeGeneratePart(JobRecord rec)
    {
        string partId = rec.PendingPartId!;
        string partDir = rec.PendingPartDir ?? Path.Combine(_partsDir, partId);
        Directory.CreateDirectory(partDir);
        string meshStl = Path.Combine(partDir, "mesh.stl");
        File.Copy(rec.ResultStlPath, meshStl, overwrite: true);

        var info = StlInfo.ReadBinary(meshStl);
        // Watertightness comes from the worker's done-stats (directed-edge check).
        bool? watertight = null;
        lock (rec.Gate)
        {
            if (rec.Stats is JsonObject so && so.TryGetPropertyValue("watertight", out var wtNode)
                && wtNode is JsonValue wtVal && wtVal.TryGetValue(out bool wt))
                watertight = wt;
        }

        var part = new PartInfo
        {
            id = partId,
            name = !string.IsNullOrWhiteSpace(rec.PendingPartName)
                ? rec.PendingPartName!
                : (rec.PendingDerived?.label ?? partId),
            sourceFormat = "derived",
            stlUrl = $"/api/parts/{partId}/mesh.stl",
            triangles = info.Triangles,
            bbox = BboxDto.From(info.Bbox),
            volumeMM3 = info.VolumeMM3,
            surfaceAreaMM2 = info.SurfaceAreaMM2,
            cogMM = info.CogMM,
            watertight = watertight,
            derived = rec.PendingDerived,
            StlPath = meshStl,
            Dir = partDir,
        };
        _parts.Add(part);
        lock (rec.Gate) rec.ResultPart = part;
        _log.LogInformation("generate job {Id} registered lattice part {PartId} '{Name}' ({Tris} tris, {Vol:0.##} mm3)",
            rec.Id, part.id, part.name, part.triangles, part.volumeMM3);
    }

    // Display labels for the lattice part's name/provenance (mirrors the UI's
    // PATTERN_LABEL map so the row and the file name read the same).
    private static readonly Dictionary<string, string> PatternLabels = new(StringComparer.OrdinalIgnoreCase)
    {
        ["gyroid"] = "GYROID", ["schwarzp"] = "SCHWARZ P", ["schwarzd"] = "SCHWARZ D",
        ["lidinoid"] = "LIDINOID", ["neovius"] = "NEOVIUS",
    };
    private const int StemMaxChars = 24;

    private static string PatternLabel(string? pattern)
    {
        string p = (pattern ?? "").Trim();
        return PatternLabels.TryGetValue(p, out var label) ? label : p.ToUpperInvariant();
    }

    /// <summary>
    /// Source part name → a short human stem for the lattice part's display name:
    /// a known mesh extension is dropped and anything over StemMaxChars is elided.
    /// Only the three known extensions are stripped, so "1.5mm plate" survives.
    /// </summary>
    private static string NameStem(string? name)
    {
        string s = (name ?? "").Trim();
        foreach (var ext in new[] { ".stl", ".step", ".stp" })
        {
            if (s.EndsWith(ext, StringComparison.OrdinalIgnoreCase)) { s = s[..^ext.Length].Trim(); break; }
        }
        if (s.Length > StemMaxChars) s = s[..(StemMaxChars - 1)].TrimEnd() + "…";
        return s.Length > 0 ? s : "PART";
    }

    /// <summary>
    /// Register EVERY part a script SavePart-ed. The worker's done-stats carry a
    /// "parts" manifest (each with an abs STL path in the job's parts dir); for
    /// each entry we reserve a part id + dir, COPY the STL to
    /// data\parts\{id}\mesh.stl, read its mass props, and register a derived
    /// PartInfo (op:"script", label:"SCRIPT · {name}", provenance = name + params
    /// + scriptSha256 — never the code). Exposed via JobStatus.parts.
    /// </summary>
    private void FinalizeScriptParts(JobRecord rec)
    {
        var registered = new List<PartInfo>();
        JsonNode? statsNode;
        lock (rec.Gate) statsNode = rec.Stats;

        var manifest = (statsNode as JsonObject)?["parts"] as JsonArray;
        if (manifest is not null)
        {
            foreach (var node in manifest)
            {
                if (node is not JsonObject entry) continue;
                string srcStl = entry["path"]?.GetValue<string>() ?? "";
                if (string.IsNullOrEmpty(srcStl) || !File.Exists(srcStl))
                {
                    _log.LogWarning("script job {Id}: manifest STL missing, skipping: {Path}", rec.Id, srcStl);
                    continue;
                }

                string partId = "p_" + Token.New();
                string partDir = Path.Combine(_partsDir, partId);
                Directory.CreateDirectory(partDir);
                string meshStl = Path.Combine(partDir, "mesh.stl");
                File.Copy(srcStl, meshStl, overwrite: true);

                var info = StlInfo.ReadBinary(meshStl);
                bool? watertight = entry["watertight"] is JsonValue wv && wv.TryGetValue(out bool wt) ? wt : null;
                string partName = entry["name"]?.GetValue<string>() ?? partId;

                var opParams = new JsonObject
                {
                    ["name"] = rec.PendingScriptName,
                    ["params"] = rec.PendingScriptParams is JsonNode pn ? JsonNode.Parse(pn.ToJsonString()) : null,
                    ["scriptSha256"] = rec.PendingScriptSha,
                };

                var part = new PartInfo
                {
                    id = partId,
                    name = partName,
                    sourceFormat = "derived",
                    stlUrl = $"/api/parts/{partId}/mesh.stl",
                    triangles = info.Triangles,
                    bbox = BboxDto.From(info.Bbox),
                    volumeMM3 = info.VolumeMM3,
                    surfaceAreaMM2 = info.SurfaceAreaMM2,
                    cogMM = info.CogMM,
                    watertight = watertight,
                    derived = new DerivedDto
                    {
                        op = "script",
                        label = $"SCRIPT · {rec.PendingScriptName}",
                        sourceIds = new List<string>(),
                        opParams = opParams,
                    },
                    StlPath = meshStl,
                    Dir = partDir,
                };
                _parts.Add(part);
                registered.Add(part);
            }
        }

        lock (rec.Gate) rec.ResultParts = registered;
        _log.LogInformation("script job {Id} registered {Count} part(s)", rec.Id, registered.Count);
    }

    private static void TryDeleteDir(string? dir)
    {
        try { if (!string.IsNullOrEmpty(dir) && Directory.Exists(dir)) Directory.Delete(dir, recursive: true); }
        catch { /* best effort */ }
    }

    private void OnWorkerStdout(JobRecord rec, string? line)
    {
        if (string.IsNullOrWhiteSpace(line)) return;
        JsonDocument doc;
        try { doc = JsonDocument.Parse(line); }
        catch { return; } // non-JSON chatter — ignore
        using (doc)
        {
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object) return;
            lock (rec.Gate)
            {
                if (root.TryGetProperty("stats", out var stats) && stats.ValueKind == JsonValueKind.Object)
                {
                    // Capture the worker's stats object VERBATIM (deep clone the raw
                    // JSON) so every field — including the flow metrics, warnings and
                    // profile arrays — flows through to the client unchanged.
                    rec.Stats = JsonNode.Parse(stats.GetRawText());
                    rec.Stage = "done";
                    rec.Progress = 1.0;
                }
                else if (root.TryGetProperty("stage", out var st))
                {
                    rec.Stage = st.GetString() ?? rec.Stage;
                    if (root.TryGetProperty("progress", out var pr) && pr.ValueKind == JsonValueKind.Number)
                        rec.Progress = pr.GetDouble();
                }
                else if (root.TryGetProperty("log", out var lg) && lg.ValueKind == JsonValueKind.String)
                {
                    // Script Log(...) note — collect into the job's log[] (in order).
                    rec.LogLines.Add(lg.GetString() ?? "");
                }
            }
        }
    }

    private static string ParseWorkerError(string stderr, int exit)
    {
        string s = stderr.Trim();
        if (s.Length > 0)
        {
            // Worker emits a single {"error","stage"} JSON line on failure.
            var lines = s.Split('\n');
            for (int i = lines.Length - 1; i >= 0; i--)
            {
                string t = lines[i].Trim();
                if (t.Length == 0) continue;
                try
                {
                    using var doc = JsonDocument.Parse(t);
                    if (doc.RootElement.TryGetProperty("error", out var ep))
                        return ep.GetString() ?? t;
                }
                catch { }
                return t; // last non-empty non-JSON line
            }
        }
        return $"worker exited with code {exit}";
    }

    /// <summary>
    /// If the worker's last stderr JSON line carried MORE than the bare
    /// {error,stage} (e.g. a script's scriptError[] diagnostics), return that
    /// whole object so agents get the structured detail. Null otherwise.
    /// </summary>
    private static JsonNode? ParseWorkerErrorData(string stderr)
    {
        string s = stderr.Trim();
        if (s.Length == 0) return null;
        var lines = s.Split('\n');
        for (int i = lines.Length - 1; i >= 0; i--)
        {
            string t = lines[i].Trim();
            if (t.Length == 0) continue;
            try
            {
                var node = JsonNode.Parse(t);
                if (node is JsonObject o &&
                    (o.ContainsKey("scriptError") || o.Count > 2))
                    return node;
            }
            catch { }
            return null;
        }
        return null;
    }

    // ---- Cancellation ------------------------------------------------------

    public bool Cancel(string id)
    {
        if (!_jobs.TryGetValue(id, out var rec)) return false;
        lock (rec.Gate)
        {
            rec.CancelRequested = true;
            if (rec.State == JobState.Queued)
            {
                rec.State = JobState.Cancelled;
                rec.Stage = "cancelled";
            }
            else if (rec.State == JobState.Running && rec.Proc != null)
            {
                try { if (!rec.Proc.HasExited) rec.Proc.Kill(entireProcessTree: true); }
                catch (Exception ex) { _log.LogWarning(ex, "failed to kill worker for job {Id}", id); }
            }
        }
        return true;
    }

    // ---- STEP export (POST /jobs/{id}/step) --------------------------------

    /// <summary>
    /// Kick off faceted-STEP conversion for a completed job. Runs sidecar
    /// stl2step on the coarse STL if the worker produced one, else the result
    /// STL. If a targetTriangles override is supplied and the chosen source has
    /// more triangles than that, an auxiliary coarseOnly worker pass remeshes
    /// first (the plan's "second worker invocation" fallback). Async: state is
    /// folded into JobStatus.step. Returns false if the job is not Done.
    /// </summary>
    public bool StartStepExport(string id, int? targetTriangles)
    {
        if (!_jobs.TryGetValue(id, out var rec)) return false;
        lock (rec.Gate)
        {
            if (rec.State != JobState.Done) return false;
            if (rec.StepState == StepState.Running) return true; // already running — idempotent
            rec.StepState = StepState.Running;
            rec.StepError = null;
            rec.StepWarning = null;
            rec.StepTriangles = null;
        }

        _ = Task.Run(() => RunStepExportAsync(rec, targetTriangles));
        return true;
    }

    private async Task RunStepExportAsync(JobRecord rec, int? targetTriangles)
    {
        try
        {
            // Choose source: worker-produced coarse STL if present, else result.
            string source = (rec.CoarseStlPath != null && File.Exists(rec.CoarseStlPath))
                ? rec.CoarseStlPath
                : rec.ResultStlPath;

            if (!File.Exists(source))
                throw new SidecarException($"result STL missing for job {rec.Id}: {source}");

            // Optional override budget: remesh coarser if the source is too dense.
            if (targetTriangles is int target && target > 0)
            {
                int srcTris = StlInfo.ReadBinary(source).Triangles;
                if (srcTris > target)
                {
                    double coarseVoxel = rec.VoxelSizeMM * Math.Sqrt((double)srcTris / target);
                    string stepCoarse = Path.Combine(rec.Dir, "step_coarse.stl");
                    await RunCoarseOnlyAsync(source, stepCoarse, coarseVoxel);
                    source = stepCoarse;
                }
            }

            var result = await _sidecar.Stl2StepAsync(source, rec.ResultStepPath, maxTris: 500_000,
                timeout: TimeSpan.FromMinutes(10));

            lock (rec.Gate)
            {
                rec.StepState = StepState.Done;
                rec.StepTriangles = result.Triangles;
                rec.StepWarning = result.Warning;
            }
            _log.LogInformation("job {Id} STEP export done: {Tris} tris in {Sec}s", rec.Id, result.Triangles, result.Seconds);
        }
        catch (Exception ex)
        {
            lock (rec.Gate)
            {
                rec.StepState = StepState.Failed;
                // Surface the sidecar's clean {detail} (e.g. "refusing: N triangles
                // exceeds --max-tris 500000. ...") rather than the class-name-prefixed
                // message, so the UI toast is directly actionable.
                rec.StepError = ex is SidecarException se && !string.IsNullOrEmpty(se.Detail)
                    ? se.Detail
                    : ex.Message;
            }
            _log.LogWarning(ex, "job {Id} STEP export failed", rec.Id);
        }
    }

    /// <summary>
    /// Auxiliary coarseOnly worker invocation (throttled by the SAME slot gate as
    /// generate/op jobs, so the live worker count never exceeds MaxConcurrentJobs).
    /// `internal` so the Wave-3 ExportManager can reuse this exact pass for
    /// part→STEP conversions instead of forking a second remesh implementation.
    /// </summary>
    internal async Task RunCoarseOnlyAsync(string inStl, string outStl, double voxelSizeMM)
    {
        if (!File.Exists(_workerPath))
            throw new SidecarException($"worker executable not found: {_workerPath}");

        string jobJson = Path.Combine(Path.GetDirectoryName(outStl)!, "coarseonly_job.json");
        var wj = new Dictionary<string, object?>
        {
            ["mode"] = "coarseOnly",
            ["stlPath"] = inStl,
            ["voxelSizeMM"] = voxelSizeMM,
            ["outputPath"] = outStl,
        };
        File.WriteAllText(jobJson, JsonSerializer.Serialize(wj, CamelOut));

        await _slots.WaitAsync(_shutdown.Token);
        try
        {
            var psi = new ProcessStartInfo
            {
                FileName = _workerPath,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
                WorkingDirectory = _repoRoot,
            };
            psi.ArgumentList.Add(jobJson);
            using var proc = new Process { StartInfo = psi };
            var stderr = new StringBuilder();
            proc.ErrorDataReceived += (_, e) => { if (e.Data != null) stderr.AppendLine(e.Data); };
            proc.Start();
            proc.BeginOutputReadLine();
            proc.BeginErrorReadLine();
            await proc.WaitForExitAsync();
            if (proc.ExitCode != 0)
                throw new SidecarException($"coarse remesh failed: {ParseWorkerError(stderr.ToString(), proc.ExitCode)}");
        }
        finally { _slots.Release(); }
    }

    // ---- helpers -----------------------------------------------------------

    /// <summary>Serialize a Vec3Dto (or null) to a {x,y,z} object for job.json.</summary>
    private static Dictionary<string, object?> Vec(Vec3Dto? v) => new()
    {
        ["x"] = v?.x ?? 0.0,
        ["y"] = v?.y ?? 0.0,
        ["z"] = v?.z ?? 0.0,
    };

    /// <summary>
    /// Serialize a TransformDto to the worker's TRS shape (translateMM/rotateDeg/
    /// scale, each {x,y,z}), or null if the transform is absent. Only present
    /// components are emitted so an omitted axis stays at the worker default.
    /// </summary>
    private static Dictionary<string, object?>? TrsDict(TransformDto? t)
    {
        if (t is null) return null;
        var d = new Dictionary<string, object?>();
        if (t.translateMM is not null) d["translateMM"] = Vec(t.translateMM);
        if (t.rotateDeg is not null)   d["rotateDeg"]   = Vec(t.rotateDeg);
        if (t.scale is not null)       d["scale"]       = Vec(t.scale);
        return d.Count > 0 ? d : null;
    }

    /// <summary>Serialize a resolved MeshRefPayload to {path, transform} for job.json.</summary>
    private static Dictionary<string, object?> MeshRefDict(MeshRefPayload r) => new()
    {
        ["path"] = r.Path,
        ["transform"] = TrsDict(r.Transform),
    };

    public async ValueTask DisposeAsync()
    {
        _shutdown.Cancel();
        _queue.Writer.TryComplete();
        try { await _dispatcher; } catch { }
        foreach (var rec in _jobs.Values)
        {
            lock (rec.Gate)
            {
                try { if (rec.Proc is { } p && !p.HasExited) p.Kill(entireProcessTree: true); } catch { }
            }
        }
        _shutdown.Dispose();
        _slots.Dispose();
    }
}

// ---- Internal job record ---------------------------------------------------

public enum JobState { Queued, Running, Done, Failed, Cancelled }
public enum StepState { None, Running, Done, Failed }
public enum JobKind { Generate, Op, Script }

public sealed class JobRecord
{
    public string Id = "";
    public string Dir = "";
    public string JobJsonPath = "";
    public string ResultStlPath = "";
    public string? CoarseStlPath;
    public string ResultStepPath = "";
    public double VoxelSizeMM;

    // ---- Wave-1 op jobs (Kind == Op) ----
    public JobKind Kind = JobKind.Generate;
    public string? PendingPartId;      // reserved destination part id
    public string? PendingPartDir;     // reserved part dir (deleted on fail/cancel)
    public string? PendingPartName;    // display name (req.name ?? derived.label)
    public DerivedDto? PendingDerived; // provenance to stamp on the result part
    public PartInfo? ResultPart;       // set on success -> exposed via Snapshot

    // ---- Stage 5 script jobs (Kind == Script) ----
    public string? PendingScriptName;      // display name for SCRIPT · {name}
    public string? PendingScriptSha;       // sha-256 hex of the code (provenance)
    public JsonNode? PendingScriptParams;  // user params (provenance)
    public List<PartInfo>? ResultParts;    // every registered SavePart output
    public readonly List<string> LogLines = new(); // script Log(...) notes, in order

    public readonly object Gate = new();
    public JobState State = JobState.Queued;
    public string Stage = "queued";
    public double Progress;
    public JsonNode? Stats;
    public string? Warning;
    public string? Error;
    public JsonNode? ErrorData;         // full worker error JSON (e.g. scriptError[])
    public readonly StringBuilder Stderr = new();

    public StepState StepState = StepState.None;
    public int? StepTriangles;
    public string? StepWarning;
    public string? StepError;

    public Process? Proc;
    public volatile bool CancelRequested;

    public JobStatusDto Snapshot()
    {
        lock (Gate)
        {
            return new JobStatusDto
            {
                id = Id,
                state = State.ToString().ToLowerInvariant(),
                stage = Stage,
                progress = Progress,
                stats = Stats,
                warning = Warning,
                error = Error,
                errorData = ErrorData,
                step = new StepStatusDto
                {
                    state = StepState.ToString().ToLowerInvariant(),
                    triangles = StepTriangles,
                    warning = StepWarning,
                    error = StepError,
                },
                part = ResultPart,
                parts = ResultParts,
                log = LogLines.Count > 0 ? new List<string>(LogLines) : null,
            };
        }
    }
}

// ---- Short id tokens -------------------------------------------------------

public static class Token
{
    private const string Alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
    public static string New(int len = 8)
    {
        Span<char> buf = stackalloc char[len];
        var rnd = Random.Shared;
        for (int i = 0; i < len; i++) buf[i] = Alphabet[rnd.Next(Alphabet.Length)];
        return new string(buf);
    }
}
