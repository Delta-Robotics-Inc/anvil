# Contributing to ANVIL

Thanks for wanting to help. ANVIL is a volumetric geometry tool, which means
most bugs are *geometric* rather than logical: a wrong sign, a half-voxel of
drift, a mesh that is not watertight. The workflow below is built around
catching that class of bug.

Outside contributions are wanted. Docs, examples and scripts count.

- [Before you start](#before-you-start)
- [Development setup](#development-setup)
- [Running the app](#running-the-app)
- [Test suites](#test-suites)
- [Code style](#code-style)
- [Project conventions that are not negotiable](#project-conventions-that-are-not-negotiable)
- [Submitting a pull request](#submitting-a-pull-request)
- [Developer Certificate of Origin](#developer-certificate-of-origin)
- [What to expect from maintainers](#what-to-expect-from-maintainers)

## Before you start

- For anything larger than a bug fix, **open an issue first**. It is cheaper for
  both of us to agree on an approach than to review a large PR built on a design
  we would not merge.
- Small fixes (typos, a broken link, an obvious off-by-one) need no discussion.
  Send the PR.
- By contributing you agree your work is licensed under
  [Apache-2.0](../LICENSE) and you sign off each commit under the
  [DCO](#developer-certificate-of-origin).

## Development setup

### Prerequisites

| Requirement | Notes |
| --- | --- |
| Windows x64 (10 or 11) | Primary and only tested platform. See the [platform note](../README.md#platform-note). |
| .NET 9 SDK | `dotnet --version` must report `9.0.x`. |
| Python 3.14 | Runs the STEP sidecar. Any 3.x with the packages below works; 3.14 is what we test. |
| A PicoGK checkout | Required as a **sibling directory**. See below. |
| Git | For the DCO sign-off you need a configured `user.name` and `user.email`. |

### 1. Clone ANVIL and PicoGK as siblings

This is the one setup step people get wrong. `worker/Anvil.Worker.csproj`
consumes PicoGK by `ProjectReference`, not by NuGet package:

```xml
<ProjectReference Include="..\..\PicoGK\src\PicoGK.csproj" />
```

That path is relative to `worker/`, so **PicoGK must sit next to the `anvil`
directory, not inside it**:

```
Repos\
  anvil\        <- this repository
    worker\
  PicoGK\       <- the PicoGK checkout, a SIBLING
    src\PicoGK.csproj
    runtime\native\win-x64\*.dll
```

```powershell
cd C:\Users\you\Repos
git clone https://github.com/Delta-Robotics-Inc/anvil.git
git clone <picogk-remote> PicoGK
```

> [!IMPORTANT]
> ANVIL builds against a **patched fork** of [LEAP 71's
> PicoGK](https://github.com/leap71/PicoGK), pinned at commit **`3725be3`**
> (`PicoGK-v1.7.7.5-5-g3725be3`). Upstream `leap71/PicoGK` is **not** a drop-in
> substitute: the fork restructures sources under `src/` and vendors the
> prebuilt `win-x64` native DLLs under `runtime/native/win-x64/`, neither of
> which upstream has. The `ProjectReference` above will not resolve against an
> upstream clone.
>
> The fork is not public yet. If you cannot access it, say so on your issue and
> we will sort out access. Until then, CI cannot build either - see the comment
> block in [`.github/workflows/ci.yml`](workflows/ci.yml).

You do **not** need to initialise PicoGK's `vendor/` submodules; the build only
uses `src/` and `runtime/`. You also do **not** need a System32 PicoGK install -
the worker csproj copies the native DLLs (`picogk.1.7.dll`, `blosc.dll`,
`lz4.dll`, `tbb12.dll`, `zlib1.dll`, `zstd.dll`) next to `AnvilWorker.exe` on
every build.

### 2. Install the Python sidecar dependencies

`sidecar/cadconvert.py` handles STEP import and faceted-BRep STEP writing. It
needs exactly two packages (everything else it uses is stdlib):

```powershell
C:\Python314\python.exe -m pip install build123d cadquery-ocp
```

`cadquery-ocp` provides the `OCP` module (OpenCascade 7.9 bindings) and is a
large download. If your interpreter lives elsewhere, point `PythonPath` in
`appsettings.json` at it:

```json
{
  "PythonPath": "C:\\Python314\\python.exe",
  "DataDir": "data",
  "MaxConcurrentJobs": 1,
  "WorkerPath": "worker\\bin\\Debug\\net9.0\\AnvilWorker.exe"
}
```

### 3. Build

```powershell
cd anvil
dotnet build Anvil.sln
```

A clean build from a fresh clone takes a few seconds and should report
**0 errors**. One `CS0219` warning from PicoGK's own `PicoGK_MeshIo.cs` is
expected and not yours to fix.

## Running the app

```powershell
# Build, verify prerequisites, start the server, open a browser:
scripts\run.ps1

# Headless, for scripting or when you already have a browser tab open:
scripts\run.ps1 -NoBrowser
```

`run.ps1` works from any directory. It builds `Anvil.sln` in Debug, checks the
worker exe, the Python interpreter and `sidecar/cadconvert.py` exist with
actionable errors, starts the server on **`http://127.0.0.1:5238`**, polls
`/api/health` for up to 60 seconds, then opens your browser. Server output goes
to `data\server.out.log` and `data\server.err.log`. Ctrl+C stops it.

The front end has **no build step**: `server/wwwroot/` is plain ES modules plus
three.js from a CDN. Edit a `.js` file and hard-reload the page. Only C# changes
need a rebuild.

## Test suites

Three PowerShell harnesses cover the worker, HTTP, scripting and MCP surfaces.
Each **builds to its own scratch output** and runs its own server instance on an
isolated port and data directory, so a dev server on 5238 is never touched.
Each prints an `N passed / N failed / N total` summary and exits non-zero on any
failure.

```powershell
# Worker CLI, driven directly with generated job.json files. Asserts primitive
# volumes and bounding boxes, boolean/shell/offset results, transform-bake and
# rotate bbox math, the winding-corrected mirror, a full zoned generate
# (lattice region + void-clear self-check), and the legacy single/fuse path.
powershell -ExecutionPolicy Bypass -File scripts\test_ops.ps1

# HTTP API. Upload, POST /api/ops, part listing with mass properties, the
# unified export pipeline (single, zipped multi-part, combined, transform-baked,
# STEP, job-id sources), lattice-registers-as-a-part, plus the negative cases
# (zone == base, unknown op, over-resolution, bad format -> 400/404).
powershell -ExecutionPolicy Bypass -File scripts\test_api.ps1

# Roslyn scripting + MCP. A worker-direct script job, a compile-error script
# returning structured scriptError diagnostics, POST /api/scripts/run against
# heat_exchanger_core, and an MCP smoke test over raw JSON-RPC to /mcp.
powershell -ExecutionPolicy Bypass -File scripts\test_scripts.ps1
```

`test_api.ps1` and `test_scripts.ps1` accept `-Port` (default **5239**) if that
port is busy.

**The merge gate is a clean `dotnet build Anvil.sln` plus all three suites
green.** There is no CI substitute for this today: the suites need a live
server, the PicoGK native runtime and the Python sidecar, none of which CI has.
Please run them locally and paste the summaries into your PR.

Add assertions for new behaviour to whichever harness owns that surface.

## Code style

There is no formatter gate. Match the file you are editing; the
[`.editorconfig`](../.editorconfig) encodes the rest.

- **C#**: 4 spaces, Allman braces, nullable enabled, implicit usings on. Server
  code is minimal-API style; worker code is procedural and allocation-aware
  because it runs on million-triangle meshes.
- **JavaScript**: 2 spaces, ES modules, no framework, no build step, no new
  runtime dependencies without discussion. Keep it readable over clever.
- **Python**: 4 spaces, standard library plus `build123d` and `OCP` only.
- **PowerShell**: 4 spaces, CRLF endings, `[CmdletBinding()]` on scripts.
- **Comments explain why, not what.** Geometry code especially: if a sign, an
  epsilon or an ordering matters, say why in a comment. The next person will not
  be able to infer it.
- **Docs**: no emoji, and no em dashes or en dashes. Use hyphens, commas or
  parentheses. This applies to Markdown and to user-visible UI strings.

### Architecture, in one paragraph

Three processes keep PicoGK's native constraints away from the web host: the
**server** (ASP.NET minimal API) references no PicoGK and only shells out; a
per-job **worker** (`AnvilWorker.exe`) owns all voxel math with one PicoGK
`Library` per process so a native crash cannot take down the host and a cancel
is a real `Kill`; and the **Python sidecar** does STEP conversion. If you find
yourself wanting to reference PicoGK from the server, that is the signal you
want a worker job instead.

## Project conventions that are not negotiable

These are correctness guarantees, not preferences. A PR that breaks one will be
sent back.

1. **Never recenter geometry.** Every stage - worker, sidecar and viewer -
   operates in the source world frame. STLs load force-MM and save MM, TPMS
   fields are world-anchored, no boolean recenters, and the viewer fits the
   camera with a `Box3` union instead of moving the mesh. This is the feature
   that makes results merge back into CAD; a recenter anywhere silently destroys
   it. `CENTER` in the transform panel is an explicit, visible, clearable
   translate, not a hidden one.
2. **Transforms compose one way, everywhere:** `scale -> rotX -> rotY -> rotZ ->
   translate`. Worker, server and viewer must agree exactly or previews lie.
3. **The TRS field is `translateMM`**, in millimetres, in every payload.
   `translate` and `position` are silently ignored.
4. **Results must be watertight.** Mesh output runs through island removal and a
   watertight check before it is registered or exported. Do not bypass it.
5. **Voxel ops are accurate to plus or minus half a voxel; mesh-only ops are
   exact.** Primitive, transform-bake and mirror are mesh-only by design - keep
   them that way rather than routing them through the voxel kernel.
6. **Respect the resolution guard.** The server rejects jobs above roughly 2000
   voxels per axis and warns above roughly 2e9 total voxels. New ops that build
   a voxel field must go through the same guard.

## Submitting a pull request

1. Fork, then branch from `main`. Name it for the change (`fix/mirror-winding`,
   `feat/schwarz-d-bias`).
2. Keep the PR focused. Unrelated refactors make geometry review much harder.
3. Run the build and all three suites. Paste the summaries.
4. Include visual evidence for anything that changes geometry or UI: a
   before/after screenshot, or the triangle count, volume and porosity numbers.
5. Update the docs in the same PR if behaviour or setup changed.
6. Add a `CHANGELOG.md` entry under `[Unreleased]` if the change is user-visible.
7. Sign off every commit (below), and fill in the PR template.

Commit messages: a short imperative subject line (about 72 characters), then a
body explaining *why* if it is not obvious. Conventional Commits prefixes
(`feat:`, `fix:`, `docs:`, `chore:`) are welcome but not required.

## Developer Certificate of Origin

ANVIL uses the [DCO](https://developercertificate.org/) instead of a CLA. It is
a lightweight statement that you wrote the contribution, or otherwise have the
right to submit it under Apache-2.0. There is nothing to sign and no account to
create.

Add a `Signed-off-by` trailer to every commit:

```powershell
git commit -s -m "fix: correct mirror winding on the YZ plane"
```

which appends:

```
Signed-off-by: Your Name <your.email@example.com>
```

The name and email must match your `git config user.name` and `user.email`, and
should be a real identity (a pseudonym you are known by is fine).

Forgot to sign off?

```powershell
git commit --amend -s --no-edit          # the last commit
git rebase --signoff main                # every commit on your branch
git push --force-with-lease
```

## What to expect from maintainers

- **A first response within a few days.** ANVIL is maintained alongside other
  work, so a detailed review may take longer than an acknowledgement.
- **A decision, not silence.** If we are not going to merge something we will
  say so and why. We will not leave a PR open forever.
- Some patience, please, if a review takes a week. A polite bump is welcome.

Looking for a first contribution? Issues labelled
[`good first issue`](https://github.com/Delta-Robotics-Inc/anvil/labels/good%20first%20issue)
are scoped to be self-contained. Documentation improvements and additional
`scripts-library/` examples are always useful and need no geometry expertise.
