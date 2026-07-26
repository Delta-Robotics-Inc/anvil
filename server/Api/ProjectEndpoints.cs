//
// ProjectEndpoints — PROJECT SAVE / OPEN (the `.anvil` bundle).
//
//   POST /api/project/save  — JSON scene manifest → streams one .anvil (a ZIP)
//   POST /api/project/open  — multipart .anvil    → registers its parts, returns
//                             the manifest with the NEW part ids
//
// A `.anvil` file is a plain ZIP with a flat, forward-versioned layout:
//
//   project.json          { anvil:1, savedAt, upAxis, latticeParams, parts:[…] }
//   parts/0.stl           the SOURCE mesh of row 0 (binary STL, verbatim)
//   parts/0_lattice.stl   its lattice mesh, when that row is latticed
//   parts/1.stl           …
//
// Deliberately NOT bundled: scripts (they live in the server-side library, see
// /api/scripts) and job artefacts. A project is the SCENE — meshes plus the row
// state needed to put them back exactly where they were.
//
// Coordinates are preserved VERBATIM: the STL bytes are copied without a single
// transform, and each row's non-destructive TRS travels in the manifest. Opening
// a project therefore reproduces the same world positions, and an export after
// an open is byte-identical to one taken before the save.
//
// This endpoint pair is pure packaging/unpacking. Save changes NO server state;
// open only ADDS parts (registered through the same path as any other local file
// import) and never touches what is already loaded — the FRONTEND decides when
// to clear its scene.
//
using System.IO.Compression;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using Anvil.Server.Jobs;
using Anvil.Server.Sidecar;
using Anvil.Server.Stl;

namespace Anvil.Server.Api;

public static class ProjectEndpoints
{
    /// <summary>Bundle schema version this build WRITES (and the max it reads).</summary>
    public const int FormatVersion = 1;

    private const string ManifestEntry = "project.json";
    private static readonly string[] UpAxes = { "+y", "-y", "+z", "-z" };

