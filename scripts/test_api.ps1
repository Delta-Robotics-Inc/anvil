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
          - create primitives via /api/ops (box 60x40x20, sphere d24, cyl d8 h60)
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
# The server resolves the Python sidecar as <repoRoot>\sidecar\cadconvert.py, and
# with no Anvil.sln above the scratch build "repoRoot" falls back to the working
# directory ($SrvRoot). Mirror the script in so STEP conversions work here too.
New-Item -ItemType Directory -Force -Path (Join-Path $SrvRoot 'sidecar') | Out-Null
Copy-Item (Join-Path $RepoRoot 'sidecar\cadconvert.py') (Join-Path $SrvRoot 'sidecar\cadconvert.py') -Force

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
function Http-Download([string]$url, [string]$outPath) {
    $resp  = $client.GetAsync($url).GetAwaiter().GetResult()
    $bytes = $resp.Content.ReadAsByteArrayAsync().GetAwaiter().GetResult()
    $fname = ''
    $cd = $resp.Content.Headers.ContentDisposition
    if ($cd) {
        if ($cd.FileNameStar) { $fname = $cd.FileNameStar } elseif ($cd.FileName) { $fname = $cd.FileName }
    }
    $fname = ($fname -replace '"', '')
    if ($bytes.Length -gt 0) { [System.IO.File]::WriteAllBytes($outPath, $bytes) }
    [pscustomobject]@{ status=[int]$resp.StatusCode; length=$bytes.Length; fileName=$fname; path=$outPath }
}

# --- binary-STL readers (header count + world-frame X range) -----------------
function Get-StlTriCount([string]$path) {
    $fs = [System.IO.File]::OpenRead($path)
    try {
        $head = New-Object byte[] 84
        [void]$fs.Read($head, 0, 84)
        return [int][System.BitConverter]::ToUInt32($head, 80)
    } finally { $fs.Dispose() }
}
function Get-StlXRange([string]$path) {
    $bytes = [System.IO.File]::ReadAllBytes($path)
    if ($bytes.Length -lt 84) { return $null }
    $count = [int][System.BitConverter]::ToUInt32($bytes, 80)
    $min = [double]::MaxValue; $max = [double]::MinValue
    for ($i = 0; $i -lt $count; $i++) {
        $o = 84 + $i * 50
        foreach ($k in 12, 24, 36) {
            $x = [double][System.BitConverter]::ToSingle($bytes, $o + $k)
            if ($x -lt $min) { $min = $x }
            if ($x -gt $max) { $max = $x }
        }
    }
    [pscustomobject]@{ min=$min; max=$max; tris=$count }
}
function Get-FileHeadText([string]$path, [int]$n) {
    $fs = [System.IO.File]::OpenRead($path)
    try {
        $buf = New-Object byte[] $n
        $read = $fs.Read($buf, 0, $n)
        return [System.Text.Encoding]::ASCII.GetString($buf, 0, $read)
    } finally { $fs.Dispose() }
}

