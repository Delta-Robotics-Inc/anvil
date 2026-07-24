# Anvil — Gyroid Cavity Forge

**Anvil** is a local web app that converts a **solid part** or an **enclosed
cavity** into a self-supporting **gyroid TPMS lattice** and exports it so it
drops straight back into your CAD assembly, in place. The volumetric-geometry
forge in the Delta Robotics toolchain — where raw parts are beaten into
printable form.

## What it is

3D-printed parts with large internal voids are a problem for both major additive
processes:

- **FDM** must fill an enclosed void with *support material* that you can never
  remove — it is sealed inside.
- **SLS / MJF** traps loose *powder* in the void with no escape hole, adding
  weight and wasting material.

The fix is to fill the void with a **triply-periodic minimal surface (TPMS)**
lattice — a gyroid (or Schwarz P/D, Lidinoid, Neovius). A TPMS sheet is
**self-supporting** (no support material needed) and **open-celled** (powder and
air flow straight through), so it braces the walls while staying light and
printable. No slicer can do this per-cavity, and nothing else exports the result
in a **CAD-mergeable** frame. Infill App does both:

- **Workflow A — single part:** import a part → gyroidize the whole solid →
  export it alone, coordinates preserved.
- **Workflow B — positive + negative:** import the positive part *and* a solid
  that occupies its cavity (the "negative") → lattice the cavity → voxel-boolean
  fuse it into the positive → export one watertight, FDM- and SLS-ready part.

