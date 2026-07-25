# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> [!NOTE]
> ANVIL is pre-1.0. Per SemVer, **anything may change in a 0.x release**, and
> the HTTP API, MCP tool schema and script globals are not yet stable.
>
> The releases below were reconstructed from commit history; no git tags exist
> for them yet. Dates are the dates the work landed on `main`.

## [Unreleased]

## [0.6.0] - 2026-07-25

Slicer-grade direct manipulation.

### Added

- **Undo and redo** across the whole workspace: a 50-deep command stack with
  `Ctrl+Z` / `Ctrl+Shift+Z` / `Ctrl+Y` and header buttons. Imports, tool ops,
  deletes, moves, rotations, role changes and transform edits are all
  reversible. Server-side deletes are deferred until a command falls off the
  stack, so an undo restores a part without a round trip.
- **Part-anchored transform gizmo** with `MOVE`, `ROTATE` and `SCALE` modes,
  driven through a hidden proxy object seated on the part's own pivot so drags
  read back as deltas against the pose at drag start.
- `LAY FLAT` and `DROP`, plus freeform plate dragging: grab a selected part
  anywhere on its surface to slide it across the build plate.
- Auto-drop after a rotate commit, folded into the same undo entry as the
  rotation.
- `SMOOTH` mode on the boolean tool: a filleted union with a blend-radius field.

### Changed

- **`MERGE` is folded into `BOOL`.** The tool palette is now seven tools, and
  the boolean panel carries a four-way `UNION` / `DIFFERENCE` / `INTERSECT` /
  `SMOOTH` selector.
- **Boolean results consume their sources.** Both inputs stay listed but become
  hidden and locked, so the combined result is the single active base part and
  `GENERATE` runs on it directly. Deleting the result restores them.
- Camera no longer refits on in-canvas commits, so a gizmo drag does not yank
  the view.
- Viewport axis colors moved to an orange / green / cyan triad, replacing
  three.js' default red / green / blue on the gizmo and orientation axes.

## [0.5.0] - 2026-07-24

Export became a workspace, and lattice results became real parts.

### Added

- **Unified export pipeline** (`POST /api/export` -> poll -> `GET
  /api/export/{id}/file`): multi-part selection, STL and faceted STEP, separate
  (zipped) or combined into one file, per-part transform baking, and
  human-readable filenames.
- **Generate results register as first-class parts.** A finished lattice is
  copied into the part store with `generate` provenance and its source ids
  before the job reports `done`, so it can be selected, transformed, sectioned,
  used as an input to another op, and exported like any other part.
- **Linked ghosts**: the sources a lattice was built from stay visible as
  translucent ghosts, ride the lattice's transform as one unit, and count toward
  its pivot and plate contact. Deleting the lattice releases them.
- **Onshape-style section view** with hatched caps, so a cut face reads as solid
  material rather than a hole. Pick an arbitrary plane from a triad, the X/Y/Z
  chips, or a flat face on the model; drag the arrow, or nudge with `Alt`+wheel
  (`Alt`+`Shift`+wheel for fine steps); invert the kept side with the swap chip.
- Z-up scene with the build plate at Z0, a `TOP` / `BOTTOM` / `FRONT` / `BACK` /
  `LEFT` / `RIGHT` view cube, and a bottom-left orientation triad.
- `GHOSTS` toggle to bulk-hide translucent sources while keeping the result.

### Changed

- Fit-to-view now frames the selection when something is selected, and parks the
  orbit pivot on the volume-weighted center of mass otherwise.

## [0.4.0] - 2026-07-24

The project became ANVIL, and grew an agent surface.

### Added

- **MCP server at `/mcp`** (streamable HTTP, stateless): 20 tools covering
  parts, every tool op, lattice generation, jobs, scripting and export. Any MCP
  client can drive ANVIL. Job-spawning tools poll to completion internally so an
  agent sees synchronous results.
- **Roslyn C# scripting**: compile and run `.csx` against the PicoGK and
  `Anvil.Worker` APIs in a per-job worker, with `SavePart`, `Log`, typed
  parameter reads and custom `IImplicit` fields. Two seed scripts in
  `scripts-library/` (a parametric gyroid heat-exchanger core and a radially
  graded lattice puck). Compile errors return structured diagnostics.