function Wait-Export([string]$id, [int]$timeoutSec) {
    $deadline = (Get-Date).AddSeconds($timeoutSec)
    while ((Get-Date) -lt $deadline) {
        $r = Http-Get "$Base/api/export/$id"
        if ($r.status -eq 200 -and $r.obj) {
            if ($r.obj.state -in @('done','failed')) { return $r.obj }
        }
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
    # Cylinders STAND IN Y: sizeMM.X/.Z are the diameters, sizeMM.Y the height.
    # h60 punches clean through the box's 40 mm Y extent as a zone-void.
    $cylZid   = New-Primitive 'cylinder' @{ x=8;  y=60; z=8 } 'cylinder d8 h60'

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

    # =========================================================================
    # The lattice IS a part: a finished generate registers its result as a
    # derived part (op:"generate") BEFORE the job flips to done, so the client
    # can select/move/export it like anything else. The job-dir preview.stl copy
    # must survive (legacy preview + STEP endpoints read it from there).
    # =========================================================================
    Write-Host "`n== Generate registers the lattice as a part ==" -ForegroundColor Cyan
    $latSrcId = New-Primitive 'box' @{ x=24; y=16; z=10 } 'box 24x16x10 (lattice src)'
    if (-not $latSrcId) {
        Add-Result 'generate registers a lattice part (needs the source box)' $false 'primitive box 24x16x10 failed'
    } else {
        $latResp = Http-PostJson "$Base/api/jobs" ([ordered]@{
            mode='single'; partId=$latSrcId
            pattern='gyroid'; cellSizeMM=6; wallThicknessMM=1.2; voxelSizeMM=0.4
        })
        $latAcc = ($latResp.status -eq 202) -and $latResp.obj.jobId
        Add-Result 'POST /api/jobs coarse box lattice -> 202' $latAcc ("status={0} jobId={1}" -f $latResp.status, $latResp.obj.jobId)
        if ($latAcc) {
            $lj = Wait-Job $latResp.obj.jobId 240
            if ($null -eq $lj) {
                Add-Result 'lattice job completes' $false 'timeout (240s)'
            } else {
                Add-Result 'lattice job state=done' ($lj.state -eq 'done') ("state={0} stage={1} err={2}" -f $lj.state, $lj.stage, $lj.error)
                $lp = $lj.part
                $lpOk = ($null -ne $lp) -and ($lp.derived.op -eq 'generate') -and $lp.id
                Add-Result 'job.part registered (derived.op=generate)' $lpOk `
                    ("id={0} op={1} label='{2}' name='{3}'" -f $lp.id, $lp.derived.op, $lp.derived.label, $lp.name)
                if ($lpOk) {
                    $srcOk = ($lp.derived.sourceIds -contains $latSrcId) -and ([double]$lp.volumeMM3 -gt 0)
                    Add-Result 'lattice provenance: sourceIds + mass props' $srcOk `
                        ("sourceIds={0} vol={1:0.##} tris={2}" -f ($lp.derived.sourceIds -join ','), [double]$lp.volumeMM3, $lp.triangles)

                    $md = Http-Download "$Base/api/parts/$($lp.id)/mesh.stl" (Join-Path $WorkTmp 'lattice_mesh.stl')
                    $mtris = 0
                    if ($md.status -eq 200 -and $md.length -gt 84) { $mtris = Get-StlTriCount $md.path }
                    $meshOk = ($md.status -eq 200) -and ($mtris -gt 0) -and `
                              ($md.length -eq (84 + $mtris * 50)) -and ($mtris -eq [int]$lp.triangles)
                    Add-Result 'GET /api/parts/{id}/mesh.stl is a valid binary STL' $meshOk `
                        ("status={0} bytes={1} tris={2} part.triangles={3}" -f $md.status, $md.length, $mtris, [int]$lp.triangles)

                    # part bbox vs the job's own result mesh (preview.stl still served)
                    $pvL = Http-Download "$Base/api/jobs/$($latResp.obj.jobId)/preview.stl" (Join-Path $WorkTmp 'lattice_preview.stl')
                    $rng = $null
                    if ($pvL.status -eq 200 -and $pvL.length -gt 84) { $rng = Get-StlXRange $pvL.path }
                    $bboxOk = ($null -ne $rng) -and ($rng.tris -eq $mtris) -and `
                              ([math]::Abs($rng.min - [double]$lp.bbox.min[0]) -lt 0.01) -and `
                              ([math]::Abs($rng.max - [double]$lp.bbox.max[0]) -lt 0.01)
                    Add-Result 'lattice part bbox matches the job result mesh' $bboxOk `
                        ("preview X {0:0.###}..{1:0.###} part X {2:0.###}..{3:0.###} tris={4}/{5}" -f `
                         $rng.min, $rng.max, [double]$lp.bbox.min[0], [double]$lp.bbox.max[0], $rng.tris, $mtris)

                    $plResp = Http-Get "$Base/api/parts"
                    $inList = [bool]($plResp.obj | Where-Object { $_.id -eq $lp.id })
                    Add-Result 'GET /api/parts contains the lattice part' $inList ("id={0} present={1}" -f $lp.id, $inList)
                }
            }
        }
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

    # =========================================================================
    # Wave-3 unified export: POST /api/export -> poll -> GET /api/export/{id}/file
    # One endpoint covers 1..N sources x stl|step x separate-zip|combined, with
    # the per-part TRS baked in and a HUMAN filename on the download.
    # =========================================================================
    Write-Host "`n== Wave-3 unified export (POST /api/export) ==" -ForegroundColor Cyan
    $DlDir = Join-Path $WorkTmp 'downloads'
    New-Item -ItemType Directory -Force -Path $DlDir | Out-Null

    # A SMALL box keeps the transform-bake bbox scan and the STEP conversion quick.
    $smallId = New-Primitive 'box' @{ x=20; y=12; z=8 } 'box 20x12x8 (export src)'

    if (-not $smallId) {
        Add-Result 'export tests (need the small box primitive)' $false 'primitive box 20x12x8 failed'
    } else {
        # --- 1. STL, single source, sanitized name ---------------------------
        $e1 = Http-PostJson "$Base/api/export" ([ordered]@{
            sources=@(@{ partId=$smallId }); format='stl'; combined=$false; name='unit test:part'
        })
        $e1Acc = ($e1.status -eq 202) -and $e1.obj.exportId
        Add-Result 'POST /api/export stl single -> 202 {exportId}' $e1Acc ("status={0} exportId={1}" -f $e1.status, $e1.obj.exportId)

        $stlOrig = $null
        if ($e1Acc) {
            $s1 = Wait-Export $e1.obj.exportId 60
            $s1Ok = ($null -ne $s1) -and ($s1.state -eq 'done')
            Add-Result 'stl single export state=done' $s1Ok ("state={0} file={1} err={2}" -f $s1.state, $s1.fileName, $s1.error)

            if ($s1Ok) {
                $d1 = Http-Download "$Base/api/export/$($e1.obj.exportId)/file" (Join-Path $DlDir 'single.stl')
                $tris1 = 0
                if ($d1.status -eq 200 -and $d1.length -gt 84) { $tris1 = Get-StlTriCount $d1.path }
                $binOk = ($d1.status -eq 200) -and ($tris1 -gt 0) -and ($d1.length -eq (84 + $tris1 * 50))
                Add-Result 'stl single file is a binary STL (84 + tris*50)' $binOk ("status={0} bytes={1} tris={2}" -f $d1.status, $d1.length, $tris1)

                $nameOk = ($d1.fileName -like '*unit_test_part*') -and ($d1.fileName -like '*.stl')
                Add-Result 'download filename is the sanitized name' $nameOk ("Content-Disposition filename='{0}'" -f $d1.fileName)

                $stlOrig = Get-StlXRange $d1.path
            }
        }

        # --- 2. STL, multi, SEPARATE -> zip ----------------------------------
        if ($boxId) {
            $e2 = Http-PostJson "$Base/api/export" ([ordered]@{
                sources=@(@{ partId=$smallId }, @{ partId=$boxId }); format='stl'; combined=$false; name='multi_sep'
            })
            $s2 = $null
            if ($e2.status -eq 202) { $s2 = Wait-Export $e2.obj.exportId 60 }
            $s2Ok = ($null -ne $s2) -and ($s2.state -eq 'done') -and ($s2.fileName -eq 'multi_sep.zip')
            Add-Result 'stl multi SEPARATE -> multi_sep.zip' $s2Ok ("status={0} state={1} file={2}" -f $e2.status, $s2.state, $s2.fileName)
            if ($s2Ok) {
                $d2 = Http-Download "$Base/api/export/$($e2.obj.exportId)/file" (Join-Path $DlDir 'multi.zip')
                $magic = ''
                if ($d2.length -gt 2) { $magic = Get-FileHeadText $d2.path 2 }
                Add-Result 'separate export is a real zip (PK magic)' (($d2.status -eq 200) -and ($magic -eq 'PK')) ("status={0} bytes={1} magic='{2}'" -f $d2.status, $d2.length, $magic)

                # entry names are ASCII slugs of the part display names, deduped
                Add-Type -AssemblyName System.IO.Compression.FileSystem -ErrorAction SilentlyContinue
                $zipEntries = @()
                try {
                    $za = [System.IO.Compression.ZipFile]::OpenRead($d2.path)
                    $zipEntries = @($za.Entries | ForEach-Object { $_.FullName })
                    $za.Dispose()
                } catch { }
                $asciiOk = ($zipEntries.Count -eq 2) -and `
                           (-not ($zipEntries -match '[^\x20-\x7E]')) -and `
                           ($zipEntries -join ',').EndsWith('.stl')
                Add-Result 'zip entries are ASCII slugs of the part names' $asciiOk ("entries={0}" -f ($zipEntries -join ' | '))
            }

            # --- 3. STL, multi, COMBINED -> tris == sum of both parts --------
            $plist = Http-Get "$Base/api/parts"
            $triSmall = [int](@($plist.obj | Where-Object { $_.id -eq $smallId })[0].triangles)
            $triBox   = [int](@($plist.obj | Where-Object { $_.id -eq $boxId })[0].triangles)

            $e3 = Http-PostJson "$Base/api/export" ([ordered]@{
                sources=@(@{ partId=$smallId }, @{ partId=$boxId }); format='stl'; combined=$true; name='multi_comb'
            })
            $s3 = $null
            if ($e3.status -eq 202) { $s3 = Wait-Export $e3.obj.exportId 60 }
            if ($null -ne $s3 -and $s3.state -eq 'done') {
                $d3 = Http-Download "$Base/api/export/$($e3.obj.exportId)/file" (Join-Path $DlDir 'combined.stl')
                $triComb = 0
                if ($d3.length -gt 84) { $triComb = Get-StlTriCount $d3.path }
                $sumOk = ($triComb -eq ($triSmall + $triBox)) -and ($s3.fileName -eq 'multi_comb.stl')
                Add-Result 'stl multi COMBINED tris == sum of sources' $sumOk ("combined={0} small={1} box={2} file={3}" -f $triComb, $triSmall, $triBox, $s3.fileName)
            } else {
                Add-Result 'stl multi COMBINED tris == sum of sources' $false ("status={0} state={1}" -f $e3.status, $s3.state)
            }
        } else {
            Add-Result 'stl multi separate/combined (needs the 60x40x20 box)' $false 'no boxId'
        }

        # --- 4. Transform baking: translateMM {x:25} shifts the mesh +25 in X --
        if ($null -ne $stlOrig) {
            $e4 = Http-PostJson "$Base/api/export" ([ordered]@{
                sources=@(@{ partId=$smallId }); format='stl'; combined=$false; name='xform_test'
                transforms=@{ $smallId = @{ translateMM=@{ x=25; y=0; z=0 }; rotateDeg=@{ x=0; y=0; z=0 }; scale=@{ x=1; y=1; z=1 } } }
            })
            $s4 = $null
            if ($e4.status -eq 202) { $s4 = Wait-Export $e4.obj.exportId 60 }
            if ($null -ne $s4 -and $s4.state -eq 'done') {
                $d4 = Http-Download "$Base/api/export/$($e4.obj.exportId)/file" (Join-Path $DlDir 'xform.stl')
                $moved = Get-StlXRange $d4.path
                $dMin = $moved.min - $stlOrig.min
                $dMax = $moved.max - $stlOrig.max
                $bakeOk = ([math]::Abs($dMin - 25) -lt 0.05) -and ([math]::Abs($dMax - 25) -lt 0.05) -and ($moved.tris -eq $stlOrig.tris)
                Add-Result 'transform-baked export shifted +25 mm in X' $bakeOk `
                    ("dMin={0:0.###} dMax={1:0.###} tris={2} (orig X {3:0.##}..{4:0.##})" -f $dMin, $dMax, $moved.tris, $stlOrig.min, $stlOrig.max)
            } else {
                Add-Result 'transform-baked export shifted +25 mm in X' $false ("status={0} state={1} err={2}" -f $e4.status, $s4.state, $s4.error)
            }
        } else {
            Add-Result 'transform-baked export shifted +25 mm in X' $false 'no baseline STL from test 1'
        }

        # --- 5. STEP, single, tiny budget (cold Python sidecar can take ~75s) --
        $e5 = Http-PostJson "$Base/api/export" ([ordered]@{
            sources=@(@{ partId=$smallId }); format='step'; combined=$false; name='step_tiny'; targetTriangles=5000
        })
        $e5Acc = ($e5.status -eq 202) -and $e5.obj.exportId
        Add-Result 'POST /api/export step single -> 202' $e5Acc ("status={0} exportId={1}" -f $e5.status, $e5.obj.exportId)
        if ($e5Acc) {
            $s5 = Wait-Export $e5.obj.exportId 300
            $s5Ok = ($null -ne $s5) -and ($s5.state -eq 'done') -and ($s5.fileName -eq 'step_tiny.step')
            Add-Result 'step export state=done' $s5Ok ("state={0} file={1} tris={2} err={3}" -f $s5.state, $s5.fileName, $s5.triangles, $s5.error)
            if ($s5Ok) {
                $d5 = Http-Download "$Base/api/export/$($e5.obj.exportId)/file" (Join-Path $DlDir 'tiny.step')
                $head = ''
                if ($d5.length -gt 12) { $head = Get-FileHeadText $d5.path 12 }
                Add-Result 'step file starts with ISO-10303-21' (($d5.status -eq 200) -and ($head -eq 'ISO-10303-21')) ("status={0} bytes={1} head='{2}'" -f $d5.status, $d5.length, $head)
            }
        }

        # --- 6. jobId source: export the generate RESULT mesh (no TRS ever) ---
        if ($genAcc -and $genResp.obj.jobId) {
            $e6 = Http-PostJson "$Base/api/export" ([ordered]@{
                sources=@(@{ jobId=$genResp.obj.jobId }); format='stl'; combined=$false; name='box_gyroid'
            })
            $s6 = $null
            if ($e6.status -eq 202) { $s6 = Wait-Export $e6.obj.exportId 120 }
            if ($null -ne $s6 -and $s6.state -eq 'done') {
                $d6 = Http-Download "$Base/api/export/$($e6.obj.exportId)/file" (Join-Path $DlDir 'result.stl')
                $tris6 = 0
                if ($d6.length -gt 84) { $tris6 = Get-StlTriCount $d6.path }
                $ok6 = ($d6.status -eq 200) -and ($tris6 -gt 0) -and ($d6.length -eq (84 + $tris6 * 50)) -and ($s6.fileName -eq 'box_gyroid.stl')
                Add-Result 'export a jobId source (the generate result)' $ok6 ("file={0} bytes={1} tris={2}" -f $s6.fileName, $d6.length, $tris6)
            } else {
                Add-Result 'export a jobId source (the generate result)' $false ("status={0} state={1} err={2}" -f $e6.status, $s6.state, $s6.error)
            }
        } else {
            Add-Result 'export a jobId source (the generate result)' $false 'no zoned generate job'
        }

        # --- 7. STEP over budget -> the coarseOnly worker remesh runs first ---
        # Cylinder.stl is 576 tris; a 200-tri budget forces the remesh branch, so
        # the STEP the sidecar reports back must NOT be the original count.
        $e7 = Http-PostJson "$Base/api/export" ([ordered]@{
            sources=@(@{ partId=$cyl1.id }); format='step'; combined=$false; name='coarse_step'; targetTriangles=200
        })
        $s7 = $null
        if ($e7.status -eq 202) { $s7 = Wait-Export $e7.obj.exportId 300 }
        if ($null -ne $s7 -and $s7.state -eq 'done') {
            $d7 = Http-Download "$Base/api/export/$($e7.obj.exportId)/file" (Join-Path $DlDir 'coarse.step')
            $head7 = ''
            if ($d7.length -gt 12) { $head7 = Get-FileHeadText $d7.path 12 }
            $ok7 = ($d7.status -eq 200) -and ($head7 -eq 'ISO-10303-21') -and `
                   ([int]$s7.triangles -gt 0) -and ([int]$s7.triangles -ne [int]$cyl1.triangles)
            Add-Result 'step over budget coarse-remeshes before conversion' $ok7 `
                ("srcTris={0} stepTris={1} bytes={2} head='{3}'" -f [int]$cyl1.triangles, [int]$s7.triangles, $d7.length, $head7)
        } else {
            Add-Result 'step over budget coarse-remeshes before conversion' $false ("status={0} state={1} err={2}" -f $e7.status, $s7.state, $s7.error)
        }

        # --- negatives -------------------------------------------------------
        $n5 = Http-PostJson "$Base/api/export" ([ordered]@{ sources=@(); format='stl' })
        Add-Result 'export with no sources -> 400' ($n5.status -eq 400) ("status={0} err={1}" -f $n5.status, $n5.obj.error)

        $n6 = Http-PostJson "$Base/api/export" ([ordered]@{ sources=@(@{ partId='p_does_not_exist' }); format='stl' })
        Add-Result 'export unknown partId -> 400' ($n6.status -eq 400) ("status={0} err={1}" -f $n6.status, $n6.obj.error)

        $n7 = Http-PostJson "$Base/api/export" ([ordered]@{ sources=@(@{ partId=$smallId }); format='obj' })
        Add-Result 'export bad format -> 400' ($n7.status -eq 400) ("status={0} err={1}" -f $n7.status, $n7.obj.error)

        $n8 = Http-Get "$Base/api/export/e_nope"
        Add-Result 'GET unknown export -> 404' ($n8.status -eq 404) ("status={0}" -f $n8.status)
    }
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