    private static readonly JsonSerializerOptions ManifestJson = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        WriteIndented = true,
    };
    private static readonly JsonSerializerOptions ManifestRead = new()
    {
        PropertyNameCaseInsensitive = true,
    };

    public static void MapProjectApi(this WebApplication app)
    {
        var api = app.MapGroup("/api");

        api.MapPost("/project/save", SaveProject);
        api.MapPost("/project/open", OpenProject).DisableAntiforgery();
    }

    // ── POST /api/project/save ──────────────────────────────────────────
    // Everything is validated BEFORE the first byte of the zip is written: once
    // the response stream is open a failure can no longer become a 400.
    private static IResult SaveProject(ProjectSaveDto req, PartStore parts, ILoggerFactory lf)
    {
        var log = lf.CreateLogger("Project");
        if (req is null) return Results.BadRequest(new { error = "missing project save body" });

        var rows = req.parts ?? new List<ProjectSavePartDto>();
        if (rows.Count == 0)
            return Results.BadRequest(new { error = "nothing to save: the project has no parts" });

        string upAxis = (req.upAxis ?? "+z").Trim().ToLowerInvariant();
        if (Array.IndexOf(UpAxes, upAxis) < 0)
            return Results.BadRequest(new { error = $"invalid upAxis '{req.upAxis}' (expected +y, -y, +z or -z)" });

        // Resolve every mesh up front (part exists AND its file is on disk).
        var resolved = new List<(ProjectSavePartDto row, PartInfo src, PartInfo? lat)>(rows.Count);
        for (int i = 0; i < rows.Count; i++)
        {
            var row = rows[i];
            if (row is null || string.IsNullOrWhiteSpace(row.partId))
                return Results.BadRequest(new { error = $"parts[{i}] is missing 'partId'" });
            if (!parts.TryGet(row.partId!, out var src))
                return Results.BadRequest(new { error = $"part not found: {row.partId}" });
            if (!File.Exists(src.StlPath))
                return Results.BadRequest(new { error = $"part mesh missing on disk: {row.partId}" });

            PartInfo? lat = null;
            if (!string.IsNullOrWhiteSpace(row.latticePartId))
            {
                if (!parts.TryGet(row.latticePartId!, out var l))
                    return Results.BadRequest(new { error = $"lattice part not found: {row.latticePartId}" });
                if (!File.Exists(l.StlPath))
                    return Results.BadRequest(new { error = $"lattice mesh missing on disk: {row.latticePartId}" });
                lat = l;
            }
            resolved.Add((row, src, lat));
        }

        // Manifest (row order IS the objects-list order; latticeSourceRows index
        // into this same array, so a fuse-mode lattice keeps every ghost link).
        var manifest = new ProjectManifest
        {
            anvil = FormatVersion,
            savedAt = DateTime.UtcNow.ToString("o"),
            upAxis = upAxis,
            latticeParams = req.latticeParams,
            parts = new List<ProjectManifestPart>(resolved.Count),
        };
        for (int i = 0; i < resolved.Count; i++)
        {
            var (row, src, lat) = resolved[i];
            manifest.parts.Add(new ProjectManifestPart
            {
                file = $"parts/{i}.stl",
                name = string.IsNullOrWhiteSpace(row.name) ? src.name : row.name!,
                role = string.IsNullOrWhiteSpace(row.role) ? "part" : row.role!,
                colorHex = string.IsNullOrWhiteSpace(row.colorHex) ? null : row.colorHex,
                visible = row.visible ?? true,
                ghostVisible = row.ghostVisible ?? true,
                trs = row.trs,
                sourceFormat = string.IsNullOrWhiteSpace(row.sourceFormat) ? src.sourceFormat : row.sourceFormat,
                derived = src.derived,
                latticed = lat != null,
                latticeFile = lat != null ? $"parts/{i}_lattice.stl" : null,
                latticeName = lat?.name,
                latticeTrs = lat != null ? row.latticeTrs : null,
                latticeDerived = lat?.derived,
                latticeSourceRows = lat != null ? (row.latticeSourceRows ?? new List<int> { i }) : null,
            });
        }

        string fileName = $"anvil_project_{DateTime.Now:yyyy-MM-dd}.anvil";
        log.LogInformation("project save: {Rows} rows ({Lattices} latticed) → {File}",
            manifest.parts.Count, manifest.parts.Count(p => p.latticed), fileName);

        // The zip is assembled into a SELF-DELETING temp file, not straight onto
        // the response: ZipArchive.Dispose writes the central directory with
        // SYNCHRONOUS writes, and Kestrel refuses synchronous IO on a response
        // body (AllowSynchronousIO is off, and turning it on for the whole server
        // to save one temp file is the wrong trade). FileOptions.DeleteOnClose
        // means the OS reclaims it when Kestrel disposes the stream, on every
        // path — completion, client abort, or exception.
        string spool = Path.Combine(Path.GetTempPath(), "anvil_save_" + Token.New() + ".anvil");
        var stream = new FileStream(spool, FileMode.Create, FileAccess.ReadWrite, FileShare.None,
            bufferSize: 64 * 1024, FileOptions.DeleteOnClose);
        try
        {
            using (var zip = new ZipArchive(stream, ZipArchiveMode.Create, leaveOpen: true))
            {
                var entry = zip.CreateEntry(ManifestEntry, CompressionLevel.Optimal);
                using (var es = entry.Open())
                {
                    byte[] json = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(manifest, ManifestJson));
                    es.Write(json, 0, json.Length);
                }

                for (int i = 0; i < resolved.Count; i++)
                {
                    var (_, src, lat) = resolved[i];
                    CopyIn(zip, src.StlPath, $"parts/{i}.stl");
                    if (lat != null) CopyIn(zip, lat.StlPath, $"parts/{i}_lattice.stl");
                }
            }
            stream.Position = 0;
        }
        catch
        {
            stream.Dispose();   // takes the spool file with it
            throw;
        }
        return Results.Stream(stream, "application/zip", fileDownloadName: fileName);
    }

    private static void CopyIn(ZipArchive zip, string path, string entryName)
    {
        var e = zip.CreateEntry(entryName, CompressionLevel.Optimal);
        using var es = e.Open();
        using var fs = File.OpenRead(path);
        fs.CopyTo(es);
    }

    // ── POST /api/project/open ──────────────────────────────────────────
    // Unpack → validate → register each mesh through the SAME local-file path an
    // MCP `add_part_from_file` uses, so an opened part is indistinguishable from
    // an imported one. Entry payloads are written to OUR OWN temp filenames — an
    // entry name from the archive is never used as a path, so a crafted bundle
    // cannot write outside the temp folder.
    private static async Task<IResult> OpenProject(
        HttpRequest req, PartStore parts, PythonSidecar sidecar, AppPaths paths, ILoggerFactory lf)
    {
        var log = lf.CreateLogger("Project");
        if (!req.HasFormContentType)
            return Results.BadRequest(new { error = "expected multipart/form-data with a 'file' field" });

        var form = await req.ReadFormAsync();
        var file = form.Files["file"] ?? (form.Files.Count > 0 ? form.Files[0] : null);
        if (file is null || file.Length == 0)
            return Results.BadRequest(new { error = "no file uploaded (multipart field 'file')" });

        string temp = Path.Combine(Path.GetTempPath(), "anvil_open_" + Token.New());
        Directory.CreateDirectory(temp);
        try
        {
            string bundlePath = Path.Combine(temp, "bundle.anvil");
            await using (var fs = File.Create(bundlePath))
                await file.CopyToAsync(fs);

            ZipArchive zip;
            try { zip = ZipFile.OpenRead(bundlePath); }
            catch (InvalidDataException)
            {
                return Results.BadRequest(new
                {
                    error = "not a valid .anvil project: the file is not a ZIP archive. " +
                            "A .anvil bundle is written by SAVE in the Anvil header."
                });
            }

            using (zip)
            {
                var manifestEntry = zip.GetEntry(ManifestEntry);
                if (manifestEntry is null)
                    return Results.BadRequest(new
                    {
                        error = "not a valid .anvil project: project.json is missing from the bundle."
                    });

                ProjectManifest? man;
                try
                {
                    await using var ms = manifestEntry.Open();
                    man = await JsonSerializer.DeserializeAsync<ProjectManifest>(ms, ManifestRead);
                }
                catch (JsonException je)
                {
                    return Results.BadRequest(new { error = $"project.json is not valid JSON: {je.Message}" });
                }
                if (man is null)
                    return Results.BadRequest(new { error = "project.json is empty" });

                if (man.anvil <= 0)
                    return Results.BadRequest(new { error = "project.json has no 'anvil' format version" });
                if (man.anvil > FormatVersion)
                    return Results.BadRequest(new
                    {
                        error = $"this project was written by a newer Anvil (format {man.anvil}; " +
                                $"this build reads up to {FormatVersion}). Update Anvil to open it."
                    });

                string upAxis = (man.upAxis ?? "+z").Trim().ToLowerInvariant();
                if (Array.IndexOf(UpAxes, upAxis) < 0) upAxis = "+z";

                var rows = man.parts ?? new List<ProjectManifestPart>();
                if (rows.Count == 0)
                    return Results.BadRequest(new { error = "this project contains no parts" });

                // ---- validate every referenced entry BEFORE registering anything ----
                var staged = new List<(ProjectManifestPart row, string srcPath, string? latPath)>(rows.Count);
                for (int i = 0; i < rows.Count; i++)
                {
                    var row = rows[i];
                    if (row is null || string.IsNullOrWhiteSpace(row.file))
                        return Results.BadRequest(new { error = $"parts[{i}] is missing 'file'" });

                    var (srcPath, srcErr) = await Extract(zip, row.file!, temp, $"{i}", i, "part");
                    if (srcErr != null) return Results.BadRequest(new { error = srcErr });

                    string? latPath = null;
                    if (row.latticed)
                    {
                        if (string.IsNullOrWhiteSpace(row.latticeFile))
                            return Results.BadRequest(new { error = $"parts[{i}] is latticed but has no 'latticeFile'" });
                        var (lp, latErr) = await Extract(zip, row.latticeFile!, temp, $"{i}_lattice", i, "lattice");
                        if (latErr != null) return Results.BadRequest(new { error = latErr });
                        latPath = lp;
                    }
                    staged.Add((row!, srcPath!, latPath));
                }

                // ---- register (same pipeline as any local-file import) ----
                var outRows = new List<ProjectOpenPart>(staged.Count);
                foreach (var (row, srcPath, latPath) in staged)
                {
                    var (part, err) = await Endpoints.RegisterPartFromLocalFile(srcPath, parts, sidecar, paths, log);
                    if (part is null)
                        return Results.BadRequest(new { error = $"could not load \"{row.name}\": {err}" });

                    PartInfo? latPart = null;
                    if (latPath != null)
                    {
                        var (lp, lerr) = await Endpoints.RegisterPartFromLocalFile(latPath, parts, sidecar, paths, log);
                        if (lp is null)
                            return Results.BadRequest(new { error = $"could not load the lattice of \"{row.name}\": {lerr}" });
                        latPart = lp;
                    }

                    // The registered part is named after the temp file; the row's
                    // OWN name is what the objects list shows, so hand it back.
                    part.name = string.IsNullOrWhiteSpace(row.name) ? part.name : row.name!;
                    if (latPart != null && !string.IsNullOrWhiteSpace(row.latticeName))
                        latPart.name = row.latticeName!;
                    // Provenance travels with the bundle (the row's LATTICE badge and
                    // the "└ PRIM · BOX …" sub-line are read from it).
                    if (row.derived != null) part.derived = row.derived;
                    if (latPart != null && row.latticeDerived != null) latPart.derived = row.latticeDerived;

                    outRows.Add(new ProjectOpenPart
                    {
                        partId = part.id,
                        latticePartId = latPart?.id,
                        name = part.name,
                        role = string.IsNullOrWhiteSpace(row.role) ? "part" : row.role!,
                        colorHex = row.colorHex,
                        visible = row.visible,
                        ghostVisible = row.ghostVisible,
                        trs = row.trs,
                        latticeTrs = row.latticeTrs,
                        sourceFormat = row.sourceFormat,
                        latticed = latPart != null,
                        latticeSourceRows = row.latticeSourceRows,
                        part = part,
                        latticePart = latPart,
                    });
                }

                log.LogInformation("project open: {Rows} rows ({Lattices} latticed) from '{Name}'",
                    outRows.Count, outRows.Count(r => r.latticed), file.FileName);

                return Results.Ok(new ProjectOpenResult
                {
                    anvil = man.anvil,
                    savedAt = man.savedAt,
                    upAxis = upAxis,
                    latticeParams = man.latticeParams,
                    parts = outRows,
                });
            }
        }
        catch (Exception ex)
        {
            log.LogError(ex, "project open failed");
            return Results.Problem(detail: ex.Message, statusCode: 500);
        }
        finally
        {
            try { if (Directory.Exists(temp)) Directory.Delete(temp, recursive: true); } catch { /* best effort */ }
        }
    }

    /// <summary>
    /// Pull one archive entry out to a temp file OF OUR OWN NAMING and check it
    /// really is a binary STL. Returns (path, null) or (null, error message).
    /// </summary>
    private static async Task<(string? path, string? error)> Extract(
        ZipArchive zip, string entryName, string temp, string stem, int index, string what)
    {
        var entry = zip.GetEntry(entryName);
        if (entry is null)
            return (null, $"parts[{index}]: the bundle has no entry '{entryName}' (the {what} mesh is missing)");

        string outPath = Path.Combine(temp, stem + ".stl");
        await using (var es = entry.Open())
        await using (var fs = File.Create(outPath))
            await es.CopyToAsync(fs);

        var kind = StlInfo.Detect(outPath);
        if (kind == StlKind.Ascii)
            return (null, $"parts[{index}]: '{entryName}' is an ASCII STL; an .anvil bundle stores binary STL only");
        if (kind == StlKind.Invalid)
            return (null, $"parts[{index}]: '{entryName}' is not a valid binary STL");
        return (outPath, null);
    }
}