- **Mesh cleanup before export**: floating-island removal and a watertight
  verification pass, with the component and removed-volume counts reported in
  job stats.
- Viewport wave: part selection, the first transform gizmo, lay-flat, the view
  cube, an upgraded section, and an `ADD PART` entry point.
- Hand-rolled primitive builders (box, cylinder, sphere, cone) replacing PicoGK
  `Utils` meshes, which produced malformed geometry.
- `FEEDBACK` link straight to the issue tracker.

### Changed

- **Renamed from Infill App to ANVIL** across the solution, projects, namespaces
  and tooling. `AnvilServer.exe`, `AnvilWorker.exe`, `Anvil.sln`.
- Primitives are placed at an explicit center and rest on the build plate rather
  than straddling the origin.

### Fixed

- Malformed primitive meshes from PicoGK's `Utils` helpers.

## [0.3.0] - 2026-07-24

An object workspace, not just a converter.

### Added

- **Tool palette**: primitive, boolean, merge, shell, offset, transform, mirror
  and duplicate, exposed through a single `POST /api/ops` endpoint. Every tool
  is non-destructive and produces a new derived part with a provenance line and
  a replayable snapshot of its request.
- **Zoned lattice** with Autodesk-generative-style roles: `Zone - Lattice`
  (fill), `Zone - Keep` (stay solid) and `Zone - Void` (never enter), plus skin,
  transition and keep-out-grow offsets. Void always wins, with a self-check that
  confirms the voids are clear.
- **Parts registry** with mass properties (volume, surface area, center of
  gravity) computed by a divergence-theorem pass over every mesh.
- Non-destructive per-part TRS carried on the part record, folded into the mesh
  load server-side so voxel and mesh ops both see the transformed part.
- Zone-scoped flow metrics: with zones, porosity and infill are measured against
  the lattice region rather than the whole bounding volume.
- Three PowerShell test harnesses (`test_ops.ps1`, `test_api.ps1`,
  `test_scripts.ps1`) running against isolated ports and data directories.

## [0.2.0] - 2026-07-23

### Added

- **Geometric flow metrics** computed from the voxel field and result mesh:
  porosity, open-area profile along a chosen flow axis, choke and choke ratio,
  specific surface, hydraulic diameter, Kozeny-Carman permeability and a Darcy
  pressure-drop estimate at a reference flow rate.
- Lattice controls: sheet and skeletal modes, skeletal bias, field rotation,
  per-axis phase offset, per-axis cell size, and the flow axis.
- CAD-style workspace layout with a flow tile and open-area sparkline.

## [0.1.0] - 2026-07-22

Initial release.

### Added

- Convert a solid part or an enclosed cavity into a self-supporting TPMS lattice
  and export it in the source coordinate frame.
- Five TPMS patterns: gyroid, Schwarz P, Schwarz D, Lidinoid and Neovius.
- Two workflows: **single** (gyroidize a whole solid) and **fuse** (lattice a
  cavity negative and voxel-boolean it into the positive).
- Three-process architecture: an ASP.NET server that references no PicoGK, a
  crash-isolated per-job PicoGK worker, and a Python OCP sidecar for STEP.
- STL export (lossless) and faceted-BRep STEP export with a triangle budget,
  coarse remesh above target, a warning above 150k triangles and a refusal above
  500k.
- Coordinate preservation guarantee: no stage recenters geometry, so results
  merge back into CAD in place.
- Voxel resolution guard rejecting jobs above roughly 2000 voxels per axis.
- Browser viewer with drag-drop import, live parameters and a preview, built on
  three.js with no build step.
- Sample parts and the generator that makes them.

[Unreleased]: https://github.com/Delta-Robotics-Inc/anvil/compare/main...HEAD
[0.6.0]: https://github.com/Delta-Robotics-Inc/anvil/commit/5df28b5
[0.5.0]: https://github.com/Delta-Robotics-Inc/anvil/commit/4c26fec
[0.4.0]: https://github.com/Delta-Robotics-Inc/anvil/commit/4cdb72f
[0.3.0]: https://github.com/Delta-Robotics-Inc/anvil/commit/341d4be
[0.2.0]: https://github.com/Delta-Robotics-Inc/anvil/commit/a9f493d
[0.1.0]: https://github.com/Delta-Robotics-Inc/anvil/commit/2cbe7d4
