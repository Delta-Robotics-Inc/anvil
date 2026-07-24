<#
.SYNOPSIS
    Server (HTTP API) test harness for ANVIL Wave-1 "Objects & Ops" + zoned lattice.

.DESCRIPTION
    Self-contained. Implements the approved plan's Verification section 3:

      * builds ONLY server\Anvil.Server.csproj to a SCRATCH output (never the .sln,
        never server\bin — so a dev server on 5238 keeps its exe locked and alive)
      * starts THAT build on port 5239 with an ISOLATED data dir + the real worker
        exe, from a throwaway "content root" that has no appsettings.json (so the
        --DataDir / --WorkerPath command-line args actually win)
      * waits for /api/health, then:
          - upload samples\Cylinder.stl TWICE
          - POST /api/ops boolean DIFFERENCE (2nd input offset via its TRS so the
            difference of two identical cylinders is a non-empty crescent)
          - poll the job -> assert done + registered derived part carries
            derived.label + mass props (volumeMM3 > 0, surfaceAreaMM2 > 0)
          - GET /api/parts contains the derived part
          - POST /api/ops duplicate -> 200 sync with COPIED mass props
          - create primitives via /api/ops (box 60x40x20, sphere d24, cyl d8 h40)
          - POST /api/jobs single-mode ZONED on the op-created box (base) + sphere
            (zone-lattice) + cylinder (zone-void), skin 1.5 / keepOutGrow 0.5
          - poll done -> GET preview.stl 200 & > 0 bytes; stats.latticeRegionVolumeMM3 present
        Negatives (all expect 400):
          - zone id == base id
          - unknown op
          - op with absurd voxel (0.001) -> resolution guard
          - boolean with a missing/unknown part id

    Kills ONLY the 5239 instance it started. Prints a summary table; exits
    non-zero on any failure.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\test_api.ps1
#>
[CmdletBinding()]
param(
    [int]$Port = 5239
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Net.Http

# --- Paths (CWD-independent) --------------------------------------------------
$ScriptDir    = $PSScriptRoot
$RepoRoot     = Split-Path -Parent $ScriptDir
$ServerCsproj = Join-Path $RepoRoot 'server\Anvil.Server.csproj'
$WorkerExe    = Join-Path $RepoRoot 'worker\bin\Debug\net9.0\AnvilWorker.exe'
$Cylinder     = Join-Path $RepoRoot 'samples\Cylinder.stl'

$WorkTmp  = Join-Path $env:TEMP ('anvil_test_api_' + [guid]::NewGuid().ToString('N').Substring(0,8))
$BuildDir = Join-Path $WorkTmp 'srvbuild'
$DataDir  = Join-Path $WorkTmp 'data'
$SrvRoot  = Join-Path $WorkTmp 'srvroot'     # throwaway content root (no appsettings.json)
$OutLog   = Join-Path $WorkTmp 'server.out.log'
$ErrLog   = Join-Path $WorkTmp 'server.err.log'
New-Item -ItemType Directory -Force -Path $WorkTmp | Out-Null
New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $SrvRoot 'server\wwwroot') | Out-Null

$Base = "http://127.0.0.1:$Port"

Write-Host 'ANVIL Wave-1 — server API test harness' -ForegroundColor Cyan
Write-Host "  repo:    $RepoRoot"
Write-Host "  workdir: $WorkTmp"
Write-Host "  port:    $Port"

if (-not (Test-Path $Cylinder))  { Write-Host "missing sample: $Cylinder" -ForegroundColor Red; exit 1 }
if (-not (Test-Path $WorkerExe)) { Write-Host "missing worker exe (build worker first): $WorkerExe" -ForegroundColor Red; exit 1 }

# --- Build ONLY the server, to scratch (leaves server\bin + dev server alone) --
Write-Host "`nBuilding server -> $BuildDir ..." -ForegroundColor Cyan
& dotnet build $ServerCsproj -o $BuildDir -v q -nologo
if ($LASTEXITCODE -ne 0) { Write-Host 'SERVER BUILD FAILED' -ForegroundColor Red; exit 1 }
$ServerExe = Join-Path $BuildDir 'AnvilServer.exe'

# --- HTTP client + helpers ---------------------------------------------------
$client = New-Object System.Net.Http.HttpClient
$client.Timeout = [TimeSpan]::FromMinutes(5)

