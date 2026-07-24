//
// JobModels — DTOs for parts, job requests, and job status.
//
// JSON is serialized camelCase by the host (see Program.cs). Property names here
// are already camelCase so incoming request binding and outgoing responses line
// up with the plan's API schema regardless of policy.
//
using System.Text.Json.Serialization;
using System.Text.Json.Nodes;
using Anvil.Server.Stl;

namespace Anvil.Server.Jobs;

// ---- Parts -----------------------------------------------------------------

/// <summary>Registry + response shape for an uploaded (or derived) part.</summary>
public sealed class PartInfo
{
    public string id { get; set; } = "";
    public string name { get; set; } = "";
    public string sourceFormat { get; set; } = "";   // "stl" | "step" | "derived"
    public string stlUrl { get; set; } = "";
    public int triangles { get; set; }
    public BboxDto bbox { get; set; } = new();

    // ---- mass properties (divergence theorem; see StlInfo) ----
    public double volumeMM3 { get; set; }
    public double surfaceAreaMM2 { get; set; }
    public double[] cogMM { get; set; } = new double[3];

    // ---- mesh hygiene: watertight per the worker's directed-edge check
    //      (set for derived op parts from op stats; null for uploads) ----
    public bool? watertight { get; set; }

    // ---- provenance for parts produced by a tool op (null for uploads) ----
    public DerivedDto? derived { get; set; }

    // --- internal (never serialized to the client) ---
    [JsonIgnore] public string StlPath { get; set; } = "";  // abs path to canonical binary mesh.stl
    [JsonIgnore] public string Dir { get; set; } = "";       // abs part folder
}

/// <summary>Provenance/recipe for a derived part (result of a tool op).</summary>
public sealed class DerivedDto
{
    public string op { get; set; } = "";                       // boolean|merge|shell|offset|transform|mirror|primitive|duplicate
    public string label { get; set; } = "";                    // e.g. "BOOLEAN · A − B", "SHELL · INSIDE 2mm"
    public List<string> sourceIds { get; set; } = new();       // source part ids (empty for primitive)
    public JsonNode? opParams { get; set; }                    // replayable op request snapshot
}

public sealed class BboxDto
{
    public double[] min { get; set; } = new double[3];
    public double[] max { get; set; } = new double[3];

    public static BboxDto From(StlBbox b) => new() { min = b.Min, max = b.Max };
    public static BboxDto From(double[] min, double[] max) => new() { min = min, max = max };

    public double MaxDim()
    {
        double dx = max[0] - min[0], dy = max[1] - min[1], dz = max[2] - min[2];
        return Math.Max(dx, Math.Max(dy, dz));
    }

    public double VoxelCount(double voxel)
    {
        if (voxel <= 0) return double.PositiveInfinity;
        double dx = Math.Max(0, max[0] - min[0]) / voxel;
        double dy = Math.Max(0, max[1] - min[1]) / voxel;
        double dz = Math.Max(0, max[2] - min[2]) / voxel;
        return dx * dy * dz;
    }
}

// ---- Job request (POST /jobs body) -----------------------------------------

public sealed class Vec3Dto
{
    public double x { get; set; }
    public double y { get; set; }
    public double z { get; set; }
}

// ---- Wave-1 transforms + zones + op requests -------------------------------

/// <summary>
/// Per-part non-destructive TRS. Field names match the worker's TransformDto
/// exactly (translateMM/rotateDeg/scale) so the passthrough into job.json is
/// verbatim. Canonical composition (worker + viewer): scale → rotX → rotY →
/// rotZ → translate. Rotation in DEGREES; translation in mm; scale reserved =1.
/// </summary>
public sealed class TransformDto
{
    public Vec3Dto? translateMM { get; set; }
    public Vec3Dto? rotateDeg { get; set; }
    public Vec3Dto? scale { get; set; }
}

/// <summary>Zone role membership + offsets for a zoned generate job.</summary>
public sealed class ZonesDto
{
    public List<string>? latticeIds { get; set; }   // blue: lattice-only regions
    public List<string>? keepIds { get; set; }      // green: stay-solid regions
    public List<string>? voidIds { get; set; }      // red: never-enter regions
    public double skinThicknessMM { get; set; }      // inward skin off the part surface (single only)
    public double transitionMM { get; set; }         // accepted + validated >= 0; UNUSED v1 (hard edge)
    public double keepOutGrowMM { get; set; }        // outward growth of void zones
}

/// <summary>One op input: a source part id plus its current (non-destructive) TRS.</summary>
public sealed class OpInputDto
{
    public string? partId { get; set; }
    public TransformDto? transform { get; set; }
}

/// <summary>Mirror plane for the mirror op (matches the worker MirrorDto).</summary>
public sealed class MirrorDto
{
    public Vec3Dto? planePoint { get; set; }    // mm; defaults to origin
    public Vec3Dto? planeNormal { get; set; }   // required, any length
}

