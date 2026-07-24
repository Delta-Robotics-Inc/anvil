<#
.SYNOPSIS
    Build and launch Anvil (gyroid cavity converter).

.DESCRIPTION
    1. Builds Anvil.sln in Debug.
    2. Verifies the worker executable, the Python interpreter, and the sidecar
       script all exist (clear error messages if not).
    3. Starts the ASP.NET server bound to http://127.0.0.1:5238.
    4. Waits for GET /api/health to respond.
    5. Opens the browser at the app URL (unless -NoBrowser).

    Runs from ANY working directory: every path is resolved from this script's
    own location, not the current directory.

.PARAMETER NoBrowser
    Start the server but do not open a browser window.

.EXAMPLE
    scripts\run.ps1
    scripts\run.ps1 -NoBrowser
#>
[CmdletBinding()]
param(
    [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'

# --- Resolve every path from THIS script's folder (CWD-independent) ----------
$ScriptDir   = $PSScriptRoot
$RepoRoot    = Split-Path -Parent $ScriptDir
$ParentDir   = Split-Path -Parent $RepoRoot
$Sln         = Join-Path $RepoRoot 'Anvil.sln'
$ServerExe   = Join-Path $RepoRoot 'server\bin\Debug\net9.0\AnvilServer.exe'
$WorkerExe   = Join-Path $RepoRoot 'worker\bin\Debug\net9.0\AnvilWorker.exe'
$Sidecar     = Join-Path $RepoRoot 'sidecar\cadconvert.py'
$AppSettings = Join-Path $RepoRoot 'appsettings.json'
$Url         = 'http://127.0.0.1:5238/'
$HealthUrl   = 'http://127.0.0.1:5238/api/health'

function Fail([string]$msg) {
    Write-Host ''
    Write-Host "ERROR: $msg" -ForegroundColor Red
    exit 1
}

Write-Host 'Anvil launcher' -ForegroundColor Cyan
Write-Host "  repo: $RepoRoot"

# --- Python path comes from appsettings.json (documented default fallback) ---
$PythonPath = 'C:\Python314\python.exe'
if (Test-Path $AppSettings) {
    try {
        $cfg = Get-Content $AppSettings -Raw | ConvertFrom-Json
        if ($cfg.PythonPath) { $PythonPath = $cfg.PythonPath }
    } catch {
        Write-Host '  (could not parse appsettings.json; using default Python path)' -ForegroundColor Yellow
    }
}

# --- 1. Build ---------------------------------------------------------------
if (-not (Test-Path $Sln)) { Fail "solution not found: $Sln" }
Write-Host ''
Write-Host '[1/4] Building Anvil.sln (Debug)...' -ForegroundColor Cyan
dotnet build $Sln -c Debug --nologo
if ($LASTEXITCODE -ne 0) {
    Fail "build failed (dotnet build exited $LASTEXITCODE). Fix the compile errors above and re-run."
}

# --- 2. Verify prerequisites ------------------------------------------------
Write-Host ''
Write-Host '[2/4] Verifying prerequisites...' -ForegroundColor Cyan

if (-not (Test-Path $WorkerExe)) {
    Fail ("worker executable not found: $WorkerExe`n" +
          "The build should have produced it. Confirm the sibling PicoGK fork exists at $ParentDir\PicoGK " +
          "(the worker references ..\PicoGK\src\PicoGK.csproj) and that worker\Anvil.Worker.csproj built.")
}
Write-Host "  worker : $WorkerExe"

if (-not (Test-Path $PythonPath)) {
    Fail ("Python interpreter not found: $PythonPath`n" +
          "Install Python 3.14 with build123d + cadquery-ocp, or set `"PythonPath`" in appsettings.json to your interpreter.")
}
Write-Host "  python : $PythonPath"

if (-not (Test-Path $Sidecar)) {
    Fail "sidecar script not found: $Sidecar"
}
Write-Host "  sidecar: $Sidecar"

if (-not (Test-Path $ServerExe)) {
    Fail "server executable not found: $ServerExe (the build did not produce it)."
}

# --- 3. Start the server ----------------------------------------------------
Write-Host ''
Write-Host "[3/4] Starting server -> $Url" -ForegroundColor Cyan
$LogDir = Join-Path $RepoRoot 'data'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$OutLog = Join-Path $LogDir 'server.out.log'
$ErrLog = Join-Path $LogDir 'server.err.log'

$server = Start-Process -FilePath $ServerExe -WorkingDirectory $RepoRoot `
    -NoNewWindow -PassThru `
    -RedirectStandardOutput $OutLog -RedirectStandardError $ErrLog

# --- 4. Wait for health -----------------------------------------------------
Write-Host '[4/4] Waiting for /api/health...' -ForegroundColor Cyan
$healthy = $false
for ($i = 0; $i -lt 120; $i++) {
    if ($server.HasExited) {
        Write-Host ''
        Write-Host '--- server.err.log (tail) ---' -ForegroundColor Yellow
        if (Test-Path $ErrLog) { Get-Content $ErrLog -Tail 30 | Write-Host }
        Fail "server process exited before becoming healthy (exit $($server.ExitCode)). See $ErrLog / $OutLog."
    }
    try {
        $resp = Invoke-WebRequest -Uri $HealthUrl -UseBasicParsing -TimeoutSec 2
        if ($resp.StatusCode -eq 200) { $healthy = $true; break }
    } catch {
        Start-Sleep -Milliseconds 500
    }
}
if (-not $healthy) {
    try { if (-not $server.HasExited) { $server.Kill() } } catch { }
    Fail "server did not become healthy within ~60s. See $ErrLog / $OutLog."
}

Write-Host ''
Write-Host "Server is up and healthy at $Url" -ForegroundColor Green
Write-Host "  logs: $OutLog"

if (-not $NoBrowser) {
    Write-Host 'Opening browser...'
    Start-Process $Url
} else {
    Write-Host '(-NoBrowser) Not opening a browser.'
}

Write-Host ''
Write-Host 'Press Ctrl+C to stop the server.' -ForegroundColor Cyan
try {
    Wait-Process -Id $server.Id
} finally {
    try { if (-not $server.HasExited) { $server.Kill() } } catch { }
    Write-Host 'Server stopped.'
}
