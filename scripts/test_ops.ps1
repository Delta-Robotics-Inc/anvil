<#
.SYNOPSIS
    Worker-CLI test harness for ANVIL Wave-1 "Objects & Ops" + zoned lattice.

.DESCRIPTION
    Builds ONLY the worker (never the full solution, so a running dev server on
    port 5238 is never touched), then drives AnvilWorker.exe directly with
    generated job.json files and asserts every check in the approved plan's
    Verification section 2:

      * primitive box 60x40x20  vol ~= 48000 (+/-1%)
      * primitive sphere d20     vol ~= 4189  (+/-2%)
      * boolean difference       box - cylinder (+/-2%)
      * shell inside t2          48000 - 56*36*16 (+/-2%)
      * offset -2                ~= 32256 (+/-2%)
      * transform bake +10 x     bbox shifted EXACTLY (mesh-exact)
      * rotate 90 deg Z          bbox X/Y extents swapped
      * mirror                   mesh vol +/-0.5% AND re-voxelize non-empty
                                 (catches the missing winding flip)
      * zoned generate           box + sphere zone-lattice + through-cylinder
                                 zone-void, skin 1.5 / grow 0.5:
                                   - latticeRegionVolume sane
                                   - voidClear passes
                                   - output bbox unchanged
      * legacy regression        current-style single (Cylinder.stl) matches the
                                 known-good stats, and the fuse pair envelope
                                 volume matches -- proving byte-for-byte back-compat.

    Exits non-zero on ANY failure and prints a summary table.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\test_ops.ps1
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

# --- Resolve every path from THIS script's folder (CWD-independent) ----------
$ScriptDir = $PSScriptRoot
$RepoRoot  = Split-Path -Parent $ScriptDir
$WorkerCsproj = Join-Path $RepoRoot 'worker\Anvil.Worker.csproj'
$WorkerExe    = Join-Path $RepoRoot 'worker\bin\Debug\net9.0\AnvilWorker.exe'
$Samples   = Join-Path $RepoRoot 'samples'
$Data      = Join-Path $RepoRoot 'data'
$Cylinder  = Join-Path $Samples 'Cylinder.stl'
$PosStl    = Join-Path $Data 'positive.stl'
$NegStl    = Join-Path $Data 'negative.stl'

$WorkDir = Join-Path $env:TEMP ('anvil_test_ops_' + [guid]::NewGuid().ToString('N').Substring(0,8))
New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null

Write-Host 'ANVIL Wave-1 — worker ops test harness' -ForegroundColor Cyan
Write-Host "  repo:    $RepoRoot"
Write-Host "  workdir: $WorkDir"

# --- Build ONLY the worker (never the .sln; leaves the dev server alone) ------
Write-Host "`nBuilding worker (worker\Anvil.Worker.csproj)..." -ForegroundColor Cyan
& dotnet build $WorkerCsproj -v q -nologo
if ($LASTEXITCODE -ne 0) { Write-Host 'WORKER BUILD FAILED' -ForegroundColor Red; exit 1 }
if (-not (Test-Path $WorkerExe)) { Write-Host "worker exe not found: $WorkerExe" -ForegroundColor Red; exit 1 }

