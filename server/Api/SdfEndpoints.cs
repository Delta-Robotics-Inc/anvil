//
// SdfEndpoints — per-part signed-distance-field bake for the GPU lattice preview.
//
//   POST /api/parts/{id}/sdf        — bake (or reuse) the part's SDF.
//                                      200 {ready:true}  cached bake already covers it
//                                      202 {jobId}       poll GET /api/jobs/{jobId}
//   GET  /api/parts/{id}/sdf.json   — grid metadata (+ the sdf.bin url).
//   GET  /api/parts/{id}/sdf.bin    — raw Uint8 field, nx*ny*nz bytes, x-fastest.
//
// The bake is the ONE size-dependent step of the preview, so it runs in the
// worker (mode == "sdf") through the SAME queue + slot gate as every other job.
// Artefacts live in the part's own data dir, so deleting the part deletes them.
//
// The field is PART-LOCAL (the mesh is voxelized with NO transform): moving a
// part never invalidates its bake — the client applies the TRS itself.
//
using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Server.Jobs;

namespace Anvil.Server.Api;

public static class SdfEndpoints
{
    internal const int DefaultResolution = 128;
    internal const int MinResolution = 64;
    internal const int MaxResolution = 192;

    public const string BinFile = "sdf.bin";
    public const string JsonFile = "sdf.json";

    public static void MapSdfApi(this WebApplication app)
    {
        var api = app.MapGroup("/api");

        api.MapPost("/parts/{id}/sdf", async (string id, HttpRequest req, PartStore parts, JobManager jobs) =>
        {
            if (!parts.TryGet(id, out var part))
                return Results.NotFound(new { error = $"part not found: {id}" });
            if (string.IsNullOrEmpty(part.StlPath) || !File.Exists(part.StlPath))
                return Results.NotFound(new { error = $"part mesh not found: {id}" });

            // Optional body: {"resolution": int}. An empty/invalid body keeps the
            // default (same tolerance as POST /jobs/{id}/step).
            int? requested = null;
            if (req.ContentLength is > 0)
            {
                try
                {
                    var body = await req.ReadFromJsonAsync<SdfRequestDto>();
                    requested = body?.resolution;
                }
                catch { /* empty/invalid body → default resolution */ }
            }
            int resolution = Math.Clamp(requested ?? DefaultResolution, MinResolution, MaxResolution);

            // Cache: a bake at the same OR a finer resolution already covers this
            // request (a finer field is strictly more information, never stale —
            // the field is part-local, so a moved part never needs a re-bake).
            if (ReadCachedResolution(part.Dir) is int cached && cached >= resolution)
                return Results.Ok(new { ready = true, resolution = cached });

            string jobId = jobs.SubmitSdf(part.id, part.StlPath, part.Dir, resolution);
            return Results.Accepted($"/api/jobs/{jobId}", new { jobId, resolution });
        });

        api.MapGet("/parts/{id}/sdf.json", (string id, PartStore parts) =>
        {
            if (!parts.TryGet(id, out var part))
                return Results.NotFound(new { error = $"part not found: {id}" });

            string jsonPath = Path.Combine(part.Dir, JsonFile);
            string binPath = Path.Combine(part.Dir, BinFile);
            if (!File.Exists(jsonPath) || !File.Exists(binPath))
                return Results.NotFound(new { error = $"sdf not baked for part {id}; POST /api/parts/{id}/sdf first" });

            JsonNode? meta;
            try { meta = JsonNode.Parse(File.ReadAllText(jsonPath)); }
            catch { meta = null; }
            if (meta is not JsonObject obj || obj["nx"] is null)
                return Results.NotFound(new { error = $"sdf metadata unreadable for part {id}; re-bake with POST /api/parts/{id}/sdf" });

            // The worker writes the geometry; only the SERVER knows the route.
            obj["url"] = $"/api/parts/{id}/{BinFile}";
            return Results.Text(obj.ToJsonString(), "application/json");
        });

        api.MapGet("/parts/{id}/sdf.bin", (string id, PartStore parts) =>
        {
            if (!parts.TryGet(id, out var part))
                return Results.NotFound(new { error = $"part not found: {id}" });

            string binPath = Path.Combine(part.Dir, BinFile);
            if (!File.Exists(binPath))
                return Results.NotFound(new { error = $"sdf not baked for part {id}; POST /api/parts/{id}/sdf first" });

            return Results.File(binPath, "application/octet-stream");
        });
    }

    /// <summary>
    /// Resolution of the bake sitting in a part dir, or null when there is none.
    /// A bake only counts when sdf.json parses AND sdf.bin is exactly nx*ny*nz
    /// bytes — a truncated or half-written pair re-bakes instead of being served.
    /// </summary>
    internal static int? ReadCachedResolution(string partDir)
    {
        if (string.IsNullOrEmpty(partDir)) return null;
        string jsonPath = Path.Combine(partDir, JsonFile);
        string binPath = Path.Combine(partDir, BinFile);
        if (!File.Exists(jsonPath) || !File.Exists(binPath)) return null;

        try
        {
            using var doc = JsonDocument.Parse(File.ReadAllText(jsonPath));
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object) return null;
            if (!root.TryGetProperty("nx", out var nxEl) ||
                !root.TryGetProperty("ny", out var nyEl) ||
                !root.TryGetProperty("nz", out var nzEl) ||
                !root.TryGetProperty("resolution", out var resEl)) return null;

            long cells = (long)nxEl.GetInt32() * nyEl.GetInt32() * nzEl.GetInt32();
            if (cells <= 0 || new FileInfo(binPath).Length != cells) return null;
            return resEl.GetInt32();
        }
        catch { return null; }
    }
}