// ── DTOs ────────────────────────────────────────────────────────────────
// The request the frontend posts to /project/save. `trs`/`latticeTrs`/
// `latticeParams` are opaque JSON: the server round-trips them verbatim so a
// panel gaining a field never needs a server change.
public sealed class ProjectSaveDto
{
    public List<ProjectSavePartDto>? parts { get; set; }
    public string? upAxis { get; set; }
    public JsonNode? latticeParams { get; set; }
}

public sealed class ProjectSavePartDto
{
    public string? partId { get; set; }
    public string? latticePartId { get; set; }
    public string? name { get; set; }
    public string? role { get; set; }
    public string? colorHex { get; set; }
    public string? sourceFormat { get; set; }
    public bool? visible { get; set; }        // the UNIT mesh (the lattice, when latticed)
    public bool? ghostVisible { get; set; }   // the source shell behind a lattice
    public JsonNode? trs { get; set; }
    public JsonNode? latticeTrs { get; set; }
    public List<int>? latticeSourceRows { get; set; }
}

/// <summary>project.json — the whole bundle manifest.</summary>
public sealed class ProjectManifest
{
    public int anvil { get; set; }
    public string? savedAt { get; set; }
    public string? upAxis { get; set; }
    public JsonNode? latticeParams { get; set; }
    public List<ProjectManifestPart>? parts { get; set; }
}

