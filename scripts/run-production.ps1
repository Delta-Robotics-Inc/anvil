<#
.SYNOPSIS
    Start the published ANVIL Release package and keep the console attached.

.DESCRIPTION
    Starts publish\Anvil\server\AnvilServer.exe, explicitly points it to the
    published worker, waits for the local health endpoint, opens the browser,
    and stops the server when this console is closed or interrupted.

.PARAMETER NoBrowser
    Start the server but do not open a browser window.

.EXAMPLE
    scripts\run-production.ps1
    scripts\run-production.ps1 -NoBrowser
#>
[CmdletBinding()]
param(
    [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'

$ScriptDir = $PSScriptRoot
$RepoRoot = Split-Path -Parent $ScriptDir
$PackageRoot = Join-Path $RepoRoot 'publish\Anvil'
$ServerExe = Join-Path $PackageRoot 'server\AnvilServer.exe'
$WorkerExe = Join-Path $PackageRoot 'worker\AnvilWorker.exe'
$Sidecar = Join-Path $PackageRoot 'sidecar\cadconvert.py'
$AppSettings = Join-Path $PackageRoot 'appsettings.json'
$Url = 'http://127.0.0.1:5238/'
$HealthUrl = 'http://127.0.0.1:5238/api/health'
$DataDir = Join-Path $PackageRoot 'data'
$OutLog = Join-Path $DataDir 'server.out.log'
$ErrLog = Join-Path $DataDir 'server.err.log'

function Fail([string]$Message) {
    Write-Host ''
    Write-Host "ERROR: $Message" -ForegroundColor Red
    exit 1
}

function Get-AnvilHealth {
    try {
        $response = Invoke-WebRequest -Uri $HealthUrl -UseBasicParsing -TimeoutSec 2
        if ($response.StatusCode -ne 200) { return $null }
        return ($response.Content | ConvertFrom-Json)
    } catch {
        return $null
    }
}

function Test-ProductionHealth($Health) {
    if ($null -eq $Health -or -not $Health.ok -or -not $Health.workerExists -or -not $Health.workerPath) {
        return $false
    }
    return [string]::Equals(
        [System.IO.Path]::GetFullPath([string]$Health.workerPath),
        [System.IO.Path]::GetFullPath($WorkerExe),
        [System.StringComparison]::OrdinalIgnoreCase)
}

if (-not (Test-Path -LiteralPath $ServerExe)) {
    Fail "published server not found: $ServerExe. Run scripts\publish-release.ps1 first."
}
if (-not (Test-Path -LiteralPath $WorkerExe)) {
    Fail "published worker not found: $WorkerExe. Run scripts\publish-release.ps1 first."
}
if (-not (Test-Path -LiteralPath $Sidecar)) {
    Fail "packaged Python sidecar not found: $Sidecar. Run scripts\publish-release.ps1 first."
}

$PythonPath = 'C:\Python314\python.exe'
if (Test-Path -LiteralPath $AppSettings) {
    try {
        $settings = Get-Content -LiteralPath $AppSettings -Raw | ConvertFrom-Json
        if ($settings.PythonPath) { $PythonPath = $settings.PythonPath }
    } catch {
        Fail "could not parse ${AppSettings}: $($_.Exception.Message)"
    }
}
if (-not (Test-Path -LiteralPath $PythonPath)) {
    Fail "Python interpreter not found: $PythonPath. Set PythonPath in $AppSettings, then run the launcher again."
}

$existingHealth = Get-AnvilHealth
if ($null -ne $existingHealth) {
    if (-not (Test-ProductionHealth $existingHealth)) {
        Fail "port 5238 is already serving a different process or ANVIL build. Stop it before starting this production package."
    }
    Write-Host 'ANVIL production is already running.' -ForegroundColor Green
    if (-not $NoBrowser) {
        Write-Host 'Opening it in the browser.'
        Start-Process $Url
    }
    exit 0
}

New-Item -ItemType Directory -Force -Path $DataDir | Out-Null

Write-Host 'ANVIL production launcher' -ForegroundColor Cyan
Write-Host "  package: $PackageRoot"
Write-Host "  worker : $WorkerExe"
Write-Host "  python : $PythonPath"
Write-Host ''
Write-Host "Starting server -> $Url" -ForegroundColor Cyan

# WorkerPath is repeated on the command line deliberately. Command-line
# configuration has the highest precedence, so a copied development
# appsettings.json cannot accidentally start the Debug worker.
$serverArguments = "--WorkerPath `"$WorkerExe`""
$server = Start-Process -FilePath $ServerExe -WorkingDirectory $PackageRoot `
    -ArgumentList $serverArguments -NoNewWindow -PassThru `
    -RedirectStandardOutput $OutLog -RedirectStandardError $ErrLog

Write-Host 'Waiting for /api/health...' -ForegroundColor Cyan
$healthy = $false
for ($i = 0; $i -lt 120; $i++) {
    if ($server.HasExited) {
        Write-Host ''
        Write-Host '--- server.err.log (tail) ---' -ForegroundColor Yellow
        if (Test-Path -LiteralPath $ErrLog) { Get-Content -LiteralPath $ErrLog -Tail 30 | Write-Host }
        Fail "server process exited before becoming healthy (exit $($server.ExitCode)). See $ErrLog and $OutLog."
    }
    $health = Get-AnvilHealth
    if (Test-ProductionHealth $health) { $healthy = $true; break }
    Start-Sleep -Milliseconds 500
}
if (-not $healthy) {
    try { if (-not $server.HasExited) { $server.Kill() } } catch { }
    Fail "server did not become healthy within about 60 seconds. See $ErrLog and $OutLog."
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
Write-Host 'Press Ctrl+C or close this window to stop the server.' -ForegroundColor Cyan
try {
    Wait-Process -Id $server.Id
} finally {
    try { if (-not $server.HasExited) { $server.Kill() } } catch { }
    Write-Host 'Server stopped.'
}
