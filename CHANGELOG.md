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

### Added

- **Banana for scale, as a real part.** A `BANANA` button beside `ADD PART` in the
  toolbar sets a life-size scanned banana (about 165 mm) on the build plate, and
  one more on every click. It rides the ordinary import path (fetch the asset,
  wrap it in a `File`, `POST /api/parts`), so it arrives as a genuine part with no
  special case anywhere downstream: it takes a row and a role select, selects and
  moves with the gizmo, takes a colour, feeds `BOOL` / `SHELL` / `OFFSET` /
  `XFORM` / `MIRROR` / `DUPE`, is latticed by `GENERATE`, exports to STL and STEP,
  saves and reopens in a `.anvil` project, and undoes in one `Ctrl+Z`. Each one is
  rotated onto the display up axis and set down beside the existing content
  (25 mm clear along the display right), as a normal visible, clearable `XFORM`
  pose that export bakes - the same latitude a new cylinder gets, because a banana
  is authored in ANVIL and has no external frame to preserve. Clicks serialise, so
  holding the button down lines bananas up instead of stacking them. Never scaled:
  being life-size is the point. The asset ships baked and re-centred at
  `server/wwwroot/assets/banana.stl` (about 13k triangles).
- **SHELL leaves picked faces OPEN.** The tool grows an `OPEN FACES` row: `PICK`
  arms the flat faces of the bound part as clickable targets, and each one you
  click is left out of the shell, so the hollow interior breaks out there instead
  of being closed by a wall. Picked faces tint `--green` and stay tinted, which is
  the same language a Negative cavity already uses: green is air. Clicking a green
  face closes it again. Face detection is planar-cluster only, so curved surfaces
  are not offered and the tooltip says so. The picks are keyed to each face's
  plane in the part's own frame, so they survive a gizmo move and the op still
  lands on the moved part; they clear when the bound part changes or the tool
  closes. The op body gains an optional `openFaces` array of oriented in-plane
  rectangles in the post-transform world frame, and the worker subtracts one
  oriented slab cutter per face. Omitting it is byte-identical to the closed shell
  that shipped before, which the suite asserts by hash.
- **`Beams` - batch beam/strut lattices in one render.** `Beams(beams)` takes
  `(start, end, diameter at start, diameter at end)` tuples; `Beams(path, d,
  dEnd)` chains a polyline with an optional taper; `Spheres(points, d)` does the
  point-cloud equivalent. Each beam is rendered natively over its own tight
  bounding box, where an implicit field is sampled once per voxel of the *whole*
  box and has to consider every segment each time. For the 22-start helical
  cooling circuit in the new nozzle that is the difference between three seconds
  and several hours. A per-end diameter is free, which is what makes tapered
  struts, graded lattices and self-supporting teardrop channel roofs cheap.
- **`Pipe` now hands long runs to `Beams`.** Up to 16 segments it stays one
  implicit field with an exact distance; above that the per-voxel segment scan
  turns quadratic, so the run is rendered as a lattice instead. Same shape,
  different cost. Documented, and asserted in `forge_smoke.csx`.
- **`Fillet(shape, r)` - concave-only, strictly additive.** Every internal
  corner gets a radius and nothing else moves, so a 1.5 mm rib survives a 0.6 mm
  fillet untouched. This is the finishing pass `Smooth` could never be: `Smooth`
  is a triple offset and it deletes anything thinner than twice its radius.
- **`Area(shape)` - wetted surface area in mm2.** The headline number for a heat
  exchanger or a lattice, and the way to predict a part's triangle count
  (`Area / (0.5 * voxel^2)`) *before* `SavePart` spends the time. It meshes the
  shape to measure it, and the docs say so.
- **`axis: "z"` on every command that has an axis.** `Cylinder`, `Cone`, `Loft`,
  `Torus` and `ArrayRadial` build along +Y as before by default, and along +Z
  when asked. Nothing else in the command set has an up axis, so those five are
  the whole story: a script can now author a part standing on the plate at
  `z = 0` - which is what the viewer's default up axis and every build plate
  want - with no reorientation step and no mesh round trip. For mesh primitives
  the rotation is applied to the mesh before voxelisation, so it is exact.
- **`compliant_wheel.csx` - a new example.** An airless O180 mm rover wheel:
  bolted hub, three concentric bands of counter-handed logarithmic-spiral ribs
  (12, then 24, then 48, thinning outward, so symmetry rises and thickness falls
  as the circumference grows), a rim and a chevron tread, finished with
  `Fillet`. The ribs are the level sets of an `IImplicit` written in the script
  itself - about 15 lines for any rib count - which makes this the worked
  example for the deepest thing an ANVIL script can do.

### Changed

