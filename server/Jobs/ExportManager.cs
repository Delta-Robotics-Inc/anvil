//
// ExportManager — the ONE export pipeline behind POST /api/export.
//
// Every export (STL or STEP, one source or many, separate or combined) becomes a
// tracked async record so the frontend has a single uniform flow: 202 {exportId}
// → poll GET /api/export/{id} → GET /api/export/{id}/file. STL work finishes in
// milliseconds; STEP shells out to the worker (coarse remesh) and the Python
// sidecar (stl2step) and can take minutes — same contract either way.
//
// Concurrency: max 1 export at a time, FIFO (a Channel + a single dispatcher that
// awaits each run). The auxiliary coarse remesh it may spawn still goes through
// JobManager's slot gate, so the total number of live workers stays bounded.
//
// Every artefact lands under {DataDir}/exports/{id}/ — the baked per-source
// copies, the merged mesh, the converted STEPs, and the final file that
// /file streams back with a HUMAN filename ("bracket_gyroid.step"), not a job id.
//
using System.Collections.Concurrent;
using System.IO.Compression;
using System.Threading.Channels;
using Anvil.Server.Api;
using Anvil.Server.Sidecar;
using Anvil.Server.Stl;

namespace Anvil.Server.Jobs;

public enum ExportState { Queued, Running, Done, Failed }

/// <summary>One resolved thing to export: an abs STL path, a display name for
/// the zip entry, and the TRS to bake (null = already in world coordinates).</summary>
public sealed record ExportSource(string StlPath, string DisplayName, TransformDto? Transform);

public sealed class ExportRecord
{
    public string Id = "";
    public string Dir = "";
    public string Format = "stl";          // stl | step
    public bool Combined;
    public string BaseName = "anvil_export";
    public int? TargetTriangles;
    public IReadOnlyList<ExportSource> Sources = Array.Empty<ExportSource>();

    public readonly object Gate = new();
    public ExportState State = ExportState.Queued;
    public string? Note;
    public string? Error;
    public string? Warning;
    public int? Triangles;
    public string? FileName;               // e.g. "bracket_set.zip"
    public string? FilePath;               // abs path to the finished artefact

    public ExportStatusDto Snapshot()
    {
        lock (Gate)
        {
            return new ExportStatusDto
            {
                id = Id,
                state = State.ToString().ToLowerInvariant(),
                note = Note,
                error = Error,
                fileName = FileName,
                format = Format,
                combined = Combined,
                sources = Sources.Count,
                triangles = Triangles,
                warning = Warning,
            };
        }
    }
}

public sealed class ExportManager : IAsyncDisposable
{
    private readonly string _exportsDir;
    private readonly JobManager _jobs;
    private readonly PythonSidecar _sidecar;
    private readonly ILogger<ExportManager> _log;

    private readonly ConcurrentDictionary<string, ExportRecord> _exports = new();
    private readonly Channel<ExportRecord> _queue = Channel.CreateUnbounded<ExportRecord>(
        new UnboundedChannelOptions { SingleReader = true, SingleWriter = false });
    private readonly Task _dispatcher;
    private readonly CancellationTokenSource _shutdown = new();

    public ExportManager(AppPaths paths, JobManager jobs, PythonSidecar sidecar, ILogger<ExportManager> log)
    {
        _exportsDir = Path.Combine(paths.DataDir, "exports");
        _jobs = jobs;
        _sidecar = sidecar;
        _log = log;
        Directory.CreateDirectory(_exportsDir);
        _dispatcher = Task.Run(DispatchLoopAsync);
    }

    // ---- Submission --------------------------------------------------------

    /// <summary>Queue an export. Returns the export id (poll GET /api/export/{id}).</summary>
    public string Start(IReadOnlyList<ExportSource> sources, string format, bool combined,
        string baseName, int? targetTriangles)
    {
        string id = "e_" + Token.New();
        string dir = Path.Combine(_exportsDir, id);
        Directory.CreateDirectory(dir);

        var rec = new ExportRecord
        {
            Id = id,
            Dir = dir,
            Format = format,
            Combined = combined && sources.Count > 1,
            BaseName = baseName,
            TargetTriangles = targetTriangles,
            Sources = sources,
            State = ExportState.Queued,
            Note = "queued",
        };
        _exports[id] = rec;
        _queue.Writer.TryWrite(rec);
        _log.LogInformation("export {Id} queued: {Count} source(s), {Format}, combined={Combined}, name='{Name}'",
            id, sources.Count, format, rec.Combined, baseName);
        return id;
    }

