//
// JobManager — spawns/tracks/kills InfillWorker.exe processes.
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
using System.Threading.Channels;
using InfillServer.Sidecar;
using InfillServer.Stl;

namespace InfillServer.Jobs;

public sealed class JobManager : IAsyncDisposable
{
    private readonly string _workerPath;   // abs InfillWorker.exe
    private readonly string _jobsDir;      // abs {DataDir}/jobs
    private readonly string _repoRoot;
    private readonly PythonSidecar _sidecar;
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

    public JobManager(string workerPath, string jobsDir, string repoRoot,
        int maxConcurrent, PythonSidecar sidecar, ILogger<JobManager> log)
    {
        _workerPath = workerPath;
        _jobsDir = jobsDir;
        _repoRoot = repoRoot;
        _sidecar = sidecar;
        _log = log;
        _slots = new SemaphoreSlim(Math.Max(1, maxConcurrent), Math.Max(1, maxConcurrent));
        Directory.CreateDirectory(_jobsDir);
        _dispatcher = Task.Run(DispatchLoopAsync);

        if (!File.Exists(_workerPath))
            _log.LogWarning("WorkerPath does not exist yet: {Path} — jobs will fail until the worker is built", _workerPath);
    }

    public string WorkerPath => _workerPath;
    public bool WorkerExists => File.Exists(_workerPath);

    // ---- Submission --------------------------------------------------------

    public sealed record WorkerInputs(string Mode, string? StlPath, string? PositiveStlPath, string? NegativeStlPath);

    /// <summary>Create a job folder, write job.json, enqueue. Returns the job id.</summary>
    public string Submit(JobRequestDto req, WorkerInputs inputs, string? warning)
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
        };
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
        File.WriteAllText(jobJson, JsonSerializer.Serialize(workerJob, CamelOut));

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
        };
        _jobs[id] = rec;
        _queue.Writer.TryWrite(rec);
        _log.LogInformation("job {Id} submitted ({Mode})", id, inputs.Mode);
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
                rec.Error = $"worker executable not found: {_workerPath}. Build the worker project (worker/InfillWorker.csproj).";
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

        lock (rec.Gate)
        {
            rec.Proc = null;
            if (rec.CancelRequested)
            {
                rec.State = JobState.Cancelled;
                rec.Stage = "cancelled";
            }
            else if (exit == 0)
            {
                rec.State = JobState.Done;
                rec.Stage = "done";
                rec.Progress = 1.0;
            }
            else
            {
                rec.State = JobState.Failed;
                rec.Stage = "failed";
                rec.Error = ParseWorkerError(rec.Stderr.ToString(), exit);
            }
        }
        proc.Dispose();
        _log.LogInformation("job {Id} finished: {State} (exit {Exit})", rec.Id, rec.State, exit);
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
                    rec.Stats = new StatsDto
                    {
                        volumeMM3 = GetD(stats, "volumeMM3"),
                        envelopeVolumeMM3 = GetD(stats, "envelopeVolumeMM3"),
                        infillPct = GetD(stats, "infillPct"),
                        triangles = GetI(stats, "triangles"),
                    };
                    rec.Stage = "done";
                    rec.Progress = 1.0;
                }
                else if (root.TryGetProperty("stage", out var st))
                {
                    rec.Stage = st.GetString() ?? rec.Stage;
                    if (root.TryGetProperty("progress", out var pr) && pr.ValueKind == JsonValueKind.Number)
                        rec.Progress = pr.GetDouble();
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

    /// <summary>Auxiliary coarseOnly worker invocation (throttled by the slot gate).</summary>
    private async Task RunCoarseOnlyAsync(string inStl, string outStl, double voxelSizeMM)
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

    private static double GetD(JsonElement e, string name)
        => e.TryGetProperty(name, out var p) && p.ValueKind == JsonValueKind.Number ? p.GetDouble() : 0;
    private static int GetI(JsonElement e, string name)
        => e.TryGetProperty(name, out var p) && p.ValueKind == JsonValueKind.Number ? p.GetInt32() : 0;

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

public sealed class JobRecord
{
    public string Id = "";
    public string Dir = "";
    public string JobJsonPath = "";
    public string ResultStlPath = "";
    public string? CoarseStlPath;
    public string ResultStepPath = "";
    public double VoxelSizeMM;

    public readonly object Gate = new();
    public JobState State = JobState.Queued;
    public string Stage = "queued";
    public double Progress;
    public StatsDto? Stats;
    public string? Warning;
    public string? Error;
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
                step = new StepStatusDto
                {
                    state = StepState.ToString().ToLowerInvariant(),
                    triangles = StepTriangles,
                    warning = StepWarning,
                    error = StepError,
                },
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