- **`rocket_nozzle.csx` is now a regeneratively-cooled engine, not a bell with
  stubs.** It stands exit-plane-down on the plate, so radius falls monotonically
  from the exit to the throat and the outer wall leans inward the whole way -
  self-supporting, no supports. The hot-gas wall is graded on *radius* from
  1.4 mm at the throat to 0.9 mm at the exit, so the convergent section picks up
  an intermediate thickness automatically. 22 helical cooling channels wrap the
  whole bell at constant perpendicular pitch, which means the helix angle is
  solved rather than picked: nearly straight and tightly packed at the throat
  where the flux peaks, wrapping harder and harder down the bell to a 298-degree
  total wrap. Each channel grows a tapered cone radially outward per sample,
  turning the round bore into a self-supporting teardrop. The coolant volume -
  channels, two manifold rings, two radial ports - is built as a void, clipped
  out of the hot-gas wall so the wall thickness is a guarantee, and the closeout
  jacket is *grown from the coolant* rather than drawn around it. About 58 s at
  0.3 mm, 4.9 M triangles, watertight.
- **`heat_exchanger_core.csx` is now `heat_exchanger.csx`, and it is a real heat
  exchanger.** A gyroid splits the core into two interpenetrating domains; each
  is sealed against a *different* boundary (A against the cylindrical side, B
  against the end faces) so each can only breathe one way and each gets its own
  headers - A through coaxial trumpet plenums and axial ports, B through an
  annular jacket blocked at mid-height so it has to travel through the core.
  Four ports, two circuits, one printable part. The metal is *derived* as the
  complement of the fluid inside an offset skin, so it cannot leak, and the
  script **proves** the separation: it measures the overlap of the two circuits,
  measures it again after growing one by 40 % of the wall thickness, and throws
  if either is anything but zero. The header comment names Lin Kayser's public
  scepticism of TPMS heat exchangers and answers the dead-end half of it
  directly. Saves the metal plus, by default, both fluid volumes as separate
  parts. About 45 s at 0.4 mm.
- **`embossed_card.csx` is a credit card, and the emblem is the real ANVIL
  logo.** 1.6 mm thick instead of 4, with a true 3 mm corner radius built from
  two slabs and four corner cylinders (so the faces stay flat and the thickness
  stays honest) plus a 0.3 mm `Smooth` edge break. `assets/emboss-sample.png` is
  regenerated from `server/wwwroot/anvil.svg`: the path is rasterised at 4x
  supersampling, converted to a chamfer distance ramp for a crisp silhouette
  with a wide bevel, and crowned with a blurred copy so the top of the relief is
  not exactly parallel to the card it sits on. A flat plateau shades identically
  to a flat card however tall it is; that crown is what makes the emblem read.
- **Every bundled example now stands on the plate at `z = 0`.** `manifold_block.csx`
  and `graded_lattice_puck.csx` were the last two authored +Y-up, so they lay on
  their side in a viewer whose default up axis is +Z. Both are now transposed
  through the same rotation `axis: "z"` applies: the manifold's billet spans
  `z in [0, blockHgtMM]` with its bores drilled down the +Z face and the gallery
  turning out through -Y, and the puck stands on its own face with the radial
  grading measured in the XY plane. Parameters, defaults and derived sizes are
  unchanged.
- **Script outputs are solid parts, not ghosts.** A part a script builds now
  draws with the same opaque, light-gray material a generated lattice uses,
  because the script already built the model - there was nothing provisional
  about it to signal with a translucent orange shell. It stays an ordinary row
  in every other way: selectable, movable, re-rolable, tintable from the colour
  picker, capped at full strength by `SECTION`, and left alone by the `GHOSTS`
  toggle and the ghost dim. Generating a lattice **on** a script part still
  works and still reads correctly: the script part becomes the ghost shell of
  the unit for as long as it belongs to that lattice, and gets its solid body
  back when the lattice is reverted, undone or deleted.
- **The SCRIPTS picker is `EXAMPLES`, not `TEMPLATE`.** The label, the empty
  option, the library group and every tooltip say example now; the bundled
  scripts are examples to read and adapt, not templates to fill in.
- **The SCRIPTS editor soft-wraps, and the panel widens for it.** Long lines
  wrap instead of running off the right edge behind a horizontal scrollbar, so
  a whole script is readable in the sidebar, and the left panel opens at 520px
  while the view is up (back to the standard width on the way out; collapsing
  is unchanged). The line-number gutter now paints one row per **logical** line
  at that line's measured height, so a line that wraps to four rows still shows
  exactly one number, glued to it - re-measured on every edit, window resize and
  panel-width change. Clicking a compile error still lands the caret on its
  line.
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

- **The header `SCRIPTS` link and its popover are gone**, replaced by the
  toolbar `SCRIPTS` view. The overlay markup, its module and its styles were
  deleted rather than hidden. See the `SCRIPTS` entry below.
- **The `USED · BOOL` / `USED · SMOOTH` source row is gone**, along with its
  dimmed styling and locked role select, because a boolean no longer leaves its
  sources behind. See the `BOOL` entry above.
- **The import auto-lift is gone.** With a selectable up axis and an adaptive
  plate it was unnecessary, and removing it means an imported part now always
  arrives with an identity transform - nothing is ever added to your geometry.

