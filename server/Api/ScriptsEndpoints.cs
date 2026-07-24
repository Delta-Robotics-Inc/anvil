//
// ScriptsEndpoints — the /api/scripts surface (Stage 5 in-app scripting).
//
//   POST /api/scripts/run   { code, name?, params?, voxelSizeMM?=0.3 } -> 202 {jobId}
//   GET  /api/scripts        -> [{ id, name, source, savedUtc }]  (library + user)
//   GET  /api/scripts/{id}   -> { id, name, code, source }
//   POST /api/scripts        { name, code } -> 200 { id, name, source, savedUtc }
//
// Running a script spawns a worker "script" job (JobManager.SubmitScript). The
// resulting parts land in the normal parts registry (JobStatus.parts). The same
// submit + library logic backs the MCP run_script / list_scripts / get_script /
// save_script tools (server\Mcp\AnvilTools.cs) via the shared statics here.
//
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using Anvil.Server.Jobs;

namespace Anvil.Server.Api;

/// <summary>POST /api/scripts/run body.</summary>
public sealed class ScriptRunDto
{
    public string? code { get; set; }
    public string? name { get; set; }
    [JsonPropertyName("params")] public JsonNode? Params { get; set; }
    public double? voxelSizeMM { get; set; }
}

/// <summary>POST /api/scripts body.</summary>
public sealed class ScriptSaveDto
{
    public string? name { get; set; }
    public string? code { get; set; }
}

public static class ScriptsEndpoints
{
    // Script voxel bounds (a script has no known bbox, so guard the voxel itself).
    internal const double MinVoxelMM = 0.01;
    internal const double MaxVoxelMM = 5.0;
    internal const double DefaultVoxelMM = 0.3;

    public static void MapScriptsApi(this WebApplication app)
    {
        var api = app.MapGroup("/api");

        api.MapPost("/scripts/run", (ScriptRunDto req, JobManager jobs) =>
        {
            if (SubmitRun(req?.code, req?.name, req?.Params, req?.voxelSizeMM, jobs,
                    out string? jobId, out string? error) is false)
                return Results.BadRequest(new { error });
            return Results.Accepted($"/api/jobs/{jobId}", new { jobId });
        });

        api.MapGet("/scripts", (ScriptLibrary lib) => Results.Ok(lib.List()));

        api.MapGet("/scripts/{id}", (string id, ScriptLibrary lib) =>
        {
            var c = lib.Get(id);
            return c is null
                ? Results.NotFound(new { error = $"script not found: {id}" })
                : Results.Ok(new { id = c.id, name = c.name, code = c.code, source = c.source });
        });

        api.MapPost("/scripts", (ScriptSaveDto req, ScriptLibrary lib) =>
        {
            if (req is null || string.IsNullOrWhiteSpace(req.name) || string.IsNullOrWhiteSpace(req.code))
                return Results.BadRequest(new { error = "name and code are required" });
            try
            {
                var d = lib.Save(req.name!, req.code!);
                return Results.Ok(d);
            }
            catch (ArgumentException ex)
            {
                return Results.BadRequest(new { error = ex.Message });
            }
        });
    }

    /// <summary>
    /// Validate + submit a script run. Shared by the HTTP endpoint and the MCP
    /// run_script tool. Returns false with <paramref name="error"/> set on a
    /// validation failure; true with <paramref name="jobId"/> on success.
    /// </summary>
    public static bool SubmitRun(
        string? code, string? name, JsonNode? scriptParams, double? voxelSizeMM,
        JobManager jobs, out string? jobId, out string? error)
    {
        jobId = null;
        error = null;

        if (string.IsNullOrWhiteSpace(code))
        {
            error = "script code is required (non-empty)";
            return false;
        }

        double voxel = voxelSizeMM ?? DefaultVoxelMM;
        if (voxel < MinVoxelMM || voxel > MaxVoxelMM)
        {
            error = $"voxelSizeMM must be between {MinVoxelMM} and {MaxVoxelMM} mm";
            return false;
        }

        // params must be a JSON object if supplied.
        JsonObject? paramObj = null;
        if (scriptParams is not null)
        {
            if (scriptParams is JsonObject o) paramObj = o;
            else { error = "params must be a JSON object"; return false; }
        }

        jobId = jobs.SubmitScript(code!, name, paramObj, voxel);
        return true;
    }
}