    public ExportRecord? Get(string id) => _exports.TryGetValue(id, out var r) ? r : null;

    public ExportStatusDto? Status(string id) => _exports.TryGetValue(id, out var r) ? r.Snapshot() : null;

    // ---- Dispatch (max 1 concurrent, FIFO) ---------------------------------

    private async Task DispatchLoopAsync()
    {
        try
        {
            while (await _queue.Reader.WaitToReadAsync(_shutdown.Token))
            {
                while (_queue.Reader.TryRead(out var rec))
                {
                    // Awaited inline: one export runs at a time, in submission order.
                    try { await RunAsync(rec); }
                    catch (Exception ex)
                    {
                        _log.LogError(ex, "export {Id} crashed", rec.Id);
                        Fail(rec, ex is SidecarException se && !string.IsNullOrEmpty(se.Detail) ? se.Detail! : ex.Message);
                    }
                }
            }
        }
        catch (OperationCanceledException) { /* shutting down */ }
    }

    private async Task RunAsync(ExportRecord rec)
    {
        SetNote(rec, ExportState.Running, "preparing…");

        // ---- 1. Bake each source's TRS into a private copy -------------------
        // The export must land exactly where the viewport shows the part, so the
        // per-part TRS is applied here (and NOWHERE else — no recentring).
        var staged = new List<(string Path, string Name)>(rec.Sources.Count);
        var usedNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        for (int i = 0; i < rec.Sources.Count; i++)
        {
            var src = rec.Sources[i];
            if (!File.Exists(src.StlPath))
                throw new InvalidDataException($"source mesh missing on disk: {src.StlPath}");

            string entry = UniqueName(Slug(src.DisplayName, $"part_{i + 1}"), usedNames);
            string path = src.StlPath;
            if (!StlTransform.IsIdentity(src.Transform))
            {
                SetNote(rec, ExportState.Running, $"baking transforms {i + 1}/{rec.Sources.Count}…");
                path = Path.Combine(rec.Dir, $"src_{i + 1}.stl");
                StlTransform.Bake(src.StlPath, path, src.Transform);
            }
            staged.Add((path, entry));
        }

        // ---- 2. Produce the artefact ----------------------------------------
        if (rec.Format == "step") await RunStepAsync(rec, staged);
        else RunStl(rec, staged);
    }

    // ---- STL ---------------------------------------------------------------

    private void RunStl(ExportRecord rec, List<(string Path, string Name)> staged)
    {
        if (staged.Count == 1)
        {
            string outPath = Path.Combine(rec.Dir, rec.BaseName + ".stl");
            SetNote(rec, ExportState.Running, "writing STL…");
            CopyIfNeeded(staged[0].Path, outPath);
            Done(rec, outPath, rec.BaseName + ".stl", StlTransform.ReadTriangleCount(outPath));
            return;
        }

        if (rec.Combined)
        {
            string outPath = Path.Combine(rec.Dir, rec.BaseName + ".stl");
            SetNote(rec, ExportState.Running, $"merging {staged.Count} meshes…");
            int tris = StlTransform.Concat(staged.Select(s => s.Path).ToList(), outPath);
            Done(rec, outPath, rec.BaseName + ".stl", tris);
            return;
        }

        // separate → one .stl per source inside a zip
        string zipPath = Path.Combine(rec.Dir, rec.BaseName + ".zip");
        SetNote(rec, ExportState.Running, $"zipping {staged.Count} files…");
        int total = 0;
        using (var zip = ZipFile.Open(zipPath, ZipArchiveMode.Create))
        {
            foreach (var (path, name) in staged)
            {
                zip.CreateEntryFromFile(path, name + ".stl", CompressionLevel.Fastest);
                total += StlTransform.ReadTriangleCount(path);
            }
        }
        Done(rec, zipPath, rec.BaseName + ".zip", total);
    }

    // ---- STEP --------------------------------------------------------------