### Added

- **Project save and open: the whole session in one `.anvil` file.** `SAVE` and
  `OPEN` sit in the header, left of undo. A `.anvil` is a plain ZIP holding
  `project.json` (the row manifest, the `UP` convention and every `LATTICE`
  panel value) plus one binary STL per row, and a second STL for a latticed
  row's lattice mesh. Reopening restores every object in order with its name,
  role, colour, eye and ghost visibility, transform and provenance line; a
  latticed row comes back as one object with its ghost linkage rebuilt, so it
  still moves as a body and `REVERT` still gives the plain part back.
  Coordinates travel **verbatim** - the STL bytes are copied without a single
  transform applied and each row's TRS rides in the manifest, so an export taken
  after an open is byte-identical to one taken before the save. Scripts are not
  bundled: they live in the server-side library and are shared across projects.
  Opening replaces the scene and **clears the undo history** (a stack that could
  unwind past the open into the previous session would be a lie), and it asks
  first when there is something on the plate. A bundle from a newer ANVIL is
  refused with the version it needs; anything malformed comes back as a `400`
  with the reason and leaves the current scene untouched. New endpoints
  `POST /api/project/save` and `POST /api/project/open`.
- **[`docs/scripting.md`](docs/scripting.md), the canonical Forge reference.** One
  section per command, grouped into builders, combinators, modifiers and info,
  each with its signature, a one-line description and a table of modifiers
  giving units, defaults and meaning. Around it: how to run a script from the
  `SCRIPTS` view, the HTTP API or MCP; the script globals; the coordinate
  conventions; the voxel-size rule; a worked example walking `rocket_nozzle.csx`
  from its six input numbers to a watertight part; and a gotchas list. Every
  public Forge command is covered, checked against `Forge.cs` rather than
  transcribed by hand. The `TOOLS ?` button in the `SCRIPTS` view has pointed
  here since the view landed; the page now exists.
- **Three showcase scripts in [`scripts-library/`](scripts-library)**, all
  parameter-driven and all under 15 seconds at the default 0.3 mm voxel.
  `rocket_nozzle.csx` turns throat, exit and chamber diameters into a Rao bell
  contour with `Loft`, subtracts an over-length bore for a constant wall, fuses
  a `Cylinder` plus `Torus` flange with `SmoothUnion`, and uses `ArrayRadial`
  twice, once to cut bolt holes and once to add regenerative cooling tubes
  swept with `Pipe`. `embossed_card.csx` rounds a blank with `Smooth` and bakes
  one depth map onto it twice, raised on the front and engraved on the back.
  `manifold_block.csx` drills `ArrayLinear` port bores, joins them with a
  `Pipe` gallery that turns out through a side face, and fills that gallery
  with a gyroid `Lattice` welded to the manifold wall. They join the existing
  seeds in the template picker.
- **`get_forge_reference` MCP tool.** Serves `docs/scripting.md` as markdown so
  an agent has the whole command vocabulary before its first compile, trimmed
  to the reference sections by default and complete with `full: true`. The
  `run_script` and `save_script` descriptions now name the Forge API, list its
  command groups, carry example calls, and tell the agent to read the reference
  first. The MCP surface is 21 tools.
- **`SCRIPTS` is a toolbar view with a real code editor.** The header `SCRIPTS`
  link and its popover (a read-only list with a `RUN` per row) are gone. In their
  place is a toolbar button between `DUPE` and `LATTICE` that takes the left
  panel on the same toggle contract as every tool: click to open, click again to
  close, `Esc` or `✕` back to `LATTICE`. The view holds a template picker (the
  `scripts-library` seeds plus everything you have saved, loaded into the editor
  on pick, with an inline confirm if the buffer is dirty), a self-contained
  monospace editor with a line-number gutter, and `RUN`. `RUN` posts the
  editor's text to `/api/scripts/run`, shows the job's stage inline with a
  `CANCEL` beside it, and lands every part the script saved through the normal
  derived-part flow, so a whole run is one `Ctrl+Z`. `SAVE` files the buffer
  under a name you type inline, `UPLOAD` reads a `.csx` off disk into the editor,
  and `TOOLS ?` opens the scripting reference in the repo. `Ctrl+Enter` runs,
  `Tab` indents two spaces, and `Ctrl+Z` inside the editor is ordinary text undo
  that never reaches the app history. `RUN` is this view's `CONFIRM` in the
  accent budget: it holds the single solid fill while there is code to run and
  swaps to the running pulse while a job is in flight. There is no editor
  library and no new CDN dependency.
- **Compile errors are structured and clickable.** A failed script run lists
  Roslyn's diagnostics as `L<line>:<char>` plus the message in a neutral
  advisory block; clicking a row focuses the editor and puts the caret on that
  line and column. The diagnostics come from `JobStatus.errorData.scriptError`,
  which the server already passed through verbatim for agents.
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
