//
// OpsEndpoints — Wave-1 "Objects & Ops" tool surface.
//
//   POST /api/ops    — run a tool op that produces a NEW derived part.
//   GET  /api/parts  — list every registered part (uploads + derived).
//
// Every op except `duplicate` is a short worker job (mode == "op") that writes a
// new mesh to data/parts/{id}/mesh.stl and, on success, registers a derived
// PartInfo (mass props + provenance) via JobManager. `duplicate` is a synchronous
// file copy that registers immediately.
//
// The op job.json this file drives is emitted by JobManager.SubmitOp and MUST
// match the worker schema (worker\OpJob.cs / worker\MeshUtil.cs):
//   mode:"op", opKind, inputs:[{path,transform:{translateMM,rotateDeg,scale}}],
//   booleanKind, filletMM, shellDirection, shellThicknessMM, offsetDistMM, bake,
//   mirror:{planePoint,planeNormal}, primitive:{kind,sizeMM,centerMM,sides},
//   outputPath, voxelSizeMM.
//
using System.Globalization;
using System.Numerics;
using System.Text.Json;
using System.Text.Json.Serialization;
using Anvil.Server.Jobs;

namespace Anvil.Server.Api;

public static class OpsEndpoints
{
    private static readonly string[] OpKinds =
        { "boolean", "merge", "shell", "offset", "transform", "mirror", "primitive", "duplicate" };
    private static readonly string[] BooleanKinds = { "union", "difference", "intersection" };
    private static readonly string[] ShellDirs = { "inside", "outside", "centered" };
    private static readonly string[] PrimitiveKinds =
        { "cube", "box", "cylinder", "sphere", "geosphere", "cone" };

    private static readonly JsonSerializerOptions OpParamJson = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    public static void MapOpsApi(this WebApplication app)
    {
        var api = app.MapGroup("/api");
        api.MapGet("/parts", (PartStore parts) => Results.Ok(parts.All()));
        api.MapPost("/ops", CreateOp);
    }

    // ---- POST /api/ops -----------------------------------------------------