function Try-Json([string]$text) { try { return ($text | ConvertFrom-Json) } catch { return $null } }

function Http-Get([string]$url) {
    $resp = $client.GetAsync($url).GetAwaiter().GetResult()
    $text = $resp.Content.ReadAsStringAsync().GetAwaiter().GetResult()
    [pscustomobject]@{ status=[int]$resp.StatusCode; body=$text; obj=(Try-Json $text) }
}
function Http-GetBytes([string]$url) {
    $resp  = $client.GetAsync($url).GetAwaiter().GetResult()
    $bytes = $resp.Content.ReadAsByteArrayAsync().GetAwaiter().GetResult()
    [pscustomobject]@{ status=[int]$resp.StatusCode; length=$bytes.Length }
}
function Http-PostJson([string]$url, $obj) {
    $json    = ($obj | ConvertTo-Json -Depth 20 -Compress)
    $content = New-Object System.Net.Http.StringContent -ArgumentList $json,([System.Text.Encoding]::UTF8),'application/json'
    $resp    = $client.PostAsync($url, $content).GetAwaiter().GetResult()
    $text    = $resp.Content.ReadAsStringAsync().GetAwaiter().GetResult()
    [pscustomobject]@{ status=[int]$resp.StatusCode; body=$text; obj=(Try-Json $text) }
}
function Http-Upload([string]$url, [string]$filePath) {
    $mp    = New-Object System.Net.Http.MultipartFormDataContent
    $bytes = [System.IO.File]::ReadAllBytes($filePath)
    $fc    = New-Object System.Net.Http.ByteArrayContent -ArgumentList (,$bytes)
    $fc.Headers.ContentType = New-Object System.Net.Http.Headers.MediaTypeHeaderValue -ArgumentList 'application/octet-stream'
    $mp.Add($fc, 'file', [System.IO.Path]::GetFileName($filePath))
    $resp = $client.PostAsync($url, $mp).GetAwaiter().GetResult()
    $text = $resp.Content.ReadAsStringAsync().GetAwaiter().GetResult()
    [pscustomobject]@{ status=[int]$resp.StatusCode; body=$text; obj=(Try-Json $text) }
}

function Wait-Health([int]$timeoutSec) {
    $deadline = (Get-Date).AddSeconds($timeoutSec)
    while ((Get-Date) -lt $deadline) {
        try { $r = Http-Get "$Base/api/health"; if ($r.status -eq 200 -and $r.obj.ok) { return $r.obj } } catch { }
        Start-Sleep -Milliseconds 400
    }
    return $null
}
function Wait-Job([string]$id, [int]$timeoutSec) {
    $deadline = (Get-Date).AddSeconds($timeoutSec)
    while ((Get-Date) -lt $deadline) {
        $r = Http-Get "$Base/api/jobs/$id"
        if ($r.status -eq 200 -and $r.obj) {
            if ($r.obj.state -in @('done','failed','cancelled')) { return $r.obj }
        }
        Start-Sleep -Milliseconds 400
    }
    return $null
}

# --- Result collector --------------------------------------------------------
$script:Results = New-Object System.Collections.Generic.List[object]
function Add-Result([string]$name, [bool]$pass, [string]$detail) {
    $status = 'FAIL'; if ($pass) { $status = 'PASS' }
    $script:Results.Add([pscustomobject]@{ Test=$name; Result=$status; Detail=$detail })
    $color = 'Red'; if ($pass) { $color = 'Green' }
    Write-Host ('  [{0}] {1} — {2}' -f $status, $name, $detail) -ForegroundColor $color
}

