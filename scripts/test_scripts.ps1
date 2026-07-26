<#
.SYNOPSIS
    Stage-5 test harness: in-app Roslyn scripting + MCP server.

.DESCRIPTION
    Self-contained. Implements the approved plan's Stage-5 gate:

      (a) worker-direct mode:"script" job (inline trivial script that SavePart-s
          a 20 mm box) -> asserts a manifest entry + on-disk STL + watertight.
      (b) compile-error script -> worker stderr carries scriptError[] with a line
          number AND the process exits non-zero.
      (c) via a scratch server on port 5239 (isolated DataDir + the real worker):
          POST /api/scripts/run with heat_exchanger_core.csx -> poll the job ->
          the SavePart-ed part(s) are registered and appear in GET /api/parts.
      (d) MCP smoke over raw JSON-RPC HTTP to 127.0.0.1:5239/mcp:
          initialize -> tools/list (>= 18 tools) -> tools/call create_primitive
          (box 30^3 off-origin) -> boolean_op difference with a 2nd primitive ->
          generate_infill (coarse: voxel 1.0, cell 10) -> run_script
          (graded_lattice_puck) -> each must return a terminal SUCCESS payload.
      (e) the Forge API self-test: POST /api/scripts/run with forge_smoke.csx,
          which exercises EVERY Forge command and checks each result against the
          analytic answer. The harness parses its FORGE-ASSERT log lines and
          fails if any assertion failed.
      (f) Forge.Emboss: the bundled anvil depth map baked onto a plate both ways
          -> raise ADDS volume, cut REMOVES volume, neither grows a skirt past
          the plate footprint, and both exported STLs are watertight.

    Builds ONLY worker + server(scratch) (never the .sln, never server\bin — so a
    dev server on 5238 keeps running). Kills only the 5239 instance it starts.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\test_scripts.ps1