    private static IResult CreateOp(
        OpRequestDto req, PartStore parts, JobManager jobs, AppPaths paths, ILoggerFactory lf)
    {
        var log = lf.CreateLogger("Ops");
        if (req is null) return Bad("missing op request body");

        string op = (req.op ?? "").Trim().ToLowerInvariant();
        if (Array.IndexOf(OpKinds, op) < 0)
            return Bad($"unknown op '{req.op}' (expected {string.Join('|', OpKinds)})");

        double voxel = req.voxelSizeMM;
        if (voxel <= 0) return Bad("voxelSizeMM must be > 0");
        double minFeature = 1.5 * voxel;   // thickness/offset must clear this

        // ---- primitive: no inputs; validate descriptor + sizes ----
        if (op == "primitive")
        {
            var p = req.primitive;
            if (p is null || p.sizeMM is null)
                return Bad("primitive op requires primitive.sizeMM");
            string pk = (p.kind ?? "").Trim().ToLowerInvariant();
            if (Array.IndexOf(PrimitiveKinds, pk) < 0)
                return Bad($"unknown primitive kind '{p.kind}' (expected {string.Join('|', PrimitiveKinds)})");
            var sz = p.sizeMM;
            if (sz.x <= 0 || sz.y <= 0 || sz.z <= 0)
                return Bad("primitive sizeMM must be > 0 on all axes");

            var c = p.centerMM ?? new Vec3Dto();
            var bbox = BboxDto.From(
                new[] { c.x - sz.x / 2, c.y - sz.y / 2, c.z - sz.z / 2 },
                new[] { c.x + sz.x / 2, c.y + sz.y / 2, c.z + sz.z / 2 });
            if (Endpoints.ResolutionError(bbox.MaxDim(), voxel) is { } pe) return Bad(pe);
            string? pw = Endpoints.ResolutionWarning(bbox.VoxelCount(voxel));

            string plabel = $"PRIM · {pk.ToUpperInvariant()} {Fmt(sz.x)}×{Fmt(sz.y)}×{Fmt(sz.z)}";
            return SubmitWorkerOp(req, op, new List<JobManager.MeshRefPayload>(),
                new List<string>(), plabel, pw, parts, jobs, paths, log);
        }

        // ---- input arity per op ----
        int required = op switch
        {
            "boolean" or "merge" => 2,
            _ => 1,   // shell, offset, transform, mirror, duplicate
        };
        if (ResolveInputs(req, parts, required, out var srcParts, out var refs) is { } inErr)
            return Bad(inErr);

        string a = srcParts[0].name;
        string b = srcParts.Count > 1 ? srcParts[1].name : "";
        var sourceIds = srcParts.Select(sp => sp.id).ToList();

        // ---- duplicate: synchronous mesh copy, register immediately (200) ----
        if (op == "duplicate")
        {
            var src = srcParts[0];
            string dupId = "p_" + Token.New();
            string dupDir = Path.Combine(paths.PartsDir, dupId);
            Directory.CreateDirectory(dupDir);
            string dupStl = Path.Combine(dupDir, "mesh.stl");
            try
            {
                File.Copy(src.StlPath, dupStl, overwrite: true);
            }
            catch (Exception ex)
            {
                TryDeleteDir(dupDir);
                return Results.Problem(detail: $"duplicate copy failed: {ex.Message}", statusCode: 500);
            }

            string dupLabel = $"DUPLICATE · {a}";
            var dupPart = new PartInfo
            {
                id = dupId,
                name = !string.IsNullOrWhiteSpace(req.name) ? req.name!.Trim() : dupLabel,
                sourceFormat = "derived",
                stlUrl = $"/api/parts/{dupId}/mesh.stl",
                triangles = src.triangles,
                bbox = BboxDto.From((double[])src.bbox.min.Clone(), (double[])src.bbox.max.Clone()),
                volumeMM3 = src.volumeMM3,
                surfaceAreaMM2 = src.surfaceAreaMM2,
                cogMM = (double[])src.cogMM.Clone(),
                watertight = src.watertight,   // a copy shares the source's watertightness
                derived = new DerivedDto
                {
                    op = "duplicate",
                    label = dupLabel,
                    sourceIds = sourceIds,
                    opParams = JsonSerializer.SerializeToNode(req, OpParamJson),
                },
                StlPath = dupStl,
                Dir = dupDir,
            };
            parts.Add(dupPart);
            log.LogInformation("duplicate part {Id} <- {SrcId}", dupId, src.id);
            return Results.Ok(dupPart);
        }

        // ---- per-op validation + label ----
        string label;
        bool guard = false;   // apply the resolution guard (voxel ops + not mesh-only)
        switch (op)
        {
            case "boolean":
            {
                string bk = (req.booleanKind ?? "").Trim().ToLowerInvariant();
                if (Array.IndexOf(BooleanKinds, bk) < 0)
                    return Bad($"unknown booleanKind '{req.booleanKind}' (expected {string.Join('|', BooleanKinds)})");
                string sym = bk switch { "union" => "+", "difference" => "−", _ => "∩" };
                label = $"BOOLEAN · {a} {sym} {b}";
                guard = true;
                break;
            }
            case "merge":
                label = $"MERGE · {a} + {b}";
                guard = true;
                break;
            case "shell":
            {
                string dir = (req.shellDirection ?? "").Trim().ToLowerInvariant();
                if (Array.IndexOf(ShellDirs, dir) < 0)
                    return Bad($"unknown shellDirection '{req.shellDirection}' (expected {string.Join('|', ShellDirs)})");
                if (req.shellThicknessMM <= minFeature)
                    return Bad($"shellThicknessMM ({req.shellThicknessMM}) must exceed 1.5×voxel ({minFeature:0.###} mm)");
                label = $"SHELL · {dir.ToUpperInvariant()} {Fmt(req.shellThicknessMM)}mm";
                guard = true;
                break;
            }
            case "offset":
                if (Math.Abs(req.offsetDistMM) <= minFeature)
                    return Bad($"|offsetDistMM| ({Math.Abs(req.offsetDistMM)}) must exceed 1.5×voxel ({minFeature:0.###} mm)");
                label = $"OFFSET · {(req.offsetDistMM >= 0 ? "+" : "−")}{Fmt(Math.Abs(req.offsetDistMM))}mm";
                guard = true;
                break;
            case "transform":
                // mesh-only (exact) — bakes the input's TRS; no resolution guard.
                label = $"APPLY · {a}";
                break;
            case "mirror":
                if (req.mirror is null || req.mirror.planeNormal is null)
                    return Bad("mirror op requires mirror.planeNormal");
                var n = req.mirror.planeNormal;
                if (n.x == 0 && n.y == 0 && n.z == 0)
                    return Bad("mirror.planeNormal must be non-zero");
                label = $"MIRROR · {a}";
                break;
            default:
                return Bad($"unhandled op '{op}'");
        }

        // ---- resolution guard over the union bbox of (transformed) inputs ----
        string? warning = null;
        if (guard)
        {
            var union = UnionBbox(srcParts, req.inputs!, required);
            if (Endpoints.ResolutionError(union.MaxDim(), voxel) is { } ge) return Bad(ge);
            warning = Endpoints.ResolutionWarning(union.VoxelCount(voxel));
        }

        return SubmitWorkerOp(req, op, refs, sourceIds, label, warning, parts, jobs, paths, log);
    }

