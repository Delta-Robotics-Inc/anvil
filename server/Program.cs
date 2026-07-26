//
// Anvil.Server — ASP.NET minimal API host (milestone M2).
//
// Binds http://127.0.0.1:5238, serves the static frontend from wwwroot/, and
// exposes the /api surface (parts, jobs). All heavy voxel work is delegated to
// AnvilWorker.exe (spawned per job) and STEP<->STL to the Python sidecar; this
// process references neither PicoGK nor the worker assembly.
//
// Paths (DataDir, WorkerPath) resolve relative to the REPO ROOT (the folder
// containing Anvil.sln), discovered by walking up from the executable —
// never relative to the current working directory.
//
using System.Text.Json;
using System.Text.Json.Serialization;
using Anvil.Server.Api;
using Anvil.Server.Jobs;
using Anvil.Server.Sidecar;
using Microsoft.AspNetCore.Http.Features;

string repoRoot = FindRepoRoot(AppContext.BaseDirectory);
string serverDir = Path.Combine(repoRoot, "server");

var builder = WebApplication.CreateBuilder(new WebApplicationOptions
{
    Args = args,
    ContentRootPath = serverDir,   // so default wwwroot (serverDir/wwwroot) resolves
});

// appsettings.json lives at the repo root, not next to the server project.
builder.Configuration.AddJsonFile(Path.Combine(repoRoot, "appsettings.json"),
    optional: true, reloadOnChange: false);

// ---- Configuration -> resolved absolute paths ------------------------------
var cfg = builder.Configuration;
string pythonPath = cfg["PythonPath"] ?? @"C:\Python314\python.exe";
string dataDirCfg = cfg["DataDir"] ?? "data";
string workerCfg = cfg["WorkerPath"] ?? @"worker\bin\Debug\net9.0\AnvilWorker.exe";
string repoUrl = cfg["RepoUrl"] ?? "";
int maxConcurrent = int.TryParse(cfg["MaxConcurrentJobs"], out var mc) ? Math.Max(1, mc) : 1;

string dataDir = Path.IsPathRooted(dataDirCfg) ? dataDirCfg : Path.Combine(repoRoot, dataDirCfg);
string workerPath = Path.IsPathRooted(workerCfg) ? workerCfg : Path.Combine(repoRoot, workerCfg);
string sidecarScript = Path.Combine(repoRoot, "sidecar", "cadconvert.py");
string partsDir = Path.Combine(dataDir, "parts");
string jobsDir = Path.Combine(dataDir, "jobs");
string exportsDir = Path.Combine(dataDir, "exports");   // Wave-3 unified export artefacts
string wwwRoot = Path.Combine(serverDir, "wwwroot");
Directory.CreateDirectory(partsDir);
Directory.CreateDirectory(jobsDir);
Directory.CreateDirectory(exportsDir);

var paths = new AppPaths(repoRoot, dataDir, partsDir, jobsDir, serverDir, wwwRoot);

// ---- Services --------------------------------------------------------------
builder.Services.ConfigureHttpJsonOptions(o =>
{
    o.SerializerOptions.PropertyNamingPolicy = JsonNamingPolicy.CamelCase;
    o.SerializerOptions.PropertyNameCaseInsensitive = true;
    o.SerializerOptions.DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull;
});

// Allow large STL/STEP uploads.
builder.Services.Configure<FormOptions>(o =>
{
    o.MultipartBodyLengthLimit = 1024L * 1024 * 1024; // 1 GiB
});
builder.WebHost.ConfigureKestrel(o =>
{
    o.Limits.MaxRequestBodySize = 1024L * 1024 * 1024; // 1 GiB
});

builder.Services.AddSingleton(paths);
builder.Services.AddSingleton<PartStore>();
builder.Services.AddSingleton(sp => new PythonSidecar(
    pythonPath, sidecarScript, sp.GetRequiredService<ILogger<PythonSidecar>>()));
builder.Services.AddSingleton(sp => new JobManager(
    workerPath, jobsDir, partsDir, repoRoot, maxConcurrent,
    sp.GetRequiredService<PythonSidecar>(),
    sp.GetRequiredService<PartStore>(),
    sp.GetRequiredService<ILogger<JobManager>>()));
