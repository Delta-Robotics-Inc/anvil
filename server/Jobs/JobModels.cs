//
// JobModels — DTOs for parts, job requests, and job status.
//
// JSON is serialized camelCase by the host (see Program.cs). Property names here
// are already camelCase so incoming request binding and outgoing responses line
// up with the plan's API schema regardless of policy.
//
using System.Text.Json.Serialization;
using InfillServer.Stl;

namespace InfillServer.Jobs;

// ---- Parts -----------------------------------------------------------------

/// <summary>Registry + response shape for an uploaded part.</summary>
public sealed class PartInfo
{
    public string id { get; set; } = "";
    public string name { get; set; } = "";
    public string sourceFormat { get; set; } = "";   // "stl" | "step"
    public string stlUrl { get; set; } = "";
    public int triangles { get; set; }
    public BboxDto bbox { get; set; } = new();

    // --- internal (never serialized to the client) ---
    [JsonIgnore] public string StlPath { get; set; } = "";  // abs path to canonical binary mesh.stl
    [JsonIgnore] public string Dir { get; set; } = "";       // abs part folder
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

public sealed class StatsDto
{
    public double volumeMM3 { get; set; }
    public double envelopeVolumeMM3 { get; set; }
    public double infillPct { get; set; }
    public int triangles { get; set; }
}

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
    public StatsDto? stats { get; set; }
    public StepStatusDto step { get; set; } = new();
    public string? warning { get; set; }
    public string? error { get; set; }
}
