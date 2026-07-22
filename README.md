# Infill App — Gyroid Cavity Converter

A local web app that converts a **solid part** or an **enclosed cavity** into a
self-supporting **gyroid TPMS lattice** and exports it so it drops straight back
into your CAD assembly, in place.

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
  "cellSizeMM": 8.0,
  "wallThicknessMM": 1.2,
  "voxelSizeMM": 0.3,
  "overlapMM": 0.3,              // fuse mode
  "smoothOffsetMM": 0,
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
  "stats": { "volumeMM3": 0, "envelopeVolumeMM3": 0, "infillPct": 0, "triangles": 0 },
  "step":  { "state": "none",    // none | running | done | failed
             "triangles": null, "warning": null, "error": null },
  "warning": null,
  "error": null                  // set to the worker's message when state == "failed"
}
```

> **Error surfacing.** A worker crash mid-job sets `state: "failed"` with the
> worker's stderr message in `error`. A failed STEP conversion (e.g. the >500 000
> triangle refusal) sets `step.state: "failed"` with the sidecar's actionable
> `{detail}` in `step.error`. The UI surfaces both as toasts.

## Samples

`samples/` contains ready-to-use test parts and the generator that made them:

| File | Use |
|---|---|
| `Cylinder.stl` | A simple binary STL (from PicoGK) for a quick Workflow A test. |
| `positive.step` | 60×40×20 box with a fully-enclosed 50×30×12 cavity — Workflow B **positive**. |
| `negative.step` | The 50×30×12 cavity solid alone, in the **same world frame** it occupies inside `positive.step` — Workflow B **negative**. |
| `hollow_bracket.step` | A single-solid L-bracket (~50 mm) for Workflow A. |
| `make_test_parts.py` | Regenerates the three STEP parts: `C:\Python314\python.exe samples\make_test_parts.py`. |

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