#>
[CmdletBinding()]
param(
    [int]$Port = 5239
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Net.Http
Add-Type -AssemblyName System.Web

# Windows PowerShell 5.1's ConvertTo-Json hangs pathologically on objects that
# embed a script's source (multi-line C# with braces / em-dashes). Serialize
# request bodies ourselves via HttpUtility.JavaScriptStringEncode instead.
function To-Json($o) {
    if ($null -eq $o) { return 'null' }
    if ($o -is [bool]) { if ($o) { return 'true' } else { return 'false' } }
    if ($o -is [int] -or $o -is [long] -or $o -is [double] -or $o -is [single] -or $o -is [decimal]) {
        return ([double]$o).ToString([System.Globalization.CultureInfo]::InvariantCulture)
    }
    if ($o -is [string]) { return [System.Web.HttpUtility]::JavaScriptStringEncode($o, $true) }
    if ($o -is [System.Collections.IDictionary]) {
        $parts = foreach ($k in $o.Keys) { (To-Json ([string]$k)) + ':' + (To-Json $o[$k]) }
        return '{' + ($parts -join ',') + '}'
    }
    if ($o -is [System.Collections.IEnumerable]) {
        $parts = foreach ($x in $o) { To-Json $x }
        return '[' + ($parts -join ',') + ']'
    }
    return [System.Web.HttpUtility]::JavaScriptStringEncode([string]$o, $true)
}

# --- Paths (CWD-independent) --------------------------------------------------
$ScriptDir    = $PSScriptRoot
$RepoRoot     = Split-Path -Parent $ScriptDir
$WorkerCsproj = Join-Path $RepoRoot 'worker\Anvil.Worker.csproj'
$ServerCsproj = Join-Path $RepoRoot 'server\Anvil.Server.csproj'
$WorkerExe    = Join-Path $RepoRoot 'worker\bin\Debug\net9.0\AnvilWorker.exe'
$LibDir       = Join-Path $RepoRoot 'scripts-library'
$HxCsx        = Join-Path $LibDir 'heat_exchanger_core.csx'
$PuckCsx      = Join-Path $LibDir 'graded_lattice_puck.csx'
$ForgeCsx     = Join-Path $LibDir 'forge_smoke.csx'
$EmbossPng    = Join-Path $LibDir 'assets\emboss-sample.png'

$WorkTmp  = Join-Path $env:TEMP ('anvil_test_scripts_' + [guid]::NewGuid().ToString('N').Substring(0,8))
$BuildDir = Join-Path $WorkTmp 'srvbuild'
$DataDir  = Join-Path $WorkTmp 'data'
$SrvRoot  = Join-Path $WorkTmp 'srvroot'
$WorkDir  = Join-Path $WorkTmp 'work'
$OutLog   = Join-Path $WorkTmp 'server.out.log'
$ErrLog   = Join-Path $WorkTmp 'server.err.log'
New-Item -ItemType Directory -Force -Path $WorkTmp,$DataDir,$WorkDir,(Join-Path $SrvRoot 'server\wwwroot') | Out-Null
# The scratch server's repo-root resolves to $SrvRoot (no Anvil.sln above the
# scratch build), so mirror the versioned seeds there for list_scripts/get_script.
Copy-Item -Recurse -Force $LibDir (Join-Path $SrvRoot 'scripts-library')

$Base = "http://127.0.0.1:$Port"

Write-Host 'ANVIL Stage-5 — scripting + MCP test harness' -ForegroundColor Cyan
Write-Host "  repo:    $RepoRoot"
Write-Host "  workdir: $WorkTmp"
Write-Host "  port:    $Port"

if (-not (Test-Path $HxCsx))    { Write-Host "missing seed: $HxCsx" -ForegroundColor Red; exit 1 }
if (-not (Test-Path $PuckCsx))  { Write-Host "missing seed: $PuckCsx" -ForegroundColor Red; exit 1 }
if (-not (Test-Path $ForgeCsx)) { Write-Host "missing seed: $ForgeCsx" -ForegroundColor Red; exit 1 }
if (-not (Test-Path $EmbossPng)) { Write-Host "missing asset: $EmbossPng" -ForegroundColor Red; exit 1 }

# --- Result collector --------------------------------------------------------
$script:Results = New-Object System.Collections.Generic.List[object]
function Add-Result([string]$name, [bool]$pass, [string]$detail) {
    $status = 'FAIL'; if ($pass) { $status = 'PASS' }
    $script:Results.Add([pscustomobject]@{ Test=$name; Result=$status; Detail=$detail })
    $color = 'Red'; if ($pass) { $color = 'Green' }
    Write-Host ('  [{0}] {1} — {2}' -f $status, $name, $detail) -ForegroundColor $color
}

# --- Build worker + scratch server -------------------------------------------
Write-Host "`nBuilding worker..." -ForegroundColor Cyan
& dotnet build $WorkerCsproj -v q -nologo
if ($LASTEXITCODE -ne 0) { Write-Host 'WORKER BUILD FAILED' -ForegroundColor Red; exit 1 }
if (-not (Test-Path $WorkerExe)) { Write-Host "worker exe missing: $WorkerExe" -ForegroundColor Red; exit 1 }

Write-Host "Building server -> scratch..." -ForegroundColor Cyan
& dotnet build $ServerCsproj -o $BuildDir -v q -nologo
if ($LASTEXITCODE -ne 0) { Write-Host 'SERVER BUILD FAILED' -ForegroundColor Red; exit 1 }
$ServerExe = Join-Path $BuildDir 'AnvilServer.exe'

# --- Binary-STL watertight helper (native; PS tri loops are too slow) ---------
if (-not ([System.Management.Automation.PSTypeName]'StlTool5').Type) {
    Add-Type -Language CSharp -TypeDefinition @'
using System;
using System.IO;
public static class StlTool5 {
    public static double[] Watertight(string path) {
        byte[] b = File.ReadAllBytes(path);
        uint n = BitConverter.ToUInt32(b, 80);
        var index = new System.Collections.Generic.Dictionary<string,int>();
        var edge  = new System.Collections.Generic.Dictionary<long,int>();
        int off = 84; int[] tri = new int[3];
        for (uint i=0; i<n; i++) {
            int bp = off + (int)i*50 + 12;
            for (int v=0; v<3; v++) {
                int p = bp + v*12;
                int xb=BitConverter.ToInt32(b,p), yb=BitConverter.ToInt32(b,p+4), zb=BitConverter.ToInt32(b,p+8);
                if (xb==int.MinValue) xb=0; if (yb==int.MinValue) yb=0; if (zb==int.MinValue) zb=0;
                string key = xb+","+yb+","+zb;
                int idx; if (!index.TryGetValue(key, out idx)) { idx = index.Count; index[key]=idx; }
                tri[v]=idx;
            }
            AddEdge(edge,tri[0],tri[1]); AddEdge(edge,tri[1],tri[2]); AddEdge(edge,tri[2],tri[0]);
        }
        int open=0;
        foreach (var kv in edge) {
            long k=kv.Key; int u=(int)(k>>32), w=(int)(k & 0xffffffffL);
            long rev=((long)w<<32)|(uint)u; int cRev; edge.TryGetValue(rev, out cRev);
            if (cRev != kv.Value) open++;
        }
        return new double[]{ open==0?1.0:0.0, (double)open, (double)n };
    }
    static void AddEdge(System.Collections.Generic.Dictionary<long,int> e,int a,int b){
        long k=((long)a<<32)|(uint)b; int c; e.TryGetValue(k,out c); e[k]=c+1;
    }
}
'@
}

# =============================================================================
# (a) + (b): worker-direct script jobs
# =============================================================================
Write-Host "`n== (a) worker-direct trivial script (box 20) ==" -ForegroundColor Cyan

$aScript = Join-Path $WorkDir 'trivial.csx'
@'
Log("building a 20mm box");
Mesh m = MeshUtil.CreateBox(new Vector3(20,20,20), Vector3.Zero);
SavePart("trivial_box", m);
'@ | Set-Content -Path $aScript -Encoding UTF8
$aOutDir = Join-Path $WorkDir 'a_parts'
$aJob = Join-Path $WorkDir 'a.job.json'
@{ mode='script'; scriptPath=$aScript; voxelSizeMM=0.3; outputDir=$aOutDir } |
    ConvertTo-Json | Set-Content -Path $aJob -Encoding UTF8

$aOut = Join-Path $WorkDir 'a.out.txt'; $aErr = Join-Path $WorkDir 'a.err.txt'
$p = Start-Process -FilePath $WorkerExe -ArgumentList "`"$aJob`"" -NoNewWindow -Wait -PassThru `
    -RedirectStandardOutput $aOut -RedirectStandardError $aErr
$aExit = $p.ExitCode
$aStats = $null
foreach ($ln in (Get-Content $aOut)) {
    $t="$ln".Trim(); if (-not $t) { continue }
    $o=$null; try { $o=$t|ConvertFrom-Json } catch { continue }
    if ($o.stage -eq 'done') { $aStats = $o.stats }
}
Add-Result '(a) worker script exit 0' ($aExit -eq 0) ("exit={0}" -f $aExit)
if ($aStats) {
    $prt = @($aStats.parts)[0]
    Add-Result '(a) manifest has 1 part (box 20 vol ~8000)' `
        (($aStats.parts.Count -eq 1) -and ([math]::Abs([double]$prt.volumeMM3 - 8000) -lt 8)) `
        ("parts={0} vol={1:0.##} tris={2}" -f $aStats.parts.Count, [double]$prt.volumeMM3, [int]$prt.triangles)
    $stlOk = (Test-Path $prt.path) -and ((Get-Item $prt.path).Length -gt 0)
    Add-Result '(a) manifest STL written to disk' $stlOk ("path exists={0}" -f $stlOk)
    Add-Result '(a) manifest watertight=true' ([bool]$prt.watertight) ("watertight={0}" -f [bool]$prt.watertight)
    if ($stlOk) {
        $w = [StlTool5]::Watertight($prt.path)
        Add-Result '(a) STL directed-edge watertight' ([int]$w[0] -eq 1) ("openEdges={0}" -f [int]$w[1])
    }
    Add-Result '(a) logCount == 1' ([int]$aStats.logCount -eq 1) ("logCount={0}" -f [int]$aStats.logCount)
} else {
    Add-Result '(a) worker script produced done stats' $false "no done stats; stderr=$((Get-Content $aErr -Raw))"
}

Write-Host "`n== (b) compile-error script -> scriptError ==" -ForegroundColor Cyan
$bScript = Join-Path $WorkDir 'bad.csx'
@'
Log("fine");
var x = NoSuchThing.Nope(1);
SavePart("never", x)
'@ | Set-Content -Path $bScript -Encoding UTF8
$bOutDir = Join-Path $WorkDir 'b_parts'
$bJob = Join-Path $WorkDir 'b.job.json'
@{ mode='script'; scriptPath=$bScript; voxelSizeMM=0.3; outputDir=$bOutDir } |
    ConvertTo-Json | Set-Content -Path $bJob -Encoding UTF8
$bOut = Join-Path $WorkDir 'b.out.txt'; $bErr = Join-Path $WorkDir 'b.err.txt'
$p = Start-Process -FilePath $WorkerExe -ArgumentList "`"$bJob`"" -NoNewWindow -Wait -PassThru `
    -RedirectStandardOutput $bOut -RedirectStandardError $bErr
$bExit = $p.ExitCode
Add-Result '(b) compile-error worker exits non-zero' ($bExit -ne 0) ("exit={0}" -f $bExit)
$bErrText = Get-Content $bErr -Raw
$bErrObj = $null; try { $bErrObj = ($bErrText.Trim() -split "`n")[-1] | ConvertFrom-Json } catch { }
$hasScriptError = ($null -ne $bErrObj) -and ($null -ne $bErrObj.scriptError) -and (@($bErrObj.scriptError).Count -ge 1)
Add-Result '(b) stderr carries scriptError[]' $hasScriptError ("error='{0}'" -f $bErrObj.error)
if ($hasScriptError) {
    $d0 = @($bErrObj.scriptError)[0]
    Add-Result '(b) scriptError has a line number' ([int]$d0.line -ge 1) `
        ("line={0} char={1} msg='{2}'" -f [int]$d0.line, [int]$d0.character, $d0.message)
}

# =============================================================================
# HTTP + MCP: launch scratch server on $Port
# =============================================================================
$client = New-Object System.Net.Http.HttpClient
$client.Timeout = [TimeSpan]::FromMinutes(12)

function Try-Json([string]$t) { try { return ($t | ConvertFrom-Json) } catch { return $null } }
function Http-Get([string]$url) {
    $r = $client.GetAsync($url).GetAwaiter().GetResult()
    $t = $r.Content.ReadAsStringAsync().GetAwaiter().GetResult()
    [pscustomobject]@{ status=[int]$r.StatusCode; obj=(Try-Json $t); body=$t }
}
function Http-PostJson([string]$url, $obj) {
    $json = (To-Json $obj)
    $c = New-Object System.Net.Http.StringContent($json,[System.Text.Encoding]::UTF8,'application/json')
    $r = $client.PostAsync($url,$c).GetAwaiter().GetResult()
    $t = $r.Content.ReadAsStringAsync().GetAwaiter().GetResult()
    [pscustomobject]@{ status=[int]$r.StatusCode; obj=(Try-Json $t); body=$t }
}
function Wait-Health([int]$sec) {
    $dl=(Get-Date).AddSeconds($sec)
    while ((Get-Date) -lt $dl) { try { $r=Http-Get "$Base/api/health"; if ($r.status -eq 200 -and $r.obj.ok){return $r.obj} } catch {}; Start-Sleep -Milliseconds 400 }
    return $null
}
function Wait-Job([string]$id, [int]$sec) {
    $dl=(Get-Date).AddSeconds($sec)
    while ((Get-Date) -lt $dl) {
        $r = Http-Get "$Base/api/jobs/$id"
        if ($r.status -eq 200 -and $r.obj -and ($r.obj.state -in @('done','failed','cancelled'))) { return $r.obj }
        Start-Sleep -Milliseconds 400
    }
    return $null
}

# --- MCP raw JSON-RPC (streamable HTTP -> SSE 'data:' line) -------------------
$script:McpId = 0
function Mcp-Raw([string]$method, $params) {
    $script:McpId++
    $body = To-Json @{ jsonrpc='2.0'; id=$script:McpId; method=$method; params=$params }
    $req = New-Object System.Net.Http.HttpRequestMessage('Post', "$Base/mcp")
    $req.Content = New-Object System.Net.Http.StringContent($body,[System.Text.Encoding]::UTF8,'application/json')
    $req.Headers.Accept.ParseAdd('application/json')
    $req.Headers.Accept.ParseAdd('text/event-stream')
    $resp = $client.SendAsync($req).GetAwaiter().GetResult()
    $text = $resp.Content.ReadAsStringAsync().GetAwaiter().GetResult()
    $payload = $null
    foreach ($ln in ($text -split "`n")) {
        $t = $ln.Trim()
        if ($t.StartsWith('data:')) { $payload = $t.Substring(5).Trim(); break }
    }
    if (-not $payload) { $payload = $text.Trim() }
    return (Try-Json $payload)
}
# tools/call -> parse the tool's returned JSON text (content[0].text).
function Mcp-Tool([string]$name, $arguments) {
    $r = Mcp-Raw 'tools/call' @{ name=$name; arguments=$arguments }
    $txt = $null
    try { $txt = $r.result.content[0].text } catch {}
    $inner = if ($txt) { Try-Json $txt } else { $null }
    [pscustomobject]@{ raw=$r; inner=$inner; isError=$r.result.isError }
}