    private async Task RunStepAsync(ExportRecord rec, List<(string Path, string Name)> staged)
    {
        int target = rec.TargetTriangles is int t && t > 0 ? t : 60_000;

        if (rec.Combined || staged.Count == 1)
        {
            string source = staged[0].Path;
            if (staged.Count > 1)
            {
                SetNote(rec, ExportState.Running, $"merging {staged.Count} meshes…");
                source = Path.Combine(rec.Dir, "merged.stl");
                StlTransform.Concat(staged.Select(s => s.Path).ToList(), source);
            }
            string outPath = Path.Combine(rec.Dir, rec.BaseName + ".step");
            SetNote(rec, ExportState.Running, "converting to STEP…");
            var r = await ToStepAsync(rec, source, outPath, target, "step");
            lock (rec.Gate) { rec.Warning = r.Warning; }
            Done(rec, outPath, rec.BaseName + ".step", r.Triangles);
            return;
        }

        // separate → one .step per source inside a zip
        var made = new List<(string Path, string Name)>();
        int total = 0;
        string? warn = null;
        for (int i = 0; i < staged.Count; i++)
        {
            SetNote(rec, ExportState.Running, $"converting {i + 1}/{staged.Count}…");
            string outStep = Path.Combine(rec.Dir, $"step_{i + 1}.step");
            var r = await ToStepAsync(rec, staged[i].Path, outStep, target, $"step{i + 1}");
            made.Add((outStep, staged[i].Name));
            total += r.Triangles;
            warn ??= r.Warning;
        }

        string zipPath = Path.Combine(rec.Dir, rec.BaseName + ".zip");
        SetNote(rec, ExportState.Running, $"zipping {made.Count} files…");
        using (var zip = ZipFile.Open(zipPath, ZipArchiveMode.Create))
            foreach (var (path, name) in made)
                zip.CreateEntryFromFile(path, name + ".step", CompressionLevel.Fastest);

        lock (rec.Gate) { rec.Warning = warn; }
        Done(rec, zipPath, rec.BaseName + ".zip", total);
    }

    /// <summary>
    /// One mesh → one faceted STEP. Over the triangle budget the mesh is first
    /// remeshed by the SAME coarseOnly worker pass JobManager's STEP export uses
    /// (throttled by its slot gate), then handed to the sidecar's stl2step.
    /// </summary>
    private async Task<Stl2StepResult> ToStepAsync(
        ExportRecord rec, string inStl, string outStep, int target, string tag)
    {
        var info = StlInfo.ReadBinary(inStl);
        string source = inStl;

        if (info.Triangles > target)
        {
            double voxel = CoarseVoxelFor(info, target);
            string coarse = Path.Combine(rec.Dir, $"coarse_{tag}.stl");
            _log.LogInformation("export {Id}: coarsening {Tris} → ~{Target} tris at voxel {Voxel:0.###} mm",
                rec.Id, info.Triangles, target, voxel);
            await _jobs.RunCoarseOnlyAsync(source, coarse, voxel);
            source = coarse;
        }

        return await _sidecar.Stl2StepAsync(source, outStep, maxTris: 500_000,
            timeout: TimeSpan.FromMinutes(10));
    }

    /// <summary>
    /// Voxel size that re-meshes a mesh to roughly <paramref name="target"/>
    /// triangles. Marching cubes emits ~2 triangles per voxel-sized surface patch,
    /// so tris ≈ 2·area/voxel² ⇒ voxel ≈ √(2·area/target). Clamped so the coarse
    /// pass never trips the resolution guard (floor) and never dissolves the part
    /// into a blob (ceiling). Parts carry no generation voxel size of their own —
    /// unlike a generate job — so this estimate is what makes part→STEP work.
    /// </summary>
    private static double CoarseVoxelFor(StlResult info, int target)
    {
        double maxDim = Math.Max(info.Bbox.Max[0] - info.Bbox.Min[0],
                       Math.Max(info.Bbox.Max[1] - info.Bbox.Min[1],
                                info.Bbox.Max[2] - info.Bbox.Min[2]));
        if (maxDim <= 0) maxDim = 1;
        double v = info.SurfaceAreaMM2 > 0 && target > 0
            ? Math.Sqrt(2.0 * info.SurfaceAreaMM2 / target)
            : maxDim / 100.0;
        double floor = Math.Max(0.02, maxDim / 1500.0);   // resolution guard is 2000 across
        double ceiling = Math.Max(floor, maxDim / 8.0);   // keep at least a recognisable shape
        return Math.Clamp(v, floor, ceiling);
    }