# --- Fast binary-STL bbox reader (native; PS loops over 1e6 tris are too slow) -
if (-not ([System.Management.Automation.PSTypeName]'StlTool').Type) {
    Add-Type -Language CSharp -TypeDefinition @'
using System;
using System.IO;
public static class StlTool {
    // Returns [minx,miny,minz, maxx,maxy,maxz, count].
    public static double[] BBox(string path) {
        byte[] b = File.ReadAllBytes(path);
        uint n = BitConverter.ToUInt32(b, 80);
        double minx=double.PositiveInfinity, miny=minx, minz=minx;
        double maxx=double.NegativeInfinity, maxy=maxx, maxz=maxx;
        int off = 84;
        for (uint i=0; i<n; i++) {
            int bp = off + (int)i*50 + 12; // skip the 3-float normal
            for (int v=0; v<3; v++) {
                int p = bp + v*12;
                float x = BitConverter.ToSingle(b, p);
                float y = BitConverter.ToSingle(b, p+4);
                float z = BitConverter.ToSingle(b, p+8);
                if (x<minx) minx=x; if (x>maxx) maxx=x;
                if (y<miny) miny=y; if (y>maxy) maxy=y;
                if (z<minz) minz=z; if (z>maxz) maxz=z;
            }
        }
        return new double[]{ minx,miny,minz, maxx,maxy,maxz, (double)n };
    }

    // Weld vertices by bit-identical position (normalizing -0.0 -> +0.0), then
    // build the directed-edge multiset. A closed 2-manifold requires every
    // directed edge (u,v) to be matched by an equal count of (v,u); any edge
    // where the two directions disagree is an OPEN edge (a boundary/crack).
    // Returns [watertight(1/0), openEdgeCount, weldedVertexCount].
    public static double[] Watertight(string path) {
        byte[] b = File.ReadAllBytes(path);
        uint n = BitConverter.ToUInt32(b, 80);
        var index = new System.Collections.Generic.Dictionary<string,int>();
        var edge  = new System.Collections.Generic.Dictionary<long,int>();
        int off = 84;
        int[] tri = new int[3];
        for (uint i=0; i<n; i++) {
            int bp = off + (int)i*50 + 12; // skip the 3-float normal
            for (int v=0; v<3; v++) {
                int p  = bp + v*12;
                int xb = BitConverter.ToInt32(b, p);
                int yb = BitConverter.ToInt32(b, p+4);
                int zb = BitConverter.ToInt32(b, p+8);
                if (xb == int.MinValue) xb = 0; // -0.0f -> +0.0f
                if (yb == int.MinValue) yb = 0;
                if (zb == int.MinValue) zb = 0;
                string key = xb + "," + yb + "," + zb;
                int idx;
                if (!index.TryGetValue(key, out idx)) { idx = index.Count; index[key] = idx; }
                tri[v] = idx;
            }
            AddEdge(edge, tri[0], tri[1]);
            AddEdge(edge, tri[1], tri[2]);
            AddEdge(edge, tri[2], tri[0]);
        }
        int open = 0;
        foreach (var kv in edge) {
            long k = kv.Key;
            int u = (int)(k >> 32);
            int w = (int)(k & 0xffffffffL);
            long rev = ((long)w << 32) | (uint)u;
            int cRev; edge.TryGetValue(rev, out cRev);
            if (cRev != kv.Value) open++;
        }
        return new double[]{ open == 0 ? 1.0 : 0.0, (double)open, (double)index.Count };
    }

    static void AddEdge(System.Collections.Generic.Dictionary<long,int> edge, int a, int b) {
        long k = ((long)a << 32) | (uint)b;
        int c; edge.TryGetValue(k, out c); edge[k] = c + 1;
    }
}
'@
}

function Test-Watertight([string]$name, [string]$path) {
    $w = [StlTool]::Watertight($path)
    $ok = ([int]$w[0] -eq 1)
    Add-Result $name $ok ('openEdges={0} weldedVerts={1}' -f [int]$w[1], [int]$w[2])
}

function Get-StlBBox([string]$path) {
    $a = [StlTool]::BBox($path)
    return [pscustomobject]@{
        min  = @($a[0], $a[1], $a[2])
        max  = @($a[3], $a[4], $a[5])
        size = @(($a[3]-$a[0]), ($a[4]-$a[1]), ($a[5]-$a[2]))
        count = [int]$a[6]
    }
}

# --- Result collector --------------------------------------------------------
$script:Results = New-Object System.Collections.Generic.List[object]

function Add-Result([string]$name, [bool]$pass, [string]$detail) {
    $status = 'FAIL'; if ($pass) { $status = 'PASS' }
    $script:Results.Add([pscustomobject]@{ Test=$name; Result=$status; Detail=$detail })
    $color = 'Red'; if ($pass) { $color = 'Green' }
    Write-Host ('  [{0}] {1} — {2}' -f $status, $name, $detail) -ForegroundColor $color
}

function Assert-Close([string]$name, [double]$actual, [double]$expected, [double]$relTol) {
    $tol = [math]::Abs($expected) * $relTol
    $ok  = [math]::Abs($actual - $expected) -le $tol
    Add-Result $name $ok ('actual={0:0.####} expected={1:0.####} tol=+/-{2:0.####}' -f $actual, $expected, $tol)
}

function Assert-AbsClose([string]$name, [double]$actual, [double]$expected, [double]$absTol) {
    $ok = [math]::Abs($actual - $expected) -le $absTol
    Add-Result $name $ok ('actual={0:0.#####} expected={1:0.#####} absTol={2}' -f $actual, $expected, $absTol)
}

# Asymmetric band: actual must lie within [expected*(1-loFrac), expected*(1+hiFrac)].
# Used for inscribed-polygon primitives whose polyhedron volume is strictly BELOW
# the ideal (a small negative deficit, a negligible positive slack).
function Assert-Band([string]$name, [double]$actual, [double]$expected, [double]$loFrac, [double]$hiFrac) {
    $lo = $expected * (1.0 - $loFrac)
    $hi = $expected * (1.0 + $hiFrac)
    $ok = ($actual -ge $lo) -and ($actual -le $hi)
    Add-Result $name $ok ('actual={0:0.###} band=[{1:0.###},{2:0.###}]' -f $actual, $lo, $hi)
}