/// <summary>Primitive descriptor for the primitive op (matches the worker PrimitiveDto).</summary>
public sealed class PrimitiveDto
{
    public string? kind { get; set; }            // cube|box|cylinder|sphere|cone
    public Vec3Dto? sizeMM { get; set; }         // full dimensions (X,Y,Z)
    public Vec3Dto? centerMM { get; set; }       // center (defaults to origin)
    public int sides { get; set; }               // 0 = auto from voxel size
}

/// <summary>POST /api/ops body.</summary>
public sealed class OpRequestDto
{
    public string op { get; set; } = "";                       // boolean|merge|shell|offset|transform|mirror|primitive|duplicate
    public List<OpInputDto>? inputs { get; set; }              // source parts (with per-input TRS)
    public string? name { get; set; }                          // optional display name (defaults to derived label)
    public double voxelSizeMM { get; set; } = 0.3;
    public string? booleanKind { get; set; }                   // union|difference|intersection
    public double filletMM { get; set; } = 1.0;                // merge blend radius
    public string? shellDirection { get; set; }                // inside|outside|centered
    public double shellThicknessMM { get; set; }
    public double offsetDistMM { get; set; }                   // signed
    public bool bake { get; set; }                             // transform-bake marker
    public MirrorDto? mirror { get; set; }
    public PrimitiveDto? primitive { get; set; }
}

public sealed class JobRequestDto
{
    public string mode { get; set; } = "single";        // single | fuse
    public string? partId { get; set; }                  // single
    public string? positiveId { get; set; }              // fuse
    public string? negativeId { get; set; }              // fuse

    public string pattern { get; set; } = "gyroid";      // gyroid|schwarzP|schwarzD|lidinoid|neovius
    public double cellSizeMM { get; set; } = 8.0;
    public double wallThicknessMM { get; set; } = 1.2;
    public double voxelSizeMM { get; set; } = 0.2;
    public double overlapMM { get; set; } = 0.3;         // fuse
    public double smoothOffsetMM { get; set; } = 0;
    public StepExportDto? stepExport { get; set; }

    // Mesh cleanup before export (remove floating islands). null = worker default
    // (on); passed through verbatim to the worker job.json when present.
    public bool? cleanup { get; set; }

    // ---- flow metrics v1 additions (all optional; defaults preserve behavior) ----
    public string latticeType { get; set; } = "sheet";   // sheet | skeletal
    public double biasMM { get; set; } = 0;               // skeletal bias
    public Vec3Dto? cellSizeXYZ { get; set; }             // null -> scalar cellSizeMM
    public Vec3Dto? rotationDeg { get; set; }             // null -> {0,0,0}
    public Vec3Dto? phaseOffset { get; set; }             // null -> {0,0,0} cell fractions (clamped 0-1)
    public string flowAxis { get; set; } = "z";           // x | y | z
    public double refFlowLpm { get; set; } = 10;

    // ---- Wave-1 zoned generate (all optional; default = legacy behavior) ----
    public ZonesDto? zones { get; set; }
    // Per-part non-destructive TRS, keyed by part id (base parts AND zone parts).
    public Dictionary<string, TransformDto>? transforms { get; set; }
}

public sealed class StepExportDto
{
    public bool enabled { get; set; }
    public int targetTriangles { get; set; } = 60_000;
}

/// <summary>Optional body of POST /jobs/{id}/step.</summary>
public sealed class StepRequestDto
{
    public int? targetTriangles { get; set; }
}

// ---- Job status (GET /jobs/{id} response) ----------------------------------

public sealed class StepStatusDto
{
    public string state { get; set; } = "none";   // none | running | done | failed
    public int? triangles { get; set; }
    public string? warning { get; set; }
    public string? error { get; set; }
}

public sealed class JobStatusDto
{
    public string id { get; set; } = "";
    public string state { get; set; } = "queued"; // queued | running | done | failed | cancelled
    public string? stage { get; set; }
    public double progress { get; set; }
    // Verbatim worker stats object (whatever fields the worker emits in its
    // "done" line — volumeMM3, porosityPct, warnings, profile, …). Passed
    // through unchanged so new metrics reach the client without re-mapping.
    public JsonNode? stats { get; set; }
    public StepStatusDto step { get; set; } = new();
    public string? warning { get; set; }
    public string? error { get; set; }

    // Populated when an op job (mode == "op") completes: the newly registered
    // derived part (id, mass props, provenance). Null for generate jobs and for
    // op jobs that have not finished.
    public PartInfo? part { get; set; }

    // ---- Stage 5 script jobs (mode == "script") ----
    // Every part the script SavePart-ed, registered as a normal derived part.
    // Null for non-script jobs and for script jobs that have not finished.
    public List<PartInfo>? parts { get; set; }
    // Structured progress notes the script emitted via Log(...) (in order).
    public List<string>? log { get; set; }
    // On FAILURE only: the worker's full error JSON when it carried more than the
    // bare {error,stage} (e.g. a script's scriptError[] diagnostics). Null on
    // success and for plain failures. Passed through verbatim to agents.
    public JsonNode? errorData { get; set; }
}
