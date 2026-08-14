<#
.SYNOPSIS
    Publish ANVIL in Release mode and install a desktop launcher shortcut.

.DESCRIPTION
    Creates a shortcut for this clone, so users can run this script from any
    checkout instead of editing an absolute path into a tracked file.

.PARAMETER NoPublish
    Create or refresh the shortcut without rebuilding the Release package.

.PARAMETER ShortcutPath
    Override the default desktop shortcut path.

.EXAMPLE
    scripts\install-desktop-shortcut.ps1
#>
[CmdletBinding()]
param(
    [switch]$NoPublish,
    [string]$ShortcutPath = (Join-Path ([Environment]::GetFolderPath('Desktop')) 'ANVIL (Production).lnk')
)

$ErrorActionPreference = 'Stop'

$ScriptDir = $PSScriptRoot
$PublishScript = Join-Path $ScriptDir 'publish-release.ps1'
$RunScript = Join-Path $ScriptDir 'run-production.ps1'
$ServerExe = Join-Path (Split-Path -Parent $ScriptDir) 'publish\Anvil\server\AnvilServer.exe'
$IconFile = Join-Path (Split-Path -Parent $ScriptDir) 'publish\Anvil\server\wwwroot\anvil.ico'

function Fail([string]$Message) {
    Write-Host ''
    Write-Host "ERROR: $Message" -ForegroundColor Red
    exit 1
}

if (-not (Test-Path -LiteralPath $RunScript)) { Fail "production launcher not found: $RunScript" }
if (-not $NoPublish) {
    if (-not (Test-Path -LiteralPath $PublishScript)) { Fail "Release publisher not found: $PublishScript" }
    & $PublishScript
    if ($LASTEXITCODE -ne 0) { Fail "Release publish failed (script exited $LASTEXITCODE)." }
}
if (-not (Test-Path -LiteralPath $ServerExe)) {
    Fail "published server not found: $ServerExe. Run this installer without -NoPublish first."
}
if (-not (Test-Path -LiteralPath $IconFile)) {
    Fail "published ANVIL icon not found: $IconFile. Run this installer without -NoPublish first."
}

$shortcutDirectory = Split-Path -Parent $ShortcutPath
if ([string]::IsNullOrWhiteSpace($shortcutDirectory)) { Fail "ShortcutPath must include a directory: $ShortcutPath" }
New-Item -ItemType Directory -Force -Path $shortcutDirectory | Out-Null

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($ShortcutPath)
$shortcut.TargetPath = (Get-Command -Name 'powershell.exe' -CommandType Application -ErrorAction Stop).Source
$shortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$RunScript`""
$shortcut.WorkingDirectory = Split-Path -Parent $ScriptDir
$shortcut.Description = 'Start the local ANVIL Release package'
$shortcut.IconLocation = "$IconFile,0"
$shortcut.Save()

Write-Host 'Desktop shortcut installed.' -ForegroundColor Green
Write-Host "  shortcut: $ShortcutPath"
Write-Host 'Open it to start ANVIL. Keep its PowerShell window open while using the app.'