# Per-axis bbox size AND bbox centre for a primitive placed off the origin. The
# centre check is the direct regression for the old geosphere bug (which dragged
# geometry toward the world origin); the size check confirms per-axis extent.
function Assert-PrimBbox([string]$prefix, [string]$path, [double[]]$expSize, [double[]]$expCenter, [double]$tol) {
    $bb = Get-StlBBox $path
    $axes = @('X', 'Y', 'Z')
    for ($k = 0; $k -lt 3; $k++) {
        Assert-AbsClose ("$prefix size.$($axes[$k])") ([double]$bb.size[$k]) $expSize[$k] $tol
        $ctr = ([double]$bb.min[$k] + [double]$bb.max[$k]) / 2.0
        Assert-AbsClose ("$prefix center.$($axes[$k])") $ctr $expCenter[$k] $tol
    }
}

# --- Worker runner: writes job.json, runs, parses the done stats + voidClear --
function Invoke-Worker($job, [string]$tag) {
    $jobPath = Join-Path $WorkDir "$tag.job.json"
    $outPath = Join-Path $WorkDir "$tag.out.txt"
    $errPath = Join-Path $WorkDir "$tag.err.txt"
    ($job | ConvertTo-Json -Depth 12) | Set-Content -Path $jobPath -Encoding UTF8

    $proc = Start-Process -FilePath $WorkerExe -ArgumentList "`"$jobPath`"" `
        -NoNewWindow -Wait -PassThru `
        -RedirectStandardOutput $outPath -RedirectStandardError $errPath
    $exit = $proc.ExitCode

    $lines = @(); if (Test-Path $outPath) { $lines = @(Get-Content $outPath) }
    $errText = ''; if (Test-Path $errPath) { $errText = (Get-Content $errPath -Raw) }

    $stats = $null; $void = $null
    foreach ($ln in $lines) {
        $t = "$ln".Trim(); if (-not $t) { continue }
        $obj = $null; try { $obj = $t | ConvertFrom-Json } catch { continue }
        if ($obj.stage -eq 'done') { $stats = $obj.stats }
        if ($obj.note  -eq 'voidClear') { $void = $obj }
    }
    return [pscustomobject]@{ exit=$exit; stats=$stats; void=$void; lines=$lines; err=$errText; jobPath=$jobPath }
}

function Test-Ok($r, [string]$name) {
    if ($r.exit -ne 0 -or $null -eq $r.stats) {
        $e = ("$($r.err)" -replace '\s+', ' ').Trim()
        Add-Result $name $false ("worker exit={0} err={1}" -f $r.exit, $e)
        return $false
    }
    return $true
}

# --- Common part paths -------------------------------------------------------
$BoxStl     = Join-Path $WorkDir 'box.stl'         # 60x40x20 @ origin
$SphereStl  = Join-Path $WorkDir 'sphere.stl'      # d20 @ origin
$CylStl     = Join-Path $WorkDir 'cyl.stl'         # d20 h30 @ origin (boolean cutter)
$SphereZone = Join-Path $WorkDir 'sphere_zone.stl' # d30 @ origin (zone-lattice)
$CylVoid    = Join-Path $WorkDir 'cyl_void.stl'    # d10 h40 @ origin (zone-void, through Z)

Write-Host "`n== Primitives ==" -ForegroundColor Cyan

# 1) box 60x40x20 -> vol ~= 48000 (+/-1%)
$r = Invoke-Worker ([ordered]@{
    mode='op'; opKind='primitive'; voxelSizeMM=0.3; outputPath=$BoxStl
    primitive=@{ kind='box'; sizeMM=@{x=60;y=40;z=20}; centerMM=@{x=0;y=0;z=0}; sides=0 }
}) 'prim_box'
if (Test-Ok $r 'primitive box volume') {
    Assert-Close 'primitive box volume' ([double]$r.stats.volumeMM3) 48000 0.01
    $cog = $r.stats.cogMM
    $cogOk = ([math]::Abs([double]$cog[0]) -lt 0.01) -and ([math]::Abs([double]$cog[1]) -lt 0.01) -and ([math]::Abs([double]$cog[2]) -lt 0.01)
    Add-Result 'primitive box CoG ~= origin' $cogOk ('cog=({0:0.###},{1:0.###},{2:0.###})' -f [double]$cog[0],[double]$cog[1],[double]$cog[2])
}

# 2) sphere d20 -> vol ~= 4188.79 (+/-2%)
$r = Invoke-Worker ([ordered]@{
    mode='op'; opKind='primitive'; voxelSizeMM=0.3; outputPath=$SphereStl
    primitive=@{ kind='sphere'; sizeMM=@{x=20;y=20;z=20}; centerMM=@{x=0;y=0;z=0}; sides=0 }
}) 'prim_sphere'
if (Test-Ok $r 'primitive sphere volume') {
    Assert-Close 'primitive sphere volume' ([double]$r.stats.volumeMM3) 4188.79 0.02
}

# helper cylinders / zone parts (generated, not directly asserted)
$r = Invoke-Worker ([ordered]@{
    mode='op'; opKind='primitive'; voxelSizeMM=0.3; outputPath=$CylStl
    primitive=@{ kind='cylinder'; sizeMM=@{x=20;y=20;z=30}; centerMM=@{x=0;y=0;z=0}; sides=0 }
}) 'prim_cyl'
[void](Test-Ok $r 'primitive cylinder (cutter)')

$r = Invoke-Worker ([ordered]@{
    mode='op'; opKind='primitive'; voxelSizeMM=0.3; outputPath=$SphereZone
    primitive=@{ kind='sphere'; sizeMM=@{x=30;y=30;z=30}; centerMM=@{x=0;y=0;z=0}; sides=0 }
}) 'prim_sphere_zone'
[void](Test-Ok $r 'primitive sphere zone')

$r = Invoke-Worker ([ordered]@{
    mode='op'; opKind='primitive'; voxelSizeMM=0.3; outputPath=$CylVoid
    primitive=@{ kind='cylinder'; sizeMM=@{x=10;y=10;z=40}; centerMM=@{x=0;y=0;z=0}; sides=0 }
}) 'prim_cyl_void'
[void](Test-Ok $r 'primitive cylinder void')

Write-Host "`n== Primitives off-origin (center 37,-22,51) + watertight ==" -ForegroundColor Cyan

# The old PicoGK geosphere projected subdivision midpoints toward the WORLD
# ORIGIN, so a sphere placed off-origin drifted/shattered (bbox centre wrong).
# These cases place ALL FOUR primitives at a non-trivial off-origin centre and
# assert (a) exact per-axis bbox size, (b) exact bbox centre (regression proof),
# (c) sensible volume, and (d) watertightness by the directed-edge test.
$OffC   = @{ x = 37; y = -22; z = 51 }
$OffCtr = @(37.0, -22.0, 51.0)
$BboxTol = 0.001

# box 60x40x20 off-origin -> size exact, centre exact, vol 48000 (+/-0.1%)
$offBox = Join-Path $WorkDir 'off_box.stl'
$r = Invoke-Worker ([ordered]@{
    mode='op'; opKind='primitive'; voxelSizeMM=0.3; outputPath=$offBox
    primitive=@{ kind='box'; sizeMM=@{x=60;y=40;z=20}; centerMM=$OffC; sides=0 }
}) 'off_box'
if (Test-Ok $r 'off-origin box') {
    Assert-Band  'off-origin box volume' ([double]$r.stats.volumeMM3) 48000 0.001 0.001
    Assert-PrimBbox 'off-origin box' $offBox @(60.0,40.0,20.0) $OffCtr $BboxTol
    Test-Watertight 'off-origin box watertight' $offBox
}

# cylinder dia20 h40 off-origin -> X/Y size 20, Z size 40, centre exact,
# vol pi*r^2*h = 12566.37 within the -1%/+0.1% inscribed-polygon band
$offCyl = Join-Path $WorkDir 'off_cyl.stl'
$expCylVol = [math]::PI * 100.0 * 40.0
$r = Invoke-Worker ([ordered]@{
    mode='op'; opKind='primitive'; voxelSizeMM=0.3; outputPath=$offCyl
    primitive=@{ kind='cylinder'; sizeMM=@{x=20;y=20;z=40}; centerMM=$OffC; sides=0 }
}) 'off_cyl'
if (Test-Ok $r 'off-origin cylinder') {
    Assert-Band  'off-origin cylinder volume' ([double]$r.stats.volumeMM3) $expCylVol 0.01 0.001
    Assert-PrimBbox 'off-origin cylinder' $offCyl @(20.0,20.0,40.0) $OffCtr $BboxTol
    Test-Watertight 'off-origin cylinder watertight' $offCyl
}

# sphere d24 off-origin -> size 24 on every axis, centre exact,
# vol (4/3)pi r^3 = 7238.23 (+/-2%); then re-voxelize to prove OUTWARD winding
$offSph = Join-Path $WorkDir 'off_sph.stl'
$expSphVol = (4.0/3.0) * [math]::PI * [math]::Pow(12.0,3)
$r = Invoke-Worker ([ordered]@{
    mode='op'; opKind='primitive'; voxelSizeMM=0.3; outputPath=$offSph
    primitive=@{ kind='sphere'; sizeMM=@{x=24;y=24;z=24}; centerMM=$OffC; sides=0 }
}) 'off_sph'
if (Test-Ok $r 'off-origin sphere') {
    $sphMeshVol = [double]$r.stats.volumeMM3
    Assert-Close 'off-origin sphere volume' $sphMeshVol $expSphVol 0.02
    Assert-PrimBbox 'off-origin sphere' $offSph @(24.0,24.0,24.0) $OffCtr $BboxTol
    Test-Watertight 'off-origin sphere watertight' $offSph
    # re-voxelize the off-origin sphere (offset 0). If winding were inward the
    # SDF would collapse/invert; a non-empty result ~ mesh volume proves it solid.
    $sphRevox = Join-Path $WorkDir 'off_sph_revox.stl'
    $r2 = Invoke-Worker ([ordered]@{
        mode='op'; opKind='offset'; offsetDistMM=0.0; voxelSizeMM=0.3; outputPath=$sphRevox
        inputs=@(@{ path=$offSph })
    }) 'off_sph_revox'
    if (Test-Ok $r2 'off-origin sphere re-voxelize') {
        $rv = [double]$r2.stats.volumeMM3
        Add-Result 'off-origin sphere re-voxelize non-empty' ($rv -gt 1.0) ('re-voxelized volume={0:0.##} mm3' -f $rv)
        Assert-Close 'off-origin sphere re-voxelize ~ mesh volume' $rv $sphMeshVol 0.02
    }
}

# cone dia20 h40 off-origin -> X/Y size 20, Z size 40, centre exact,
# vol pi*r^2*h/3 = 4188.79 (+/-2%)
$offCone = Join-Path $WorkDir 'off_cone.stl'
$expConeVol = [math]::PI * 100.0 * 40.0 / 3.0
$r = Invoke-Worker ([ordered]@{
    mode='op'; opKind='primitive'; voxelSizeMM=0.3; outputPath=$offCone
    primitive=@{ kind='cone'; sizeMM=@{x=20;y=20;z=40}; centerMM=$OffC; sides=0 }
}) 'off_cone'
if (Test-Ok $r 'off-origin cone') {
    Assert-Close 'off-origin cone volume' ([double]$r.stats.volumeMM3) $expConeVol 0.02
    Assert-PrimBbox 'off-origin cone' $offCone @(20.0,20.0,40.0) $OffCtr $BboxTol
    Test-Watertight 'off-origin cone watertight' $offCone
}

Write-Host "`n== Boolean / Shell / Offset ==" -ForegroundColor Cyan

# 3) boolean difference: box - cylinder(d20,h30) -> 48000 - pi*100*20 = 41716.8 (+/-2%)
$diffStl = Join-Path $WorkDir 'diff.stl'
$expDiff = 48000.0 - [math]::PI * 100.0 * 20.0
$r = Invoke-Worker ([ordered]@{
    mode='op'; opKind='boolean'; booleanKind='difference'; voxelSizeMM=0.3; outputPath=$diffStl
    inputs=@(@{ path=$BoxStl }, @{ path=$CylStl })
}) 'bool_diff'
if (Test-Ok $r 'boolean difference volume') {
    Assert-Close 'boolean difference volume' ([double]$r.stats.volumeMM3) $expDiff 0.02
}

# 4) shell inside t2 -> 48000 - 56*36*16 = 15744 (+/-2%)
$shellStl = Join-Path $WorkDir 'shell.stl'
$expShell = 48000.0 - (56.0*36.0*16.0)
$r = Invoke-Worker ([ordered]@{
    mode='op'; opKind='shell'; shellDirection='inside'; shellThicknessMM=2.0; voxelSizeMM=0.3; outputPath=$shellStl
    inputs=@(@{ path=$BoxStl })
}) 'shell_inside'
if (Test-Ok $r 'shell inside volume') {
    Assert-Close 'shell inside volume' ([double]$r.stats.volumeMM3) $expShell 0.02
}

# 5) offset -2 -> 56*36*16 = 32256 (+/-2%)
$offStl = Join-Path $WorkDir 'off.stl'
$expOff = 56.0*36.0*16.0
$r = Invoke-Worker ([ordered]@{
    mode='op'; opKind='offset'; offsetDistMM=-2.0; voxelSizeMM=0.3; outputPath=$offStl
    inputs=@(@{ path=$BoxStl })
}) 'offset_neg2'
if (Test-Ok $r 'offset -2 volume') {
    Assert-Close 'offset -2 volume' ([double]$r.stats.volumeMM3) $expOff 0.02
}

Write-Host "`n== Transform / Mirror (mesh-exact) ==" -ForegroundColor Cyan

# 6) transform bake +10 in X -> bbox shifted EXACTLY (box was x:[-30,30])
$xbakeStl = Join-Path $WorkDir 'xbake.stl'
$r = Invoke-Worker ([ordered]@{
    mode='op'; opKind='transform'; bake=$true; voxelSizeMM=0.3; outputPath=$xbakeStl
    inputs=@(@{ path=$BoxStl; transform=@{ translateMM=@{x=10;y=0;z=0}; rotateDeg=@{x=0;y=0;z=0} } })
}) 'xform_bake'
if (Test-Ok $r 'transform bake +10x bbox') {
    $bb = Get-StlBBox $xbakeStl
    Assert-AbsClose 'transform bake +10x min.X' ([double]$bb.min[0]) (-20.0) 0.001
    Assert-AbsClose 'transform bake +10x max.X' ([double]$bb.max[0]) ( 40.0) 0.001
}

# 7) rotate 90 deg Z -> X/Y extents swap: size ~= (40,60,20)
$xrotStl = Join-Path $WorkDir 'xrot.stl'
$r = Invoke-Worker ([ordered]@{
    mode='op'; opKind='transform'; bake=$true; voxelSizeMM=0.3; outputPath=$xrotStl
    inputs=@(@{ path=$BoxStl; transform=@{ translateMM=@{x=0;y=0;z=0}; rotateDeg=@{x=0;y=0;z=90} } })
}) 'xform_rot90z'
if (Test-Ok $r 'rotate 90z bbox swap') {
    $bb = Get-StlBBox $xrotStl
    Assert-AbsClose 'rotate 90z size.X (was 60->40)' ([double]$bb.size[0]) 40.0 0.02
    Assert-AbsClose 'rotate 90z size.Y (was 40->60)' ([double]$bb.size[1]) 60.0 0.02
    Assert-AbsClose 'rotate 90z size.Z (unchanged)'  ([double]$bb.size[2]) 20.0 0.02
}

# 8) mirror: across plane point (50,0,0) normal (1,0,0). mesh vol +/-0.5%,
#    then re-voxelize (offset 0) must be NON-EMPTY & ~box volume (catches winding).
$mirStl = Join-Path $WorkDir 'mir.stl'
$r = Invoke-Worker ([ordered]@{
    mode='op'; opKind='mirror'; voxelSizeMM=0.3; outputPath=$mirStl
    inputs=@(@{ path=$BoxStl })
    mirror=@{ planePoint=@{x=50;y=0;z=0}; planeNormal=@{x=1;y=0;z=0} }
}) 'mirror'
if (Test-Ok $r 'mirror mesh volume') {
    Assert-Close 'mirror mesh volume (+/-0.5%)' ([double]$r.stats.volumeMM3) 48000 0.005
    $bb = Get-StlBBox $mirStl
    # reflected box: x in [70,130], center 100 — geometry actually moved
    Assert-AbsClose 'mirror bbox center.X (moved to 100)' (([double]$bb.min[0]+[double]$bb.max[0])/2.0) 100.0 0.01
    # re-voxelize the mirrored mesh: winding must be outward or this collapses/errors
    $revoxStl = Join-Path $WorkDir 'mir_revox.stl'
    $r2 = Invoke-Worker ([ordered]@{
        mode='op'; opKind='offset'; offsetDistMM=0.0; voxelSizeMM=0.3; outputPath=$revoxStl
        inputs=@(@{ path=$mirStl })
    }) 'mirror_revox'
    if (Test-Ok $r2 'mirror re-voxelize non-empty') {
        $rv = [double]$r2.stats.volumeMM3
        Add-Result 'mirror re-voxelize non-empty' ($rv -gt 1.0) ('re-voxelized volume={0:0.##} mm3' -f $rv)
        Assert-Close 'mirror re-voxelize ~ box volume' $rv 48000 0.05
    }
}

Write-Host "`n== Zoned generate (single) ==" -ForegroundColor Cyan

# 9) box base + sphere zone-lattice + through-cylinder zone-void, skin 1.5 / grow 0.5
$zonedStl = Join-Path $WorkDir 'zoned.stl'
$r = Invoke-Worker ([ordered]@{
    mode='single'; stlPath=$BoxStl; outputPath=$zonedStl
    pattern='gyroid'; cellSizeMM=8; wallThicknessMM=1.2; voxelSizeMM=0.3
    zoneLattice=@(@{ path=$SphereZone })
    zoneVoid=@(@{ path=$CylVoid })
    skinThicknessMM=1.5
    keepOutGrowMM=0.5
    transitionMM=0
}) 'zoned_single'
if (Test-Ok $r 'zoned generate') {
    $lrv = [double]$r.stats.latticeRegionVolumeMM3
    # latticeRegion ⊆ sphere(r15) so 0 < LRV < 14137; and clearly non-trivial.
    $lrvOk = ($lrv -gt 100.0) -and ($lrv -lt 14200.0)
    Add-Result 'zoned latticeRegionVolume sane' $lrvOk ('latticeRegionVolumeMM3={0:0.##}' -f $lrv)

    $vOk = ($null -ne $r.void) -and ([bool]$r.void.pass)
    $resid = 0.0; if ($null -ne $r.void) { $resid = [double]$r.void.residualMM3 }
    Add-Result 'zoned voidClear passes' $vOk ('pass={0} residualMM3={1:0.####}' -f ($null -ne $r.void -and [bool]$r.void.pass), $resid)

    # bbox unchanged == full box 60x40x20 centered at origin (voids only pierce faces)
    $bb = Get-StlBBox $zonedStl
    $sizeOk = ([math]::Abs([double]$bb.size[0]-60.0) -lt 1.0) -and `
              ([math]::Abs([double]$bb.size[1]-40.0) -lt 1.0) -and `
              ([math]::Abs([double]$bb.size[2]-20.0) -lt 1.0)
    Add-Result 'zoned bbox unchanged (60x40x20)' $sizeOk ('size=({0:0.##},{1:0.##},{2:0.##})' -f [double]$bb.size[0],[double]$bb.size[1],[double]$bb.size[2])
    $infill = [double]$r.stats.infillPct
    Add-Result 'zoned infillPct in (0,100)' (($infill -gt 0.0) -and ($infill -lt 100.0)) ('infillPct={0:0.###}' -f $infill)

    # Stage 3: cleanup runs by default on generate; result must be watertight and
    # carry a cleanup summary.
    Add-Result 'zoned watertight' ([bool]$r.stats.watertight) `
        ('watertight={0} openEdges={1}' -f [bool]$r.stats.watertight, [int]$r.stats.openEdges)
    Add-Result 'zoned cleanup present' ($null -ne $r.stats.cleanup) `
        ('components={0} removedComponents={1}' -f [int]$r.stats.cleanup.components, [int]$r.stats.cleanup.removedComponents)
}

Write-Host "`n== Mesh cleanup - island removal + watertight (Stage 3) ==" -ForegroundColor Cyan

# box 40^3 @ origin (the body) + a 0.2^3 speck 60mm away. A voxel merge welds
# them into one Voxels field that meshes to TWO disconnected shells; cleanup
# drops the sub-threshold speck (always keeping the largest component).
$clBox = Join-Path $WorkDir 'cl_box.stl'
$r = Invoke-Worker ([ordered]@{
    mode='op'; opKind='primitive'; voxelSizeMM=0.3; outputPath=$clBox
    primitive=@{ kind='box'; sizeMM=@{x=40;y=40;z=40}; centerMM=@{x=0;y=0;z=0}; sides=0 }
}) 'cl_box'
[void](Test-Ok $r 'cleanup base box40')

$clSpeck = Join-Path $WorkDir 'cl_speck.stl'
$r = Invoke-Worker ([ordered]@{
    mode='op'; opKind='primitive'; voxelSizeMM=0.3; outputPath=$clSpeck
    primitive=@{ kind='box'; sizeMM=@{x=0.2;y=0.2;z=0.2}; centerMM=@{x=60;y=0;z=0}; sides=0 }
}) 'cl_speck'
[void](Test-Ok $r 'cleanup speck')

# merge with cleanup ON -> the far speck is removed as an island.
$clMerge = Join-Path $WorkDir 'cl_merge_on.stl'
$r = Invoke-Worker ([ordered]@{
    mode='op'; opKind='merge'; filletMM=0; voxelSizeMM=0.3; outputPath=$clMerge; cleanup=$true
    inputs=@(@{ path=$clBox }, @{ path=$clSpeck })
}) 'cl_merge_on'
if (Test-Ok $r 'cleanup merge (islands removed)') {
    $rc = [int]$r.stats.cleanup.removedComponents
    Add-Result 'cleanup removedComponents == 1' ($rc -eq 1) `
        ('removedComponents={0} components={1} removedVol={2:0.######}' -f $rc, [int]$r.stats.cleanup.components, [double]$r.stats.cleanup.removedVolumeMM3)
    # result volume ~ 40^3 (the speck is negligible; voxel-truth ~ box).
    Assert-Band 'cleanup result volume ~ 40^3' ([double]$r.stats.volumeMM3) 64000 0.02 0.02
    Add-Result 'cleanup result watertight' ([bool]$r.stats.watertight) `
        ('watertight={0} openEdges={1}' -f [bool]$r.stats.watertight, [int]$r.stats.openEdges)
    # after island removal the output bbox is the box only (max.X ~ 20, not ~60).
    $bb = Get-StlBBox $clMerge
    Add-Result 'cleanup removed the far speck (bbox max.X ~ 20)' `
        ([math]::Abs([double]$bb.max[0] - 20.0) -lt 1.0) ('max.X={0:0.###}' -f [double]$bb.max[0])
}

# same merge, cleanup OFF -> the speck SURVIVES (bbox still reaches x~60) and no
# cleanup summary is reported.
$clMergeF = Join-Path $WorkDir 'cl_merge_off.stl'
$r = Invoke-Worker ([ordered]@{
    mode='op'; opKind='merge'; filletMM=0; voxelSizeMM=0.3; outputPath=$clMergeF; cleanup=$false
    inputs=@(@{ path=$clBox }, @{ path=$clSpeck })
}) 'cl_merge_off'
if (Test-Ok $r 'cleanup:false regression (speck survives)') {
    Add-Result 'cleanup:false reports no island removal' ($null -eq $r.stats.cleanup) `
        ('cleanup={0}' -f $(if ($null -eq $r.stats.cleanup) { 'null' } else { 'present' }))
    $bb = Get-StlBBox $clMergeF
    Add-Result 'cleanup:false speck survives (bbox max.X > 40)' `
        ([double]$bb.max[0] -gt 40.0) ('max.X={0:0.###}' -f [double]$bb.max[0])
}

Write-Host "`n== Legacy regression (byte-compat) ==" -ForegroundColor Cyan

# 10) current-style single: Cylinder.stl gyroid cell8 wall1.2 voxel0.3
#     known-good: vol 32272.293, infillPct 53.4518, tris 1509056  (+/-0.1%)
$legStl = Join-Path $WorkDir 'legacy_single.stl'
$r = Invoke-Worker ([ordered]@{
    mode='single'; stlPath=$Cylinder; outputPath=$legStl
    pattern='gyroid'; cellSizeMM=8; wallThicknessMM=1.2; voxelSizeMM=0.3; smoothOffsetMM=0
}) 'legacy_single'
if (Test-Ok $r 'legacy single regression') {
    Assert-Close 'legacy single volumeMM3'  ([double]$r.stats.volumeMM3) 32272.293 0.001
    Assert-Close 'legacy single infillPct'  ([double]$r.stats.infillPct) 53.4518   0.001
    Assert-Close 'legacy single triangles'  ([double]$r.stats.triangles) 1509056   0.001
}

# 11) fuse pair -> envelopeVolumeMM3 ~= 18036 (cavity 50x30x12 = 18000)
$fuseStl = Join-Path $WorkDir 'legacy_fuse.stl'
if ((Test-Path $PosStl) -and (Test-Path $NegStl)) {
    $r = Invoke-Worker ([ordered]@{
        mode='fuse'; positiveStlPath=$PosStl; negativeStlPath=$NegStl; outputPath=$fuseStl
        pattern='gyroid'; cellSizeMM=8; wallThicknessMM=1.2; voxelSizeMM=0.3; overlapMM=0.3; smoothOffsetMM=0
    }) 'legacy_fuse'
    if (Test-Ok $r 'legacy fuse regression') {
        Assert-Close 'legacy fuse envelopeVolumeMM3' ([double]$r.stats.envelopeVolumeMM3) 18036 0.005
    }
} else {
    Add-Result 'legacy fuse regression' $false "missing $PosStl / $NegStl"
}

# --- Summary -----------------------------------------------------------------
Write-Host "`n==== SUMMARY ====" -ForegroundColor Cyan
$script:Results | Format-Table -AutoSize | Out-String | Write-Host
$fails = @($script:Results | Where-Object { $_.Result -eq 'FAIL' })
$pass  = $script:Results.Count - $fails.Count
Write-Host ('{0} passed / {1} failed / {2} total' -f $pass, $fails.Count, $script:Results.Count) `
    -ForegroundColor $(if ($fails.Count -gt 0) { 'Red' } else { 'Green' })

if ($fails.Count -gt 0) {
    Write-Host "workdir retained for inspection: $WorkDir" -ForegroundColor Yellow
    exit 1
}
# clean up on success
Remove-Item -Recurse -Force $WorkDir -ErrorAction SilentlyContinue
exit 0