$serverProc = $null
try {
    $srvArgs = "--urls $Base --DataDir `"$DataDir`" --WorkerPath `"$WorkerExe`""
    $fp = $ServerExe; $allArgs = $srvArgs
    if (-not (Test-Path $ServerExe)) { $fp='dotnet'; $allArgs = "`"$(Join-Path $BuildDir 'AnvilServer.dll')`" $srvArgs" }
    Write-Host "`nStarting server: $fp $allArgs" -ForegroundColor Cyan
    $serverProc = Start-Process -FilePath $fp -ArgumentList $allArgs -WorkingDirectory $SrvRoot `
        -PassThru -NoNewWindow -RedirectStandardOutput $OutLog -RedirectStandardError $ErrLog

    $health = Wait-Health 40
    if ($null -eq $health) {
        if (Test-Path $ErrLog) { Write-Host '--- server.err ---'; Get-Content $ErrLog -Tail 40 | Write-Host }
        Add-Result 'server health' $false 'no /api/health within 40s'; throw 'health-timeout'
    }
    Add-Result 'server health' ([bool]$health.ok) ("ok={0} workerExists={1}" -f $health.ok, $health.workerExists)

    # =========================================================================
    # (c) POST /api/scripts/run heat_exchanger_core -> parts registered
    # =========================================================================
    Write-Host "`n== (c) /api/scripts/run heat_exchanger_core ==" -ForegroundColor Cyan
    $hxCode = Get-Content $HxCsx -Raw
    $runResp = Http-PostJson "$Base/api/scripts/run" @{
        code = $hxCode; name = 'heat_exchanger_core'
        params = @{ sizeMM = 30; cellMM = 6; wallMM = 1.0 }
        voxelSizeMM = 0.5
    }
    $runAcc = ($runResp.status -eq 202) -and $runResp.obj.jobId
    Add-Result '(c) POST /api/scripts/run -> 202 {jobId}' $runAcc ("status={0} jobId={1}" -f $runResp.status, $runResp.obj.jobId)
    if ($runAcc) {
        $sj = Wait-Job $runResp.obj.jobId 600
        if ($null -eq $sj) {
            Add-Result '(c) script job completes' $false 'timeout (600s)'
        } else {
            Add-Result '(c) script job state=done' ($sj.state -eq 'done') ("state={0} err={1}" -f $sj.state, $sj.error)
            $regParts = @(@($sj.parts) | Where-Object { $null -ne $_ })
            Add-Result '(c) job.parts registered (>=1)' ($regParts.Count -ge 1) ("parts={0}" -f $regParts.Count)
            if ($regParts.Count -ge 1) {
                $sp0 = $regParts[0]
                Add-Result '(c) part carries SCRIPT label + mass props' `
                    (($sp0.derived.op -eq 'script') -and ([double]$sp0.volumeMM3 -gt 0)) `
                    ("op={0} label='{1}' vol={2:0.##}" -f $sp0.derived.op, $sp0.derived.label, [double]$sp0.volumeMM3)
                Add-Result '(c) provenance stores sha not code' `
                    (($null -ne $sp0.derived.opParams.scriptSha256) -and ($null -eq $sp0.derived.opParams.code)) `
                    ("sha={0}" -f $sp0.derived.opParams.scriptSha256)
                $listResp = Http-Get "$Base/api/parts"
                $inList = @($listResp.obj | Where-Object { $_.id -eq $sp0.id }).Count -ge 1
                Add-Result '(c) GET /api/parts contains the script part' $inList ("id={0} present={1}" -f $sp0.id, $inList)
            }
            $logLines = @($sj.log)
            Add-Result '(c) job.log collected Log() notes' ($logLines.Count -ge 1) ("log lines={0}" -f $logLines.Count)
        }
    }

    # =========================================================================
    # (d) MCP smoke over raw JSON-RPC
    # =========================================================================
    Write-Host "`n== (d) MCP smoke (/mcp raw JSON-RPC) ==" -ForegroundColor Cyan

    $init = Mcp-Raw 'initialize' @{ protocolVersion='2024-11-05'; capabilities=@{}; clientInfo=@{ name='test_scripts'; version='1' } }
    $initOk = ($null -ne $init) -and ($null -ne $init.result.serverInfo)
    Add-Result '(d) initialize' $initOk ("server={0} proto={1}" -f $init.result.serverInfo.name, $init.result.protocolVersion)

    $tl = Mcp-Raw 'tools/list' @{}
    $tools = @($tl.result.tools)
    Add-Result '(d) tools/list >= 18 tools' ($tools.Count -ge 18) ("count={0}" -f $tools.Count)

    # create_primitive box 30^3 off-origin
    $cp = Mcp-Tool 'create_primitive' @{ kind='box'; sizeMM=@(30,30,30); centerMM=@(20,10,-5); voxelSizeMM=0.5 }
    $cpOk = ($null -ne $cp.inner) -and ([bool]$cp.inner.ok) -and ($cp.inner.job.state -eq 'done')
    $boxA = $cp.inner.partId
    Add-Result '(d) create_primitive box A' $cpOk ("ok={0} partId={1} vol={2:0.##}" -f [bool]$cp.inner.ok, $boxA, [double]$cp.inner.job.part.volumeMM3)

    # a 2nd primitive to difference against (overlapping box)
    $cp2 = Mcp-Tool 'create_primitive' @{ kind='box'; sizeMM=@(20,20,40); centerMM=@(20,10,-5); voxelSizeMM=0.5 }
    $boxB = $cp2.inner.partId
    Add-Result '(d) create_primitive box B' ([bool]$cp2.inner.ok) ("ok={0} partId={1}" -f [bool]$cp2.inner.ok, $boxB)

    # boolean_op difference A - B
    if ($boxA -and $boxB) {
        $bo = Mcp-Tool 'boolean_op' @{ kind='difference'; aId=$boxA; bId=$boxB; voxelSizeMM=0.5 }
        $boOk = ([bool]$bo.inner.ok) -and ($bo.inner.job.state -eq 'done') -and ([double]$bo.inner.job.part.volumeMM3 -gt 0)
        Add-Result '(d) boolean_op difference' $boOk ("ok={0} vol={1:0.##}" -f [bool]$bo.inner.ok, [double]$bo.inner.job.part.volumeMM3)
    } else { Add-Result '(d) boolean_op difference' $false 'missing box ids' }

    # generate_infill coarse on box A (voxel 1.0, cell 10)
    if ($boxA) {
        $gi = Mcp-Tool 'generate_infill' @{ mode='single'; partId=$boxA; pattern='gyroid'; cellSizeMM=10; wallThicknessMM=1.5; voxelSizeMM=1.0 }
        $giOk = ([bool]$gi.inner.ok) -and ($gi.inner.job.state -eq 'done') -and ([double]$gi.inner.job.stats.volumeMM3 -gt 0)
        Add-Result '(d) generate_infill (coarse)' $giOk ("ok={0} state={1} vol={2:0.##}" -f [bool]$gi.inner.ok, $gi.inner.job.state, [double]$gi.inner.job.stats.volumeMM3)
    } else { Add-Result '(d) generate_infill (coarse)' $false 'no box A' }

    # run_script graded_lattice_puck (coarse voxel for speed)
    $puckCode = Get-Content $PuckCsx -Raw
    $rs = Mcp-Tool 'run_script' @{ code=$puckCode; name='graded_lattice_puck'; voxelSizeMM=0.6; params=@{ diaMM=30; heightMM=12; cellMM=6 } }
    $rsParts = @($rs.inner.job.parts)
    $rsOk = ([bool]$rs.inner.ok) -and ($rs.inner.job.state -eq 'done') -and ($rsParts.Count -ge 1)
    Add-Result '(d) run_script graded_lattice_puck' $rsOk ("ok={0} state={1} parts={2} vol={3:0.##}" -f `
        [bool]$rs.inner.ok, $rs.inner.job.state, $rsParts.Count, [double]$rsParts[0].volumeMM3)

    # list_scripts should include both seeds
    $ls = Mcp-Tool 'list_scripts' @{}
    $names = @($ls.inner.scripts | ForEach-Object { $_.name })
    Add-Result '(d) list_scripts includes seeds' `
        (($names -contains 'heat_exchanger_core') -and ($names -contains 'graded_lattice_puck')) `
        ("scripts={0}" -f ($names -join ','))

    # =========================================================================
    # (e) Forge API: forge_smoke.csx self-test through the real pipeline
    # =========================================================================
    Write-Host "`n== (e) Forge API smoke (forge_smoke.csx) ==" -ForegroundColor Cyan

    $forgeCode = Get-Content $ForgeCsx -Raw
    $fResp = Http-PostJson "$Base/api/scripts/run" @{
        code = $forgeCode; name = 'forge_smoke'; voxelSizeMM = 0.5
    }
    $fAcc = ($fResp.status -eq 202) -and $fResp.obj.jobId
    Add-Result '(e) POST forge_smoke -> 202 {jobId}' $fAcc ("status={0} jobId={1}" -f $fResp.status, $fResp.obj.jobId)

    if ($fAcc) {
        $fj = Wait-Job $fResp.obj.jobId 900
        if ($null -eq $fj) {
            Add-Result '(e) forge_smoke completes' $false 'timeout (900s)'
        } else {
            Add-Result '(e) forge_smoke state=done' ($fj.state -eq 'done') ("state={0} err={1}" -f $fj.state, $fj.error)

            # Every Forge command asserts its own result; parse those log lines.
            $fLog     = @($fj.log)
            $fAsserts = @($fLog | Where-Object { "$_" -like 'FORGE-ASSERT *' })
            $fFails   = @($fLog | Where-Object { "$_" -like 'FORGE-ASSERT FAIL*' })
            Add-Result '(e) Forge assertions all pass' `
                (($fAsserts.Count -ge 50) -and ($fFails.Count -eq 0)) `
                ("asserts={0} failed={1}{2}" -f $fAsserts.Count, $fFails.Count,
                    $(if ($fFails.Count -gt 0) { ' :: ' + ($fFails -join ' | ') } else { '' }))

            $sumOk = $false; $sumTxt = '(no FORGE-SMOKE line)'
            foreach ($ln in $fLog) {
                if ("$ln" -match 'FORGE-SMOKE total=(\d+) pass=(\d+) fail=(\d+)') {
                    $sumTxt = $Matches[0]
                    $sumOk  = ([int]$Matches[3] -eq 0) -and ([int]$Matches[2] -ge 50)
                }
            }
            Add-Result '(e) FORGE-SMOKE summary fail=0' $sumOk $sumTxt

            $fParts = @(@($fj.parts) | Where-Object { $null -ne $_ })
            Add-Result '(e) forge_smoke saved parts (>=2)' ($fParts.Count -ge 2) ("parts={0}" -f $fParts.Count)
        }
    }

    # =========================================================================
    # (f) Forge Emboss: the bundled depth map, raised AND cut
    # =========================================================================
    Write-Host "`n== (f) Forge Emboss raise + cut ==" -ForegroundColor Cyan

    $embCode = @'
Shape plate = Box(30, 4, 30);
Log($"EMBOSS-BASE {Volume(plate):0.####}");
Shape up = Emboss(plate, "emboss-sample.png", face: "+y", depth: 1.2, mode: "raise", marginMM: 2);
Log($"EMBOSS-RAISE {Volume(up):0.####}");
Shape down = Emboss(plate, "emboss-sample.png", face: "+y", depth: 1.2, mode: "cut", marginMM: 2);
Log($"EMBOSS-CUT {Volume(down):0.####}");
SavePart("emboss_raise", up);
SavePart("emboss_cut", down);
'@
    $eResp = Http-PostJson "$Base/api/scripts/run" @{ code = $embCode; name = 'emboss_check'; voxelSizeMM = 0.4 }
    $eAcc = ($eResp.status -eq 202) -and $eResp.obj.jobId
    Add-Result '(f) POST emboss script -> 202 {jobId}' $eAcc ("status={0}" -f $eResp.status)

    if ($eAcc) {
        $ej = Wait-Job $eResp.obj.jobId 600
        if ($null -eq $ej) {
            Add-Result '(f) emboss job completes' $false 'timeout (600s)'
        } else {
            Add-Result '(f) emboss job state=done' ($ej.state -eq 'done') ("state={0} err={1}" -f $ej.state, $ej.error)

            $vBase = $null; $vUp = $null; $vDown = $null
            foreach ($ln in @($ej.log)) {
                if ("$ln" -match '^EMBOSS-BASE ([0-9.]+)')  { $vBase = [double]$Matches[1] }
                if ("$ln" -match '^EMBOSS-RAISE ([0-9.]+)') { $vUp   = [double]$Matches[1] }
                if ("$ln" -match '^EMBOSS-CUT ([0-9.]+)')   { $vDown = [double]$Matches[1] }
            }
            Add-Result '(f) raise ADDS material vs the base plate' `
                (($null -ne $vUp) -and ($null -ne $vBase) -and ($vUp -gt $vBase)) `
                ("base={0:0.##} raise={1:0.##} delta=+{2:0.##}" -f $vBase, $vUp, ($vUp - $vBase))
            Add-Result '(f) cut REMOVES material vs the base plate' `
                (($null -ne $vDown) -and ($null -ne $vBase) -and ($vDown -lt $vBase)) `
                ("base={0:0.##} cut={1:0.##} delta={2:0.##}" -f $vBase, $vDown, ($vDown - $vBase))

            # The emboss must not grow a skirt past the plate's own footprint.
            $eParts = @(@($ej.parts) | Where-Object { $null -ne $_ })
            Add-Result '(f) emboss saved both parts' ($eParts.Count -eq 2) ("parts={0}" -f $eParts.Count)
            foreach ($ep in $eParts) {
                $spanX = [double]$ep.bbox.max[0] - [double]$ep.bbox.min[0]
                Add-Result ("(f) {0}: no skirt (bbox X == 30)" -f $ep.derived.label) `
                    ([math]::Abs($spanX - 30) -lt 0.8) ("bboxX={0:0.###}" -f $spanX)
                $epStl = Join-Path $DataDir ("parts\{0}\mesh.stl" -f $ep.id)
                if (Test-Path $epStl) {
                    $w = [StlTool5]::Watertight($epStl)
                    Add-Result ("(f) {0}: STL directed-edge watertight" -f $ep.derived.label) `
                        ([int]$w[0] -eq 1) ("openEdges={0} tris={1}" -f [int]$w[1], [int]$w[2])
                } else {
                    Add-Result ("(f) {0}: STL on disk" -f $ep.derived.label) $false "missing: $epStl"
                }
            }
        }
    }
}
finally {
    if ($serverProc -and -not $serverProc.HasExited) {
        try { Stop-Process -Id $serverProc.Id -Force -ErrorAction SilentlyContinue } catch {}
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
    Write-Host "workdir retained: $WorkTmp" -ForegroundColor Yellow
    Write-Host "  server.out: $OutLog"; Write-Host "  server.err: $ErrLog"
    exit 1
}
Remove-Item -Recurse -Force $WorkTmp -ErrorAction SilentlyContinue
exit 0
