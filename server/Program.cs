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
int maxConcurrent = int.TryParse(cfg["MaxConcurrentJobs"], out var mc) ? Math.Max(1, mc) : 1;

string dataDir = Path.IsPathRooted(dataDirCfg) ? dataDirCfg : Path.Combine(repoRoot, dataDirCfg);
string workerPath = Path.IsPathRooted(workerCfg) ? workerCfg : Path.Combine(repoRoot, workerCfg);
string sidecarScript = Path.Combine(repoRoot, "sidecar", "cadconvert.py");
string partsDir = Path.Combine(dataDir, "parts");
string jobsDir = Path.Combine(dataDir, "jobs");
string wwwRoot = Path.Combine(serverDir, "wwwroot");
Directory.CreateDirectory(partsDir);
Directory.CreateDirectory(jobsDir);

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
    workerPath, jobsDir, repoRoot, maxConcurrent,
    sp.GetRequiredService<PythonSidecar>(),
    sp.GetRequiredService<PartStore>(),
    sp.GetRequiredService<ILogger<JobManager>>()));

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
app.UseDefaultFiles();
app.UseStaticFiles();

app.MapGet("/api/health", () => Results.Ok(new
{
    ok = true,
    workerExists = jm.WorkerExists,
    workerPath,
    python = pythonPath,
}));

app.MapInfillApi();
app.MapOpsApi();

app.Run();

// ---------------------------------------------------------------------------
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
