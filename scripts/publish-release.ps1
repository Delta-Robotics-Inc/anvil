<#
.SYNOPSIS
    Build ANVIL as a self-contained Windows Release package.

.DESCRIPTION
    Publishes the server and worker into publish\Anvil, then copies the Python
    sidecar and bundled script library that the server needs at runtime. The
    package is gitignored and can be recreated from any clone with its required
    sibling PicoGK checkout.

.EXAMPLE
    scripts\publish-release.ps1
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$ScriptDir = $PSScriptRoot
$RepoRoot = Split-Path -Parent $ScriptDir
$ParentDir = Split-Path -Parent $RepoRoot
$ServerProject = Join-Path $RepoRoot 'server\Anvil.Server.csproj'
$WorkerProject = Join-Path $RepoRoot 'worker\Anvil.Worker.csproj'
$PicoProject = Join-Path $ParentDir 'PicoGK\src\PicoGK.csproj'
$PackageRoot = Join-Path $RepoRoot 'publish\Anvil'
$ServerOutput = Join-Path $PackageRoot 'server'
$WorkerOutput = Join-Path $PackageRoot 'worker'
$SidecarSource = Join-Path $RepoRoot 'sidecar'
$LibrarySource = Join-Path $RepoRoot 'scripts-library'
$SidecarOutput = Join-Path $PackageRoot 'sidecar'
$LibraryOutput = Join-Path $PackageRoot 'scripts-library'
$PackageSettings = Join-Path $PackageRoot 'appsettings.json'
$ReleaseMarker = Join-Path $PackageRoot '.anvil-release'
$ExpectedPackageRoot = [System.IO.Path]::GetFullPath((Join-Path $RepoRoot 'publish\Anvil'))

function Fail([string]$Message) {
    Write-Host ''
    Write-Host "ERROR: $Message" -ForegroundColor Red
    exit 1
}

if (-not (Test-Path -LiteralPath $ServerProject)) { Fail "server project not found: $ServerProject" }
if (-not (Test-Path -LiteralPath $WorkerProject)) { Fail "worker project not found: $WorkerProject" }
if (-not (Test-Path -LiteralPath $PicoProject)) {
    Fail "PicoGK sibling checkout not found: $PicoProject. Clone https://github.com/Kevofehr/PicoGK as a sibling named PicoGK."
}

Write-Host 'Publishing ANVIL Release package' -ForegroundColor Cyan
Write-Host "  source : $RepoRoot"
Write-Host "  package: $PackageRoot"

if (-not [string]::Equals(
    [System.IO.Path]::GetFullPath($PackageRoot),
    $ExpectedPackageRoot,
    [System.StringComparison]::OrdinalIgnoreCase)) {
    Fail "refusing to clean unexpected package path: $PackageRoot"
}
if (Test-Path -LiteralPath $PackageRoot) {
    Write-Host '  cleaning previous package'
    Remove-Item -LiteralPath $PackageRoot -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $ServerOutput, $WorkerOutput | Out-Null

Write-Host ''
Write-Host '[1/3] Publishing server (Release, win-x64, self-contained)...' -ForegroundColor Cyan
dotnet publish $ServerProject -c Release -r win-x64 --self-contained true --nologo -o $ServerOutput
if ($LASTEXITCODE -ne 0) { Fail "server publish failed (dotnet exited $LASTEXITCODE)." }

Write-Host ''
Write-Host '[2/3] Publishing worker (Release, win-x64, self-contained)...' -ForegroundColor Cyan
dotnet publish $WorkerProject -c Release -r win-x64 --self-contained true --nologo -o $WorkerOutput
if ($LASTEXITCODE -ne 0) { Fail "worker publish failed (dotnet exited $LASTEXITCODE)." }

if (-not (Test-Path -LiteralPath (Join-Path $ServerOutput 'AnvilServer.exe'))) {
    Fail "published server executable not found: $ServerOutput\AnvilServer.exe"
}
if (-not (Test-Path -LiteralPath (Join-Path $WorkerOutput 'AnvilWorker.exe'))) {
    Fail "published worker executable not found: $WorkerOutput\AnvilWorker.exe"
}

Write-Host ''
Write-Host '[3/3] Packaging runtime support files...' -ForegroundColor Cyan
New-Item -ItemType Directory -Force -Path $SidecarOutput, $LibraryOutput | Out-Null
Get-ChildItem -LiteralPath $SidecarSource -Force | Copy-Item -Destination $SidecarOutput -Recurse -Force
Get-ChildItem -LiteralPath $LibrarySource -Force | Copy-Item -Destination $LibraryOutput -Recurse -Force

$sourceSettings = [ordered]@{}
$sourceSettingsPath = Join-Path $RepoRoot 'appsettings.json'
if (Test-Path -LiteralPath $sourceSettingsPath) {
    try {
        $parsedSettings = Get-Content -LiteralPath $sourceSettingsPath -Raw | ConvertFrom-Json
        foreach ($property in $parsedSettings.PSObject.Properties) {
            $sourceSettings[$property.Name] = $property.Value
        }
    } catch {
        Fail "could not parse ${sourceSettingsPath}: $($_.Exception.Message)"
    }
}

if (-not $sourceSettings.Contains('PythonPath')) { $sourceSettings['PythonPath'] = 'C:\Python314\python.exe' }
if (-not $sourceSettings.Contains('DataDir')) { $sourceSettings['DataDir'] = 'data' }
if (-not $sourceSettings.Contains('MaxConcurrentJobs')) { $sourceSettings['MaxConcurrentJobs'] = 1 }
if (-not $sourceSettings.Contains('RepoUrl')) { $sourceSettings['RepoUrl'] = 'https://github.com/Delta-Robotics-Inc/anvil' }
$sourceSettings['WorkerPath'] = 'worker\AnvilWorker.exe'

$sourceSettings | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $PackageSettings -Encoding utf8
Set-Content -LiteralPath $ReleaseMarker -Value 'ANVIL release package marker' -Encoding ascii
Copy-Item -LiteralPath (Join-Path $RepoRoot 'LICENSE'), (Join-Path $RepoRoot 'NOTICE') `
    -Destination $PackageRoot -Force

Write-Host ''
Write-Host 'Release package is ready.' -ForegroundColor Green
Write-Host "  launcher: $ScriptDir\run-production.ps1"
Write-Host "  install : $ScriptDir\install-desktop-shortcut.ps1"
