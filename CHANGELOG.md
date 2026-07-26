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

### Changed

- **`BOOL` and `SMOOTH` now remove their sources.** A boolean result used to
  leave both inputs listed as dimmed, locked `USED · BOOL` rows that only
  deleting the result could restore. The source rows are now removed outright,
  so two parts in leaves exactly one part out. Nothing is lost: the whole
  operation is a single history command, so one `Ctrl+Z` restores both sources
  with their exact transforms, roles, colours and row positions and removes the
  result, and redo consumes them again. Deleting the result no longer brings the
  sources back - undo does.
- **Nested translucent parts no longer vanish at some camera angles.** Ghost
  parts draw in a fixed order derived from their role (`part` / `positive`
  first, then `negative`, then the zone roles, with a solid lattice above all)
  instead of being re-sorted by depth every frame. A `negative` cavity inside a
  `positive` shell used to blink out across roughly half an orbit, because the
  per-frame depth sort put the outer shell last and it blended over the part
  inside it. The lane is reassigned when a part's role changes.
- **One tool per sidebar.** The left panel is a single-view host: the `LATTICE`
  view (the home view) or one open tool, full height, never both. Tools no
  longer stack above the parameters, and nothing scrolls from one tool into
  another. `Esc` or the tool's `✕` returns to `LATTICE`.
- **`TPMS` is now `LATTICE`, and `ORIENT` is now `POSITION`.** The toolbar's
  `TPMS` button became `LATTICE` and opens that view; the `ORIENT` button is
  gone and its controls (rotation, phase offset, per-axis cell size, reference
  flow) live in a collapsible `POSITION` section inside the `LATTICE` view.
- **`GENERATE` lives only in the `LATTICE` view.** While a tool owns the panel
  there is no generate button anywhere, and the tool's `CONFIRM` holds the
  single accent fill.
- **The `STEP target` stepper moved into the `EXPORT` tile**, in the STEP
  options row it belongs to. The left panel's `STEP` tile is gone.
- **A generated lattice no longer adds a second row.** The source object absorbs
  it: one object, one row, keeping the source's name and carrying a
  `LATTICE · <PATTERN>` badge where the role select was, plus the lattice's
  triangle count and volume. The row's eye toggles the lattice mesh, a ghost
  icon toggles the source shell behind it, and the pair moves, exports and
  deletes as one unit. Regenerating replaces the lattice in place.
- **The selection can target `GENERATE`.** Selecting one eligible part targets
  it for single mode; selecting a Positive plus a Negative targets that pair
  for fuse mode. The selection wins over the role-derived mode, zone roles
  are ignored for targeting, and the mode note always names the target.
- **The up axis is now selectable** from the `UP` chips in the view strip:
  `+Y`, `-Y`, `+Z`, `-Z`, defaulting to `+Y` and remembered between sessions.
  `LAY FLAT`, `DROP`, the plate drag, the primitive spawn pose and the view cube
  (labels and corner axes alike) all follow it. This is a display change only:
  no geometry is rotated or recentered, so file, world and export coordinates
  stay identical and switching modes leaves every export byte-identical.
- **`FRONT` is the negative of the remaining world axis** - `-Z` when up is on
  Y, `-Y` when up is on Z - and `RIGHT` is `cross(UP, FRONT)`, so `+Y` gives
  `RIGHT = -X` and `-Y` gives `RIGHT = +X`. The Y-up case was measured against
  reference CAD renders of a real imported part: with `FRONT` on `+Z`, HOME
  parked the camera behind every import and users saw the back of the part.
- **The build plate is adaptive.** It is the plane normal to the up axis, drawn
  at the resting height of everything visible and snapped to zero when the
  content already stands on the origin plane. Grounding targets that plate
  rather than an absolute zero.
- **The camera up vector no longer changes.** A `TOP` or `BOTTOM` view cube snap
  parks a hair off the pole, tilted toward `FRONT`, instead of swapping the up
  vector, so a top view still keeps `FRONT` at the bottom of the screen and
  orbiting out of it behaves normally.
- **The nav cube's x arrow points along `-X`.** The corner triad's hub is
  unchanged, but the x arrow now traces the cube's bottom edge the other way
  instead of leaving the cube outward, so all three arrows run along cube edges.
  It re-parks with the up axis exactly as y and z do.
- **Cylinder and cone primitives stand display-up.** They are authored along Y
  (`sizeMM.X` and `sizeMM.Z` are the diameters, `sizeMM.Y` the height) and given
  the convention rotation for the selected up axis, which shows in the `XFORM`
  panel like any other transform.