    // ---- helpers -----------------------------------------------------------

    private static void CopyIfNeeded(string from, string to)
    {
        if (string.Equals(Path.GetFullPath(from), Path.GetFullPath(to), StringComparison.OrdinalIgnoreCase)) return;
        File.Copy(from, to, overwrite: true);
    }

    private void SetNote(ExportRecord rec, ExportState state, string note)
    {
        lock (rec.Gate) { rec.State = state; rec.Note = note; }
    }

    private void Done(ExportRecord rec, string filePath, string fileName, int triangles)
    {
        lock (rec.Gate)
        {
            rec.State = ExportState.Done;
            rec.Note = "done";
            rec.FilePath = filePath;
            rec.FileName = fileName;
            rec.Triangles = triangles;
        }
        _log.LogInformation("export {Id} done → {File} ({Tris} tris)", rec.Id, fileName, triangles);
    }

    private void Fail(ExportRecord rec, string error)
    {
        lock (rec.Gate)
        {
            rec.State = ExportState.Failed;
            rec.Note = null;
            rec.Error = error;
        }
        _log.LogWarning("export {Id} failed: {Error}", rec.Id, error);
    }

    /// <summary>
    /// Filename sanitizer shared by the base name and the zip entry names: strips
    /// the Windows-illegal set \/:*?"&lt;&gt;| plus control chars, folds separators
    /// to '_', drops a trailing mesh extension, and falls back when empty.
    /// </summary>
    public static string Sanitize(string? raw, string fallback = "anvil_export")
    {
        string s = (raw ?? "").Trim();
        // drop a trailing .stl/.step/.stp so "Cylinder.stl" doesn't become "cylinder_stl"
        foreach (var ext in new[] { ".stl", ".step", ".stp" })
            if (s.EndsWith(ext, StringComparison.OrdinalIgnoreCase)) { s = s[..^ext.Length]; break; }

        var sb = new System.Text.StringBuilder(s.Length);
        foreach (char c in s)
        {
            if (c is '\\' or '/' or ':' or '*' or '?' or '"' or '<' or '>' or '|' || char.IsControl(c)) sb.Append('_');
            else if (char.IsWhiteSpace(c)) sb.Append('_');
            else sb.Append(c);
        }
        s = sb.ToString();
        while (s.Contains("__")) s = s.Replace("__", "_");
        s = s.Trim('.', ' ', '_');
        return s.Length == 0 ? fallback : (s.Length > 120 ? s[..120] : s);
    }

    /// <summary>
    /// Stricter ASCII slug for ZIP ENTRY names, which are derived from part
    /// DISPLAY names ("PRIM · BOX 60×40×20") rather than typed by the user. The
    /// decorative separators would otherwise ride into the archive verbatim, so
    /// '×' folds to 'x' and anything outside [A-Za-z0-9._-] becomes '_' →
    /// "PRIM_BOX_60x40x20.stl". The user's own base name keeps Sanitize's lighter
    /// touch (hyphens, case and unicode they typed on purpose survive).
    /// </summary>
    public static string Slug(string? raw, string fallback = "part")
    {
        string s = Sanitize(raw, "");
        var sb = new System.Text.StringBuilder(s.Length);
        foreach (char c in s)
        {
            char ch = c is '×' or '✕' ? 'x' : c;
            bool keep = (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z')
                     || (ch >= '0' && ch <= '9') || ch is '.' or '-' or '_';
            sb.Append(keep ? ch : '_');
        }
        string t = sb.ToString();
        while (t.Contains("__")) t = t.Replace("__", "_");
        t = t.Trim('.', '-', '_');
        return t.Length == 0 ? fallback : (t.Length > 100 ? t[..100] : t);
    }

    private static string UniqueName(string name, HashSet<string> used)
    {
        if (used.Add(name)) return name;
        for (int n = 2; ; n++)
        {
            string candidate = $"{name}_{n}";
            if (used.Add(candidate)) return candidate;
        }
    }

    public async ValueTask DisposeAsync()
    {
        _shutdown.Cancel();
        _queue.Writer.TryComplete();
        try { await _dispatcher; } catch { }
        _shutdown.Dispose();
    }
}