    // ---- shared reserve-part + submit-op path (202) ------------------------

    private static IResult SubmitWorkerOp(
        OpRequestDto req, string op,
        List<JobManager.MeshRefPayload> refs, List<string> sourceIds,
        string label, string? warning,
        PartStore parts, JobManager jobs, AppPaths paths, ILogger log)
    {
        string newId = "p_" + Token.New();
        string newDir = Path.Combine(paths.PartsDir, newId);
        Directory.CreateDirectory(newDir);
        string outStl = Path.Combine(newDir, "mesh.stl");

        var derived = new DerivedDto
        {
            op = op,
            label = label,
            sourceIds = sourceIds,
            opParams = JsonSerializer.SerializeToNode(req, OpParamJson),
        };
        string pendingName = !string.IsNullOrWhiteSpace(req.name) ? req.name!.Trim() : label;

        string jobId;
        try
        {
            jobId = jobs.SubmitOp(req, refs, newId, newDir, outStl, pendingName, derived, warning);
        }
        catch (Exception ex)
        {
            TryDeleteDir(newDir);
            log.LogError(ex, "op submit failed");
            return Results.Problem(detail: $"op submit failed: {ex.Message}", statusCode: 500);
        }

        return Results.Accepted($"/api/jobs/{jobId}", new { jobId, partId = newId, warning });
    }

    // ---- helpers -----------------------------------------------------------

    private static IResult Bad(string message) => Results.BadRequest(new { error = message });

    /// <summary>
    /// Resolve the first <paramref name="required"/> inputs: each must have a
    /// partId that exists and is distinct. Populates the source parts and the
    /// resolved MeshRefPayloads (abs STL path + the input's current TRS).
    /// Returns an error string, or null on success.
    /// </summary>
    private static string? ResolveInputs(
        OpRequestDto req, PartStore parts, int required,
        out List<PartInfo> srcParts, out List<JobManager.MeshRefPayload> refs)
    {
        srcParts = new List<PartInfo>();
        refs = new List<JobManager.MeshRefPayload>();
        var inputs = req.inputs ?? new List<OpInputDto>();
        if (inputs.Count < required)
            return $"{req.op} op requires {required} input part(s), got {inputs.Count}";

        var seen = new HashSet<string>(StringComparer.Ordinal);
        for (int i = 0; i < required; i++)
        {
            string? pid = inputs[i]?.partId;
            if (string.IsNullOrWhiteSpace(pid))
                return $"input[{i}] is missing partId";
            if (!seen.Add(pid))
                return $"input parts must be distinct (duplicate '{pid}')";
            if (!parts.TryGet(pid, out var part))
                return $"part not found: {pid}";
            srcParts.Add(part);
            refs.Add(new JobManager.MeshRefPayload(part.StlPath, inputs[i].transform));
        }
        return null;
    }