- The default **flow axis** is now `Y`.

### Removed

- **The `USED · BOOL` / `USED · SMOOTH` source row is gone**, along with its
  dimmed styling and locked role select, because a boolean no longer leaves its
  sources behind. See the `BOOL` entry above.
- **The import auto-lift is gone.** With a selectable up axis and an adaptive
  plate it was unnecessary, and removing it means an imported part now always
  arrives with an identity transform - nothing is ever added to your geometry.

### Added

- **Live lattice preview.** A `PREVIEW OFF | ON` row at the top of the `LATTICE`
  panel raymarches the TPMS field on the GPU inside the target part, so scrubbing
  cell size, wall thickness, bias, pattern, sheet/skeletal, rotation, phase or
  per-axis cell redraws the lattice frame by frame instead of after a bake. The
  target is whatever `GENERATE` would build - the selected or role-assigned part
  in single mode, the `Negative` in fuse mode - and it re-derives when the
  selection or the roles change. A `QUALITY LOW | HIGH` row trades raymarch
  budget for frame rate; `HIGH` is the default. The preview is an approximation
  and says so in the docs: the bake stays the ground truth for export,
  watertightness and every metric. Finishing a generate turns the preview off,
  shows the real mesh and toasts `preview replaced by the baked result`; turning
  the preview back on hides the baked mesh, so one object is never drawn at two
  fidelities at once. The section plane cuts the preview, the plate grid shows
  through its openings and the gizmo draws over it (the shader writes true
  per-pixel depth). Preview state is session only and is never persisted.
- **Part distance fields for the preview clip.** `POST /api/parts/{id}/sdf` bakes
  a narrow-band signed-distance volume for a part, `GET .../sdf.json` describes
  it and `GET .../sdf.bin` serves it as `r8` bytes. The preview clips the lattice
  to the part's real shape with it. The field is stored in the part's own
  coordinates, so moving the part with the gizmo re-uses the same bake and never
  re-requests one. While a bake is in flight the panel notes
  `BAKING PART FIELD_` and the preview clips to the part's bounding box instead;
  the clip tightens on its own when the field arrives.
- **A per-part colour picker.** Every objects row carries a colour swatch beside
  the eye that opens an anchored picker: ten curated colours, a `HEX` field
  (`#rrggbb`, validated live, applied on `Enter` or blur) and `RESET`. There is
  no gradient or rainbow control. The colour drives the part's 3D tint and
  selection glow, its row accent bar, selection border and swatch, and its
  `EXPORT` row marker; a latticed object colours its lattice mesh and its ghost
  shell together. It survives a role change - only `RESET` clears it - and every
  change is one undo entry. Colours are per session and are not persisted.
- **`REVERT LATTICE`** on a latticed row (and in the right-click menu) drops the
  lattice and gives the plain part back, role select and all. It is undoable,
  and so is deleting a latticed object: one `Ctrl+Z` restores the unit with its
  ghost linkage intact.
- **Multi-select.** `Ctrl`+click or `Shift`+click toggles parts in and out of an
  ordered selection, in the canvas and in the objects list alike. The gizmo
  moves the whole group about its combined bbox centre as one undo entry, and
  the last part picked is the primary that numeric entry binds to.
- **A canvas context menu**: `DUPLICATE…` with a copy count, `DELETE`,
  `HIDE` / `SHOW`, `LAY FLAT`, `DROP`, `FIT SELECTION`, `SELECT ALL`,
  `DESELECT ALL`, plus `SHOW GHOST` / `HIDE GHOST` and `REVERT LATTICE` on a
  latticed object. Every verb applies to the whole selection as one undo entry.
- **The `XFORM` panel binds to the selection** instead of carrying its own part
  dropdown, and shows a live `WORLD` readout of the selection's bbox centre and
  size that ticks through every gizmo drag.
- **The orientation triad merged into the nav cube.** The world axes hang off
  the cube's front-right-bottom corner, faces, edges and corners all snap, and
  the hovered zone lights in neutral gray so what lights up is what a click
  takes you to.
- **`CLEAR`** in the `XFORM` panel resets a part to an identity transform.
- **An empty scene now shows the build plate**, framed from HOME, instead of an
  empty void. Deleting the last part restores exactly that state.
- **`ADD PART` holds the single accent fill while the scene is empty**, and
  hands it back to `GENERATE` / `EXPORT` the moment a part exists, so there is
  always exactly one filled primary action on screen.
- README: a **worked example** walking a real three-port pneumatic manifold from
  CAD body plus gallery, through a fuse-mode lattice, to the sliced result.

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