$serverProc = $null
try {
    # --- Launch the scratch build on $Port, isolated data dir + real worker ----
    $srvArgs = "--urls $Base --DataDir `"$DataDir`" --WorkerPath `"$WorkerExe`""
    if (Test-Path $ServerExe) {
        $fp = $ServerExe; $allArgs = $srvArgs
    } else {
        $fp = 'dotnet'; $allArgs = "`"$(Join-Path $BuildDir 'AnvilServer.dll')`" $srvArgs"
    }
    Write-Host "`nStarting server: $fp $allArgs" -ForegroundColor Cyan
    $serverProc = Start-Process -FilePath $fp -ArgumentList $allArgs -WorkingDirectory $SrvRoot `
        -PassThru -NoNewWindow -RedirectStandardOutput $OutLog -RedirectStandardError $ErrLog

    $health = Wait-Health 40
    if ($null -eq $health) {
        Write-Host 'SERVER DID NOT BECOME HEALTHY' -ForegroundColor Red
        if (Test-Path $OutLog) { Write-Host '--- server.out ---'; Get-Content $OutLog -Tail 40 | Write-Host }
        if (Test-Path $ErrLog) { Write-Host '--- server.err ---'; Get-Content $ErrLog -Tail 40 | Write-Host }
        Add-Result 'server health' $false 'no /api/health within 40s'
        throw 'health-timeout'
    }
    Add-Result 'server health (workerExists)' ([bool]$health.workerExists) ("ok={0} workerExists={1}" -f $health.ok, $health.workerExists)

    Write-Host "`n== Upload x2 ==" -ForegroundColor Cyan
    $u1 = Http-Upload "$Base/api/parts" $Cylinder
    $u2 = Http-Upload "$Base/api/parts" $Cylinder
    $cyl1 = $u1.obj; $cyl2 = $u2.obj
    $upOk = ($u1.status -eq 200) -and ($u2.status -eq 200) -and $cyl1.id -and $cyl2.id -and ($cyl1.id -ne $cyl2.id)
    Add-Result 'upload Cylinder.stl x2' $upOk ("ids={0},{1} status={2},{3}" -f $cyl1.id, $cyl2.id, $u1.status, $u2.status)
    $upMass = ([double]$cyl1.volumeMM3 -gt 0) -and ([double]$cyl1.surfaceAreaMM2 -gt 0)
    Add-Result 'upload carries mass props' $upMass ("vol={0:0.##} area={1:0.##} cog=({2:0.##},{3:0.##},{4:0.##})" -f `
        [double]$cyl1.volumeMM3, [double]$cyl1.surfaceAreaMM2, [double]$cyl1.cogMM[0], [double]$cyl1.cogMM[1], [double]$cyl1.cogMM[2])

    # Offset 2nd input by ~0.45 * diameter so difference(cyl, cyl) is a real crescent.
    $sizeX  = [double]$cyl1.bbox.max[0] - [double]$cyl1.bbox.min[0]
    $offset = [math]::Round($sizeX * 0.45, 3)

    Write-Host "`n== Boolean difference (op job) ==" -ForegroundColor Cyan
    $boolReq = [ordered]@{
        op='boolean'; booleanKind='difference'; voxelSizeMM=0.3
        inputs=@(
            @{ partId=$cyl1.id },
            @{ partId=$cyl2.id; transform=@{ translateMM=@{ x=$offset; y=0; z=0 } } }
        )
    }
    $boolResp = Http-PostJson "$Base/api/ops" $boolReq
    $boolAccepted = ($boolResp.status -eq 202) -and $boolResp.obj.jobId -and $boolResp.obj.partId
    Add-Result 'POST /api/ops boolean -> 202 {jobId,partId}' $boolAccepted ("status={0} jobId={1} partId={2} offX={3}" -f $boolResp.status, $boolResp.obj.jobId, $boolResp.obj.partId, $offset)

    $boolPartId = $boolResp.obj.partId
    $bj = Wait-Job $boolResp.obj.jobId 120
    if ($null -eq $bj) {
        Add-Result 'boolean job completes' $false 'timeout (120s)'
    } else {
        Add-Result 'boolean job state=done' ($bj.state -eq 'done') ("state={0} stage={1} err={2}" -f $bj.state, $bj.stage, $bj.error)
        $bp = $bj.part
        $bpOk = ($null -ne $bp) -and ($bp.id -eq $boolPartId)
        Add-Result 'job exposes registered part' $bpOk ("part.id={0} expected={1}" -f $bp.id, $boolPartId)
        if ($bp) {
            $lblOk = -not [string]::IsNullOrWhiteSpace($bp.derived.label)
            Add-Result 'derived.label present' $lblOk ("op={0} label='{1}' sourceIds={2}" -f $bp.derived.op, $bp.derived.label, ($bp.derived.sourceIds -join ','))
            $mpOk = ([double]$bp.volumeMM3 -gt 0) -and ([double]$bp.surfaceAreaMM2 -gt 0)
            Add-Result 'derived mass props (vol>0, area>0)' $mpOk ("vol={0:0.##} area={1:0.##}" -f [double]$bp.volumeMM3, [double]$bp.surfaceAreaMM2)
            $sane = ([double]$bp.volumeMM3 -gt 100) -and ([double]$bp.volumeMM3 -lt 60000)
            Add-Result 'derived volume sane (crescent < full cyl)' $sane ("vol={0:0.##} mm3" -f [double]$bp.volumeMM3)
        }
    }

    Write-Host "`n== GET /api/parts ==" -ForegroundColor Cyan
    $partsResp = Http-Get "$Base/api/parts"
    $listOk = ($partsResp.status -eq 200) -and ($partsResp.obj | Where-Object { $_.id -eq $boolPartId })
    Add-Result 'GET /api/parts contains derived part' ([bool]$listOk) ("count={0} hasDerived={1}" -f @($partsResp.obj).Count, [bool]$listOk)

    Write-Host "`n== Duplicate (synchronous) ==" -ForegroundColor Cyan
    $dupResp = Http-PostJson "$Base/api/ops" ([ordered]@{ op='duplicate'; inputs=@(@{ partId=$cyl1.id }) })
    $dup = $dupResp.obj
    $dupOk = ($dupResp.status -eq 200) -and $dup.id -and ($dup.id -ne $cyl1.id) -and ($dup.derived.op -eq 'duplicate')
    Add-Result 'duplicate -> 200 sync {part}' $dupOk ("status={0} id={1} label='{2}'" -f $dupResp.status, $dup.id, $dup.derived.label)
    $copyOk = ([math]::Abs([double]$dup.volumeMM3 - [double]$cyl1.volumeMM3) -lt 0.01) -and `
              ([math]::Abs([double]$dup.surfaceAreaMM2 - [double]$cyl1.surfaceAreaMM2) -lt 0.01)
    Add-Result 'duplicate copied mass props' $copyOk ("dupVol={0:0.###} srcVol={1:0.###}" -f [double]$dup.volumeMM3, [double]$cyl1.volumeMM3)

    Write-Host "`n== Primitives (op jobs) ==" -ForegroundColor Cyan
    function New-Primitive([string]$kind, $size, [string]$tag) {
        $r = Http-PostJson "$Base/api/ops" ([ordered]@{
            op='primitive'; voxelSizeMM=0.3
            primitive=@{ kind=$kind; sizeMM=$size; centerMM=@{ x=0; y=0; z=0 }; sides=0 }
        })
        if ($r.status -ne 202 -or -not $r.obj.jobId) {
            Add-Result "primitive $tag accepted" $false ("status={0} body={1}" -f $r.status, $r.body); return $null
        }
        $j = Wait-Job $r.obj.jobId 120
        $ok = ($null -ne $j) -and ($j.state -eq 'done') -and ($j.part.id -eq $r.obj.partId)
        Add-Result "primitive $tag done + registered" $ok ("state={0} partId={1} vol={2:0.##}" -f $j.state, $r.obj.partId, [double]$j.part.volumeMM3)
        if ($ok) { return $r.obj.partId } else { return $null }
    }
    $boxId    = New-Primitive 'box'      @{ x=60; y=40; z=20 } 'box 60x40x20'
    $sphereId = New-Primitive 'sphere'   @{ x=24; y=24; z=24 } 'sphere d24'
    $cylZid   = New-Primitive 'cylinder' @{ x=8;  y=8;  z=40 } 'cylinder d8 h40'

    Write-Host "`n== Zoned generate (op-created parts) ==" -ForegroundColor Cyan
    if ($boxId -and $sphereId -and $cylZid) {
        $genReq = [ordered]@{
            mode='single'; partId=$boxId
            pattern='gyroid'; cellSizeMM=8; wallThicknessMM=1.2; voxelSizeMM=0.3
            zones=@{
                latticeIds=@($sphereId)
                voidIds=@($cylZid)
                skinThicknessMM=1.5
                keepOutGrowMM=0.5
                transitionMM=0
            }
        }
        $genResp = Http-PostJson "$Base/api/jobs" $genReq
        $genAcc = ($genResp.status -eq 202) -and $genResp.obj.jobId
        Add-Result 'POST /api/jobs zoned -> 202' $genAcc ("status={0} jobId={1} warning={2}" -f $genResp.status, $genResp.obj.jobId, $genResp.obj.warning)
        if ($genAcc) {
            $gj = Wait-Job $genResp.obj.jobId 240
            if ($null -eq $gj) {
                Add-Result 'zoned job completes' $false 'timeout (240s)'
            } else {
                Add-Result 'zoned job state=done' ($gj.state -eq 'done') ("state={0} stage={1} err={2}" -f $gj.state, $gj.stage, $gj.error)
                $lrv = [double]$gj.stats.latticeRegionVolumeMM3
                Add-Result 'stats.latticeRegionVolumeMM3 present & > 0' ($lrv -gt 0) ("latticeRegionVolumeMM3={0:0.##}" -f $lrv)
                $pv = Http-GetBytes "$Base/api/jobs/$($genResp.obj.jobId)/preview.stl"
                Add-Result 'GET preview.stl 200 & > 0 bytes' (($pv.status -eq 200) -and ($pv.length -gt 0)) ("status={0} bytes={1}" -f $pv.status, $pv.length)
            }
        }
    } else {
        Add-Result 'zoned generate (needs primitives)' $false "missing primitive part(s): box=$boxId sphere=$sphereId cyl=$cylZid"
    }

    Write-Host "`n== Negatives (expect 400) ==" -ForegroundColor Cyan

    # zone id == base id
    if ($boxId) {
        $n1 = Http-PostJson "$Base/api/jobs" ([ordered]@{
            mode='single'; partId=$boxId; pattern='gyroid'; cellSizeMM=8; wallThicknessMM=1.2; voxelSizeMM=0.3
            zones=@{ latticeIds=@($boxId) }
        })
        Add-Result 'zone id == base id -> 400' ($n1.status -eq 400) ("status={0} err={1}" -f $n1.status, $n1.obj.error)
    } else {
        Add-Result 'zone id == base id -> 400' $false 'no boxId'
    }

    # unknown op
    $n2 = Http-PostJson "$Base/api/ops" ([ordered]@{ op='frobnicate'; inputs=@(@{ partId=$cyl1.id }) })
    Add-Result 'unknown op -> 400' ($n2.status -eq 400) ("status={0} err={1}" -f $n2.status, $n2.obj.error)

    # absurd voxel (resolution guard)
    $n3 = Http-PostJson "$Base/api/ops" ([ordered]@{
        op='boolean'; booleanKind='difference'; voxelSizeMM=0.001
        inputs=@(@{ partId=$cyl1.id }, @{ partId=$cyl2.id })
    })
    Add-Result 'absurd voxel 0.001 -> 400 (resolution guard)' ($n3.status -eq 400) ("status={0} err={1}" -f $n3.status, $n3.obj.error)

    # boolean with a missing / unknown part id
    $n4 = Http-PostJson "$Base/api/ops" ([ordered]@{
        op='boolean'; booleanKind='difference'; voxelSizeMM=0.3
        inputs=@(@{ partId=$cyl1.id }, @{ partId='p_does_not_exist' })
    })
    Add-Result 'boolean missing part id -> 400' ($n4.status -eq 400) ("status={0} err={1}" -f $n4.status, $n4.obj.error)
}
finally {
    if ($serverProc -and -not $serverProc.HasExited) {
        try { Stop-Process -Id $serverProc.Id -Force -ErrorAction SilentlyContinue } catch { }
    }
    if ($client) { $client.Dispose() }
}

# --- Summary -----------------------------------------------------------------
Write-Host "`n==== SUMMARY ====" -ForegroundColor Cyan
$script:Results | Format-Table -AutoSize | Out-String | Write-Host
$fails = @($script:Results | Where-Object { $_.Result -eq 'FAIL' })
$pass  = $script:Results.Count - $fails.Count
Write-Host ('{0} passed / {1} failed / {2} total' -f $pass, $fails.Count, $script:Results.Count) `
    -ForegroundColor $(if ($fails.Count -gt 0) { 'Red' } else { 'Green' })

if ($fails.Count -gt 0) {
    Write-Host "workdir retained for inspection: $WorkTmp" -ForegroundColor Yellow
    Write-Host "  server.out: $OutLog"
    Write-Host "  server.err: $ErrLog"
    exit 1
}
Remove-Item -Recurse -Force $WorkTmp -ErrorAction SilentlyContinue
exit 0