The voxel engine is [PicoGK](https://github.com/leap71/PicoGK); STEP↔STL and
faceted-STEP writing are handled by a Python OCP sidecar. The browser UI is a
bumpmesh-style drag-drop → parameters → preview → export loop.

## Requirements

| | |
|---|---|
| **OS** | Windows x64 (Windows 10/11). See the [macOS note](#platform-note) below. |
| **.NET** | .NET 9 SDK (`dotnet --version` ≥ 9.0). |
| **PicoGK fork** | A **sibling clone** of the patched PicoGK fork at `..\PicoGK` (i.e. `C:\Users\...\Repos\PicoGK` next to this repo). The worker consumes it via a `ProjectReference` to `..\..\PicoGK\src\PicoGK.csproj` — no NuGet package. |
| **PicoGK native runtime** | The worker csproj auto-copies the native DLLs (`picogk.1.7.dll`, `blosc.dll`, `lz4.dll`, `tbb12.dll`, `zlib1.dll`, `zstd.dll`) from `PicoGK\runtime\native\win-x64` next to `InfillWorker.exe` on build. **A System32 PicoGK install is NOT required.** |
| **Python** | Python 3.14 with `build123d` + `cadquery-ocp` (OCCT 7.9). Default interpreter path `C:\Python314\python.exe`; change it via `PythonPath` in `appsettings.json`. |

`appsettings.json` (repo root) holds the tunables:

```json
{
  "PythonPath": "C:\\Python314\\python.exe",
  "DataDir": "data",
  "MaxConcurrentJobs": 1,
  "WorkerPath": "worker\\bin\\Debug\\net9.0\\InfillWorker.exe"
}
```

## Quick start

```powershell
# Build, verify prerequisites, launch the server, open the browser:
scripts\run.ps1

# Headless (no browser — e.g. for scripting/CI):
scripts\run.ps1 -NoBrowser
```

`run.ps1` works from any directory. It builds `InfillApp.sln` (Debug), checks the
worker exe / Python / sidecar are present with clear errors, starts the server on
**http://127.0.0.1:5238**, waits for `/api/health`, then opens your browser.

Or run the server directly (build first with `dotnet build`):

```powershell
dotnet run --project server\InfillServer.csproj
```

## Usage

Drop one or more **STL** or **STEP** files onto the drop zone, assign each part a
**role**, set parameters, and click **Generate**. The role you pick decides the
workflow:

| Roles in the parts list | Mode | What happens |
|---|---|---|
| exactly one **Part** | **single** | The whole solid is gyroidized (Workflow A). |
| one **Positive** + one **Negative** | **fuse** | The Negative's volume is latticed and merged into the Positive (Workflow B). |

Only **base** roles (Part / Positive / Negative) decide the mode. **Zone** roles
(Zone · Lattice / Keep / Void) and derived parts layer on top without changing it
— see [Zoned lattice](#zoned-lattice). Beyond importing, you can also **build and
edit parts in-app** with [the tool palette](#the-tool-palette).

Uploaded parts render translucent; the generated result renders solid. Nothing is
ever recentered — the preview sits exactly where CAD will place it.

### Parameters

| Parameter | Meaning | Guidance |
|---|---|---|
| **Pattern** | TPMS family: Gyroid, Schwarz P, Schwarz D, Lidinoid, Neovius. | Gyroid is the robust default (smooth, isotropic, printable in any orientation). |
| **Cell size (mm)** | Unit-cell period of the lattice. | Larger = coarser, lighter, faster. Smaller = denser, heavier, more triangles. Typical 6–12 mm. Default 8. |
| **Wall thickness (mm)** | Thickness of the TPMS sheet. | Keep ≥ your printer's minimum wall (≈ nozzle/line width, e.g. ≥ 0.8–1.2 mm for FDM). Default 1.2. |
| **Resolution (voxel mm)** | Voxel edge length — the sampling grid. | **Smaller = finer detail but O(n³) memory & time.** 0.2–0.4 mm is a good range. See the guard below. Default 0.3. |
| **Overlap (mm)** *(fuse only)* | How far the lattice grows past the cavity wall into the positive, for a watertight joint. | 0.2–0.5 mm. Too small can leave a hairline seam; too large wastes material. Default 0.3. |
| **Smoothing (mm)** | Optional `TripleOffset` that rounds sharp lattice edges. | 0 = off (fastest). A small value (0.1–0.3) softens facet ridges. Default 0. |
| **STEP target (triangles)** | Triangle budget for the faceted-STEP export. | See [STEP export reality check](#step-export-reality-check). Default 60 000. |

> **Resolution guard.** The server rejects a job when the largest part dimension
> divided by the voxel size exceeds **~2000 voxels per axis** (e.g. a 200 mm part
> at 0.05 mm voxels = 4000 across → rejected: raise the voxel size). It also
> **warns** when the effective grid exceeds **~2×10⁹ voxels** — the job will run
> but may be slow and memory-heavy. When in doubt, start coarse (0.4 mm) and
> refine.

### Lattice & flow parameters

These control the lattice topology and the flow-metrics analysis. The advanced
group (rotation, phase, per-axis cell, reference flow) lives under the collapsible
**LATTICE // 格子** disclosure and is optional — sensible defaults apply.

| Parameter | Meaning | Guidance |
|---|---|---|
| **Lattice type** | **Sheet** or **skeletal** — see [below](#sheet-vs-skeletal). | Sheet is the default (a thin TPMS wall separating two independent air networks). Skeletal is a solid strut network around one continuous channel. |
| **Bias (mm)** *(skeletal only)* | Shifts the iso-level of the TPMS field, thickening/thinning the solid struts. Replaces **Wall thickness** when skeletal is selected. Range **−5…+5**, default 0. | Negative bias → thinner struts, more open channel. Positive → beefier struts, less open volume. 0 is the balanced minimal surface. |
| **Flow axis** | The through-flow direction (**X / Y / Z**) the profile and permeability are measured along. | Pick the axis fluid/powder actually travels. Default **Z**. Drives the open-area profile, choke, hydraulic diameter, and ΔP. |
| **Rotation (deg)** | Rotates the lattice field about X/Y/Z before sampling. Step 15°, range −180…180, default 0. | Re-orients cells relative to the part and the build plate — see [orientation guidance](#orientation-guidance). |
| **Phase offset (0–1)** | Shifts the TPMS field's phase per axis (fraction of one cell period). Default 0. | Nudges where cell walls land relative to the part surface; useful to avoid a wall coinciding with a thin feature. Server clamps to 0–1. |
| **Cell size (xyz)** | **Uniform** (one period, the default) or **per-axis** (independent X/Y/Z periods). | Per-axis stretches cells along one direction — e.g. a longer period along the flow axis for lower resistance. Prefilled from the uniform value when you switch. |
| **Ref flow (L/min)** | Reference volumetric flow rate the Darcy ΔP estimate is reported at. Step 5, range 1–1000, default 10. | Only affects the reported **ΔP** number (linear in flow); it does not change the geometry. |

### Sheet vs skeletal

A TPMS field `f(x,y,z) = 0` is a single minimal surface that cleanly divides space
into **two interpenetrating volumes** (`f > 0` and `f < 0`). The two modes keep
different parts of that geometry as solid:

- **Sheet** thickens the *surface itself* into a wall of the given thickness. The
  solid is the thin membrane; the **two** labyrinths on either side are both open.
  This is the classic self-supporting, open-celled infill: two independent air/powder
  networks that never connect, braced by the wall between them. Best stiffness-to-weight
  and the safe default for cavity venting.
- **Skeletal** keeps *one* of the two volumes solid (biased by **Bias mm**) and leaves
  the other as a **single** continuous channel. The result is a strut/gyroid-node
  network. One connected pore means lower, more predictable flow resistance along the
  channel — at some cost in isotropic stiffness.

Rule of thumb: **sheet** when you want light bracing and powder escape on both sides;
**skeletal** when a single clear flow path (cooling, filtration, fluidics) matters more
than symmetric stiffness.

### Orientation guidance

The lattice family and its orientation interact with both flow and printability:

- **Gyroid is nearly isotropic** — its properties barely change with direction, so
  rotation mostly matters for how walls meet the part surface, not for flow. It prints
  self-supporting in essentially any orientation. This is why it is the default.
- **Schwarz P is strongly anisotropic** — it has straight, axis-aligned channels.
  Aligning the **flow axis** with a Schwarz P channel gives a much larger open area (and
  lower ΔP) than sampling it off-axis; a 45° rotation deliberately chokes it. If you pick
  Schwarz P, set the flow axis and rotation on purpose — the choke number will move a lot.
- **Rotation affects FDM overhangs.** Rotating the field changes the local wall angle
  relative to the build plate. Steep, self-supporting angles print clean; rotating walls
  toward horizontal introduces overhangs that may need support or sag. For FDM, prefer
  rotations that keep sheet walls near-vertical along the print Z; for SLS/MJF (powder
  support) orientation is unconstrained.

## The tool palette

Wave 1 turns Anvil into a HyDesign-style **object workspace**. The pipeline
toolbar's middle groups — **PRIM · BOOL · MERGE · SHELL · OFFSET · XFORM ·
MIRROR · DUPE** — each open a contextual panel at the top of the left column
(part pickers + parameters + **CONFIRM**, with inline progress; **Esc** or the
✕ closes it).

Every tool is **non-destructive**: it runs a short worker job that produces a
**new derived part** (its mesh at `data/parts/{id}/mesh.stl`, registered in the
PartStore) and leaves its sources untouched. The derived part shows a
**provenance line** in the OBJECTS tree — e.g. `└ BOOLEAN · A − B`,
`└ SHELL · INSIDE 2mm` — and carries a replayable snapshot of the op request.
There is no live modifier stack: **undo = delete the derived part.**

| Tool | What it does | Key params |
|---|---|---|
| **Primitive** | Adds a box / cylinder / sphere / cone as a new part. | `kind`, `sizeMM` (full X/Y/Z), `centerMM` (defaults to the visible-union bbox centre), resolution (voxel mm) |
| **Boolean** | Union, difference or intersection of two parts (`MAIN − SECONDARY`). | main, secondary, operation (`union` \| `difference` \| `intersection`), voxel |
| **Merge** | Smooth (filleted) union of two parts. | A, B, blend (fillet mm), voxel |
| **Shell** | Hollows a part into a wall — inward, outward or centred on the surface. | part, direction (`inside` \| `outside` \| `centered`), thickness mm, voxel |
| **Offset** | Grows (+) or shrinks (−) a part by a signed distance. | part, distance (signed mm), voxel |
| **Transform** | Non-destructive translate / rotate with live preview; **APPLY** bakes a new part. See [Transforms](#transforms). | part, translate mm, rotate deg, **CENTER** preset, **APPLY** |
| **Mirror** | Reflects a part across the XY / YZ / XZ plane (winding-corrected). | part, plane, plane offset mm |
| **Duplicate** | An instant, independent copy. | part |

- **Mesh-exact vs voxelized.** **Primitive**, **Transform (APPLY)** and
  **Mirror** are **mesh-only** — they never touch the voxel kernel, so they are
  geometrically exact (no half-voxel loss). **Boolean**, **Merge**, **Shell**
  and **Offset** run through PicoGK and are accurate to **± half a voxel**. Each
  voxel op carries its own **Resolution (voxel mm)** field (prefilled from the
  current TPMS voxel size); smaller = finer but heavier. Feature sizes must
  clear the grid: shell thickness and `|offset|` must exceed **1.5 × voxel**, and
  the server rejects an op whose union bounding box would blow the same
  [resolution guard](#parameters) the generate path uses.
- **Duplicate is synchronous** (a file copy, returned `200`); every other op is
  an async worker job (`202`, then it finishes like a generate job).
- **In-memory registry.** The PartStore is in memory only. Uploaded and derived
  parts (and their `data/parts/{id}/` folders) are **not restored after a server
  restart** — a fresh server starts with an empty parts list.

## Transforms

Each part carries an optional **non-destructive TRS** — translate (mm) + rotate
(degrees); scale is reserved (= 1). It lives on the part record, **not** baked
into geometry:

- **Live preview.** The **TRANSFORM** tool edits translate/rotate with the
  viewer applying the identical matrix instantly. The one canonical composition,
  shared by worker and viewer, is **scale → rotX → rotY → rotZ → translate**.
- **It travels with the part.** The TRS is folded into the mesh load
  server-side (before voxelization) for **any** op or **Generate** that consumes
  the part, so voxel and mesh ops both see the transformed part.
- **APPLY bakes** the TRS mesh-to-mesh into a new part (exact, zero resolution
  loss) beside the source, then resets the source's TRS to identity.
- **CENTER** is a preset that writes an explicit `translate` moving the part's
  bbox centre to the origin. Like every transform it is **visible, editable and
  clearable — never a silent recentre.**

This preserves Anvil's [coordinate guarantee](#coordinate-preservation-guarantee):
ops never recenter, primitives are placed at an explicit `centerMM`, and the TRS
is explicit and previewed 1:1.

## Zoned lattice

Instead of latticing a whole body, you can **section off regions** with
Autodesk-generative-design-style keep/avoid roles, layered on a base part. Assign
these roles in the parts list exactly like base roles; the **ZONES** tile appears
as soon as one exists:

- **Zone · Lattice** (blue) — the lattice fills here.
- **Zone · Keep** (green) — stays solid.
- **Zone · Void** (red) — never latticed.

> **The promise:** *the lattice fills the blue zones, stays **SKIN** mm inside
> the surface, keeps green solid, and never enters red (+**GROW** mm).*

The **ZONES** tile exposes three offsets:

| Offset | Meaning |
|---|---|
| **Skin (mm)** | Inward skin off the base part surface the lattice keeps clear (single mode). Blue zones stay this many mm inside the wall. |
| **Transition (mm)** | **V2 — hard edge for now.** Reserved for a smooth solid↔lattice blend. The value is accepted and stored but **not yet applied** in Wave 1. |
| **Keep-out grow (mm)** | Outward growth of the red void zones. The lattice (and the body) is carved back this many mm around every void — a safety margin. |

Zone algebra (single mode), in order: the lattice region = the blue zones ∩ the
body (or the whole body if no blue zone), pulled **SKIN** mm inside the surface,
minus the green keep zones; the clipped TPMS fills that region and is merged back
into the body; then — **last, so void always wins** — the grown red voids are
subtracted. A self-check confirms the voids are clear.

- **Fuse mode.** Zones also apply to Workflow B: **skin is ignored** (the server
  zeroes it and warns), **keep** zones inside the cavity are re-added solid, and
  **voids carve last** (they may cut into the positive — intended).
- **Zone-scoped flow metrics.** With zones, the flow envelope becomes the
  **lattice region** (not the whole part). A new stat
  **`latticeRegionVolumeMM3`** reports that region's volume, and porosity / infill
  are measured against it rather than the full bounding volume.

## Volume analysis

Every part — uploaded, converted-from-STEP, or derived from an op — carries
**mass properties** computed by one divergence-theorem pass over its mesh:

- **Volume** (`volumeMM3`), **surface area** (`surfaceAreaMM2`), and **centre of
  gravity** (`cogMM`).

They are surfaced per part in the sidebar and returned by `POST /api/parts`,
`GET /api/parts`, and — for a derived part — in `JobStatus.part` when its op
completes.

## Flow metrics

When a job finishes, the **FLOW // 流量** tile reports a set of **geometric** flow
descriptors computed directly from the voxel field and the meshed result — sampled in
≤128 bins along the chosen **flow axis**. These are **fast geometric estimates, not a
CFD solution**: no Navier–Stokes, no turbulence, no real fluid. Use them to *compare*
lattices and spot a choke, not to predict an absolute pressure drop.

Let `ε` = porosity (open fraction), `Sᵥ` = specific surface area (solid–void interface
area per unit envelope volume), `A(s)` = open cross-sectional area at position `s` along
the flow axis, and `A_env(s)` = the part's cross-section (envelope) at `s`.

| Metric | Formula / definition | Notes |
|---|---|---|
| **Porosity** `ε` | `airVolumeMM3 / envelopeVolumeMM3` (as %) | Fraction of the bounding volume that is open (air). Free volume = `airVolumeMM3 / 1000` cm³. |
| **Open-area profile** `A(s)` | Open (void) area of each cross-section vs `A_env(s)`, per bin | Plotted as the **primary line**; the envelope is the dim reference. Leading/trailing zero bins are the empty space before/after the solid. |
| **Choke** | `min_s A(s)` = `minOpenAreaMM2` at `minAtMM` | The tightest open cross-section — the flow-limiting constriction. **Choke ratio** = `minOpenAreaMM2 / grossAreaMM2` (how pinched the narrowest slice is vs the widest). Marked in red on the sparkline. |
| **Specific surface** `Sᵥ` | `surfaceAreaMM2 / envelopeVolumeMM3` (mm⁻¹) | Wetted interface per unit volume. High `Sᵥ` = lots of surface (good for heat/mass transfer, higher drag). |
| **Hydraulic diameter** `D_h` | `D_h = 4ε / Sᵥ` | The standard porous-media characteristic pore size. Larger `D_h` → freer flow. |
| **Permeability** `k` | **Kozeny–Carman:** `k = ε³ / (c · Sᵥ² · (1−ε)²)` (m², `c ≈ 5`) | Geometric permeability of the pore network along the flow axis. Reported in scientific notation. |
| **Pressure drop** `ΔP` | **Darcy:** `ΔP = (μ · L · Q) / (k · A)` at **Ref flow** `Q` | `μ` = fluid viscosity, `L` = `flowLengthMM`, `A` = mean open area. Labelled **EST** — linear in flow, derived from the geometric `k` above, **not** a solved flow field. |

The tile also surfaces the worker's `warnings[]` as amber chips (red when the message
contains "severe") — e.g. a sheet lattice's *two independent networks* note, or a
near-total choke.

## Coordinate preservation guarantee

Every stage — worker, sidecar, and the three.js viewer — operates in the **source
world frame**. STLs are loaded force-MM and saved MM, TPMS fields are
world-anchored, no boolean recenters, and the viewer fits the camera with a
`Box3` union instead of moving the mesh. Consequently **the exported part lands
exactly where the original did** (± half a voxel): import `result.step` into
Onshape/Fusion and it slots into place and boolean-merges with the source part —
no manual mesh alignment. For Workflow B, model the positive and the negative in
one shared coordinate system (as `samples\make_test_parts.py` does) and the fused
result inherits that frame.

## STEP export reality check

STL is always exported losslessly (it *is* the result mesh). STEP is
**best-effort and faceted**: the sidecar sews the triangle mesh into a
faceted-BRep solid where **every triangle becomes one planar face**. A true
analytic B-rep of a gyroid is **impossible** — there is no closed-form
NURBS/analytic surface for a TPMS clipped to an arbitrary volume, in any CAD tool.
So STEP files are large, and the triangle count is budgeted:

| Budget | Behavior |
|---|---|
| **default target 60 000 tris** | If the result exceeds the target, the worker coarse-remeshes (dispose → re-init PicoGK at a larger voxel) before conversion. |
| **warn at 150 000 tris** | Conversion proceeds but returns a warning (slow, very large file). |
| **refuse above 500 000 tris** | The sidecar refuses with an actionable message; decimate / raise the voxel size and retry. |

Observed cost: **~60 000 triangles ≈ a 135 MB STEP file, ~20 s** to write. Prefer
STL for slicing; use STEP only when you must boolean-merge in CAD.

## Architecture

Three cooperating processes keep PicoGK's native constraints (one `Library` per
process, process-global voxel size, native crashes kill the host) isolated from
the web host:

```
  Browser  (three.js via jsDelivr CDN, no build step)
     │  HTTP  /api   →  http://127.0.0.1:5238
     ▼
  InfillServer  (ASP.NET minimal API)         ← references NO PicoGK
     ├─ per job ─▶  InfillWorker.exe          headless PicoGK, one Library/job,
     │                                         crash-isolated, real cancel (Kill)
     └─ STEP↔STL ─▶ cadconvert.py (Python)     OCP / OCCT 7.9 faceted-BRep + mesh
```

The server only shells out — it queues jobs (max `MaxConcurrentJobs`), spawns one
`InfillWorker.exe` per generation with a `job.json`, parses the worker's
JSON-lines progress on stdout, and calls the Python sidecar for STEP/STL. All
voxel math lives in the worker. (The viewer loads three.js from a CDN, so the 3D
preview needs internet access on first load.)

## API reference

Base path `/api`, JSON is camelCase. The server binds `http://127.0.0.1:5238`.

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/api/health` | `{ ok, workerExists, workerPath, python }` |
| `POST` | `/api/parts` | multipart upload `.stl` / `.step` / `.stp` (STEP is converted to STL via the sidecar first) → `{ id, name, sourceFormat, stlUrl, triangles, bbox }` |
| `GET` | `/api/parts/{id}/mesh.stl` | binary STL for the preview |
| `DELETE` | `/api/parts/{id}` | remove a part |
| `GET` | `/api/parts` | list every registered part (uploads + derived) → `[PartInfo]` |
| `POST` | `/api/ops` | run a tool op → a new derived part. `duplicate` returns `200 { …PartInfo }` (synchronous file copy); every other op returns `202 { jobId, partId }` and finishes as an op job (watch `part` in JobStatus). See [Objects & Ops](#objects--ops-post-apiops). |
| `POST` | `/api/jobs` | JobRequest (below) → `202 { jobId, warning }` |
| `GET` | `/api/jobs/{id}` | JobStatus (below); the frontend polls @ 500 ms |
| `POST` | `/api/jobs/{id}/cancel` | kill the worker for a running job |
| `GET` | `/api/jobs/{id}/preview.stl` | result binary STL — this **is** the STL export (`?download=1` to attach) |
| `POST` | `/api/jobs/{id}/step` | optional `{ targetTriangles }` → kick off faceted-STEP conversion (async; watch `step` in JobStatus) |
| `GET` | `/api/jobs/{id}/result.step` | faceted-BRep STEP (`?download=1`) |

**JobRequest** (`POST /api/jobs`):

```jsonc
{
  "mode": "single",              // "single" | "fuse"
  "partId": "p_…",               // single mode
  "positiveId": "p_…",           // fuse mode
  "negativeId": "p_…",           // fuse mode
  "pattern": "gyroid",           // gyroid | schwarzP | schwarzD | lidinoid | neovius
  "latticeType": "sheet",        // "sheet" (default) | "skeletal"
  "cellSizeMM": 8.0,
  "cellSizeXYZ": { "x": 8, "y": 8, "z": 16 },  // optional; omit for uniform cellSizeMM
  "wallThicknessMM": 1.2,        // sheet mode: TPMS wall thickness
  "biasMM": 0.0,                 // skeletal mode only: field iso-level bias (−5…+5)
  "voxelSizeMM": 0.3,
  "overlapMM": 0.3,              // fuse mode
  "smoothOffsetMM": 0,
  "rotationDeg": { "x": 0, "y": 0, "z": 0 },   // lattice field rotation, degrees
  "phaseOffset": { "x": 0, "y": 0, "z": 0 },   // 0–1 per axis (server clamps)
  "flowAxis": "z",               // "x" | "y" | "z" (default z) — flow-metrics axis
  "refFlowLpm": 10,              // 1–1000; reference flow for the ΔP estimate
  "stepExport": { "enabled": false, "targetTriangles": 60000 }
}
```

**JobStatus** (`GET /api/jobs/{id}`):

```jsonc
{
  "id": "j_…",
  "state": "running",            // queued | running | done | failed | cancelled
  "stage": "boolean",
  "progress": 0.6,
  "stats": {
    "volumeMM3": 0, "envelopeVolumeMM3": 0, "infillPct": 0, "triangles": 0,
    "latticeRegionVolumeMM3": 0,   // zoned generate: volume of the lattice region (envelope for flow)
    // ── flow metrics (present when the analysis ran) ──
    "airVolumeMM3": 0, "porosityPct": 0,
    "minOpenAreaMM2": 0, "minAtMM": 0, "chokeRatio": 0, "grossAreaMM2": 0,
    "flowLengthMM": 0, "surfaceAreaMM2": 0, "specificSurfaceInvMM": 0,
    "hydraulicDiameterMM": 0, "permeabilityM2": 0, "deltaPKPa": 0,
    "flowAxis": "z", "refFlowLpm": 10,
    "warnings": [],              // string[]; UI renders as amber/red chips
    "profile": {                 // ≤128 bins; leading/trailing zero bins exist
      "axis": "z",
      "positionsMM":   [/* … */],
      "openAreaMM2":   [/* … */],
      "envelopeAreaMM2":[/* … */]
    }
  },
  "step":  { "state": "none",    // none | running | done | failed
             "triangles": null, "warning": null, "error": null },
  "warning": null,
  "error": null,                 // set to the worker's message when state == "failed"
  "part": null                   // op jobs only — the derived PartInfo once state == "done"
}
```

> **Error surfacing.** A worker crash mid-job sets `state: "failed"` with the
> worker's stderr message in `error`. A failed STEP conversion (e.g. the >500 000
> triangle refusal) sets `step.state: "failed"` with the sidecar's actionable
> `{detail}` in `step.error`. The UI surfaces both as toasts.

### Objects & Ops (`POST /api/ops`)

One endpoint drives the whole [tool palette](#the-tool-palette). The `op` field
selects the tool; the rest of the body is op-specific. `duplicate` returns `200`
with the finished `PartInfo`; every other op returns `202 { jobId, partId }` and
completes as an op job.

```jsonc
{
  "op": "boolean",               // boolean|merge|shell|offset|transform|mirror|primitive|duplicate
  "inputs": [                     // source parts (0 for primitive, 1 or 2 otherwise)
    { "partId": "p_…",
      "transform": {              // OPTIONAL per-input TRS, folded into the mesh load
        "translateMM": { "x": 0, "y": 0, "z": 0 },   // NOTE the field name: translateMM (mm), not "translate"/"position"
        "rotateDeg":   { "x": 0, "y": 0, "z": 0 }    // degrees; scale is reserved
      } }
  ],
  "name": "optional display name",
  "voxelSizeMM": 0.3,             // voxel ops only (boolean/merge/shell/offset)
  "booleanKind": "difference",    // boolean: union|difference|intersection
  "filletMM": 1.0,                // merge: blend radius
  "shellDirection": "inside",     // shell: inside|outside|centered
  "shellThicknessMM": 2.0,        // shell (> 1.5 × voxel)
  "offsetDistMM": -2.0,           // offset: signed (|d| > 1.5 × voxel)
  "bake": true,                   // transform: bake the input TRS mesh-to-mesh (APPLY)
  "mirror":    { "planePoint": {"x":0,"y":0,"z":0}, "planeNormal": {"x":1,"y":0,"z":0} },
  "primitive": { "kind": "box", "sizeMM": {"x":60,"y":40,"z":20}, "centerMM": {"x":0,"y":0,"z":0}, "sides": 0 }
}
```

Validation is strict (`400` on failure): unknown `op`/`booleanKind`/`shellDirection`,
non-distinct or missing input parts, feature sizes ≤ 1.5 × voxel, and the union
bbox blowing the [resolution guard](#parameters).

### Zones & transforms on `POST /api/jobs`

`JobRequest` gains two optional fields; omit both and the generate path is
byte-identical to the legacy behaviour.

```jsonc
{
  // …all existing JobRequest fields…
  "zones": {
    "latticeIds": ["p_…"],        // blue  — lattice-only regions
    "keepIds":    ["p_…"],        // green — stay-solid regions
    "voidIds":    ["p_…"],        // red   — never-enter regions
    "skinThicknessMM": 1.5,       // inward skin off the surface (single mode; zeroed + warned in fuse)
    "transitionMM": 0,            // V2 — accepted & stored, NOT applied in Wave 1 (hard edge)
    "keepOutGrowMM": 0.5          // outward growth of the void zones
  },
  "transforms": {                 // per-part non-destructive TRS, keyed by part id (base AND zone parts)
    "p_…": { "translateMM": { "x": 10, "y": 0, "z": 0 }, "rotateDeg": { "x": 0, "y": 0, "z": 0 } }
  }
}
```

> **`translateMM`, not `translate`.** The TRS translation field is **`translateMM`**
> (millimetres) everywhere — the op `inputs[].transform`, the job `transforms`
> map, and the internal `TransformDto`. Sending `translate` or `position` is
> silently ignored.

> **In-memory PartStore.** Both endpoints register parts in an in-memory store
> that starts empty on every launch — parts (uploads and derived alike) **do not
> survive a server restart**, even though their `data/parts/{id}/` folders remain
> on disk.

## Samples

`samples/` contains ready-to-use test parts and the generator that made them:

| File | Use |
|---|---|
| `Cylinder.stl` | A simple binary STL (from PicoGK) for a quick Workflow A test. |
| `positive.step` | 60×40×20 box with a fully-enclosed 50×30×12 cavity — Workflow B **positive**. |
| `negative.step` | The 50×30×12 cavity solid alone, in the **same world frame** it occupies inside `positive.step` — Workflow B **negative**. |
| `hollow_bracket.step` | A single-solid L-bracket (~50 mm) for Workflow A. |
| `make_test_parts.py` | Regenerates the three STEP parts: `C:\Python314\python.exe samples\make_test_parts.py`. |

## Testing

Two PowerShell harnesses cover the Wave-1 surface. Both are **self-contained and
side-effect-free against a running dev server** — they build to a scratch output
and use an isolated port/data dir, so a live server on `5238` is never touched.

```powershell
# Worker CLI — drives InfillWorker.exe directly with generated job.json files.
# Asserts primitive volumes, boolean/shell/offset results, transform-bake and
# rotate bbox math, the winding-corrected mirror, a full zoned generate
# (latticeRegion + void-clear), and the legacy single/fuse regression.
powershell -ExecutionPolicy Bypass -File scripts\test_ops.ps1

# HTTP API — builds the server to a scratch dir, runs it on port 5239, then:
# upload → POST /api/ops boolean → poll → GET /api/parts (derived w/ mass props)
# → duplicate 200 → a zoned /api/jobs on op-created primitives → preview.stl,
# plus the negative cases (zone == base, unknown op, over-resolution → 400).
powershell -ExecutionPolicy Bypass -File scripts\test_api.ps1
```

A clean `dotnet build InfillApp.sln` plus a green run of both scripts is the
Wave-1 gate. (`scripts\test_api.ps1` accepts `-Port` to move its throwaway
instance off 5239 if needed.)

## Platform note

PicoGK ships an `osx-arm64` native runtime, so the worker could in principle run
on Apple Silicon — but this app's launcher (`scripts\run.ps1`), default paths
(`C:\Python314\python.exe`, `worker\bin\Debug\net9.0\InfillWorker.exe`), and the
native-DLL copy step are **Windows-first and untested on macOS**.

## Credits & licenses

- **[PicoGK](https://github.com/leap71/PicoGK)** — the voxel geometry kernel that
  does all the heavy lifting (booleans, offsets, TPMS rendering, meshing). PicoGK
  is licensed under the **Apache License 2.0**. This project uses a local patched
  **fork** at `..\PicoGK` via `ProjectReference`.
- **`worker/TPMSWall.cs`** — the TPMS signed-distance implicit (Gyroid / Schwarz P
  / Schwarz D / Lidinoid / Neovius) is **copied verbatim** (only the namespace
  changed) from the PicoGK fork's `examples/03_SimpleShapes/GyroidCylinder.cs`
  (class `TPMSWall`), which carries an `SPDX-License-Identifier: CC0-1.0` header.
- **[bumpmesh.com](https://bumpmesh.com) / CNCKitchen `stlTexturizer`** — **UX
  inspiration only** for the drag-drop → parameters → preview → export loop. **No
  code was copied**, and its surface-displacement mesh math is unrelated to this
  app's volumetric gyroid work.