builder.Services.AddSingleton<ScriptLibrary>();
// Unified export pipeline (POST /api/export). Depends on JobManager (coarse
// remesh pass) + the sidecar (stl2step); max 1 export at a time, FIFO.
builder.Services.AddSingleton<ExportManager>();

// ---- MCP server (official C# SDK) ----------------------------------------
// In-process, stateless HTTP MCP at /mcp (loopback binding unchanged). Tools
// live in server\Mcp\AnvilTools.cs ([McpServerToolType]) and call the same
// JobManager / PartStore / ScriptLibrary / sidecar as the HTTP API.
builder.Services
    .AddMcpServer()
    .WithHttpTransport(o => o.Stateless = true)
    .WithToolsFromAssembly();

// Bind to 127.0.0.1:5238 by default, but honor an explicit --urls / ASPNETCORE_URLS
// override (both surface as the "urls" configuration key) so a second instance can
// be launched on a different port without clashing with a running server.
string bindUrls = cfg["urls"] ?? "http://127.0.0.1:5238";
builder.WebHost.UseUrls(bindUrls);

var app = builder.Build();

// Force-construct the JobManager so its dispatcher starts immediately.
var jm = app.Services.GetRequiredService<JobManager>();

app.Logger.LogInformation("Anvil server");
app.Logger.LogInformation("  repoRoot   : {RepoRoot}", repoRoot);
app.Logger.LogInformation("  dataDir    : {DataDir}", dataDir);
app.Logger.LogInformation("  workerPath : {WorkerPath} (exists: {Exists})", workerPath, jm.WorkerExists);
app.Logger.LogInformation("  python     : {Python}", pythonPath);
app.Logger.LogInformation("  sidecar    : {Sidecar}", sidecarScript);
app.Logger.LogInformation("  maxJobs    : {Max}", maxConcurrent);

// ---- Pipeline --------------------------------------------------------------
// Static frontend. The browser MUST revalidate every hand-authored asset:
// ANVIL ships as one HTML shell + a handful of ES modules with no content
// hashing, so a cached js/main.js paired with freshly-served markup produces a
// half-wired page that reads as a hung/crashed server (it is neither). A plain
// `no-cache` still allows 304s via the ETag Kestrel already emits, so this costs
// a conditional request per asset, not a re-download.
//
// Scope is deliberately the STATIC FILE middleware only — /api/parts/{id}/mesh
// and the export artefact streams are minimal-API endpoints and never pass
// through here, so their caching is untouched.
app.UseDefaultFiles();   // rewrites "/" → "/index.html", so the shell is covered below
app.UseStaticFiles(new StaticFileOptions
{
    OnPrepareResponse = ctx =>
    {
        if (!IsNoCacheAsset(ctx.File.Name)) return;
        var headers = ctx.Context.Response.Headers;
        headers.CacheControl = "no-cache";
        headers.Pragma = "no-cache";
    },
});

app.MapGet("/api/health", () => Results.Ok(new
{
    ok = true,
    workerExists = jm.WorkerExists,
    workerPath,
    python = pythonPath,
    repoUrl,
}));

app.MapInfillApi();
app.MapOpsApi();
app.MapScriptsApi();
app.MapExportApi();

// MCP JSON-RPC endpoint (stateless streamable HTTP). Loopback only, no auth —
// see the README SECURITY section: connecting an agent lets it run code here.
app.MapMcp("/mcp");

app.Run();

// ---------------------------------------------------------------------------
// Hand-authored frontend assets — no content hashing, so they must revalidate.
// Fonts / images / anything else static keeps the default (no header at all).
static bool IsNoCacheAsset(string fileName)
{
    foreach (string ext in new[] { ".html", ".js", ".css", ".svg" })
        if (fileName.EndsWith(ext, StringComparison.OrdinalIgnoreCase)) return true;
    return false;
}

static string FindRepoRoot(string start)
{
    var dir = new DirectoryInfo(start);
    while (dir != null)
    {
        if (File.Exists(Path.Combine(dir.FullName, "Anvil.sln")))
            return dir.FullName;
        dir = dir.Parent;
    }
    // Fallback: two levels above the server project if the sln wasn't found.
    return Directory.GetCurrentDirectory();
}