    /// <summary>Union of each input part's bbox after its TRS is applied.</summary>
    private static BboxDto UnionBbox(List<PartInfo> srcParts, List<OpInputDto> inputs, int required)
    {
        double[] min = { double.MaxValue, double.MaxValue, double.MaxValue };
        double[] max = { double.MinValue, double.MinValue, double.MinValue };
        for (int i = 0; i < required; i++)
        {
            var (bmin, bmax) = TransformedBbox(srcParts[i].bbox, inputs[i].transform);
            for (int k = 0; k < 3; k++)
            {
                if (bmin[k] < min[k]) min[k] = bmin[k];
                if (bmax[k] > max[k]) max[k] = bmax[k];
            }
        }
        return BboxDto.From(min, max);
    }

    /// <summary>
    /// Transform a bbox by a TRS matrix built with the ONE canonical composition
    /// (scale → rotX → rotY → rotZ → translate) — identical to worker MeshUtil —
    /// and return the axis-aligned bounds of the 8 transformed corners.
    /// </summary>
    private static (double[] min, double[] max) TransformedBbox(BboxDto b, TransformDto? t)
    {
        Matrix4x4 m = BuildMatrix(t);
        double[] min = { double.MaxValue, double.MaxValue, double.MaxValue };
        double[] max = { double.MinValue, double.MinValue, double.MinValue };
        for (int i = 0; i < 8; i++)
        {
            var corner = new Vector3(
                (float)((i & 1) == 0 ? b.min[0] : b.max[0]),
                (float)((i & 2) == 0 ? b.min[1] : b.max[1]),
                (float)((i & 4) == 0 ? b.min[2] : b.max[2]));
            Vector3 p = Vector3.Transform(corner, m);
            min[0] = Math.Min(min[0], p.X); min[1] = Math.Min(min[1], p.Y); min[2] = Math.Min(min[2], p.Z);
            max[0] = Math.Max(max[0], p.X); max[1] = Math.Max(max[1], p.Y); max[2] = Math.Max(max[2], p.Z);
        }
        return (min, max);
    }

    private static Matrix4x4 BuildMatrix(TransformDto? t)
    {
        if (t is null) return Matrix4x4.Identity;
        Vector3 s = Vector3.One;
        if (t.scale is Vec3Dto sc)
            s = new Vector3(sc.x != 0 ? (float)sc.x : 1f, sc.y != 0 ? (float)sc.y : 1f, sc.z != 0 ? (float)sc.z : 1f);
        Vector3 r = t.rotateDeg is Vec3Dto rd ? new Vector3((float)rd.x, (float)rd.y, (float)rd.z) : Vector3.Zero;
        Vector3 tr = t.translateMM is Vec3Dto td ? new Vector3((float)td.x, (float)td.y, (float)td.z) : Vector3.Zero;
        float rx = r.X * MathF.PI / 180f, ry = r.Y * MathF.PI / 180f, rz = r.Z * MathF.PI / 180f;
        return Matrix4x4.CreateScale(s)
             * Matrix4x4.CreateRotationX(rx)
             * Matrix4x4.CreateRotationY(ry)
             * Matrix4x4.CreateRotationZ(rz)
             * Matrix4x4.CreateTranslation(tr);
    }

    private static string Fmt(double d) => d.ToString("0.###", CultureInfo.InvariantCulture);

    private static void TryDeleteDir(string? dir)
    {
        try { if (!string.IsNullOrEmpty(dir) && Directory.Exists(dir)) Directory.Delete(dir, recursive: true); }
        catch { /* best effort */ }
    }
}