public sealed class ProjectManifestPart
{
    public string file { get; set; } = "";
    public string name { get; set; } = "";
    public string role { get; set; } = "part";
    public string? colorHex { get; set; }
    public bool visible { get; set; } = true;
    public bool ghostVisible { get; set; } = true;
    public JsonNode? trs { get; set; }
    public string? sourceFormat { get; set; }
    public DerivedDto? derived { get; set; }
    public bool latticed { get; set; }
    public string? latticeFile { get; set; }
    public string? latticeName { get; set; }
    public JsonNode? latticeTrs { get; set; }
    public DerivedDto? latticeDerived { get; set; }
    public List<int>? latticeSourceRows { get; set; }
}

/// <summary>What /project/open hands back: the manifest row + the NEW ids.</summary>
public sealed class ProjectOpenPart
{
    public string partId { get; set; } = "";
    public string? latticePartId { get; set; }
    public string name { get; set; } = "";
    public string role { get; set; } = "part";
    public string? colorHex { get; set; }
    public bool visible { get; set; } = true;
    public bool ghostVisible { get; set; } = true;
    public JsonNode? trs { get; set; }
    public JsonNode? latticeTrs { get; set; }
    public string? sourceFormat { get; set; }
    public bool latticed { get; set; }
    public List<int>? latticeSourceRows { get; set; }
    public PartInfo? part { get; set; }         // fresh mass props / bbox / stlUrl
    public PartInfo? latticePart { get; set; }
}

public sealed class ProjectOpenResult
{
    public int anvil { get; set; }
    public string? savedAt { get; set; }
    public string upAxis { get; set; } = "+z";
    public JsonNode? latticeParams { get; set; }
    public List<ProjectOpenPart> parts { get; set; } = new();
}
