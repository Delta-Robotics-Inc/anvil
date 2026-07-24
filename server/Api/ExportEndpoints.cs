//
// ExportEndpoints — Wave-3 unified export surface.
//
//   POST /api/export           — queue an export → 202 { exportId }
//   GET  /api/export/{id}      — status { state, note, error, fileName, … }
//   GET  /api/export/{id}/file — the finished artefact, with a HUMAN filename
//
// One endpoint replaces the old split (preview.stl?download=1 for meshes,
// jobs/{id}/step + result.step for CAD): any mix of registered parts and the
// current generate result, in STL or STEP, as separate files (zip) or one merged
// file, named by the user instead of "j_ab12cd_anvil.stl".
//
// The legacy per-job endpoints in Endpoints.cs stay exactly as they were — the
// MCP tools and scripts\test_api.ps1 still drive them.
//
using Anvil.Server.Jobs;

namespace Anvil.Server.Api;

public static class ExportEndpoints
{
    private static readonly string[] Formats = { "stl", "step" };

    public static void MapExportApi(this WebApplication app)
    {
        var api = app.MapGroup("/api");

        api.MapPost("/export", (ExportRequestDto req, PartStore parts, JobManager jobs, ExportManager exports) =>
        {
            if (req is null) return Results.BadRequest(new { error = "missing export request body" });

            string format = (req.format ?? "stl").Trim().ToLowerInvariant();
            if (Array.IndexOf(Formats, format) < 0)
                return Results.BadRequest(new { error = $"invalid format '{req.format}' (expected 'stl' or 'step')" });

            var srcDtos = req.sources ?? new List<ExportSourceDto>();
            if (srcDtos.Count == 0)
                return Results.BadRequest(new { error = "export requires at least one source (partId or jobId)" });

            var resolved = new List<ExportSource>(srcDtos.Count);
            foreach (var s in srcDtos)
            {
                bool hasPart = !string.IsNullOrWhiteSpace(s?.partId);
                bool hasJob = !string.IsNullOrWhiteSpace(s?.jobId);
                if (hasPart == hasJob)
                    return Results.BadRequest(new { error = "each source needs exactly one of 'partId' or 'jobId'" });

                if (hasPart)
                {
                    if (!parts.TryGet(s!.partId!, out var p))
                        return Results.BadRequest(new { error = $"part not found: {s.partId}" });
                    if (!File.Exists(p.StlPath))
                        return Results.BadRequest(new { error = $"part mesh missing on disk: {s.partId}" });
                    resolved.Add(new ExportSource(p.StlPath, p.name,
                        req.transforms != null && req.transforms.TryGetValue(s.partId!, out var t) ? t : null));
                }
                else
                {
                    var rec = jobs.Get(s!.jobId!);
                    if (rec is null)
                        return Results.BadRequest(new { error = $"job not found: {s.jobId}" });
                    if (!File.Exists(rec.ResultStlPath))
                        return Results.BadRequest(new
                        {
                            error = $"job has no result mesh yet (state: {rec.Snapshot().state}): {s.jobId}"
                        });
                    // The generate result is already in world coordinates (the worker
                    // baked every input TRS) — never transform it again.
                    resolved.Add(new ExportSource(rec.ResultStlPath, "result", null));
                }
            }

            string baseName = ExportManager.Sanitize(req.name);
            string id = exports.Start(resolved, format, req.combined, baseName, req.targetTriangles);
            return Results.Accepted($"/api/export/{id}", new { exportId = id });
        });

        api.MapGet("/export/{id}", (string id, ExportManager exports) =>
        {
            var st = exports.Status(id);
            return st is null ? Results.NotFound(new { error = $"export not found: {id}" }) : Results.Ok(st);
        });

        api.MapGet("/export/{id}/file", (string id, ExportManager exports) =>
        {
            var rec = exports.Get(id);
            if (rec is null) return Results.NotFound(new { error = $"export not found: {id}" });

            string? path, name, state;
            lock (rec.Gate)
            {
                path = rec.FilePath; name = rec.FileName;
                state = rec.State.ToString().ToLowerInvariant();
            }
            if (path is null || name is null || !File.Exists(path))
                return Results.Problem(
                    detail: $"export not ready (state: {state}); poll GET /api/export/{id} until state=done",
                    statusCode: StatusCodes.Status409Conflict);

            string mime = Path.GetExtension(name).ToLowerInvariant() switch
            {
                ".zip" => "application/zip",
                ".step" => "application/step",
                _ => "application/octet-stream",
            };
            return Results.File(path, mime, fileDownloadName: name);
        });
    }
}
