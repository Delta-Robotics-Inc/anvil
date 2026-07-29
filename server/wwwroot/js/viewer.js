//
// viewer.js — three.js scene for the Infill App.
//
// Hard rule (product guarantee): geometry is NEVER recentered or transformed.
// Voxel fields are world-anchored, so the STL we load sits exactly where CAD
// expects it. The camera fits the content via a Box3 union instead of moving
// the mesh. See the plan's "coordinates are never recentered" note.
//

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { roleColorInt } from './roles.js';
import { LatticePreview } from './preview.js';

// Wave-2 viewport constants.
const SELECT_DRAG_PX = 4;      // pointer travel under which a pointerup counts as a click
// ORIENTATION WIDGET SIZING — these five hang together, so change them as a set.
// The widget draws into a CUBE_PX square scissor slice through an ortho camera
// of half-extent CUBE_ORTHO, so the cube's own on-screen edge is
//     CUBE_PX · (2·CUBE_HALF) / (2·CUBE_ORTHO)  =  CUBE_PX · 0.469
// and everything else (labels, triad) scales with it.
//
// History: the cube shipped at 96 px with ortho 1.35 (edge ≈ 53 px). Hanging the
// world triad off a corner needed room, so ortho grew to 1.60 — which shrank the
// cube inside the SAME box to ≈ 37 px, and 78 px made that worse still (≈ 27 px
// of cube carrying a 6-letter "Bottom"). Restoring 96 px puts the cube back at
// ≈ 45 px WITH the triad, and the label/axis constants below are re-tuned for
// that draw size rather than the 78 px one.
const CUBE_PX = 96;            // orientation-widget size (cube + corner triad, top-right)
const CUBE_MARGIN = 14;        // px inset of the cube from the viewport corner
const CUBE_CAM_DIST = 3.4;     // orthographic cube camera distance
const CUBE_HALF = 0.75;        // half-extent of the cube mesh (edge 1.5)
const CUBE_ORTHO = 1.60;       // ortho half-extent — the cube plus room for the triad
const CUBE_ZONE = 0.22;        // edge/corner pick band ÷ half-extent (see _cubeZoneAt)
const CUBE_AX_LEN = 0.40;      // corner-triad arrow length, cube units
const CUBE_AX_FAT = 2.3;       // arrow xy fattening ÷ length (sub-pixel otherwise)
const CUBE_AX_GLYPH = 0.58;    // triad letter distance from the hub
const CUBE_AX_GLYPH_PX = 0.38; // triad letter sprite size, cube units
// Label auto-fit: the widest a label may run across the 128 px face texture.
// Note this ratio is SCALE-INVARIANT: label-to-edge clearance is a property of
// the texture, not of CUBE_PX, so a bigger widget alone never un-crowds a face.
// Dropped from 104 (81% of the face — near full-bleed, chosen at 78 px where
// every pixel of type counted) to 96 (75%). "Front" and "Right" now stop short
// of the vertical edge they share instead of meeting across it, and the corner
// triad clears the "Bottom" / "Right" glyphs in all four UP modes. Even after
// the trim the labels land ~16% LARGER on screen than they did at 78 px, since
// 96 px buys more than the 8% the margin costs.
const CUBE_LABEL_W = 96;       // px of the 128px face texture a label may span
const SNAP_MS = 250;           // view-cube snap animation duration
// EULER round-trip self-test flag. Flipped true during Stage-4 verification to
// print the hand-chain-vs-proxy matrix proof to the console, then returned to
// false. The method (`_selfTestEuler`) stays available for on-demand re-runs.
const EULER_SELFTEST = false;
// Same idea for the Wave-4 pivot math (`_selfTestPivot`): proves
// T(P)·R(Δq)·T(−P)·M0 decomposes back into the canonical T·Rz·Ry·Rx·S chain.
const PIVOT_SELFTEST = false;

// ── World display frame (selectable up axis) ─────────────────────────────
// IRON RULE: geometry is NEVER rotated, mirrored or translated by any of this.
// These are LABELS on the world axes, not a change of basis. The up axis is a
// pure DISPLAY / plate convention: it moves the camera up vector, the grid
// plane, the view-cube labels and the plate math (LAY FLAT, DROP, plate drag,
// primitive spawn pose) — and nothing else. File coordinates, world coordinates
// and export coordinates stay identical in every mode.
//
// Four modes exist because CAD exports disagree about which way is up. Each is
// a trio of unit vectors:
//
//   UP     the world direction that reads screen-UP.
//   FRONT  outward normal of the FRONT face = where the camera SITS for a FRONT
//          view (a FRONT snap therefore looks ALONG −FRONT).
//   RIGHT  = cross(UP, FRONT). The camera basis is right-handed with
//          X_cam = screen-right, Y_cam = screen-up (= UP), Z_cam = the direction
//          back toward the camera (= FRONT at the FRONT view), so screen-right
//          is cross(up, toCamera).
//
// Where FRONT comes from — ONE construction rule, four rows:
//
//   X is always the left-right screen axis (true of every CAD front view), so
//   FRONT is the one remaining world axis. Its SIGN is fixed by requiring the
//   POSITIVE-up mode of each pair to read +X to the RIGHT, i.e.
//   cross(UP, FRONT) = +X:
//
//     up +Y → FRONT +Z   cross(( 0,1,0), (0, 0,1)) = ( 1,0,0)   ← ANVIL original
//     up +Z → FRONT −Y   cross(( 0,0,1), (0,−1,0)) = ( 1,0,0)   ← Onshape/SolidWorks
//
//   The NEGATIVE-up mode of a pair is that same frame rolled 180° about FRONT:
//   it KEEPS the pair's FRONT, and RIGHT flips to −X on its own through the
//   cross product. Each mode is therefore self-consistent, and X stays the
//   horizontal screen axis in all four.
//
//                UP        FRONT     RIGHT = cross(UP, FRONT)
//   '+y'      ( 0, 1, 0) ( 0, 0, 1)  ( 1, 0, 0)
//   '-y'      ( 0,−1, 0) ( 0, 0, 1)  (−1, 0, 0)
//   '+z'      ( 0, 0, 1) ( 0,−1, 0)  ( 1, 0, 0)
//   '-z'      ( 0, 0,−1) ( 0,−1, 0)  (−1, 0, 0)
//
// '+y' reproduces ANVIL's original frame exactly: the cube reads +X RIGHT, −X
// LEFT, +Z FRONT, −Z BACK, +Y TOP, −Y BOTTOM; HOME iso direction (1, 0.8, 1);
// first camera ≈ (79, 63, 79).
//
// A −Y default shipped briefly, inferred from the pneumatic-manifold reference
// renders (its holes appeared to face FRONT only if FRONT was −Z). The FIXTURE
// was mis-oriented, not the viewer, so that inference is withdrawn — hence the
// storage-key bump to `anvil.upAxis.v2` in main.js, which drops a stored '-y'
// that was only ever written by the old default.
//
// The default is now '+z' (key bumped again, to `anvil.upAxis.v3`, so an
// existing session lands on it instead of on a stored '+y'): ANVIL's own CAD is
// authored Z-up, and Z-up is what every mechanical CAD package this talks to
// (Onshape, SolidWorks, Fusion) presents. The ±Y modes stay — they are one
// chip away and the frame maths is mode-agnostic.
//
// _cubeFaceSpec derives the view-cube labels and per-face glyph rotations from
// this trio, so labels and camera can never drift apart.
const UP_AXES = Object.freeze({
  '+y': Object.freeze({ up: [0, 1, 0], front: [0, 0, 1] }),
  '-y': Object.freeze({ up: [0, -1, 0], front: [0, 0, 1] }),
  '+z': Object.freeze({ up: [0, 0, 1], front: [0, -1, 0] }),
  '-z': Object.freeze({ up: [0, 0, -1], front: [0, -1, 0] }),
});
// Default +Z — Z IS UP. Any document can pick another mode from the view strip;
// the choice is presentation only (no vertex data is ever touched).
export const UP_AXIS_DEFAULT = '+z';
export const UP_AXIS_KEYS = Object.freeze(Object.keys(UP_AXES));

const HOME_TILT = 0.8;      // UP share of the HOME iso (FRONT + RIGHT + 0.8·UP)
// TOP/BOTTOM snaps park a hair OFF the pole instead of moving camera.up: up ∥
// view is a degenerate lookAt, and swapping camera.up mid-session is what makes
// orbiting out of a top view feel wrong. ~1.1°, invisible at any print scale.
const POLE_EPS = 0.02;
const PLATE_SNAP_MM = 0.01;   // |resting height| under this reads as "sits at zero"

// Convention rotation that stands a worker-authored +Y shape (cylinder, cone)
// display-up. THREE's rotateX(a) maps +Y → (0, cos a, sin a), so:
//   180° → −Y      +90° → +Z      −90° → −Z
const PRIM_ROT = Object.freeze({
  '+y': null,
  '-y': Object.freeze({ x: 180, y: 0, z: 0 }),
  '+z': Object.freeze({ x: 90, y: 0, z: 0 }),
  '-z': Object.freeze({ x: -90, y: 0, z: 0 }),
});

// The same convention rotation for an asset authored +Z UP (the banana scan)
// rather than +Y. THREE's rotateX(a) maps +Z → (0, −sin a, cos a), so:
//   0° → +Z      −90° → +Y      +90° → −Y      180° → −Z
// which is PRIM_ROT turned a further quarter turn, as it must be. Degrees, X
// only, so it composes trivially under scale → rotX → rotY → rotZ → translate.
const SPAWN_ROT = Object.freeze({ '+y': -90, '-y': 90, '+z': 0, '-z': 180 });

// BoxGeometry material-index order, and per face the WORLD directions its
// texture-right (r) / texture-up (u) map to. Fixed properties of BoxGeometry's
// authored UVs (a Y-up box), independent of which up axis ANVIL displays.
const CUBE_FACES = Object.freeze([
  Object.freeze({ n: [1, 0, 0], r: [0, 0, -1], u: [0, 1, 0] }),    // +X
  Object.freeze({ n: [-1, 0, 0], r: [0, 0, 1], u: [0, 1, 0] }),    // −X
  Object.freeze({ n: [0, 1, 0], r: [1, 0, 0], u: [0, 0, -1] }),    // +Y
  Object.freeze({ n: [0, -1, 0], r: [1, 0, 0], u: [0, 0, 1] }),    // −Y
  Object.freeze({ n: [0, 0, 1], r: [1, 0, 0], u: [0, 1, 0] }),     // +Z
  Object.freeze({ n: [0, 0, -1], r: [-1, 0, 0], u: [0, 1, 0] }),   // −Z
]);
// Empty-scene plate: the grid + camera framing shown before the first import, so
// the viewport reads as a build plate instead of a void (mm).
const EMPTY_PLATE_MM = 120;

// SPAWN PLACEMENT: where a part ANVIL authors itself (the BANANA button) is set
// down. It stands clear of whatever is already visible by this gap, measured
// along the display RIGHT between the two boxes. See spawnBeside.
const SPAWN_GAP_MM = 25;
// TRANSFORM-GIZMO axis colours: X --primary, Y --green, Z --cyan. The HUD's
// "no red" rule still governs here and everywhere else in the app.
const AX_X = 0xff5c00, AX_Y = 0x47c86e, AX_Z = 0x5bc8e8;
const AX_HUB     = 0x9a9a9a;   // triad origin pip / recoloured neutral gizmo parts

// VIEW-CUBE triad colours — the ONE deliberate exception to "no red". A corner
// axis triad is a reading of world orientation, not an ANVIL accent, and every
// CAD package a user arrives from paints it R/G/B; a triad in orange/green/cyan
// costs a translation step on every glance. Values are the pastel RGB from the
// design mock, near-equiluminant (L* ≈ 0.63–0.66) so no arrow shouts over the
// others on the dark cube. Deliberately NOT shared with the gizmo above: they
// are different widgets, and the gizmo palette is unchanged.
const CUBE_AX_X = 0xe06666,   // x — red
      CUBE_AX_Y = 0x6aa84f,   // y — green
      CUBE_AX_Z = 0x6d9eeb;   // z — blue, and in the default frame it points UP
const CUBE_HI    = 0x9a9a9a;   // view-cube zone hover — neutral gray, never an accent
// Per-face base value for the view-cube textures, keyed by the DISPLAY label
// _cubeFaceSpec derives (so a face re-shades with the up axis, not with its
// world normal). Top catches the most light, the sides less, Bottom least.
// Front/Back and Right/Left pair up deliberately: no viewpoint shows both
// members of a pair, so the three faces on screen are always three distinct
// values and every visible edge is a value step. This is the ONLY thing
// separating the faces now — the stroked frame is gone (see _makeCubeFaceTexture).
const CUBE_FACE_SHADE = Object.freeze({
  Top: '#3f3f3f', Front: '#333333', Back: '#333333',
  Right: '#2b2b2b', Left: '#2b2b2b', Bottom: '#232323',
});
const GIZ_HI_MIX = 0.42;       // hover/drag highlight = axis colour brightened toward white
const GIZ_YELLOW = 0xffff00;   // the hardcoded TransformControls highlight we intercept

// Ghost meshes take their colour from the shared role map (roles.js) so a part's
// 3D preview always matches its sidebar row accent: Part/Positive = --primary
// orange (the body), Negative = --green (the cavity interior). Uploaded parts
// render translucent; the generated result is solid light gray (--fg) with a sheen.
const RESULT_COLOR = 0xd9d9d9;  // --fg

const UP_OPACITY = 0.42;   // uploaded parts, translucent
const DIM_OPACITY = 0.16;  // uploaded parts once a result is shown

// ── Wave-3 · SECTION (Onshape-style plane manipulator + hatched caps) ──
// HUD palette mirrored from style.css (in-canvas 3D gizmos are exempt from the
// "no new solid --primary UI fills" rule; DOM chrome is not).
const COL_PRIMARY = 0xff5c00;   // --primary
const COL_LINE    = 0x353535;   // --line
const COL_INK     = 0x242424;   // --card (hatch base tint target)

const SEC_HATCH_MM   = 2.0;     // target world-space hatch period, clamped 1–4 mm
const SEC_TRIAD_FRAC = 0.50;    // pick-triad quad edge ÷ bbox max dim
const SEC_RECT_FRAC  = 1.15;    // manipulator plane rect ÷ bbox max dim
const SEC_ARROW_FRAC = 0.42;    // arrow length ÷ bbox max dim
const SEC_CLICK_PX   = 4;       // arrow drag travel under which a release = flip

const FACE_NORMAL_Q  = 0.02;    // planar-cluster normal quantisation
const FACE_OFFSET_Q  = 0.25;    // planar-cluster plane-offset quantisation (mm)
const FACE_MIN_FRAC  = 0.04;    // keep clusters ≥ 4% of the mesh's total area…
const FACE_MIN_AREA  = 25;      // …and ≥ 25 mm²
const FACE_MAX       = 12;      // top-N clusters by area
const FACE_TRI_CAP   = 2000000; // skip face detection above this triangle count
const FACE_LIFT_MM   = 0.3;     // face quads float this far off the surface

// OPEN FACES (the SHELL tool's multi-select). A picked face reads --green, the
// same language the Negative role uses for a cavity: green means AIR. Unpicked
// quads keep the neutral hover-only look, so the two states never blur.
const COL_GREEN      = 0x47c86e;   // --green
const FACE_OPEN_A    = 0.30;       // picked-face fill alpha (neutral quads: 0.13)
// A face's STABLE identity: its plane, quantised, expressed in the part's OWN
// frame rather than the world. That survives any gizmo move, so an open set
// picked before a drag still names the same faces after it — and after the
// re-detect that follows, the world-frame data the op sends is the new pose's.
const FACE_ID_N      = 50;      // normal quantisation (1/50 = 0.02, matches FACE_NORMAL_Q)
const FACE_ID_D      = 4;       // plane-offset quantisation (1/4 mm, matches FACE_OFFSET_Q)

// Render-order lanes. Stencil writers and caps MUST interleave strictly
// (writers → cap → clearStencil → next mesh), so every section object is forced
// transparent: three.js sorts the transparent list by renderOrder first, which
// is the only way to guarantee that order across several clipped meshes.
const RO_STENCIL = 20;   // + 2·i writers, + 2·i + 1 cap
const RO_RECT    = 200;  // manipulator plane rect / triad / face quads
const RO_ARROW   = 210;  // arrow (depthTest off — always grabbable)

// ── Part draw order: interiors AFTER their containers ────────────────────
// Ghost parts are translucent with depthWrite off, and three.js re-sorts the
// transparent list by DEPTH on every frame. That sort is per-object-centre, so
// on a nested pair (a Negative cavity sitting inside a Positive shell) the two
// centres are almost coincident and the winner flips with the camera: from half
// the orbit the outer shell was drawn LAST and, writing no depth but blending
// over what was already there, washed the interior out entirely. The part
// "disappeared" at some angles and came back at others.
//
// renderOrder is applied BEFORE that depth sort, so ordering by SIZE makes the
// answer deterministic and camera-independent: bigger translucents draw first,
// nested (smaller) ones after, so an interior stays visible inside its
// container from every direction. Size, not role — role↔inner/outer depends on
// upload order and user re-roling, so it is the wrong key (learned the hard
// way: a swapped positive/negative pair hid the interior at EVERY angle).
// _resortTranslucents() reassigns 1..N by descending world-bbox volume on
// add/remove/role/transform-commit; solids sit above all translucent lanes.
const RO_SOLID = 18;   // opaque results — above every translucent, below stencil
const RO_TRANSLUCENT_MAX = 17;   // 1..17 then ties (stencil lanes start at 20)

/** '#rrggbb' → 0xrrggbb for three.js. Garbage in → white, never NaN. */
function hexInt(hex) {
  const n = parseInt(String(hex || '').replace('#', ''), 16);
  return Number.isFinite(n) ? n : 0xffffff;
}

export class Viewer {
  constructor(container, opts = {}) {
    this.container = container;
    this.parts = new Map();   // id -> { mesh, role, visible }
    this.result = null;       // THREE.Mesh | null
    this._volumeHint = null;  // { partId -> volumeMM3 } published by main.js (COM weights)
    this._loader = new STLLoader();

    // Display frame FIRST — the camera, the grid and the view cube are all built
    // from it, and main.js hands in the persisted choice so the very first frame
    // is already in the user's convention (no flash, no re-present).
    this._plateH = 0;         // plate height along UP, as currently DRAWN
    this._setUpVectors(opts.upAxis || UP_AXIS_DEFAULT);

    const scene = new THREE.Scene();
    this.scene = scene;

    const cam = new THREE.PerspectiveCamera(45, 1, 0.1, 5000);
    // The view cube labels the UP face TOP, the build plate is the plane normal
    // to UP at the scene's resting height, and lay-flat rests faces on it. This
    // is presentation only — geometry is never rotated, so file coords == world
    // coords == export coords. camera.up MUST be set BEFORE OrbitControls is
    // built: the controls snapshot the up vector to derive their orbit basis.
    cam.up.copy(this._up);
    // Front-right-top per _homeDir(). _emptyView() re-parks this on the empty
    // plate as soon as the grid exists.
    cam.position.copy(this._homeDir()).multiplyScalar(128);
    this.camera = cam;

    // stencil:true is REQUIRED — three.js defaults it to false since r163 and the
    // hatched section caps are drawn through a back/front-face stencil count.
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, stencil: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.localClippingEnabled = true;   // enables the SECTION clip plane
    this.renderer = renderer;
    container.appendChild(renderer.domElement);

    // View-strip state: GHOSTS (bulk-hide uploaded parts) + SECTION.
    // SECTION is an ARBITRARY plane (axis chips are convenience setters, flat
    // faces can be picked directly), stored as normal + an anchor `base` point +
    // a signed `offsetMM` along that normal. `sign` (+1/−1) picks the kept half.
    // `hasPlane` false = tool on but nothing picked yet → the pick triad shows.
    this._ghostsHidden = false;
    this._dimmed = false;      // true once a lattice exists → ghost parts sit at DIM_OPACITY
    this._section = {
      enabled: false, hasPlane: false, axis: 'z', sign: 1, offsetMM: 0,
      normal: new THREE.Vector3(0, 0, 1),
      base: new THREE.Vector3(),
    };
    this._clipPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
    this._planePoint = new THREE.Vector3();   // base + normal·offsetMM

    const controls = new OrbitControls(cam, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.09;
    controls.rotateSpeed = 0.9;
    this.controls = controls;

    // Lighting: hemisphere fill + a key directional, both aimed from the display
    // frame — the key sits high on UP over the HOME octant (FRONT + RIGHT) so
    // display-TOP faces read brightest and the two visible side faces stay
    // distinct; the fill lifts the back-left shadow side. _aimLights re-points
    // all three whenever the up axis changes (HemisphereLight reads its POSITION
    // as the sky direction, so it has to move too).
    this.hemi = new THREE.HemisphereLight(0xffffff, 0x40404a, 1.05);
    scene.add(this.hemi);
    this.key = new THREE.DirectionalLight(0xffffff, 1.35);
    scene.add(this.key);
    this.fill = new THREE.DirectionalLight(0xffffff, 0.4);
    scene.add(this.fill);
    this._aimLights();

    // Subtle ground grid (adaptive: repositioned by _updateGrid on each fit).
    this.grid = null;
    this._gridMeta = { size: 0 };

    this._resize();
    this._ro = new ResizeObserver(() => this._resize());
    this._ro.observe(container);

    // ── Wave-2 selection + transform gizmo + view cube ──────────────────
    // Callbacks wired by main.js (viewer stays state-free; main owns app state).
    this.onPick = null;            // (id|null, mods) → click-select / empty-click clear
    this.onFocus = null;           // (id)            → DOUBLE-click a part: select + frame it
    this.onTransformLive = null;   // ([{id,trs}])    → gizmo drag (rebuild only, no fit)
    this.onTransformCommit = null; // ([{id,trs}])    → gizmo drag END (one commit)
    this.onDragChange = null;      // (bool)         → freeze refreshParts while dragging
    this.onLayFlat = null;         // (id, trs|null) → lay-flat one-shot result
    this.onSectionChange = null;   // (sectionState) → HUD readout + chip sync
    this.onOpenFacesChange = null; // (ids[])        → the SHELL tool's open-face count
    this.onQuadArmerCancel = null; // ()             → something else took the face quads

    // Wave-6 · selection is an ORDERED MULTI-SET. `_selection` is the whole set
    // (order = the order the user picked them, which drives boolean A/B later);
    // `_selectedId` is a cached mirror of its LAST element — the PRIMARY — so
    // every single-part path below (lay flat, section face quads, face cache)
    // keeps reading exactly what it always read.
    this._selection = [];
    this._selectedId = null;
    this._gizmoActive = false;
    this._layFlatArmed = false;
    // OPEN FACES pick (SHELL). A THIRD quad-armer beside SECTION and LAY FLAT,
    // and only ever one of the three is live: each arms by cancelling the others.
    // Unlike those two it is a MULTI-select that persists — `_openFaces` holds the
    // stable face ids the tool will turn into the op's `openFaces` payload.
    this._openPick = false;
    this._openPickId = null;
    this._openFaces = new Set();
    this._raycaster = new THREE.Raycaster();
    this._cubeAnim = null;
    this._cubeCursor = false;   // body.cube-pick state, so the class is written once per crossing

    // Hidden proxy Object3D the gizmo drives: part meshes use matrixAutoUpdate=
    // false hand-built matrices, so TransformControls cannot attach to them.
    // Wave-4: the proxy no longer mirrors the part's TRS — it sits at the unit's
    // world bbox CENTRE (the pivot P), carrying the part's rotation + scale. The
    // gizmo therefore renders ON the part, and a drag is read back as a DELTA
    // against the pose captured at drag start (`_dragRef`). See _readProxyTrs.
    this._proxy = new THREE.Object3D();
    this._proxy.matrixAutoUpdate = true;
    this._proxy.visible = false;
    scene.add(this._proxy);
    this._dragRef = null;   // { id, P0, t0, r0, s0, q0, M0, mode } captured at drag start
    this._plate = null;     // in-flight freeform plate drag

    const gizmo = new TransformControls(cam, renderer.domElement);
    gizmo.size = 0.82;
    gizmo.space = 'world';
    this.gizmo = gizmo;
    scene.add(gizmo.getHelper());   // r170: add the helper root, not the control
    this._recolorGizmo();           // red/green/blue + yellow hover → the ANVIL axis palette
    gizmo.addEventListener('objectChange', () => {
      if (!this._gizmoActive || !this._selection.length) return;
      const entries = this._readDragEntries();
      if (entries.length) this.onTransformLive?.(entries);
    });
    gizmo.addEventListener('dragging-changed', (e) => {
      this.controls.enabled = !e.value;
      this.onDragChange?.(e.value);
      if (e.value) { this._captureDragRef(); return; }
      const ref = this._dragRef;
      let entries = ref ? this._readDragEntries() : [];
      // A rotation lands the SELECTION back on the bed as one body — the plate as
      // it was DRAWN when the drag started (_plateH is only recomputed on commit,
      // never mid-drag). Translate / scale are left alone (the user may be
      // hovering a part deliberately).
      if (entries.length && ref.mode === 'rotate') entries = this._groundEntries(entries);
      this._dragRef = null;
      if (entries.length) this.onTransformCommit?.(entries);
      this._syncProxy();
    });

    // ── Wave-3 SECTION scene graph ──────────────────────────────────────
    // Two identity-matrix roots so enable/disable/rebuild is a single subtree
    // swap and every child can carry a hand-built world matrix verbatim.
    this._secStencil = new THREE.Group();   // per-mesh stencil writers + hatch caps
    this._secStencil.matrixAutoUpdate = false;
    scene.add(this._secStencil);
    this._secOverlay = new THREE.Group();   // pick triad · manipulator · face quads
    this._secOverlay.matrixAutoUpdate = false;
    scene.add(this._secOverlay);

    this._quadGeo = new THREE.PlaneGeometry(1, 1);            // unit quad, +Z normal
    this._edgeGeo = new THREE.EdgesGeometry(this._quadGeo);   // its border, for definition
    this._arrowGeo = null;      // built lazily (shaft + cone + fat picker, along +Z)
    this._caps = [];            // [{ src, w0, w1, cap }]
    this._triad = null;         // THREE.Group | null
    this._manip = null;         // THREE.Group | null
    this._faceQuads = [];       // [THREE.Mesh] with userData.secFace
    this._secHover = null;      // currently glowing overlay mesh
    this._secDrag = null;       // in-flight arrow drag bookkeeping
    this._secPending = null;    // pointerdown pick awaiting a <4px release

    this._initViewCube();
    this._initPointer();

    // ── LIVE PREVIEW (GPU raymarch of the TPMS field) ───────────────────
    // Owned here so its per-frame sync rides the SINGLE rAF below; main.js
    // drives it through `viewer.preview` (enable / target / params / quality).
    this.preview = new LatticePreview(this);
    this._previewDimId = null;   // the target ghost currently held at DIM opacity
    this._resultHidden = false;  // a baked lattice parked while the preview is up

    // Empty scene ≠ empty viewport: lay the plate and park HOME on it so the
    // first frame already reads as a build volume (and so the orientation widget
    // has a ground plane to orient against before anything is imported).
    this._emptyView();

    if (EULER_SELFTEST) { try { this._selfTestEuler(); } catch (err) { console.error('[anvil] euler self-test threw', err); } }
    if (PIVOT_SELFTEST) { try { this._selfTestPivot(); } catch (err) { console.error('[anvil] pivot self-test threw', err); } }

    this._running = true;
    this._tick = this._tick.bind(this);
    requestAnimationFrame(this._tick);
  }

  // ══ MODEL UP — the display frame ═════════════════════════════════════
  // Pure presentation. Nothing below reads or writes vertex data, and no part
  // TRS is touched: switching modes re-presents the same scene from a different
  // convention, so exports are bit-identical across all four.

  /** Load one of UP_AXES into the UP / FRONT / RIGHT trio. Vector math only —
   *  safe to call before the scene exists (the constructor does). */
  _setUpVectors(axis) {
    const key = UP_AXES[axis] ? axis : UP_AXIS_DEFAULT;
    const d = UP_AXES[key];
    this._upKey = key;
    this._up = new THREE.Vector3().fromArray(d.up);
    this._front = new THREE.Vector3().fromArray(d.front);
    this._right = new THREE.Vector3().crossVectors(this._up, this._front).normalize();
    return key;
  }

  /** Switch the display convention. Returns the key actually applied. */
  setUpAxis(axis) {
    const key = this._setUpVectors(axis);
    this.camera.up.copy(this._up);
    // OrbitControls (r170) snapshots its orbit-axis quaternion from camera.up
    // ONCE, in the constructor, and never refreshes it — so a live up change has
    // to rewrite it by hand or the view keeps orbiting about the old pole.
    if (this.controls?._quat) {
      this.controls._quat.setFromUnitVectors(this._up, new THREE.Vector3(0, 1, 0));
      this.controls._quatInverse.copy(this.controls._quat).invert();
    }
    this._aimLights();
    this._relabelCube();
    this._gridMeta.size = -1;   // force a rebuild so the plate re-orients
    this.homeView();            // re-present from the new convention's HOME
    return key;
  }
  upAxis() { return this._upKey; }

  /** HOME iso direction in the current basis: FRONT + RIGHT + 0.8·UP. */
  _homeDir() {
    return new THREE.Vector3()
      .add(this._front).add(this._right).addScaledVector(this._up, HOME_TILT)
      .normalize();
  }
  /** How high a world point reads on screen. */
  _upCoord(v) { return v.dot(this._up); }
  /** Lowest UP-coordinate of an axis-aligned box. UP is axis-aligned in every
   *  mode, so this is just the corner that projects lowest. */
  _boxFloor(box) {
    const u = this._up;
    return (u.x < 0 ? box.max.x : box.min.x) * u.x
         + (u.y < 0 ? box.max.y : box.min.y) * u.y
         + (u.z < 0 ? box.max.z : box.min.z) * u.z;
  }
  /** The scene's resting height along UP, snapped to 0 when the content already
   *  sits on the origin plane — so a clean CAD export reads as standing at
   *  zero instead of at −1.7e-15. */
  _restingHeight(box) {
    if (!box) return 0;
    const h = this._boxFloor(box);
    return Math.abs(h) < PLATE_SNAP_MM ? 0 : h;
  }
  /** The plate as currently DRAWN. Grounding (DROP / LAY FLAT / auto-drop after
   *  a rotate) targets this, so a part lands on the plate the user can see
   *  rather than on the one its own new pose would have redefined. */
  plateHeight() { return this._plateH; }

  _aimLights() {
    this.hemi.position.copy(this._up);
    const shoulder = new THREE.Vector3().add(this._front).add(this._right);
    this.key.position.copy(shoulder).multiplyScalar(0.55).addScaledVector(this._up, 1);
    this.fill.position.copy(shoulder).multiplyScalar(-0.6).addScaledVector(this._up, -0.3);
  }

  /** Where a fresh primitive must be AUTHORED so it stands display-up and rests
   *  on the plate. `standing` marks the shapes with a distinguished height axis
   *  (the worker builds cylinders and cones along +Y); a box or sphere has none,
   *  so it needs no convention rotation.
   *
   *  Returns { centerMM, trs }. The rotation R maps the part's own +Y onto UP,
   *  and the DATA centre is R⁻¹·C_world, so the rotated part lands exactly on
   *  C_world under a PURE rotation TRS — visible in XFORM, clearable, and it
   *  drops the part back to its authored pose when cleared. trs is null in +Y
   *  mode (nothing to correct) and for box/sphere. */
  primitiveSpawn(sizeY, standing) {
    const half = (Number.isFinite(sizeY) ? sizeY : 0) / 2;
    const c = this.getVisibleCenter() || new THREE.Vector3();
    // The visible centre slid onto the plate, then lifted half a height along UP.
    const world = c.clone().addScaledVector(this._up, this._plateH + half - this._upCoord(c));
    const rot = standing ? PRIM_ROT[this._upKey] : null;
    if (!rot) return { centerMM: xyzOf(world), trs: null };
    const data = world.clone()
      .applyMatrix4(new THREE.Matrix4().makeRotationX(-rot.x * Math.PI / 180));
    return {
      centerMM: xyzOf(data),
      trs: {
        translateMM: { x: 0, y: 0, z: 0 },
        rotateDeg: { ...rot },
        scale: { x: 1, y: 1, z: 1 },
      },
    };
  }

  // ── Parts ───────────────────────────────────────────────────────────
  // opts.solid → the SOLID result look (light gray, opaque, sheen) instead of the
  // translucent role-coloured ghost. A generated lattice is a normal part in every
  // other respect: selectable, gizmo-drivable, section-capped, COM-weighted.
  // A SCRIPT output takes the same solid material — it is a finished model, not a
  // ghost — but it is NOT a lattice, hence opts.lattice.
  // opts.lattice → this solid IS a baked lattice, so the live preview (which
  // stands in for it) hides it. Defaults to opts.solid so every historical
  // "{solid:true}" call still means "a lattice"; a script part passes false.
  // opts.colorHex → an explicit per-part colour (see setPartColor); null means
  // "use the role colour", and a restore hands the stored override straight back.
  addPart(id, url, role, opts = {}) {
    const solid = !!opts.solid;
    const lattice = opts.lattice === undefined ? solid : !!opts.lattice;
    const colorHex = opts.colorHex || null;
    const tint = colorHex ? hexInt(colorHex) : (solid ? RESULT_COLOR : roleColorInt(role));
    return new Promise((resolve, reject) => {
      this._loader.load(url, (geometry) => {
        geometry.computeVertexNormals();
        const mat = this._partMaterial(solid, tint, id);
        const mesh = new THREE.Mesh(geometry, mat);   // no transform — world coords preserved
        mesh.renderOrder = solid ? RO_SOLID : 1;      // provisional; _resortTranslucents finalizes
        mesh.userData._solid = solid;   // the cap builder reads this for full-strength hatch
        if (this._ghostsHidden && !solid) mesh.visible = false;
        if (this._resultHidden && solid && lattice) mesh.visible = false;
        this.scene.add(mesh);
        this.parts.set(id, { id, mesh, role, visible: true, solid, lattice, colorHex });
        this._resortTranslucents();
        // Selected before its mesh finished loading (row appears first): the
        // gizmo had nothing to sit on, so seat it now.
        if (this._selection.includes(id)) this.startGizmo(this.gizmo.mode || 'translate');
        this._sectionDirty();
        this.fitView();
        resolve();
      }, undefined, (err) => reject(err instanceof Error ? err : new Error('STL load failed')));
    });
  }

  /** The two part looks, in one place so addPart and setPartSolid can never
   *  drift: SOLID = opaque light-gray-or-tint with a slight metallic sheen;
   *  GHOST = translucent role colour, no depth write. `forId` is only used to
   *  answer "is this the part the live preview is standing in for", which holds
   *  a ghost at DIM opacity regardless of the scene-wide dim mode. */
  _partMaterial(solid, tint, forId) {
    if (solid) {
      return new THREE.MeshStandardMaterial({
        color: tint,
        metalness: 0.35,   // slight metallic look
        roughness: 0.45,
        side: THREE.DoubleSide,
      });
    }
    const dim = this._dimmed || (forId && this._previewDimId === forId);
    return new THREE.MeshStandardMaterial({
      color: tint,
      metalness: 0.05,
      roughness: 0.65,
      transparent: true,
      opacity: dim ? DIM_OPACITY : UP_OPACITY,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
  }

  /** Flip an EXISTING part between the solid and the ghost look, keeping its
   *  geometry, pose, links, selection and colour override. The lattice-unity flow
   *  drives this: a solid SCRIPT part that becomes a lattice source turns back
   *  into a ghost shell for as long as it belongs to that lattice, and gets its
   *  solid body back when the lattice is dropped. */
  setPartSolid(id, on) {
    const p = this.parts.get(id);
    if (!p || !!p.solid === !!on) return;
    const solid = !!on;
    const tint = p.colorHex ? hexInt(p.colorHex) : (solid ? RESULT_COLOR : roleColorInt(p.role));
    const old = p.mesh.material;
    p.mesh.material = this._partMaterial(solid, tint, id);
    old.dispose();
    p.solid = solid;
    p.mesh.userData._solid = solid;
    p.mesh.renderOrder = solid ? RO_SOLID : 1;   // _resortTranslucents finalizes
    p._emiSaved = null;                          // the saved emissive belonged to the old material
    // Visibility answers to whichever bulk toggle owns this look now.
    if (solid) p.mesh.visible = (this._resultHidden && p.lattice) ? false : p.visible;
    else p.mesh.visible = this._ghostsHidden ? false : p.visible;
    if (this._selection.includes(id)) this._applySelTint(p);
    this._resortTranslucents();
    this._sectionDirty();   // the cap builder reads _solid for full-strength hatch
  }

  setPartRole(id, role) {
    const p = this.parts.get(id);
    if (!p) return;
    p.role = role;
    if (p.colorHex) return;   // an explicit per-part colour outlives its role
    if (p.solid) return;      // a solid result keeps RESULT_COLOR whatever its data role says
    p.mesh.material.color.setHex(roleColorInt(role));
    if (this._selection.includes(id)) this._applySelTint(p);   // keep the emissive glow hued to the new role
  }

  // Reassign translucent draw order by descending world-bbox volume: containers
  // (bigger) first, nested parts (smaller) after, so interiors never wash out.
  // Cheap (N part boxes) — called on add/remove and transform commits, never
  // per-frame. Beyond 17 translucents the smallest tie at the cap (harmless).
  _resortTranslucents() {
    const rows = [];
    for (const p of this.parts.values()) {
      if (p.solid) { p.mesh.renderOrder = RO_SOLID; continue; }
      const b = new THREE.Box3().setFromObject(p.mesh);
      const s = b.isEmpty() ? new THREE.Vector3() : b.getSize(new THREE.Vector3());
      rows.push({ mesh: p.mesh, vol: s.x * s.y * s.z });
    }
    rows.sort((a, b) => b.vol - a.vol);
    rows.forEach((r, i) => { r.mesh.renderOrder = Math.min(1 + i, RO_TRANSLUCENT_MAX); });
  }

  /** Per-part colour override. `hex` is '#rrggbb', or null to fall back to the
   *  role colour (a solid lattice falls back to RESULT_COLOR). It drives the
   *  mesh tint AND the selection emissive, which is derived from material.color,
   *  so a selected part recolours without losing its glow. */
  setPartColor(id, hex) {
    const p = this.parts.get(id);
    if (!p) return;
    const next = hex || null;
    const tint = next ? hexInt(next) : (p.solid ? RESULT_COLOR : roleColorInt(p.role));
    // No-op guard: syncViewerRoles pushes every part's colour after each history
    // step, and the section rebuild below is not free.
    if (p.colorHex === next && p.mesh.material.color.getHex() === tint) return;
    p.colorHex = next;
    p.mesh.material.color.setHex(tint);
    if (this._selection.includes(id)) this._applySelTint(p);
    this._sectionDirty();   // the hatch cap takes its tint from the source material
  }

  // ── Linked ghosts (a lattice carries the sources it was built from) ──
  // The lattice geometry already has its sources' TRS baked in, so at link time
  // the host matrix is identity and every ghost stays exactly where it is. From
  // then on a linked ghost draws at M_host · M_own: moving/rotating/scaling the
  // LATTICE carries its ghosts along, while moving a ghost on its own still only
  // moves that ghost (its stored base is refreshed in _applyPartMatrix).
  linkGhosts(hostId, ghostIds) {
    const host = this.parts.get(hostId);
    if (!host) return;
    this.unlinkGhosts(hostId);
    host.links = new Map();   // ghostId -> base matrix (the ghost's own TRS matrix)
    for (const gid of ghostIds || []) {
      const g = this.parts.get(gid);
      if (!g || gid === hostId) continue;
      g.linkHostId = hostId;
      host.links.set(gid, this._ownMatrix(g));
      this._applyPartMatrix(g);
    }
  }

  /** Release every ghost linked to `hostId` back to its own matrix. */
  unlinkGhosts(hostId) {
    const host = this.parts.get(hostId);
    if (!host || !host.links) return;
    const ids = Array.from(host.links.keys());
    host.links = null;
    for (const gid of ids) {
      const g = this.parts.get(gid);
      if (!g) continue;
      g.linkHostId = null;
      this._applyPartMatrix(g);
    }
  }

  /** Release ONE ghost from whatever lattice it is linked to. */
  unlinkGhost(ghostId) {
    const g = this.parts.get(ghostId);
    if (!g || !g.linkHostId) return;
    this.parts.get(g.linkHostId)?.links?.delete(ghostId);
    g.linkHostId = null;
    this._applyPartMatrix(g);
  }

  // ── Per-part non-destructive TRS (live transform preview) ─────────────
  // Canonical composition (MUST match worker MeshUtil + server BuildMatrix):
  //   scale → rotX → rotY → rotZ → translate.
  // three.js is column-vector (v' = M·v), so scale is the RIGHTMOST factor.
  // Building via premultiply from makeScale yields M = T·Rz·Ry·Rx·S, i.e.
  //   M·v = T(Rz(Ry(Rx(S·v)))) — scale first, translate last. matrixAutoUpdate
  // is disabled so the hand-built matrix is used verbatim (no recentering).
  // opts.fit === false → commit WITHOUT a camera refit. Every in-canvas commit
  // (gizmo drag, plate drag, lay-flat, DROP) uses it: refitting after each drag
  // would yank the camera back to the iso framing the user just orbited away
  // from. The TRANSFORM tool (a panel action, not a direct manipulation) keeps
  // the old fit-on-commit behaviour.
  setPartTransform(id, trs, opts = {}) {
    const p = this.parts.get(id);
    if (!p) return;
    p.trs = trs || null;
    this._applyPartMatrix(p);
    this._resortTranslucents();     // scale/moves can change nesting order
    this._secQuadsFrozen = false;   // commit → re-detect faces at the new pose
    this._syncFaceQuads();
    this._syncProxy();              // gizmo re-seats on the moved part's new pivot
    if (opts.fit === false) this._refreshGrid();
    else this.fitView();
  }
  // Live gizmo path: rebuild the hand matrix ONLY — no fitView (no camera jump
  // mid-drag), no state commit. main.js commits once on drag end via
  // setPartTransform (the fitView + TRS-panel-sync path).
  setPartTransformLive(id, trs) {
    const p = this.parts.get(id);
    if (!p) return;
    p.trs = trs || null;
    this._applyPartMatrix(p);
    // Face detection is a full triangle sweep — freeze the quads mid-drag and
    // re-detect once, on commit.
    if (!this._secQuadsFrozen) { this._secQuadsFrozen = true; this._syncFaceQuads(); }
  }
  clearPartTransform(id) {
    const p = this.parts.get(id);
    if (!p) return;
    p.trs = null;
    this._applyPartMatrix(p);   // identity own-matrix (still composed under a host)
    this._resortTranslucents();
    this._syncFaceQuads();
    this._syncProxy();
    this.fitView();
  }
  /** A TRS filled in with defaults — the one shape every helper below expects. */
  _trsOf(p) {
    const trs = (p && p.trs) || {};
    const t = trs.translateMM || {}, r = trs.rotateDeg || {}, s = trs.scale || {};
    return {
      translateMM: { x: t.x || 0, y: t.y || 0, z: t.z || 0 },
      rotateDeg:   { x: r.x || 0, y: r.y || 0, z: r.z || 0 },
      scale:       { x: s.x || 1, y: s.y || 1, z: s.z || 1 },
    };
  }
  /** The hand chain M = T·Rz·Ry·Rx·S for a raw TRS (worker/server canonical). */
  _matrixFromTrs(trs) {
    const { translateMM: t, rotateDeg: r, scale: s } = this._trsOf({ trs });
    const D = Math.PI / 180;
    const m = new THREE.Matrix4().makeScale(s.x, s.y, s.z);
    m.premultiply(new THREE.Matrix4().makeRotationX(r.x * D));
    m.premultiply(new THREE.Matrix4().makeRotationY(r.y * D));
    m.premultiply(new THREE.Matrix4().makeRotationZ(r.z * D));
    m.premultiply(new THREE.Matrix4().makeTranslation(t.x, t.y, t.z));
    return m;
  }
  /** The part's OWN TRS matrix — M = T·Rz·Ry·Rx·S, no link composition. */
  _ownMatrix(p) { return this._matrixFromTrs(p.trs); }

  // ── The transform UNIT: a part + every ghost linked to it ────────────
  // A lattice and its linked ghosts move as one body, so pivot / grounding /
  // scale-compensation all measure the UNION box. Linked ghosts count even when
  // hidden — a GHOSTS toggle must not silently move the plate contact.
  _unitMeshes(p) {
    const out = [{ mesh: p.mesh, base: null }];
    if (p.links) for (const [gid, base] of p.links) {
      const g = this.parts.get(gid);
      if (g && g.mesh) out.push({ mesh: g.mesh, base });
    }
    return out;
  }
  /** World AABB of the unit if the HOST's matrix were `M` (default: as drawn).
   *  Matches Box3.setFromObject (transformed geometry-bbox corners), so the
   *  "before" of a drag and the "after" of a candidate TRS are measured alike. */
  _unitBox(p, M) {
    const host = M || p.mesh.matrix;
    const box = new THREE.Box3();
    const v = new THREE.Vector3(), mm = new THREE.Matrix4();
    for (const { mesh, base } of this._unitMeshes(p)) {
      const g = mesh.geometry;
      if (!g) continue;
      if (!g.boundingBox) g.computeBoundingBox();
      const bb = g.boundingBox;
      if (!bb) continue;
      const m = base ? mm.multiplyMatrices(host, base) : host;
      for (let i = 0; i < 8; i++) {
        v.set(i & 1 ? bb.max.x : bb.min.x, i & 2 ? bb.max.y : bb.min.y, i & 4 ? bb.max.z : bb.min.z)
          .applyMatrix4(m);
        box.expandByPoint(v);
      }
    }
    return box.isEmpty() ? null : box;
  }
  /** Pivot P: the unit's world bbox centre. Falls back to translateMM. */
  _unitPivot(p, M) {
    const b = this._unitBox(p, M);
    if (b) return b.getCenter(new THREE.Vector3());
    const t = this._trsOf(p).translateMM;
    return new THREE.Vector3(t.x, t.y, t.z);
  }
  /** Same TRS, slid ALONG UP so the unit's lowest display point lands exactly on
   *  the plate height as currently drawn. The two axes in the plate plane are
   *  untouched. */
  _groundTrs(p, trs) {
    const out = {
      translateMM: { ...trs.translateMM }, rotateDeg: { ...trs.rotateDeg }, scale: { ...trs.scale },
    };
    const box = this._unitBox(p, this._matrixFromTrs(out));
    if (box) {
      const d = this._plateH - this._boxFloor(box);
      out.translateMM.x += this._up.x * d;
      out.translateMM.y += this._up.y * d;
      out.translateMM.z += this._up.z * d;
    }
    return out;
  }
  /** DROP: ground the given part's unit on the plate. Returns a TRS (or null). */
  dropToPlate(id) {
    const p = id ? this.parts.get(id) : null;
    if (!p) return null;
    return this._groundTrs(p, this._trsOf(p));
  }

  // ── Wave-6 · the SELECTION as one body ───────────────────────────────
  // A group transform measures the COMBINED box of every selected unit (each
  // unit = a part plus the ghosts linked to it), so the pivot, the plate contact
  // and the auto-drop after a rotate all treat the selection as a single body.

  /** [{id, trs}] → the world AABB the whole set would occupy. null if empty. */
  _entriesBox(entries) {
    const box = new THREE.Box3();
    for (const e of entries) {
      const p = this.parts.get(e.id);
      if (!p) continue;
      const b = this._unitBox(p, this._matrixFromTrs(e.trs));
      if (b) box.union(b);
    }
    return box.isEmpty() ? null : box;
  }
  /** Same entries, ALL slid by the same delta along UP so the combined box's
   *  lowest display point lands on the plate as currently drawn. */
  _groundEntries(entries) {
    const box = this._entriesBox(entries);
    if (!box) return entries;
    const d = this._plateH - this._boxFloor(box);
    return entries.map((e) => ({
      id: e.id,
      trs: {
        translateMM: {
          x: e.trs.translateMM.x + this._up.x * d,
          y: e.trs.translateMM.y + this._up.y * d,
          z: e.trs.translateMM.z + this._up.z * d,
        },
        rotateDeg: { ...e.trs.rotateDeg },
        scale: { ...e.trs.scale },
      },
    }));
  }
  /** The selection's current pose as entries — the input every group op starts from. */
  _selectionEntries() {
    const out = [];
    for (const id of this._selection) {
      const p = this.parts.get(id);
      if (p) out.push({ id, trs: this._trsOf(p) });
    }
    return out;
  }
  /** Combined world AABB of every selected unit, as drawn. null if none. */
  _selectionBox() { return this._entriesBox(this._selectionEntries()); }
  /** Pivot P for a group transform: the combined box centre (falls back to the
   *  primary part's own pivot, then to the origin). */
  _selectionPivot() {
    const b = this._selectionBox();
    if (b) return b.getCenter(new THREE.Vector3());
    const p = this._selectedId ? this.parts.get(this._selectedId) : null;
    return p ? this._unitPivot(p) : new THREE.Vector3();
  }
  /** DROP for the whole selection: ground the combined body. Returns entries. */
  dropSelectionToPlate() {
    const entries = this._selectionEntries();
    return entries.length ? this._groundEntries(entries) : [];
  }
  /** { center:{x,y,z}, size:{x,y,z} } of the combined selection box, or null.
   *  The XFORM tool's live world-bbox readout reads it. */
  selectionBoxInfo() {
    const b = this._selectionBox();
    if (!b) return null;
    const c = b.getCenter(new THREE.Vector3()), s = b.getSize(new THREE.Vector3());
    return { center: { x: c.x, y: c.y, z: c.z }, size: { x: s.x, y: s.y, z: s.z } };
  }
  /** The display frame's RIGHT unit vector, as plain numbers (duplicate offsets
   *  step along it so copies land beside the original, not inside it). */
  rightAxis() { return { x: this._right.x, y: this._right.y, z: this._right.z }; }
  _applyPartMatrix(p) {
    const own = this._ownMatrix(p);
    const host = p.linkHostId ? this.parts.get(p.linkHostId) : null;
    // Keep the host's stored base in step, so a ghost moved on its own keeps the
    // linkage consistent (it rides the lattice from its NEW pose).
    if (host && host.links) host.links.set(p.id, own.clone());
    // A host is never itself linked, so its mesh matrix IS its own matrix.
    const m = host ? new THREE.Matrix4().multiplyMatrices(host.mesh.matrix, own) : own;
    p.mesh.matrixAutoUpdate = false;
    p.mesh.matrix.copy(m);
    p.mesh.updateMatrixWorld(true);   // fitView/_visibleBox read matrixWorld
    p._faceCache = null;              // world-space face clusters moved with it
    // Carry every linked ghost along (host matrix is already committed above).
    if (p.links) {
      for (const gid of p.links.keys()) {
        const g = this.parts.get(gid);
        if (g) this._applyPartMatrix(g);
      }
    }
  }

  setPartVisible(id, visible) {
    const p = this.parts.get(id);
    if (!p) return;
    p.visible = visible;
    p.mesh.visible = visible;
    this._sectionDirty();
    this.fitView();
  }

  removePart(id) {
    const p = this.parts.get(id);
    if (!p) return;
    if (this._selection.includes(id)) {
      this._selection = this._selection.filter((x) => x !== id);
      this._selectedId = this._selection[this._selection.length - 1] || null;
      if (!this._selection.length) this.stopGizmo(); else this._syncProxy();
      this._syncFaceQuads();
    }
    if (this._previewDimId === id) this._previewDimId = null;
    this.preview?.forget(id);   // its baked part field is gone with it
    this.unlinkGhosts(id);   // a removed lattice releases its ghosts…
    if (p.linkHostId) this.parts.get(p.linkHostId)?.links?.delete(id);   // …a removed ghost leaves its host
    this.scene.remove(p.mesh);
    disposeMesh(p.mesh);
    this.parts.delete(id);
    this._resortTranslucents();
    this._sectionDirty();
    this.fitView();
  }

  // ── Result ──────────────────────────────────────────────────────────
  showResult(url) {
    return new Promise((resolve, reject) => {
      this._loader.load(url, (geometry) => {
        geometry.computeVertexNormals();
        this.clearResult();
        const mat = new THREE.MeshStandardMaterial({
          color: RESULT_COLOR,
          metalness: 0.35,   // slight metallic look
          roughness: 0.45,
          side: THREE.DoubleSide,
        });
        const mesh = new THREE.Mesh(geometry, mat);   // no transform
        mesh.renderOrder = RO_SOLID;   // opaque, and above every translucent lane
        this.result = mesh;
        this.scene.add(mesh);
        this.dimUploaded();
        this._sectionDirty();   // an appearing result joins the clip + caps
        this.fitView();
        resolve();
      }, undefined, (err) => reject(err instanceof Error ? err : new Error('preview load failed')));
    });
  }

  clearResult() {
    if (this.result) {
      this.scene.remove(this.result);
      disposeMesh(this.result);
      this.result = null;
      this._sectionDirty();
    }
  }

  // Ghost dimming is a scene-wide mode (a generated lattice makes every source
  // read as a ghost); solid result parts are never dimmed, and a part added while
  // the mode is on comes in already dimmed.
  dimUploaded() {
    this._dimmed = true;
    for (const p of this.parts.values()) if (!p.solid) p.mesh.material.opacity = DIM_OPACITY;
    this._syncCapOpacity();   // ghost caps follow their source mesh's opacity
  }
  undimUploaded() {
    this._dimmed = false;
    for (const p of this.parts.values()) if (!p.solid) p.mesh.material.opacity = UP_OPACITY;
    this._syncCapOpacity();
  }

  // ── LIVE PREVIEW support ────────────────────────────────────────────
  // Two small pieces of scene state the preview owns but the viewer draws:
  //  · the TARGET ghost drops to DIM opacity while the preview stands in for it
  //    (it is the same volume twice otherwise, and the ghost washes the raymarch
  //    out), restoring to whatever the scene-wide dim mode says when it leaves;
  //  · a shown RESULT mesh hides while the preview is on, and comes back when
  //    the preview turns off — a baked lattice and its preview are the same
  //    object at two fidelities and must never be drawn together.

  /** Hold one part's ghost at DIM opacity (null clears the previous holder).
   *  A SOLID target (a script output GENERATE is aimed at) has no opacity to
   *  give: it steps aside entirely while the preview stands in for it, and comes
   *  straight back when the preview releases it. */
  setPreviewDim(id) {
    const next = id || null;
    if (next === this._previewDimId) return;
    const prev = this._previewDimId ? this.parts.get(this._previewDimId) : null;
    if (prev && !prev.solid) prev.mesh.material.opacity = this._dimmed ? DIM_OPACITY : UP_OPACITY;
    else if (prev) prev.mesh.visible = (this._resultHidden && prev.lattice) ? false : prev.visible;
    this._previewDimId = next;
    const cur = next ? this.parts.get(next) : null;
    if (cur && !cur.solid) cur.mesh.material.opacity = DIM_OPACITY;
    else if (cur) cur.mesh.visible = false;
    this._syncCapOpacity();
  }

  /** Hide/show every baked LATTICE mesh (registered part or legacy result).
   *  A solid SCRIPT part is not a lattice and is not the preview's other
   *  fidelity, so it stays on screen. */
  setResultHidden(hidden) {
    const on = !!hidden;
    if (on === !!this._resultHidden) return;
    this._resultHidden = on;
    for (const p of this.parts.values()) {
      if (!p.solid || !p.lattice) continue;
      p.mesh.visible = on ? false : p.visible;
    }
    if (this.result) this.result.visible = !on;
    this._sectionDirty();
  }
  isResultHidden() { return !!this._resultHidden; }

  // ── Ghosts (bulk-toggle translucent parts; a solid lattice stays) ────
  toggleGhosts() {
    this._ghostsHidden = !this._ghostsHidden;
    for (const p of this.parts.values())
      if (!p.solid) p.mesh.visible = this._ghostsHidden ? false : p.visible;
    this._sectionDirty();
    this.fitView();
    return this._ghostsHidden;   // true = ghost parts hidden
  }

  // ══ Wave-3 · SECTION — arbitrary plane + arrow manipulator + hatch caps ══
  // The plane is stored as (normal, base anchor, signed offsetMM along normal).
  // Axis chips and flat-face picks are both just setters for that triple, so a
  // face-picked plane needs no special case downstream. Non-destructive: parts
  // are only clipped/overlaid, never transformed.

  /** Turn the SECTION tool on/off. ON with no plane chosen shows the pick triad. */
  setSection(enabled, axis) {
    const on = !!enabled;
    if (on) this._yieldOpenPick();   // SECTION takes the face quads over
    this._section.enabled = on;
    if (!on) {
      this._section.hasPlane = false;
      this._secDrag = null;
      this._secPending = null;
    } else if (axis) {
      this.pickAxisPlane(axis);
      return;
    }
    this._sectionDirty();
  }

  /** Axis chip / triad quad: an axis-aligned plane through the current anchor. */
  pickAxisPlane(axis) {
    const a = (axis === 'x' || axis === 'y' || axis === 'z') ? axis : 'z';
    this._section.axis = a;
    this._section.normal.set(a === 'x' ? 1 : 0, a === 'y' ? 1 : 0, a === 'z' ? 1 : 0);
    this._section.base.copy(this._sectionAnchor());
    this._section.offsetMM = 0;
    this._section.sign = 1;          // keep the high-coordinate half by default
    this._section.hasPlane = true;
    this._sectionDirty();
  }

  /** Flat-face pick: plane ON the face, keeping the material side (sign −1), so
   *  offset 0 cuts nothing and dragging the arrow inward starts the cut. */
  pickFacePlane(normal, point) {
    this._section.axis = null;       // arbitrary — no chip lights up
    this._section.normal.copy(normal).normalize();
    this._section.base.copy(point);
    this._section.offsetMM = 0;
    this._section.sign = -1;
    this._section.hasPlane = true;
    this._section.enabled = true;
    this._sectionDirty();
  }

  /** Signed mm from the anchor plane along the plane normal. */
  setSectionOffset(mm) {
    if (!this._section.hasPlane) return;
    this._section.offsetMM = Number.isFinite(mm) ? mm : 0;
    this._applySectionPlane();
  }
  nudgeSectionOffset(dmm) { this.setSectionOffset((this._section.offsetMM || 0) + dmm); }

  /** Section side: flips which half survives (invert ⇄ / a click on the arrow). */
  setSectionSign(sign) {
    this._section.sign = sign < 0 ? -1 : 1;
    if (this._section.hasPlane) this._applySectionPlane();
  }
  toggleSectionSign() { this.setSectionSign(-(this._section.sign || 1)); return this._section.sign; }

  /** Drop back to the pick triad without turning the tool off. */
  clearSectionPlane() { this._section.hasPlane = false; this._sectionDirty(); }

  getSectionState() {
    const s = this._section;
    return {
      enabled: s.enabled, hasPlane: s.hasPlane, axis: s.axis, sign: s.sign,
      offsetMM: s.offsetMM,
      normal: { x: s.normal.x, y: s.normal.y, z: s.normal.z },
      base: { x: s.base.x, y: s.base.y, z: s.base.z },
    };
  }

  // Anchor the triad/plane sits on: the selected part's bbox centre, else the
  // visible union centre, else world origin.
  _sectionAnchor() {
    const sel = this._selectedId ? this.parts.get(this._selectedId) : null;
    if (sel && sel.mesh.visible) {
      const b = new THREE.Box3().setFromObject(sel.mesh);
      if (!b.isEmpty()) return b.getCenter(new THREE.Vector3());
    }
    const box = this._visibleBox();
    return box ? box.getCenter(new THREE.Vector3()) : new THREE.Vector3();
  }
  // Scene scale driver for gizmo sizing / hatch period. 1 when nothing visible.
  _sceneSpan() {
    const box = this._visibleBox();
    if (!box) return 1;
    const s = box.getSize(new THREE.Vector3());
    return Math.max(s.x, s.y, s.z) || 1;
  }

  // Full rebuild: clip → stencil caps → overlays → readout.
  _sectionDirty() {
    this._applySectionPlane(true);
  }

  // Recompute the clip plane from state, then push it everywhere. `rebuild`
  // tears down and re-creates the stencil group (mesh set changed); otherwise
  // the existing caps are just re-placed (cheap enough for a live drag).
  _applySectionPlane(rebuild) {
    const s = this._section;
    if (s.normal.lengthSq() < 1e-12) s.normal.set(0, 0, 1);
    s.normal.normalize();
    this._planePoint.copy(s.base).addScaledVector(s.normal, s.offsetMM);
    const sg = s.sign || 1;
    this._clipPlane.normal.copy(s.normal).multiplyScalar(sg);
    this._clipPlane.constant = -sg * s.normal.dot(this._planePoint);

    this._applyClip();
    if (rebuild) this._rebuildCaps(); else this._syncCaps();
    this._syncOverlays();
    this.onSectionChange?.(this.getSectionState());
  }

  _sectionActive() { return this._section.enabled && this._section.hasPlane; }

  _applyClip() {
    const planes = this._sectionActive() ? [this._clipPlane] : null;
    const set = (mat) => {
      if (!mat) return;
      const had = !!(mat.clippingPlanes && mat.clippingPlanes.length);
      mat.clippingPlanes = planes;
      if (had !== !!planes) mat.needsUpdate = true;   // clip count changes the program
    };
    for (const p of this.parts.values()) set(p.mesh.material);
    if (this.result) set(this.result.material);
  }

  // ── Hatched caps (back/front-face stencil count → one quad per mesh) ──
  // Straight out of three.js' webgl_clipping_stencil, with two changes: the
  // writers SHARE the source geometry (no copies, matrices mirrored from
  // matrixWorld) and the cap is hatched instead of solid, so a cut reads as
  // "you are looking at material", never as a hole.
  _clippedMeshes() {
    const out = [];
    for (const p of this.parts.values()) if (p.mesh.visible) out.push(p.mesh);
    if (this.result) out.push(this.result);
    return out;
  }

  _rebuildCaps() {
    for (const c of this._caps) {
      this._secStencil.remove(c.w0, c.w1, c.cap);
      c.w0.material.dispose(); c.w1.material.dispose(); c.cap.material.dispose();
    }
    this._caps.length = 0;
    if (!this._sectionActive()) return;

    const meshes = this._clippedMeshes();
    for (let i = 0; i < meshes.length; i++) {
      const src = meshes[i];
      const order = RO_STENCIL + i * 2;
      const w0 = this._makeStencilWriter(src.geometry, THREE.BackSide, THREE.IncrementWrapStencilOp, order);
      const w1 = this._makeStencilWriter(src.geometry, THREE.FrontSide, THREE.DecrementWrapStencilOp, order);
      // A solid mesh (legacy result OR a registered lattice part) caps at full
      // strength; translucent ghosts cap at their own opacity.
      const isResult = src === this.result || !!src.userData._solid;
      const color = src.material.color ? src.material.color.getHex() : 0xffffff;
      const opacity = isResult ? 1 : (src.material.opacity ?? 1);
      const cap = new THREE.Mesh(this._quadGeo, makeHatchMaterial(color, opacity));
      cap.matrixAutoUpdate = false;
      cap.frustumCulled = false;
      cap.renderOrder = order + 1;
      // Clear immediately after this mesh's cap so the next mesh starts at 0.
      cap.onAfterRender = (r) => r.clearStencil();
      this._secStencil.add(w0, w1, cap);
      this._caps.push({ src, w0, w1, cap, isResult });
    }
    this._syncCaps();
  }

  _makeStencilWriter(geometry, side, op, order) {
    const mat = new THREE.MeshBasicMaterial({
      side, colorWrite: false, depthWrite: false, depthTest: false,
      transparent: true,   // forces the transparent list, where renderOrder rules
    });
    mat.clippingPlanes = [this._clipPlane];
    mat.stencilWrite = true;
    mat.stencilFunc = THREE.AlwaysStencilFunc;
    mat.stencilFail = op; mat.stencilZFail = op; mat.stencilZPass = op;
    const m = new THREE.Mesh(geometry, mat);   // SHARED geometry — never cloned
    m.matrixAutoUpdate = false;
    m.frustumCulled = false;
    m.renderOrder = order;
    return m;
  }

  // Place every cap on the plane and mirror each writer's world matrix. Cheap:
  // Box3.setFromObject reuses the cached geometry bounding box.
  _syncCaps() {
    if (!this._caps.length) return;
    const n = this._section.normal;
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
    const u = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
    const v = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
    const period = THREE.MathUtils.clamp(this._sceneSpan() / 40, 1, SEC_HATCH_MM * 2);
    const P = this._planePoint;
    const b = new THREE.Box3(), c = new THREE.Vector3(), size = new THREE.Vector3();
    for (const cap of this._caps) {
      cap.w0.matrix.copy(cap.src.matrixWorld);
      cap.w1.matrix.copy(cap.src.matrixWorld);
      b.setFromObject(cap.src);
      if (b.isEmpty()) { cap.cap.visible = false; continue; }
      cap.cap.visible = true;
      b.getCenter(c);
      b.getSize(size);
      const span = Math.max(size.length(), 1) * 1.05;
      // Project the mesh centre onto the plane, then nudge a hair toward the
      // CUT-AWAY half (i.e. toward whoever is looking at the cut) so the cap
      // never z-fights the clipped silhouette.
      const d = n.dot(c) - n.dot(P);
      c.addScaledVector(n, -d).addScaledVector(this._clipPlane.normal, -span * 2e-4);
      cap.cap.matrix.compose(c, q, new THREE.Vector3(span, span, 1));
      const uni = cap.cap.material.userData.hatch;
      uni.uHatchU.value.copy(u);
      uni.uHatchV.value.copy(v);
      uni.uHatchPeriod.value = period;
    }
  }

  _syncCapOpacity() {
    for (const cap of this._caps) {
      const o = cap.isResult ? 1 : (cap.src.material.opacity ?? 1);
      cap.cap.material.opacity = o;
      cap.cap.material.depthWrite = o > 0.9;
    }
  }

  // ── Overlays: pick triad · plane+arrow manipulator · flat-face quads ──
  _syncOverlays() {
    const s = this._section;
    if (this._triad) this._triad.visible = s.enabled && !s.hasPlane;
    if (s.enabled && !s.hasPlane) this._buildTriad();
    if (this._manip) this._manip.visible = this._sectionActive();
    if (this._sectionActive()) this._placeManip();
    this._syncFaceQuads();
  }

  _buildTriad() {
    const anchor = this._sectionAnchor();
    const size = Math.max(this._sceneSpan() * SEC_TRIAD_FRAC, 1);
    if (!this._triad) {
      const g = new THREE.Group();
      g.matrixAutoUpdate = false;
      for (const ax of ['x', 'y', 'z']) {
        const quad = this._makeOverlayQuad(0.10);
        quad.userData.secAxis = ax;
        const edge = new THREE.LineSegments(this._edgeGeo, new THREE.LineBasicMaterial({
          color: COL_LINE, transparent: true, opacity: 0.9, depthWrite: false, depthTest: false,
        }));
        edge.matrixAutoUpdate = false;
        edge.renderOrder = RO_RECT + 1;
        quad.userData.edge = edge;
        g.add(quad, edge);
      }
      this._secOverlay.add(g);
      this._triad = g;
    }
    const axisOf = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) };
    const Z = new THREE.Vector3(0, 0, 1);
    const sc = new THREE.Vector3(size, size, 1);
    for (const child of this._triad.children) {
      const ax = child.userData.secAxis;
      if (!ax) continue;
      const q = new THREE.Quaternion().setFromUnitVectors(Z, axisOf[ax]);
      child.matrix.compose(anchor, q, sc);
      child.userData.edge.matrix.copy(child.matrix);
    }
    this._triad.visible = true;
  }

  // `color` defaults to the neutral rim; an OPEN face quad passes --green and the
  // hover restore reads it back off userData, so a tinted quad never reverts to
  // neutral just because the pointer crossed it.
  _makeOverlayQuad(opacity, color = COL_LINE) {
    const m = new THREE.Mesh(this._quadGeo, new THREE.MeshBasicMaterial({
      color, transparent: true, opacity, side: THREE.DoubleSide,
      depthWrite: false, depthTest: false,
    }));
    m.matrixAutoUpdate = false;
    m.frustumCulled = false;
    m.renderOrder = RO_RECT;
    m.userData.baseOpacity = opacity;
    m.userData.baseColor = color;
    return m;
  }

  _buildManip() {
    if (this._manip) return this._manip;
    const g = new THREE.Group();
    g.matrixAutoUpdate = false;

    const rect = this._makeOverlayQuad(0.09);
    rect.userData.secAxis = null;
    rect.matrixAutoUpdate = false;
    const border = new THREE.LineSegments(this._edgeGeo, new THREE.LineBasicMaterial({
      color: COL_PRIMARY, transparent: true, opacity: 0.5, depthWrite: false, depthTest: false,
    }));
    border.matrixAutoUpdate = false;
    border.renderOrder = RO_RECT + 1;

    if (!this._arrowGeo) this._arrowGeo = makeArrowGeometry();
    const arrowMat = new THREE.MeshBasicMaterial({
      color: COL_PRIMARY, transparent: true, opacity: 0.95, depthTest: false, depthWrite: false,
    });
    const shaft = new THREE.Mesh(this._arrowGeo.shaft, arrowMat);
    const head = new THREE.Mesh(this._arrowGeo.head, arrowMat);
    // Fat invisible cylinder around the arrow so it is grabbable at any zoom.
    // material.visible=false (not object.visible) keeps it raycastable — the
    // TransformControls picker pattern.
    const picker = new THREE.Mesh(this._arrowGeo.picker, new THREE.MeshBasicMaterial({ visible: false }));
    const arrow = new THREE.Group();
    arrow.matrixAutoUpdate = false;
    for (const m of [shaft, head, picker]) { m.renderOrder = RO_ARROW; m.frustumCulled = false; }
    arrow.add(shaft, head, picker);
    picker.userData.secArrow = true;

    g.add(rect, border, arrow);
    g.userData = { rect, border, arrow, picker };
    this._secOverlay.add(g);
    this._manip = g;
    return g;
  }

  _placeManip() {
    const g = this._buildManip();
    const span = this._sceneSpan();
    const n = this._section.normal;
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
    g.matrix.compose(this._planePoint, q, new THREE.Vector3(1, 1, 1));
    const size = Math.max(span * SEC_RECT_FRAC, 1);
    const I = new THREE.Quaternion();
    g.userData.rect.matrix.compose(new THREE.Vector3(), I, new THREE.Vector3(size, size, 1));
    g.userData.border.matrix.copy(g.userData.rect.matrix);
    const alen = Math.max(span * SEC_ARROW_FRAC, 1);
    g.userData.arrow.matrix.compose(new THREE.Vector3(), I, new THREE.Vector3(alen, alen, alen));
    g.visible = true;
  }

  // Face quads: shown on the SELECTED part when SECTION is on (pick a plane),
  // LAY FLAT is armed (pick a resting face) or OPEN FACES is armed (pick the
  // walls a shell leaves out). Same objects, three different verbs — and only one
  // verb at a time, so a click is never ambiguous.
  _faceQuadsWanted() {
    if (!this._selectedId || this._secQuadsFrozen) return false;
    return this._openPick || this._layFlatArmed || this._section.enabled;
  }
  _syncFaceQuads() {
    const want = this._faceQuadsWanted();
    if (this._secHover && this._secHover.userData.secFace) this._secHover = null;
    for (const q of this._faceQuads) {
      this._secOverlay.remove(q, q.userData.edge);
      q.material.dispose();
      q.userData.edge.material.dispose();
    }
    this._faceQuads.length = 0;
    if (!want) return;
    const faces = this._facesFor(this._selectedId);
    const Z = new THREE.Vector3(0, 0, 1);
    for (const f of faces) {
      // The tint is PERSISTENT state, not hover: an open face stays green while
      // the pick is armed. Only in pick mode — SECTION and LAY FLAT get the plain
      // neutral quads even if the SHELL tool is still holding a set.
      const open = this._openPick && this._openFaces.has(f.id);
      const tint = open ? COL_GREEN : COL_LINE;
      const quad = this._makeOverlayQuad(open ? FACE_OPEN_A : 0.13, tint);
      quad.userData.secFace = f;
      const q = new THREE.Quaternion().setFromUnitVectors(Z, f.normal);
      const c = f.center.clone().addScaledVector(f.normal, FACE_LIFT_MM);
      quad.matrix.compose(c, q, new THREE.Vector3(f.w, f.h, 1));
      const edge = new THREE.LineSegments(this._edgeGeo, new THREE.LineBasicMaterial({
        color: tint, transparent: true, opacity: 0.85, depthWrite: false, depthTest: false,
      }));
      edge.matrixAutoUpdate = false;
      edge.matrix.copy(quad.matrix);
      edge.renderOrder = RO_RECT + 1;
      quad.userData.edge = edge;
      this._secOverlay.add(quad, edge);
      this._faceQuads.push(quad);
    }
  }

  /** Planar face clusters of a part in WORLD space (cached per matrixWorld), each
   *  stamped with a TRS-stable `id` (its plane in the part's own frame). */
  _facesFor(id) {
    const p = id ? this.parts.get(id) : null;
    if (!p || !p.mesh) return [];
    const key = p.mesh.matrixWorld.elements.join(',');
    if (p._faceCache && p._faceCache.key === key) return p._faceCache.faces;
    const faces = detectPlanarFaces(p.mesh);
    // Pull each cluster's plane back into the part's OWN frame and quantise it —
    // the one thing about a face that a move, a rotation or a re-detect cannot
    // change. Detection order is by area and would otherwise shuffle.
    const inv = new THREE.Matrix4().copy(p.mesh.matrixWorld).invert();
    const nMat = new THREE.Matrix3().getNormalMatrix(inv);
    const lc = new THREE.Vector3(), ln = new THREE.Vector3();
    for (const f of faces) {
      lc.copy(f.center).applyMatrix4(inv);
      ln.copy(f.normal).applyMatrix3(nMat).normalize();
      f.id = [Math.round(ln.x * FACE_ID_N), Math.round(ln.y * FACE_ID_N),
        Math.round(ln.z * FACE_ID_N), Math.round(ln.dot(lc) * FACE_ID_D)].join(',');
    }
    p._faceCache = { key, faces };
    return faces;
  }

  // ── Section pointer picking ──────────────────────────────────────────
  // Strict priority, not nearest-hit: arrow → face quads → triad. A detected
  // face is a deliberate pick and must beat the big generic triad quads, which
  // span the anchor and would otherwise swallow every click near the part.
  _secPick(cx, cy) {
    if (!this._section.enabled && !this._layFlatArmed && !this._openPick) return null;
    this._raycaster.setFromCamera(this._ndcFromClient(cx, cy), this.camera);
    if (this._manip && this._manip.visible) {
      const hit = this._raycaster.intersectObject(this._manip.userData.picker, false);
      if (hit.length) return { kind: 'arrow' };
    }
    if (this._faceQuads.length) {
      const hits = this._raycaster.intersectObjects(this._faceQuads, false);
      if (hits.length) return { kind: 'face', face: hits[0].object.userData.secFace, obj: hits[0].object };
    }
    if (this._triad && this._triad.visible) {
      const quads = this._triad.children.filter((ch) => ch.userData.secAxis);
      const hits = this._raycaster.intersectObjects(quads, false);
      if (hits.length) return { kind: 'triad', axis: hits[0].object.userData.secAxis, obj: hits[0].object };
    }
    return null;
  }

  _setSecHover(obj) {
    if (this._secHover === obj) return;
    if (this._secHover) {
      const m = this._secHover.material;
      m.color.setHex(this._secHover.userData.baseColor ?? COL_LINE);
      m.opacity = this._secHover.userData.baseOpacity;
    }
    this._secHover = obj || null;
    if (obj) {
      obj.material.color.setHex(COL_PRIMARY);
      obj.material.opacity = Math.min(obj.userData.baseOpacity + 0.22, 0.5);
    }
  }

  _beginArrowDrag(e) {
    this._secDrag = {
      offset0: this._section.offsetMM,
      t0: this._axisParamAt(e.clientX, e.clientY),
      x0: e.clientX, y0: e.clientY, moved: false,
    };
    this.controls.enabled = false;
    this.onDragChange?.(true);
    try { this.renderer.domElement.setPointerCapture(e.pointerId); } catch { /* not captured — container listeners still fire */ }
  }
  _updateArrowDrag(e) {
    const d = this._secDrag;
    if (!d) return;
    if (Math.hypot(e.clientX - d.x0, e.clientY - d.y0) > SEC_CLICK_PX) d.moved = true;
    if (d.t0 == null) return;
    const t = this._axisParamAt(e.clientX, e.clientY);
    if (t == null) return;
    this.setSectionOffset(d.offset0 + (t - d.t0));
  }
  _endArrowDrag(e) {
    const d = this._secDrag;
    this._secDrag = null;
    this.controls.enabled = true;
    this.onDragChange?.(false);
    try { this.renderer.domElement.releasePointerCapture(e.pointerId); } catch { /* nothing captured */ }
    if (d && !d.moved) this.toggleSectionSign();   // click (not drag) = flip the kept side
  }
  // Closest-approach parameter of the pointer ray against the plane-normal axis
  // line through `base`. null when the view is nearly down the axis (degenerate).
  _axisParamAt(cx, cy) {
    this._raycaster.setFromCamera(this._ndcFromClient(cx, cy), this.camera);
    const A = this._section.base, u = this._section.normal;
    const O = this._raycaster.ray.origin, v = this._raycaster.ray.direction;
    const w0 = new THREE.Vector3().subVectors(A, O);
    const b = u.dot(v), den = 1 - b * b;
    if (Math.abs(den) < 1e-6) return null;
    return (b * v.dot(w0) - u.dot(w0)) / den;
  }

  // Union bbox of currently-visible meshes (uploaded parts + result). null if empty.
  _visibleBox() {
    const box = new THREE.Box3();
    let has = false;
    for (const p of this.parts.values()) {
      if (p.mesh.visible) { box.expandByObject(p.mesh); has = true; }
    }
    if (this.result) { box.expandByObject(this.result); has = true; }
    return (!has || box.isEmpty()) ? null : box;
  }

  /** {x,y,z} size of the visible union bbox, or null. Feeds the dims readout. */
  getVisibleSize() {
    const box = this._visibleBox();
    return box ? box.getSize(new THREE.Vector3()) : null;
  }

  /** {x,y,z} center of the visible union bbox, or null. Feeds the primitive
   *  tool's default centre (fallback origin when nothing is visible). */
  getVisibleCenter() {
    const box = this._visibleBox();
    return box ? box.getCenter(new THREE.Vector3()) : null;
  }

  // ── Spawn placement (a part ANVIL authored itself) ──────────────────
  /** Where to SET DOWN a part ANVIL adds on its own (the BANANA button), given
   *  that part's own file-frame bbox `{ min:[x,y,z], max:[x,y,z] }`. Returns a
   *  plain TRS - a normal, visible, clearable XFORM pose that export bakes, on
   *  the same latitude a primitive's stand-up rotation gets: a part authored in
   *  ANVIL has no external CAD frame to preserve. An IMPORT never comes here.
   *
   *  Two moves, both in the DISPLAY frame:
   *    · rotate - one X rotation maps the asset's authored +Z onto the current
   *      UP (identity in the default +Z mode), so it lies on the plate in every
   *      mode exactly as the plate itself re-presents;
   *    · translate - rest the ROTATED box on the plate as currently drawn, and
   *      stand it off to the display RIGHT of everything already visible, clear
   *      by SPAWN_GAP_MM between the two boxes. An empty scene puts it on the
   *      plate at the origin instead.
   *  Never scales: a life-size reference that is not life-size is not one.
   *
   *  Call BEFORE addPart, while _visibleBox() still describes the OTHER content
   *  only - otherwise the new part would be measuring itself. */
  spawnBeside(bboxMM) {
    const rotX = SPAWN_ROT[this._upKey] || 0;
    const drawn = boxFromBbox(bboxMM)
      .applyMatrix4(new THREE.Matrix4().makeRotationX(rotX * Math.PI / 180));
    const size = drawn.getSize(new THREE.Vector3());
    const centre = drawn.getCenter(new THREE.Vector3());
    // UP / FRONT / RIGHT are an orthonormal axis-aligned basis, so an extent
    // along one of them is just the matching component of the size vector.
    const along = (v, axis) => Math.abs(v.dot(axis));

    const t = new THREE.Vector3();
    const content = this._visibleBox();
    if (content) {
      const cc = content.getCenter(new THREE.Vector3());
      const gap = along(content.getSize(new THREE.Vector3()), this._right) / 2
        + SPAWN_GAP_MM + along(size, this._right) / 2;
      t.addScaledVector(this._right, cc.dot(this._right) + gap - centre.dot(this._right));
      t.addScaledVector(this._front, cc.dot(this._front) - centre.dot(this._front));
    } else {
      t.addScaledVector(this._right, -centre.dot(this._right));
      t.addScaledVector(this._front, -centre.dot(this._front));
    }
    // RIGHT and FRONT are perpendicular to UP, so this lands the box floor on
    // the plate whatever the two offsets above did.
    t.addScaledVector(this._up, this._plateH - this._boxFloor(drawn));

    return {
      translateMM: xyzOf(t),
      rotateDeg: { x: rotX, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
    };
  }

  // ── Orbit pivot (selection-aware) ───────────────────────────────────
  // main.js owns "what should the pivot be" (selection vs. everything); the
  // viewer only supplies the three primitives it needs to answer that.

  /** World-space bbox centre of a part mesh — Box3.setFromObject respects the
   *  hand-built TRS matrix, so this is the ghost's centre as drawn. null if the
   *  id is unknown or the mesh has no bounds. */
  getPartCenter(id) {
    const p = id ? this.parts.get(id) : null;
    if (!p || !p.mesh) return null;
    const b = new THREE.Box3().setFromObject(p.mesh);
    return b.isEmpty() ? null : b.getCenter(new THREE.Vector3());
  }

  /** World AABB of a part AS DRAWN (its TRS matrix included), as plain numbers:
   *  { min:{x,y,z}, max:{x,y,z} }, or null. Verification and callers that need
   *  world extents in DATA terms read it. */
  getPartBox(id) {
    const p = id ? this.parts.get(id) : null;
    if (!p || !p.mesh) return null;
    const b = new THREE.Box3().setFromObject(p.mesh);
    if (b.isEmpty()) return null;
    return {
      min: { x: b.min.x, y: b.min.y, z: b.min.z },
      max: { x: b.max.x, y: b.max.y, z: b.max.z },
    };
  }

  /** Move the orbit pivot WITHOUT touching camera.position — the view swings to
   *  look at the new target immediately (expected: that IS the pivot change).
   *  null is a no-op so callers can pass a failed lookup straight through. */
  setOrbitPivot(pt) {
    if (!pt) return;
    this.controls.target.set(pt.x, pt.y, pt.z);
    this.controls.update();
  }

  /** main.js publishes { partId -> volumeMM3 } here (refreshParts) so fitView's
   *  no-selection pivot can weight parts without main having to pass it in. */
  setVolumeHint(volumeById) { this._volumeHint = volumeById || null; }

  /** Volume-weighted centre of everything visible: Σ(vol_i·centre_i)/Σvol_i over
   *  the visible part meshes, vol_i from `volumeById` (id → volumeMM3). A part
   *  with no entry — and the generated result — falls back to its bbox volume.
   *  Falls back to the visible-union centre; null when nothing is visible. */
  computeCenterOfMass(volumeById) {
    const map = volumeById || this._volumeHint || null;
    const acc = new THREE.Vector3();
    let wsum = 0;
    const add = (mesh, vol) => {
      const b = new THREE.Box3().setFromObject(mesh);
      if (b.isEmpty()) return;
      const s = b.getSize(new THREE.Vector3());
      const w = vol > 0 ? vol : Math.max(s.x * s.y * s.z, 1e-9);   // bbox-volume fallback
      acc.addScaledVector(b.getCenter(new THREE.Vector3()), w);
      wsum += w;
    };
    for (const [id, p] of this.parts) if (p.mesh.visible) add(p.mesh, map ? map[id] : 0);
    if (this.result) add(this.result, 0);
    if (wsum > 0) return acc.multiplyScalar(1 / wsum);
    const box = this._visibleBox();
    return box ? box.getCenter(new THREE.Vector3()) : null;
  }

  // ── Camera fit (Box3 union of visible objects) ──────────────────────
  // FIT is fit-to-selection when a visible part is selected (standard CAD): the
  // SELECTED box drives distance + pivot. With nothing selected it frames the
  // union as before, but parks the pivot on the centre of mass. The grid always
  // follows the UNION box — the floor must not shrink to a single part.
  fitView(opts = {}) {
    const union = this._visibleBox();
    if (!union) { this._emptyView(); return; }

    // FIT frames the WHOLE selection (one part or twenty) — the union of the
    // selected meshes that are actually visible.
    let selBox = null;
    if (!opts.union && this._selection.length) {
      const b = new THREE.Box3();
      for (const id of this._selection) {
        const q = this.parts.get(id);
        if (q && q.mesh.visible) b.expandByObject(q.mesh);
      }
      if (!b.isEmpty()) selBox = b;
    }
    const box = selBox || union;

    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z) || 1;

    const fov = this.camera.fov * Math.PI / 180;
    let dist = (maxDim / 2) / Math.tan(fov / 2);
    dist *= 1.7;

    // Isometric-ish direction in the current display frame: FRONT-RIGHT-TOP.
    const dir = this._homeDir();
    const pivot = selBox ? center : (this.computeCenterOfMass(this._volumeHint) || center);
    // camera.up is CONSTANT (= UP) in every view, snaps included, so this is a
    // re-assert rather than a repair. Drop any in-flight snap — FIT is an
    // explicit camera command.
    this._cubeAnim = null;
    this.camera.up.copy(this._up);
    this.camera.position.copy(center).add(dir.multiplyScalar(dist));
    this.camera.near = Math.max(dist / 1000, 0.01);
    this.camera.far = dist * 100;
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(pivot);
    this.controls.update();

    this._refreshGrid(union);
  }

  /** HOME — the documented default camera: the FRONT-RIGHT-TOP iso of the
   *  current display frame, fit to EVERYTHING visible (never just the
   *  selection). Falls back to the empty plate when there is nothing to frame. */
  homeView() {
    this._cubeAnim = null;
    this.camera.up.copy(this._up);
    this.fitView({ union: true });
  }

  /** Empty scene: an origin-centred plate framed from HOME. Same camera math as
   *  fitView so the transition when the first part lands is a fit, not a jump. */
  _emptyView() {
    this._cubeAnim = null;
    this._updateGrid(new THREE.Vector3(0, 0, 0), EMPTY_PLATE_MM, 0);
    const fov = this.camera.fov * Math.PI / 180;
    const dist = ((EMPTY_PLATE_MM / 2) / Math.tan(fov / 2)) * 1.7;
    this.camera.up.copy(this._up);
    this.camera.position.copy(this._homeDir()).multiplyScalar(dist);
    this.camera.near = Math.max(dist / 1000, 0.01);
    this.camera.far = dist * 100;
    this.camera.updateProjectionMatrix();
    this.controls.target.set(0, 0, 0);
    this.controls.update();
  }

  /** Re-place the plate grid without touching the camera (no-fit commits). */
  _refreshGrid(union) {
    const box = union || this._visibleBox();
    if (!box) { this._updateGrid(new THREE.Vector3(0, 0, 0), EMPTY_PLATE_MM, 0); return; }
    const s = box.getSize(new THREE.Vector3());
    this._updateGrid(box.getCenter(new THREE.Vector3()), Math.max(s.x, s.y, s.z) || 1,
      this._restingHeight(box));
  }

  // The plate is ADAPTIVE: its plane normal is UP and it sits at the scene's
  // resting height (the display-bottom of everything visible), snapped to 0 when
  // the content already stands on the origin plane. That is what lets ANVIL show
  // any CAD frame sitting on a bed without ever moving the geometry — there is
  // no import lift, in any mode. An empty scene puts the plate through the
  // origin. A part floating above the plate visibly floats; DROP / LAY FLAT put
  // it down.
  _updateGrid(center, maxDim, height) {
    const size = Math.max(maxDim * 2.4, 10);
    this._plateH = height || 0;
    // GridHelper's NATIVE plane is XZ (normal +Y); one quaternion swings it onto
    // whatever UP is. The plate draws a hair BELOW the resting height — a
    // grounded part rests exactly on it and a coplanar grid z-fights its bottom
    // face. It follows the content within the plate plane.
    const eps = Math.max(0.05, size * 0.0008);
    const pos = center.clone()
      .addScaledVector(this._up, this._plateH - eps - this._upCoord(center));
    const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), this._up);
    if (this.grid && Math.abs(this._gridMeta.size - size) < size * 0.01) {
      this.grid.position.copy(pos);
      this.grid.quaternion.copy(quat);
      return;
    }
    if (this.grid) { this.scene.remove(this.grid); this.grid.geometry.dispose(); this.grid.material.dispose(); }
    const divisions = 20;
    // Dark-only HUD grid tones: --line centerlines over --muted lines.
    const grid = new THREE.GridHelper(size, divisions, 0x353535, 0x2a2a2a);
    grid.material.transparent = true;
    grid.material.opacity = 0.5;
    grid.position.copy(pos);
    grid.quaternion.copy(quat);
    this.scene.add(grid);
    this.grid = grid;
    this._gridMeta.size = size;
  }

  // ── Theme ───────────────────────────────────────────────────────────
  // Dark-only HUD. Kept as a method (main.js still calls it) but the app no
  // longer has a light theme, so the scene always uses the HUD --bg tone.
  setTheme(/* isDark */) {
    this.scene.background = new THREE.Color(0x1a1a1a);  // --bg oklch(0.2178 0 0)
    this.hemi.groundColor.setHex(0x2e2e2e);
    if (this.grid) { this._gridMeta.size = -1; this.fitView(); }
  }

  // ══ Wave-2/6 · Selection ═════════════════════════════════════════════
  // Selection is state-derived in main.js; the viewer only reflects it: an
  // emissive tint on EVERY selected mesh (original emissive stored/restored).
  // Linked ghosts are never tinted on their own — they ride their host, which is
  // what the selection actually holds.
  //
  // `ids` is the ordered set; a bare id (or null) is still accepted so any
  // caller written against the single-selection API keeps working.
  setSelected(ids) {
    const next = (Array.isArray(ids) ? ids : (ids ? [ids] : [])).filter(Boolean);
    if (next.join('|') === this._selection.join('|')) return;
    const nextSet = new Set(next);
    for (const id of this._selection) {          // dropped members lose the tint
      if (nextSet.has(id)) continue;
      const q = this.parts.get(id);
      if (q) this._clearSelTint(q);
    }
    const prevSet = new Set(this._selection);
    this._selection = next;
    this._selectedId = next[next.length - 1] || null;
    for (const id of next) {                     // added members take it
      if (prevSet.has(id)) continue;
      const q = this.parts.get(id);
      if (q) this._applySelTint(q);
    }
    if (!next.length) this.stopGizmo();
    else if (this._gizmoActive) this._syncProxy();   // gizmo re-seats on the new combined pivot
    // An open-face set names faces OF ONE BODY, so a new primary drops it. The
    // pick itself follows the selection (it binds the way the tool does) and only
    // disarms when there is nothing left to pick on.
    if (this._openPick && this._selectedId !== this._openPickId) {
      this._openFaces.clear();
      this._openPickId = this._selectedId;
      if (!this._openPickId) this._openPick = false;
      this.onQuadArmerCancel?.();
    }
    this._secQuadsFrozen = false;   // a cancelled live transform must not strand the freeze
    this._syncFaceQuads();          // face quads belong to the PRIMARY part only
    if (this._section.enabled && !this._section.hasPlane) this._buildTriad();   // re-anchor
  }
  selectedId() { return this._selectedId; }
  /** The ordered selection (a copy — callers must not mutate the viewer's). */
  selection() { return this._selection.slice(); }
  _applySelTint(p) {
    const m = p.mesh && p.mesh.material;
    if (!m || !m.emissive) return;
    if (!p._emiSaved) p._emiSaved = { hex: m.emissive.getHex(), intensity: m.emissiveIntensity };
    m.emissive.copy(m.color).multiplyScalar(0.55);   // self-lit glow hued to the part
    m.emissiveIntensity = 0.9;
  }
  _clearSelTint(p) {
    const m = p.mesh && p.mesh.material;
    if (!m || !m.emissive || !p._emiSaved) return;
    m.emissive.setHex(p._emiSaved.hex);
    m.emissiveIntensity = p._emiSaved.intensity;
    p._emiSaved = null;
  }

  _ndcFromClient(cx, cy) {
    const r = this.renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2(((cx - r.left) / r.width) * 2 - 1, -(((cy - r.top) / r.height) * 2 - 1));
  }
  // Raycast the visible, unghosted part meshes (never the result). Returns id|null.
  _pickPart(cx, cy) {
    this._raycaster.setFromCamera(this._ndcFromClient(cx, cy), this.camera);
    const meshes = [];
    for (const [id, p] of this.parts) if (p.mesh.visible) { p.mesh.userData._pid = id; meshes.push(p.mesh); }
    const hits = this._raycaster.intersectObjects(meshes, false);
    return hits.length ? hits[0].object.userData._pid : null;
  }
  /** Public raycast — the context menu asks "what is under the cursor?". */
  pickAt(cx, cy) { return this._pickPart(cx, cy); }
  /** True when the point sits inside the nav-cube widget rect (which owns its
   *  own pointer events — the context menu stays out of it). */
  isOverCube(cx, cy) { return this._cubeContains(cx, cy); }

  // ══ Wave-4/6 · Transform gizmo — PIVOT ON THE SELECTION ══════════════
  // The proxy is parked at the COMBINED unit bbox centre P of the whole
  // selection (so the handles draw on the body being moved, never at the world
  // origin). A drag is therefore a DELTA against the pose snapshotted at drag
  // start, mapped back onto the canonical chain M = T·Rz·Ry·Rx·S — PER MEMBER,
  // all sharing the one pivot P0:
  //
  //   TRANSLATE (world)  Δ = proxy.position − P0        → t_i = t0_i + Δ
  //   ROTATE    (world)  Δq = proxy.q · pq0⁻¹
  //                      M_new_i = T(P0)·R(Δq)·T(−P0)·M0_i
  //                            ⇒ R_i = Δq·R0_i, S_i = S0_i,
  //                              t_i = Δq·(t0_i − P0) + P0     ← still T·R·S
  //   SCALE     (local)  SINGLE SELECTION ONLY. S = proxy.scale (local-axis: a
  //                      world-axis scale of a rotated body is a shear with no
  //                      T·R·S form), then t += P0 − centre(M_new).
  //
  // With one part selected the proxy carries that part's rotation, so pq0 = q0
  // and every formula collapses to the Wave-4 single-part case element for
  // element. With several, the proxy is seated unrotated at the group centre.
  // _selfTestPivot proves the rotate case numerically (max element err < 1e-6).
  _readDragEntries() {
    const ref = this._dragRef;
    if (!ref || !ref.members.length) return [];
    const R2D = 180 / Math.PI;

    if (ref.mode === 'rotate') {
      const dq = this._proxy.quaternion.clone().multiply(ref.pq0.clone().invert());
      const out = [];
      for (const m of ref.members) {
        if (!this.parts.get(m.id)) continue;
        const e = new THREE.Euler().setFromQuaternion(dq.clone().multiply(m.q0), 'ZYX');
        const t = m.t0.clone().sub(ref.P0).applyQuaternion(dq).add(ref.P0);
        out.push({ id: m.id, trs: {
          translateMM: { x: t.x, y: t.y, z: t.z },
          rotateDeg:   { x: e.x * R2D, y: e.y * R2D, z: e.z * R2D },
          scale:       { x: m.s0.x, y: m.s0.y, z: m.s0.z },
        } });
      }
      return out;
    }

    if (ref.mode === 'scale') {
      const m = ref.members[0];                     // SCALE is single-selection only
      const p = m && this.parts.get(m.id);
      if (!p) return [];
      const s = this._proxy.scale;
      const trs = {
        translateMM: { x: m.t0.x, y: m.t0.y, z: m.t0.z },
        rotateDeg:   { ...m.r0 },
        scale:       { x: s.x, y: s.y, z: s.z },
      };
      const c = this._unitPivot(p, this._matrixFromTrs(trs));   // where the centre landed
      trs.translateMM.x += ref.P0.x - c.x;
      trs.translateMM.y += ref.P0.y - c.y;
      trs.translateMM.z += ref.P0.z - c.z;
      return [{ id: m.id, trs }];
    }

    const d = this._proxy.position.clone().sub(ref.P0);
    const out = [];
    for (const m of ref.members) {
      if (!this.parts.get(m.id)) continue;
      out.push({ id: m.id, trs: {
        translateMM: { x: m.t0.x + d.x, y: m.t0.y + d.y, z: m.t0.z + d.z },
        rotateDeg:   { ...m.r0 },
        scale:       { x: m.s0.x, y: m.s0.y, z: m.s0.z },
      } });
    }
    return out;
  }
  /** Park the proxy on the selection. ONE part → its own pivot + its rotation
   *  and scale (the Wave-4 behaviour, so SCALE's local axes stay the part's).
   *  SEVERAL → the combined centre, unrotated and unscaled: a group rotate is a
   *  world-space delta and a group scale is refused outright. */
  _writeProxyFromSelection() {
    if (this._selection.length === 1) {
      const p = this.parts.get(this._selection[0]);
      if (p) { this._writeProxyFromPart(p); return; }
    }
    this._proxy.position.copy(this._selectionPivot());
    this._proxy.quaternion.identity();
    this._proxy.scale.set(1, 1, 1);
    this._proxy.updateMatrixWorld(true);
  }
  /** Park the proxy on one part: position = pivot P, rotation/scale = the TRS. */
  _writeProxyFromPart(p) {
    const { rotateDeg: r, scale: s } = this._trsOf(p);
    const D = Math.PI / 180;
    const P = this._unitPivot(p);
    this._proxy.position.copy(P);
    this._proxy.quaternion.setFromEuler(new THREE.Euler(r.x * D, r.y * D, r.z * D, 'ZYX'));
    this._proxy.scale.set(s.x, s.y, s.z);
    this._proxy.updateMatrixWorld(true);
  }
  /** Re-seat the proxy on the selection (skipped mid-drag: the gizmo owns it). */
  _syncProxy() {
    if (!this._gizmoActive || !this._selection.length || this._dragRef) return;
    this._writeProxyFromSelection();
  }
  /** Snapshot the shared pivot + every member's pose: what the drag measures. */
  _captureDragRef() {
    if (!this._selection.length) { this._dragRef = null; return; }
    const D = Math.PI / 180;
    const members = [];
    for (const id of this._selection) {
      const p = this.parts.get(id);
      if (!p) continue;
      const { translateMM: t, rotateDeg: r, scale: s } = this._trsOf(p);
      members.push({
        id,
        t0: new THREE.Vector3(t.x, t.y, t.z),
        r0: { ...r },
        s0: new THREE.Vector3(s.x, s.y, s.z),
        q0: new THREE.Quaternion().setFromEuler(new THREE.Euler(r.x * D, r.y * D, r.z * D, 'ZYX')),
        M0: this._ownMatrix(p),
      });
    }
    if (!members.length) { this._dragRef = null; return; }
    this._dragRef = {
      mode: this.gizmo.mode,
      // P0 IS where the proxy sits — one pivot, shared by every member.
      P0: this._proxy.position.clone(),
      pq0: this._proxy.quaternion.clone(),
      members,
    };
  }
  startGizmo(mode) {
    if (!this._selection.length) return;
    this._layFlatArmed = false;
    this._writeProxyFromSelection();
    let want = mode || 'translate';
    if (want === 'scale' && this._selection.length > 1) want = 'translate';
    this.gizmo.mode = want;
    this.gizmo.space = want === 'scale' ? 'local' : 'world';
    this.gizmo.attach(this._proxy);
    this._gizmoActive = true;
  }
  setGizmoMode(mode) {
    if (!this._selection.length) return;
    if (mode === 'scale' && this._selection.length > 1) return;   // group scale is a shear
    if (!this._gizmoActive) { this.startGizmo(mode); return; }
    // Already active: re-seat the proxy on the committed pose before switching
    // modes (corrects a proxy left stale by an external TRS change — transform
    // panel / lay-flat — on a selected part).
    this._writeProxyFromSelection();
    // SCALE is local-axis ONLY: scaling a rotated body along world axes is a
    // shear, which the canonical T·Rz·Ry·Rx·S chain cannot represent.
    this.gizmo.space = mode === 'scale' ? 'local' : 'world';
    this.gizmo.mode = mode;
  }
  stopGizmo() {
    if (this.gizmo) this.gizmo.detach();
    this._gizmoActive = false;
    this._dragRef = null;
  }

  // ── Gizmo palette (no red, no yellow — ANVIL house rule) ─────────────
  // TransformControls ships red/green/blue axes and stamps a hardcoded YELLOW
  // onto the hovered/dragged handle every frame, from inside
  // TransformControlsGizmo.updateMatrixWorld. Two passes make the remap stick:
  //
  //   1. Rewrite every base material colour AND the `_color` snapshot the
  //      control restores from each frame (r170 caches it lazily on first
  //      update, so pre-seeding it means the old hue can never come back).
  //      The rotate E ring is the ONE base-yellow material — it goes neutral,
  //      which leaves 0xffff00 meaning "highlight" and nothing else.
  //   2. Wrap that same updateMatrixWorld and translate the highlight into a
  //      whitened tint of the handle's own axis colour, so hovering brightens
  //      the handle without throwing away which axis it is.
  //
  // Handles share materials (matRed drives the X arrow AND the YZ quad), so the
  // sweep is keyed on the material, not the mesh.
  _recolorGizmo() {
    const root = this.gizmo && this.gizmo.getHelper();
    if (!root) return;
    const REMAP = new Map([
      [0xff0000, AX_X], [0x00ff00, AX_Y], [0x0000ff, AX_Z], [GIZ_YELLOW, AX_HUB],
    ]);
    const seen = new Set();
    root.traverse((o) => {
      const mats = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
      for (const m of mats) {
        if (!m || !m.color || seen.has(m)) continue;
        seen.add(m);
        const to = REMAP.get(m.color.getHex());
        if (to != null) m.color.setHex(to);
        if (m._color) m._color.copy(m.color); else m._color = m.color.clone();   // restore snapshot
        m.userData.axHi = whiten(m.color, GIZ_HI_MIX);
      }
    });

    const gz = root.children.find((c) => c.isTransformControlsGizmo);
    if (!gz || gz.userData._axPatched) return;
    gz.userData._axPatched = true;
    const inner = gz.updateMatrixWorld.bind(gz);
    gz.updateMatrixWorld = (force) => {
      inner(force);
      // Only an active axis gets highlighted, so this is a no-op the rest of
      // the time (and pickers are invisible — recolouring them costs nothing).
      if (!this.gizmo.enabled || !this.gizmo.axis) return;
      gz.traverse((o) => {
        const m = o.material;
        if (m && m.color && m.userData.axHi && m.color.getHex() === GIZ_YELLOW) m.color.copy(m.userData.axHi);
      });
    };
  }
  isGizmoActive() { return this._gizmoActive; }
  gizmoMode() { return this._gizmoActive ? this.gizmo.mode : null; }

  // ══ Wave-2 · Lay flat ════════════════════════════════════════════════
  armLayFlat() {
    if (!this._selectedId) return;
    this.stopGizmo();          // gizmo off during the one-shot face pick
    this._yieldOpenPick();     // …and OPEN FACES gives the quads up
    this._layFlatArmed = true;
    this._syncFaceQuads();     // detected flat faces become clickable targets
  }
  cancelLayFlat() { this._layFlatArmed = false; this._syncFaceQuads(); }
  isLayFlatArmed() { return this._layFlatArmed; }

  // ══ SHELL · OPEN FACES ═══════════════════════════════════════════════
  // A multi-select over the SAME flat-face quads SECTION and LAY FLAT pick from.
  // Exactly one of the three may be armed, so arming here cancels the other two
  // (and they cancel this, through _yieldOpenPick) — a click on a quad then has
  // exactly one meaning. The SET outlives the arm: toggling PICK off and on again
  // brings the same faces back, which is what makes it a parameter of the tool
  // rather than a gesture.

  /** Arm the pick on `id` (defaults to the primary). Returns whether it armed. */
  armOpenFacePick(id) {
    const want = id || this._selectedId;
    if (!want) return false;
    if (this._layFlatArmed) {                    // LAY FLAT gives up the quads
      this._layFlatArmed = false;
      this.onLayFlat?.(this._selectedId, null);  // null trs = "cancelled", not a move
    }
    if (this._section.enabled) this.setSection(false);   // → onSectionChange un-toggles the chip
    if (want !== this._openPickId) this._openFaces.clear();
    this._openPickId = want;
    this._openPick = true;
    this._secQuadsFrozen = false;
    this._syncFaceQuads();
    return true;
  }
  cancelOpenFacePick() {
    if (!this._openPick) return;
    this._openPick = false;
    this._syncFaceQuads();
  }
  isOpenFacePickArmed() { return this._openPick; }
  /** The picked faces, as stable ids (a copy). */
  openFaceIds() { return [...this._openFaces]; }
  clearOpenFaces() {
    if (!this._openFaces.size) return;
    this._openFaces.clear();
    this._syncFaceQuads();
  }
  /** Hand the quads to SECTION / LAY FLAT / the gizmo, keeping the SET intact. */
  _yieldOpenPick() {
    if (!this._openPick) return;
    this._openPick = false;
    this.onQuadArmerCancel?.();
  }

  /**
   * The op payload for ONE picked face, read off the CURRENT pose: centre,
   * outward unit normal, orthonormal in-plane axes and half-extents, all in the
   * world frame — which is the frame the worker sees after it bakes the part's
   * TRS, so no conversion is needed on either side. Null if that face is no
   * longer detected (the part changed under the pick).
   */
  getFaceQuadData(quadId) {
    const f = this._facesFor(this._openPickId || this._selectedId).find((x) => x.id === quadId);
    if (!f) return null;
    return {
      centerMM:   { x: f.center.x, y: f.center.y, z: f.center.z },
      normalUnit: { x: f.normal.x, y: f.normal.y, z: f.normal.z },
      axisUMM:    { x: f.u.x, y: f.u.y, z: f.u.z },
      axisVMM:    { x: f.v.x, y: f.v.y, z: f.v.z },
      halfUMM: f.w / 2,
      halfVMM: f.h / 2,
    };
  }
  // Raycast the selected mesh AND its linked ghosts (they are ONE body — a face
  // picked on a ghost lays the whole unit down), then hand the hit's world face
  // normal to the shared solver. Returns a TRS for the HOST (or null on a miss).
  computeLayFlat(id, cx, cy) {
    const p = id ? this.parts.get(id) : null;
    if (!p || !p.mesh || !p.mesh.visible) return null;
    const meshes = this._unitMeshes(p).map((u) => u.mesh).filter((m) => m.visible);
    this._raycaster.setFromCamera(this._ndcFromClient(cx, cy), this.camera);
    const hits = this._raycaster.intersectObjects(meshes, false);
    if (!hits.length || !hits[0].face) return null;
    const nWorld = hits[0].face.normal.clone()
      .applyMatrix3(new THREE.Matrix3().getNormalMatrix(hits[0].object.matrixWorld)).normalize();
    return this._layFlatFromNormal(p, nWorld);
  }
  /** Same solver, fed a detected planar-cluster normal instead of a ray hit. */
  computeLayFlatFromNormal(id, nWorld) {
    const p = id ? this.parts.get(id) : null;
    if (!p || !p.mesh || !p.mesh.visible) return null;
    return this._layFlatFromNormal(p, new THREE.Vector3().copy(nWorld).normalize());
  }
  // Spin the given world face normal onto −UP ABOUT THE UNIT'S PIVOT (same math
  // as a gizmo rotate — the part turns in place instead of orbiting the TRS
  // origin), then drop the unit onto the plate. The plate plane stays put.
  _layFlatFromNormal(p, nWorld) {
    const dq = new THREE.Quaternion().setFromUnitVectors(nWorld, this._up.clone().negate());
    const { translateMM: t0, rotateDeg: r, scale: s } = this._trsOf(p);
    const D = Math.PI / 180, R2D = 180 / Math.PI;
    const q0 = new THREE.Quaternion().setFromEuler(new THREE.Euler(r.x * D, r.y * D, r.z * D, 'ZYX'));
    const qNew = dq.clone().multiply(q0);   // world-space: lay-flat spin AFTER the current rotation
    const eNew = new THREE.Euler().setFromQuaternion(qNew, 'ZYX');

    const P0 = this._unitPivot(p);
    const t = new THREE.Vector3(t0.x, t0.y, t0.z).sub(P0).applyQuaternion(dq).add(P0);
    return this._groundTrs(p, {
      translateMM: { x: t.x, y: t.y, z: t.z },
      rotateDeg:   { x: eNew.x * R2D, y: eNew.y * R2D, z: eNew.z * R2D },
      scale:       { x: s.x, y: s.y, z: s.z },
    });
  }

  // ══ Wave-4/6 · Freeform plate drag ═══════════════════════════════════
  // Grab ANY selected part (or one of its linked ghosts) anywhere on its surface
  // and slide the WHOLE selection across the plate. The drag rides the plane
  // NORMAL TO UP through the grab point, so the height along UP never changes —
  // lifting off the bed needs the gizmo arrow. Arms only on the selection, so a
  // click on an unselected part still selects it.

  /** Nearest visible part under the pointer, if it belongs to ANY selected unit.
   *  Carries `pid` — which selected part's unit was actually grabbed. */
  _unitHit(cx, cy) {
    if (!this._selection.length) return null;
    const owner = new Map();   // mesh.id -> the SELECTED part id whose unit it belongs to
    for (const id of this._selection) {
      const p = this.parts.get(id);
      if (!p || !p.mesh.visible) continue;
      for (const u of this._unitMeshes(p)) owner.set(u.mesh.id, id);
    }
    if (!owner.size) return null;
    this._raycaster.setFromCamera(this._ndcFromClient(cx, cy), this.camera);
    const meshes = [];
    for (const q of this.parts.values()) if (q.mesh.visible) meshes.push(q.mesh);
    const hits = this._raycaster.intersectObjects(meshes, false);
    if (!hits.length) return null;
    const pid = owner.get(hits[0].object.id);
    if (!pid) return null;                       // something unselected is in front
    hits[0].pid = pid;
    return hits[0];
  }
  _beginPlateDrag(e, hit) {
    const members = [];
    for (const id of this._selection) {
      const p = this.parts.get(id);
      if (!p) continue;
      const trs = this._trsOf(p);
      members.push({ id, t0: trs.translateMM, r0: trs.rotateDeg, s0: trs.scale });
    }
    if (!members.length) return;
    this._plate = {
      id: hit.pid || this._selectedId, members, p0: hit.point.clone(),
      x0: e.clientX, y0: e.clientY, moved: false, last: null,
    };
    this.controls.enabled = false;
    this.onDragChange?.(true);
    document.body.classList.add('plate-dragging');
    try { this.renderer.domElement.setPointerCapture(e.pointerId); } catch { /* container listeners still fire */ }
  }
  _platePoint(cx, cy) {
    const d = this._plate;
    if (!d) return null;
    this._raycaster.setFromCamera(this._ndcFromClient(cx, cy), this.camera);
    // Plane normal to UP through the grab point.
    const plane = new THREE.Plane(this._up.clone(), -this._upCoord(d.p0));
    const out = new THREE.Vector3();
    return this._raycaster.ray.intersectPlane(plane, out) ? out : null;   // null = looking down the plane
  }
  _updatePlateDrag(e) {
    const d = this._plate;
    if (!d) return;
    if (!d.moved && Math.hypot(e.clientX - d.x0, e.clientY - d.y0) > SELECT_DRAG_PX) d.moved = true;
    if (!d.moved) return;
    const q = this._platePoint(e.clientX, e.clientY);
    if (!q) return;
    // q and p0 both lie in the plane, so q − p0 is perpendicular to UP by
    // construction: the height along UP is untouched without special-casing it.
    // ONE delta, every selected member.
    const dx = q.x - d.p0.x, dy = q.y - d.p0.y, dz = q.z - d.p0.z;
    d.last = d.members.map((m) => ({
      id: m.id,
      trs: {
        translateMM: { x: m.t0.x + dx, y: m.t0.y + dy, z: m.t0.z + dz },
        rotateDeg: { ...m.r0 }, scale: { ...m.s0 },
      },
    }));
    this.onTransformLive?.(d.last);
  }
  _endPlateDrag(e) {
    const d = this._plate;
    this._plate = null;
    this.controls.enabled = true;
    this.onDragChange?.(false);
    document.body.classList.remove('plate-dragging');
    try { this.renderer.domElement.releasePointerCapture(e.pointerId); } catch { /* nothing captured */ }
    if (!d) return;
    if (d.moved && d.last) { this.onTransformCommit?.(d.last); this._syncProxy(); }
    // A click, not a drag: hand the grabbed part back with the modifier state, so
    // Ctrl/Shift-clicking an already-selected part can still TOGGLE it out.
    else this.onPick?.(d.id, { ctrl: !!(e.ctrlKey || e.metaKey), shift: !!e.shiftKey });
  }

  // ══ Wave-5 · Orientation widget (2nd scene + ortho, drawn inside _tick) ══
  // ONE widget in the top-right corner carries everything orientation:
  //   · the labelled view cube (6 canvas textures, relabelled per display frame),
  //   · the world-axis triad (X/Y/Z arrows + sprite letters) hung off a corner —
  //     the bottom-left overlay it replaces is gone,
  //   · 26 invisible pick zones (6 faces · 12 edges · 8 corners) that light up
  //     translucent gray under the cursor and snap the camera when clicked.
  // Still ONE rAF: _tick renders it through a scissor slice, exactly as before.
  _initViewCube() {
    const scene = new THREE.Scene();
    const cam = new THREE.OrthographicCamera(
      -CUBE_ORTHO, CUBE_ORTHO, CUBE_ORTHO, -CUBE_ORTHO, 0.1, 100);
    cam.position.set(0, 0, CUBE_CAM_DIST);
    cam.up.set(0, 1, 0);
    cam.lookAt(0, 0, 0);
    const mats = CUBE_FACES.map(() => new THREE.MeshBasicMaterial());
    const e = CUBE_HALF * 2;
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(e, e, e), mats);
    scene.add(mesh);
    this._cube = { scene, camera: cam, mesh, zones: new Map(), axes: null, hover: null };
    this._buildCubeZones();
    this._buildCubeAxes();
    this._relabelCube();
  }

  // The 26 hover zones, keyed by their sign signature — "1,0,0" = the +X face,
  // "1,1,0" = the +X/+Y edge, "1,1,1" = the corner they share. Sizes MIRROR
  // _cubeZoneAt's classification (band m = CUBE_ZONE·H, inner half-span τ =
  // H − m), so what lights up is exactly what a click would snap to:
  //   face   plate  2τ × 2τ, 0.02 thick, floated 0.01 off the face
  //   edge   slab   (m+0.02)² across the two faces, 2τ along the edge
  //   corner cubelet (m+0.02)³
  // They are never raycast (the cursor is classified from the cube mesh itself)
  // and share one material — only ever one is visible.
  _buildCubeZones() {
    const H = CUBE_HALF, m = H * CUBE_ZONE, tau = H - m;
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const mat = new THREE.MeshBasicMaterial({
      color: CUBE_HI, transparent: true, opacity: 0.35,
      depthTest: false, depthWrite: false,   // reads on top of the cube face
    });
    this._cube.zoneGeo = geo;
    this._cube.zoneMat = mat;
    for (let i = 0; i < 27; i++) {
      const v = [(i % 3) - 1, ((i / 3) | 0) % 3 - 1, ((i / 9) | 0) - 1];
      const k = (v[0] ? 1 : 0) + (v[1] ? 1 : 0) + (v[2] ? 1 : 0);
      if (!k) continue;                        // (0,0,0) is the cube's inside
      const z = new THREE.Mesh(geo, mat);
      for (let a = 0; a < 3; a++) {
        if (!v[a]) { z.scale.setComponent(a, tau * 2); z.position.setComponent(a, 0); }
        else if (k === 1) { z.scale.setComponent(a, 0.02); z.position.setComponent(a, v[a] * (H + 0.01)); }
        else { z.scale.setComponent(a, m + 0.02); z.position.setComponent(a, v[a] * (H - m / 2)); }
      }
      z.visible = false;
      z.renderOrder = 1;                       // over the cube, under the triad
      this._cube.scene.add(z);
      this._cube.zones.set(v.join(','), z);
    }
  }

  // World-axis triad, hung off ONE corner so the widget reads as a cube with an
  // origin corner. The ARROWS are world-fixed by definition (−X/+Y/+Z, always,
  // in the view-cube palette — see the −X note below) — only the HUB moves with
  // the display frame, to the NEAR bottom corner, FRONT − UP + RIGHT.
  //
  // The design mock anchors its triad at the cube's "front-bottom-LEFT" corner,
  // with x and y running along the two bottom edges that meet there and z up the
  // vertical. What that describes is the corner NEAREST THE VIEWER at the bottom
  // of the silhouette — and it is front-bottom-left in the mock only because the
  // mock's camera sits in the front-LEFT-top octant (its visible faces are Top /
  // Front / Left). ANVIL's HOME is the mirror of that, front-RIGHT-top (Top /
  // Front / Right), so ANVIL's near bottom corner is front-bottom-RIGHT.
  //
  // Anchoring on the mock's literal corner instead was tried and is wrong here:
  // from HOME that corner scores −0.8 against the camera direction (the near one
  // scores +1.2), i.e. it is a FAR corner, so the triad gets drawn back across
  // the silhouette and straight over the "Front" label. Same corner, mirrored
  // camera, opposite result. This anchoring is the mock's intent — bottom
  // corner, arrows tracing the cube's edges, z up the vertical — reproduced
  // under ANVIL's own HOME.
  //
  // From it, in '+z': +Y traces the bottom-right edge, +Z runs up the near
  // vertical edge, and the x arrow runs back along the bottom edge (see below).
  //
  // The X ARROW IS DRAWN TOWARD −X — DELIBERATE, at the user's request. Do not
  // "fix" it back to +X. The hub is unchanged; only the arrow (shaft, head and
  // the `x` glyph) is mirrored, so instead of leaving the cube outward to the
  // right it traces the cube's bottom edge the other way, and all three arrows
  // now run along cube edges. The hub itself is still named in DISPLAY terms, so
  // this re-parks on setUpAxis exactly like y and z do.
  _buildCubeAxes() {
    if (!this._arrowGeo) this._arrowGeo = makeArrowGeometry();
    const g = new THREE.Group();
    const Z = new THREE.Vector3(0, 0, 1);
    const spec = [
      { dir: new THREE.Vector3(-1, 0, 0), col: CUBE_AX_X, ch: 'x' },   // −X per user request
      { dir: new THREE.Vector3(0, 1, 0), col: CUBE_AX_Y, ch: 'y' },
      { dir: new THREE.Vector3(0, 0, 1), col: CUBE_AX_Z, ch: 'z' },
    ];
    for (const a of spec) {
      const mat = new THREE.MeshBasicMaterial({ color: a.col, depthTest: false, depthWrite: false });
      const q = new THREE.Quaternion().setFromUnitVectors(Z, a.dir);
      for (const geo of [this._arrowGeo.shaft, this._arrowGeo.head]) {
        const m = new THREE.Mesh(geo, mat);
        m.quaternion.copy(q);
        // xy fattened against z: a uniformly-scaled unit arrow is sub-pixel at
        // this widget size. The fattening eases off as the widget grows (2.6 at
        // 78 px, 2.3 at 96 px) — the shafts read as lines again instead of bars.
        m.scale.set(CUBE_AX_LEN * CUBE_AX_FAT, CUBE_AX_LEN * CUBE_AX_FAT, CUBE_AX_LEN);
        m.frustumCulled = false;
        m.renderOrder = 2;
        g.add(m);
      }
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({
        map: makeGlyphTexture(a.ch, a.col), depthTest: false, depthWrite: false, transparent: true,
      }));
      sp.position.copy(a.dir).multiplyScalar(CUBE_AX_GLYPH);
      sp.scale.setScalar(CUBE_AX_GLYPH_PX);
      sp.renderOrder = 3;
      g.add(sp);
    }
    const hub = new THREE.Mesh(new THREE.SphereGeometry(0.055, 12, 10),
      new THREE.MeshBasicMaterial({ color: AX_HUB, depthTest: false, depthWrite: false }));
    hub.renderOrder = 2;
    g.add(hub);
    this._cube.scene.add(g);
    this._cube.axes = g;
    this._placeCubeAxes();
  }
  /** Park the triad hub on the display frame's NEAR bottom cube corner. */
  _placeCubeAxes() {
    if (!this._cube || !this._cube.axes) return;
    this._cube.axes.position.copy(this._front).sub(this._up).add(this._right)
      .multiplyScalar(CUBE_HALF);
  }

  // Per-face LABEL and glyph rotation, DERIVED from the UP/FRONT/RIGHT trio so
  // all four modes are correct by construction instead of by a hand-typed table.
  //
  //   label: the face whose outward normal is UP is TOP, −UP BOTTOM, FRONT
  //          FRONT, −FRONT BACK, RIGHT RIGHT, −RIGHT LEFT.
  //   rot:   with (R, U) = the world directions of the face's texture-right /
  //          texture-up (CUBE_FACES) and T = the screen-up its snap parks on,
  //          the canvas rotation is a = atan2(R·T, U·T) — the spin that levels
  //          the glyph baseline with that screen-up.
  //   T:     UP for every side face. TOP and BOTTOM are the pole snaps: a TOP
  //          view must keep FRONT at the BOTTOM of the screen, so T = −FRONT,
  //          and BOTTOM mirrors it with T = +FRONT. That is exactly what the
  //          POLE_EPS tilt in _snapDir produces, so the labels and the camera
  //          agree without either knowing about the other.
  //
  // Worked results for the reverted table (CUBE_FACES order: +X, −X, +Y, −Y,
  // +Z, −Z). BoxGeometry's authored UVs are a Y-up box, so '+y' — the original
  // frame — needs no glyph spin at all, and '-y' is its 180° roll:
  //   '+y'  RIGHT 0 · LEFT 0 · TOP 0 · BOTTOM 0 · FRONT 0 · BACK 0
  //   '-y'  LEFT π · RIGHT π · BOTTOM π · TOP π · FRONT π · BACK π
  //   '+z'  RIGHT −π/2 · LEFT π/2 · BACK π · FRONT 0 · TOP 0 · BOTTOM π
  //   '-z'  LEFT π/2 · RIGHT −π/2 · BACK 0 · FRONT π · BOTTOM π · TOP 0
  // TOP parks its glyph base toward FRONT (+Z in '+y'): the TOP snap's screen-up
  // is −FRONT, which is exactly the POLE_EPS tilt _snapDir applies.
  _cubeFaceSpec() {
    const U = this._up, F = this._front, R = this._right;
    const v = (a) => new THREE.Vector3().fromArray(a);
    return CUBE_FACES.map((f) => {
      const n = v(f.n);
      const dU = n.dot(U);
      let text, T;
      if (dU > 0.5) { text = 'Top'; T = F.clone().negate(); }
      else if (dU < -0.5) { text = 'Bottom'; T = F.clone(); }
      else {
        T = U.clone();
        const dF = n.dot(F);
        if (dF > 0.5) text = 'Front';
        else if (dF < -0.5) text = 'Back';
        else text = n.dot(R) > 0.5 ? 'Right' : 'Left';
      }
      return { text, rot: Math.atan2(v(f.r).dot(T), v(f.u).dot(T)) };
    });
  }
  /** Re-bake the six face textures for the current display frame, and re-park
   *  the triad hub (its corner is named in display terms). */
  _relabelCube() {
    const cube = this._cube;
    if (!cube) return;
    const spec = this._cubeFaceSpec();
    cube.mesh.material.forEach((m, i) => {
      m.map?.dispose();
      m.map = this._makeCubeFaceTexture(spec[i].text, spec[i].rot);
      m.needsUpdate = true;
    });
    this._placeCubeAxes();
  }
  // `rot` (radians) spins the LABEL inside the face. The label is fitted to
  // CUBE_LABEL_W of the face rather than set at a fixed size — the widget is
  // small enough that a 6-letter "Bottom" at a one-size-fits-all font would be
  // sub-pixel on screen.
  //
  // There is NO stroked frame around a face any more. The old 6px gray
  // strokeRect drew a visible box INSIDE each face, so the cube read as six
  // separate tiles rather than one solid; the mock has none. What replaces it is
  // SHADING: CUBE_FACE_SHADE gives every face a slightly different base value,
  // so each of the three faces visible at once is a different lightness and
  // every silhouette edge reads as a value step — the way a real lit cube
  // separates, and one less line in a HUD that already has plenty.
  _makeCubeFaceTexture(text, rot = 0) {
    const s = 128;
    const cv = document.createElement('canvas');
    cv.width = s; cv.height = s;
    const g = cv.getContext('2d');
    g.fillStyle = CUBE_FACE_SHADE[text] || CUBE_FACE_SHADE.Front;
    g.fillRect(0, 0, s, s);
    g.fillStyle = '#dcdcdc';                 // --fg label
    const font = (px) => `500 ${px}px "Kode Mono", ui-monospace, monospace`;
    let px = 34;
    g.font = font(px);
    const w = g.measureText(text).width;
    if (w > CUBE_LABEL_W) { px = Math.floor(px * CUBE_LABEL_W / w); g.font = font(px); }
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.save();
    g.translate(s / 2, s / 2);
    if (rot) g.rotate(rot);
    g.fillText(text, 0, 1);
    g.restore();
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    return tex;
  }

  _renderViewCube(w, h) {
    const cube = this._cube;
    if (!cube) return;
    const r = this.renderer;
    const dir = this.camera.position.clone().sub(this.controls.target);
    if (dir.lengthSq() < 1e-9) dir.set(0, 0, 1);
    dir.normalize();
    cube.camera.position.copy(dir).multiplyScalar(CUBE_CAM_DIST);
    cube.camera.up.copy(this.camera.up);
    cube.camera.lookAt(0, 0, 0);
    cube.camera.updateMatrixWorld();
    const x = w - CUBE_PX - CUBE_MARGIN;
    const y = h - CUBE_PX - CUBE_MARGIN;   // renderer viewport origin is bottom-left
    r.autoClear = false;
    r.clearDepth();                        // draw the cube over the scene, not behind it
    r.setScissorTest(true);
    r.setScissor(x, y, CUBE_PX, CUBE_PX);
    r.setViewport(x, y, CUBE_PX, CUBE_PX);
    r.render(cube.scene, cube.camera);
    r.setScissorTest(false);
    r.setViewport(0, 0, w, h);
    r.autoClear = true;
  }
  _cubeContains(cx, cy) {
    if (!this._cube) return false;
    const r = this.container.getBoundingClientRect();
    const left = r.right - CUBE_MARGIN - CUBE_PX;
    const top = r.top + CUBE_MARGIN;
    return cx >= left && cx <= left + CUBE_PX && cy >= top && cy <= top + CUBE_PX;
  }

  // Classify a pointer position over the cube rect into one of the 26 zones.
  // ONE raycast, against the SINGLE cube mesh — the hit POINT then says which
  // zone it landed in. With H the half-extent, m = CUBE_ZONE·H the edge band and
  // τ = H − m the inner half-span:
  //
  //   face axis  = the coordinate sitting at ±H (the largest |c|)
  //   every OTHER axis with |c| > τ JOINS the zone
  //
  // 1 axis → face, 2 → edge, 3 → corner, and the snap direction is the
  // normalised sum of the participating face normals:
  //   (1,0,0) · (1,1,0)/√2 · (1,1,1)/√3.
  // Returns { key, dir } (key = the sign signature, e.g. "1,0,-1") or null.
  _cubeZoneAt(cx, cy) {
    const cube = this._cube;
    if (!cube) return null;
    const r = this.container.getBoundingClientRect();
    const left = r.right - CUBE_MARGIN - CUBE_PX;
    const top = r.top + CUBE_MARGIN;
    const nx = ((cx - left) / CUBE_PX) * 2 - 1;
    const ny = -(((cy - top) / CUBE_PX) * 2 - 1);
    this._raycaster.setFromCamera(new THREE.Vector2(nx, ny), cube.camera);
    const hits = this._raycaster.intersectObject(cube.mesh, false);
    if (!hits.length) return null;
    const p = hits[0].point;              // cube sits at the origin, identity matrix
    const c = [p.x, p.y, p.z];
    const tau = CUBE_HALF * (1 - CUBE_ZONE);
    let face = 0;
    for (let i = 1; i < 3; i++) if (Math.abs(c[i]) > Math.abs(c[face])) face = i;
    const v = [0, 0, 0];
    for (let i = 0; i < 3; i++) if (i === face || Math.abs(c[i]) > tau) v[i] = Math.sign(c[i]) || 1;
    return { key: v.join(','), dir: new THREE.Vector3(v[0], v[1], v[2]).normalize() };
  }
  /** Show the hovered zone (and only it). null hides everything. */
  _setCubeHover(zone) {
    const cube = this._cube;
    if (!cube) return;
    const key = zone ? zone.key : null;
    if (cube.hover === key) return;
    if (cube.hover) { const z = cube.zones.get(cube.hover); if (z) z.visible = false; }
    cube.hover = key;
    if (key) { const z = cube.zones.get(key); if (z) z.visible = true; }
  }
  _handleCubeClick(cx, cy) {
    const zone = this._cubeZoneAt(cx, cy);
    if (zone) this._snapToAxis(zone.dir);
  }
  _snapToAxis(dir) {
    const target = this.controls.target.clone();
    const dist = this.camera.position.distanceTo(target) || 1;
    this._cubeAnim = {
      t0: performance.now(), dur: SNAP_MS, target,
      fromPos: this.camera.position.clone(),
      toPos: target.clone().add(this._snapDir(dir).multiplyScalar(dist)),
    };
  }
  /** camera.up is CONSTANT (= UP) in EVERY view, snaps included — nothing in the
   *  viewer ever rewrites it except setUpAxis. A TOP/BOTTOM snap therefore
   *  cannot park exactly on the pole (up ∥ view is a degenerate lookAt), so it
   *  parks a hair off it, tilted toward FRONT.
   *
   *  With dir' = normalise(±UP + ε·FRONT) the screen-up left over is the
   *  component of UP perpendicular to dir', which works out to −FRONT for the
   *  TOP pole and +FRONT for the BOTTOM one: a top view keeps FRONT at the
   *  BOTTOM of the screen (the CAD convention, and what the cube labels assume),
   *  bottom mirrors it, and orbiting away needs no up-vector repair because the
   *  up vector never moved. */
  _snapDir(dir) {
    const d = dir.clone().normalize();
    if (Math.abs(d.dot(this._up)) > 0.999) d.addScaledVector(this._front, POLE_EPS).normalize();
    return d;
  }
  _stepCubeAnim() {
    const a = this._cubeAnim;
    if (!a) return;
    let k = (performance.now() - a.t0) / a.dur;
    const done = k >= 1;
    if (done) k = 1;
    const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;   // easeInOutQuad
    this.camera.position.lerpVectors(a.fromPos, a.toPos, e);
    this.camera.lookAt(a.target);
    if (done) {
      this.controls.target.copy(a.target);
      this.controls.update();   // re-sync OrbitControls' spherical from the pose
      this._cubeAnim = null;
    }
  }

  // ══ Wave-2 · Pointer routing (cube → gizmo → selection) ══════════════
  // Priority is enforced by a capture-phase listener on the CONTAINER (an
  // ancestor of the canvas): a cube-rect pointerdown is stopPropagation()'d so
  // OrbitControls + TransformControls (both on the canvas) never see it. Non-
  // cube events fall through: TransformControls grabs if a handle is hovered
  // (mode 'gizmo'), otherwise OrbitControls orbits and a <4px pointerup selects.
  _initPointer() {
    const c = this.container;
    const st = this._ptr = { downX: 0, downY: 0, moved: false, mode: 'none' };
    const onCanvas = (e) => e.target === this.renderer.domElement;

    c.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) { st.mode = 'none'; return; }
      st.downX = e.clientX; st.downY = e.clientY; st.moved = false;
      if (onCanvas(e) && this._cubeContains(e.clientX, e.clientY)) {
        st.mode = 'cube';
        e.stopPropagation();   // capture phase → canvas listeners never fire
        return;
      }
      if (!onCanvas(e)) { st.mode = 'none'; return; }   // overlay UI (toolbar/view-strip) owns it
      // Section manipulator / triad / face quads outrank the gizmo + selection.
      const sec = this._secPick(e.clientX, e.clientY);
      if (sec) {
        e.stopPropagation();
        if (sec.kind === 'arrow') { st.mode = 'secdrag'; this._beginArrowDrag(e); }
        else { st.mode = 'secpick'; this._secPending = sec; }
        return;
      }
      if (this._layFlatArmed) { st.mode = 'layflat'; return; }
      if (this.gizmo && this.gizmo.axis) { st.mode = 'gizmo'; return; }   // a handle is hovered
      // Grab on the selected unit → freeform plate drag (never on another part).
      const hit = this._unitHit(e.clientX, e.clientY);
      if (hit) { st.mode = 'plate'; e.stopPropagation(); this._beginPlateDrag(e, hit); return; }
      st.mode = 'select';
    }, { capture: true });

    c.addEventListener('pointermove', (e) => {
      if (st.mode === 'secdrag') { e.stopPropagation(); this._updateArrowDrag(e); return; }
      if (st.mode === 'plate') { e.stopPropagation(); this._updatePlateDrag(e); return; }
      // The cube owns its rect, so its hover is checked FIRST and nothing else
      // reacts inside it. One cheap raycast against one mesh, only in-rect.
      const overCube = onCanvas(e) && (st.mode === 'none' || st.mode === 'cube')
        && this._cubeContains(e.clientX, e.clientY);
      this._setCubeHover(overCube ? this._cubeZoneAt(e.clientX, e.clientY) : null);
      if (overCube !== this._cubeCursor) {
        this._cubeCursor = overCube;
        document.body.classList.toggle('cube-pick', overCube);
      }
      if (st.mode === 'none' && overCube) {
        this._setSecHover(null);
        document.body.classList.remove('plate-grab');
      } else if (st.mode === 'none' && onCanvas(e)) {
        // Hover glow on whatever section overlay is under the cursor.
        const h = this._secPick(e.clientX, e.clientY);
        this._setSecHover(h && h.obj ? h.obj : null);
        this._syncGrabCursor(e.clientX, e.clientY);
      }
      if (st.mode === 'none') return;
      if (!st.moved && Math.hypot(e.clientX - st.downX, e.clientY - st.downY) > SELECT_DRAG_PX) st.moved = true;
    }, { capture: true });

    // DOUBLE click = FOCUS, and it is the ONLY pointer path in the viewer that
    // moves the camera. A plain click selects and nothing else — the view must
    // not lurch every time the user picks something to look at. The dblclick
    // arrives AFTER the two pointerup selects it implies; those are idempotent
    // (the part ends up selected either way), so they need no suppression and
    // the <4px click-select guard is left exactly as it is.
    c.addEventListener('dblclick', (e) => {
      if (!onCanvas(e)) return;
      if (this._cubeContains(e.clientX, e.clientY)) return;   // the cube owns its rect
      const id = this._pickPart(e.clientX, e.clientY);
      if (!id) return;                                        // empty space: no focus, no move
      e.stopPropagation();
      this.onFocus?.(id);
    }, { capture: true });

    // Leaving the viewport drops the cube highlight (no stuck gray zone).
    c.addEventListener('pointerleave', () => {
      this._setCubeHover(null);
      if (this._cubeCursor) { this._cubeCursor = false; document.body.classList.remove('cube-pick'); }
    });

    c.addEventListener('pointerup', (e) => {
      const mode = st.mode;
      st.mode = 'none';
      if (mode === 'secdrag') { e.stopPropagation(); this._endArrowDrag(e); return; }
      if (mode === 'plate') { e.stopPropagation(); this._endPlateDrag(e); return; }
      if (mode === 'secpick') {
        e.stopPropagation();
        const pending = this._secPending;
        this._secPending = null;
        if (st.moved || !pending) return;
        if (pending.kind === 'triad') { this.pickAxisPlane(pending.axis); return; }
        const f = pending.face;
        if (!f) return;
        if (this._openPick) {                           // OPEN FACES owns the click
          // A multi-select, so the click TOGGLES rather than consuming the arm:
          // the mode stays live until the tool (or another armer) takes it back.
          if (this._openFaces.has(f.id)) this._openFaces.delete(f.id);
          else this._openFaces.add(f.id);
          this._syncFaceQuads();
          this.onOpenFacesChange?.(this.openFaceIds());
        } else if (this._layFlatArmed) {                // LAY FLAT owns the click
          const trs = this.computeLayFlatFromNormal(this._selectedId, f.normal);
          this._layFlatArmed = false;
          this.onLayFlat?.(this._selectedId, trs);
        } else {
          this.pickFacePlane(f.normal, f.center);       // section from this face
        }
        return;
      }
      if (mode === 'cube') {
        e.stopPropagation();
        if (!st.moved && this._cubeContains(e.clientX, e.clientY)) this._handleCubeClick(e.clientX, e.clientY);
        return;
      }
      if (mode === 'layflat') {
        const trs = this.computeLayFlat(this._selectedId, e.clientX, e.clientY);
        this._layFlatArmed = false;
        this.onLayFlat?.(this._selectedId, trs);   // trs null → main cancels the arm
        return;
      }
      if (mode === 'select') {
        if (st.moved) return;                            // drag = orbit, not a click
        if (this.gizmo && this.gizmo.dragging) return;   // a gizmo grab just ended here
        // id or null (empty click clears). Ctrl (primary) and Shift both TOGGLE
        // membership — main.js decides what that means for the selection set.
        this.onPick?.(this._pickPart(e.clientX, e.clientY),
          { ctrl: !!(e.ctrlKey || e.metaKey), shift: !!e.shiftKey });
      }
      // mode 'gizmo' → TransformControls owned it; commit fired via dragging-changed
    }, { capture: true });

    // Alt+wheel over the canvas nudges the section OFFSET (±0.5 mm/notch, Shift
    // ±0.1 mm). preventDefault ONLY while a section plane is live AND Alt is
    // held, so a plain wheel keeps orbit-zoom.
    this.renderer.domElement.addEventListener('wheel', (e) => {
      if (!this._sectionActive() || !e.altKey) return;
      e.preventDefault();
      const step = e.shiftKey ? 0.1 : 0.5;
      this.nudgeSectionOffset(e.deltaY < 0 ? step : -step);
    }, { passive: false });
  }

  // "You can grab this" affordance over the selected unit. LAY FLAT owns the
  // cursor while armed (crosshair), and a hovered gizmo handle owns it too.
  _syncGrabCursor(cx, cy) {
    const want = !!this._selectedId && !this._layFlatArmed && !this._openPick
      && !(this.gizmo && this.gizmo.axis) && !!this._unitHit(cx, cy);
    document.body.classList.toggle('plate-grab', want);
  }

  // ══ Wave-2 · EULER round-trip self-test ══════════════════════════════
  // Proves the hand chain M = T·Rz·Ry·Rx·S equals compose(T, Euler'ZYX', S) and
  // that decompose→Euler'ZYX'→deg round-trips a nontrivial TRS, BEFORE the gizmo
  // ever writes a transform. Gated behind EULER_SELFTEST; also callable ad hoc.
  _selfTestEuler() {
    const D = Math.PI / 180, R2D = 180 / Math.PI;
    const t = { x: 13, y: -27, z: 41 }, r = { x: 31, y: -52, z: 74 }, s = { x: 1.3, y: 0.7, z: 1.9 };
    const hand = new THREE.Matrix4().makeScale(s.x, s.y, s.z);
    hand.premultiply(new THREE.Matrix4().makeRotationX(r.x * D));
    hand.premultiply(new THREE.Matrix4().makeRotationY(r.y * D));
    hand.premultiply(new THREE.Matrix4().makeRotationZ(r.z * D));
    hand.premultiply(new THREE.Matrix4().makeTranslation(t.x, t.y, t.z));
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(r.x * D, r.y * D, r.z * D, 'ZYX'));
    const proxy = new THREE.Matrix4().compose(
      new THREE.Vector3(t.x, t.y, t.z), q, new THREE.Vector3(s.x, s.y, s.z));
    let maxErr = 0;
    for (let i = 0; i < 16; i++) maxErr = Math.max(maxErr, Math.abs(hand.elements[i] - proxy.elements[i]));
    const dp = new THREE.Vector3(), dq = new THREE.Quaternion(), ds = new THREE.Vector3();
    proxy.decompose(dp, dq, ds);
    const de = new THREE.Euler().setFromQuaternion(dq, 'ZYX');
    const rtErr = Math.max(Math.abs(de.x * R2D - r.x), Math.abs(de.y * R2D - r.y), Math.abs(de.z * R2D - r.z));
    const pass = maxErr < 1e-6 && rtErr < 1e-6;
    console.log(`[anvil] EULER round-trip self-test: ${pass ? 'PASS' : 'FAIL'} · matrixMaxErr=${maxErr.toExponential(3)} · rotRoundTripErrDeg=${rtErr.toExponential(3)}`);
    console.log('[anvil]   hand  M =', Array.from(hand.elements, (n) => +n.toFixed(6)));
    console.log('[anvil]   proxy M =', Array.from(proxy.elements, (n) => +n.toFixed(6)));
    return { pass, maxErr, rtErr };
  }

  // ══ Wave-4 · PIVOT round-trip self-test ══════════════════════════════
  // Proves the rotate-about-P decomposition: the TRS this viewer emits, when
  // re-composed through the canonical hand chain, equals T(P)·R(Δq)·T(−P)·M0
  // element-for-element. Run before trusting the gizmo with a rotation.
  _selfTestPivot() {
    const D = Math.PI / 180, R2D = 180 / Math.PI;
    const t0 = { x: 13, y: -27, z: 41 }, r0 = { x: 31, y: -52, z: 74 }, s0 = { x: 1.3, y: 0.7, z: 1.9 };
    const P0 = new THREE.Vector3(-8.5, 22.25, 6.75);
    const M0 = this._matrixFromTrs({ translateMM: t0, rotateDeg: r0, scale: s0 });
    const q0 = new THREE.Quaternion().setFromEuler(new THREE.Euler(r0.x * D, r0.y * D, r0.z * D, 'ZYX'));
    // An arbitrary world-space delta rotation, exactly as a gizmo drag produces.
    const dq = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0.37, -0.66, 0.65).normalize(), 0.7431);

    // Reference: rotate M0 about the world point P0.
    const ref = new THREE.Matrix4().makeTranslation(P0.x, P0.y, P0.z)
      .multiply(new THREE.Matrix4().makeRotationFromQuaternion(dq))
      .multiply(new THREE.Matrix4().makeTranslation(-P0.x, -P0.y, -P0.z))
      .multiply(M0);

    // What _readProxyTrs emits for that drag (proxy.quaternion = Δq·q0).
    const qn = dq.clone().multiply(q0);
    const e = new THREE.Euler().setFromQuaternion(qn, 'ZYX');
    const t = new THREE.Vector3(t0.x, t0.y, t0.z).sub(P0).applyQuaternion(dq).add(P0);
    const trs = {
      translateMM: { x: t.x, y: t.y, z: t.z },
      rotateDeg:   { x: e.x * R2D, y: e.y * R2D, z: e.z * R2D },
      scale:       { x: s0.x, y: s0.y, z: s0.z },
    };
    const got = this._matrixFromTrs(trs);   // the worker's chain, from the emitted TRS

    let maxErr = 0;
    for (let i = 0; i < 16; i++) maxErr = Math.max(maxErr, Math.abs(ref.elements[i] - got.elements[i]));
    const pass = maxErr < 1e-6;
    console.log(`[anvil] PIVOT rotate-about-P self-test: ${pass ? 'PASS' : 'FAIL'} · maxElementErr=${maxErr.toExponential(3)}`);
    console.log('[anvil]   emitted TRS =', JSON.stringify(trs));
    return { pass, maxErr, trs };
  }

  // ── internals ───────────────────────────────────────────────────────
  _resize() {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    // updateStyle=true (default): size the canvas ELEMENT to the container too.
    // With updateStyle=false the canvas laid out at its full drawing-buffer size
    // (deviceW×deviceH CSS px) and overflowed the container — the scene rendered
    // off-centre and viewport/scissor overlays (the view cube) landed in the
    // clipped region. Styling the canvas to w×h keeps setViewport in sync with
    // what's visible.
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  _tick() {
    if (!this._running) return;
    // A view-cube snap drives the camera directly, so skip OrbitControls'
    // damping update for those ~250ms (avoids the two fighting).
    if (this._cubeAnim) this._stepCubeAnim();
    else this.controls.update();

    // Section overlays live in the SAME loop (never a 2nd rAF). Writers mirror
    // their source matrices and caps re-seat on the plane; both are O(meshes).
    // Hand-built matrices never raise matrixWorldNeedsUpdate, so both roots are
    // force-flushed here — the renderer's own non-forced pass would skip them.
    if (this._sectionActive()) this._syncCaps();
    this._secStencil.updateMatrixWorld(true);
    this._secOverlay.updateMatrixWorld(true);

    // Live preview rides the SAME loop: it only re-writes its proxy matrix and
    // a handful of uniforms (target TRS, world pivot, section plane, lights).
    this.preview?.sync();

    const w = this.container.clientWidth || 1, h = this.container.clientHeight || 1;
    const r = this.renderer;
    r.setViewport(0, 0, w, h);
    r.setScissorTest(false);
    r.autoClear = true;
    r.render(this.scene, this.camera);

    // Orientation widget — same rAF, a viewport/scissor slice (never a 2nd loop).
    this._renderViewCube(w, h);

    requestAnimationFrame(this._tick);
  }
}

function disposeMesh(mesh) {
  mesh.geometry?.dispose();
  if (Array.isArray(mesh.material)) mesh.material.forEach((m) => m.dispose());
  else mesh.material?.dispose();
}

// Vector3 → a plain {x,y,z} payload, rounded to 1e-6 mm. The rounding matters:
// a 180° rotation leaves 1.2e-16 sines behind, and a centre of 2.4e-15 in a
// primitive request reads as noise in the panel and the op JSON.
function xyzOf(v) {
  const r = (n) => (Math.abs(n) < 1e-9 ? 0 : Math.round(n * 1e6) / 1e6);
  return { x: r(v.x), y: r(v.y), z: r(v.z) };
}

// The server's bbox DTO ({ min:[x,y,z], max:[x,y,z] }, file frame) as a Box3.
// A missing or malformed bbox degrades to a point at the origin rather than to
// three.js' empty box, whose ±Infinity corners would poison every extent below.
function boxFromBbox(b) {
  const lo = b && b.min, hi = b && b.max;
  if (!Array.isArray(lo) || !Array.isArray(hi) || lo.length < 3 || hi.length < 3)
    return new THREE.Box3(new THREE.Vector3(), new THREE.Vector3());
  return new THREE.Box3(
    new THREE.Vector3().fromArray(lo),
    new THREE.Vector3().fromArray(hi),
  );
}

// ══ Wave-3 · SECTION helpers ═══════════════════════════════════════════

// Hatch cap material. MeshBasicMaterial + onBeforeCompile (NOT a raw
// ShaderMaterial) so three.js' colour management and the stencil plumbing come
// for free. World-space 45° stripes in the cut plane: base = the part colour
// dragged 55% toward --card (reads as solid material in shadow), stripes = the
// part colour itself. The result: a cut says "material", never "hole".
function makeHatchMaterial(colorHex, opacity) {
  const src = new THREE.Color(colorHex);
  const base = src.clone().lerp(new THREE.Color(COL_INK), 0.55);
  const line = src.clone().lerp(new THREE.Color(0xffffff), 0.12);
  const mat = new THREE.MeshBasicMaterial({
    color: 0xffffff, side: THREE.DoubleSide,
    transparent: true, opacity, depthWrite: opacity > 0.9,
    stencilWrite: true, stencilRef: 0, stencilFunc: THREE.NotEqualStencilFunc,
    stencilFail: THREE.ReplaceStencilOp, stencilZFail: THREE.ReplaceStencilOp,
    stencilZPass: THREE.ReplaceStencilOp,
  });
  const u = {
    uHatchBase:   { value: base },
    uHatchLine:   { value: line },
    uHatchU:      { value: new THREE.Vector3(1, 0, 0) },
    uHatchV:      { value: new THREE.Vector3(0, 1, 0) },
    uHatchPeriod: { value: SEC_HATCH_MM },
  };
  mat.userData.hatch = u;
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vHatchW;')
      .replace('#include <begin_vertex>',
        '#include <begin_vertex>\n\tvHatchW = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec3 vHatchW;
uniform vec3 uHatchBase;
uniform vec3 uHatchLine;
uniform vec3 uHatchU;
uniform vec3 uHatchV;
uniform float uHatchPeriod;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
{
	float s = ( dot( vHatchW, uHatchU ) + dot( vHatchW, uHatchV ) ) * 0.70710678;
	float g = fract( s / uHatchPeriod );
	float aa = clamp( fwidth( s ) / uHatchPeriod, 0.0015, 0.45 );
	float m = smoothstep( 0.34 + aa, 0.34 - aa, g );
	diffuseColor.rgb = mix( uHatchBase, uHatchLine, m );
}`);
  };
  // Distinct cache key — otherwise three.js hands us a plain MeshBasic program.
  mat.customProgramCacheKey = () => 'anvil-hatch';
  return mat;
}

// Mix a colour toward white IN sRGB. three.js Color.lerp interpolates in the
// linear working space, which desaturates hard — #ff5c00 goes salmon-pink, i.e.
// straight into the red ANVIL bans. Blending the sRGB bytes keeps the hue and
// just brightens it: orange → bright orange, green → bright green.
function whiten(color, k) {
  const hex = color.getHex();   // sRGB
  const up = (c) => Math.round(c + (255 - c) * k);
  return new THREE.Color().setHex(
    (up((hex >> 16) & 255) << 16) | (up((hex >> 8) & 255) << 8) | up(hex & 255));
}

// Single-glyph sprite texture (view-cube triad X/Y/Z letters). Transparent
// background, axis-coloured, drawn upright — sprites always face the camera, so
// the letters stay readable at every orbit angle. Set nearly full-bleed in the
// canvas: at the widget's size the sprite is ~11 px, so every pixel counts.
function makeGlyphTexture(ch, colorHex) {
  const s = 64;
  const cv = document.createElement('canvas');
  cv.width = s; cv.height = s;
  const g = cv.getContext('2d');
  g.fillStyle = '#' + colorHex.toString(16).padStart(6, '0');
  g.font = '700 54px "Kode Mono", ui-monospace, monospace';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(ch, s / 2, s / 2 + 2);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

// Arrow parts authored along +Z (so one quaternion aligns both the arrow and
// the +Z-normal plane quads), unit length, scaled by the manipulator.
function makeArrowGeometry() {
  const shaft = new THREE.CylinderGeometry(0.028, 0.028, 0.72, 12);
  shaft.rotateX(Math.PI / 2); shaft.translate(0, 0, 0.36);
  const head = new THREE.ConeGeometry(0.10, 0.28, 18);
  head.rotateX(Math.PI / 2); head.translate(0, 0, 0.86);
  const picker = new THREE.CylinderGeometry(0.16, 0.16, 1.05, 8);
  picker.rotateX(Math.PI / 2); picker.translate(0, 0, 0.52);
  return { shaft, head, picker };
}

// ── Planar face clustering (shared by SECTION face picks and LAY FLAT) ──
// One pass over world-space triangles: quantise (normal, plane offset) into
// buckets, accumulate area-weighted plane + in-plane extents. Skips meshes
// above FACE_TRI_CAP triangles; callers cache the result per matrixWorld.
function detectPlanarFaces(mesh) {
  const geo = mesh.geometry;
  const pos = geo && geo.getAttribute('position');
  if (!pos) return [];
  const index = geo.getIndex();
  const triCount = (index ? index.count : pos.count) / 3 | 0;
  if (triCount === 0 || triCount > FACE_TRI_CAP) return [];

  const M = mesh.matrixWorld;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const ab = new THREE.Vector3(), ac = new THREE.Vector3(), n = new THREE.Vector3();
  const clusters = new Map();
  let total = 0;

  for (let t = 0; t < triCount; t++) {
    const i0 = index ? index.getX(t * 3) : t * 3;
    const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
    const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;
    a.fromBufferAttribute(pos, i0).applyMatrix4(M);
    b.fromBufferAttribute(pos, i1).applyMatrix4(M);
    c.fromBufferAttribute(pos, i2).applyMatrix4(M);
    ab.subVectors(b, a); ac.subVectors(c, a);
    n.crossVectors(ab, ac);
    const len = n.length();
    if (len < 1e-12) continue;          // degenerate sliver
    const area = len * 0.5;
    total += area;
    n.multiplyScalar(1 / len);
    const off = n.dot(a);
    const key = `${Math.round(n.x / FACE_NORMAL_Q)},${Math.round(n.y / FACE_NORMAL_Q)},`
      + `${Math.round(n.z / FACE_NORMAL_Q)},${Math.round(off / FACE_OFFSET_Q)}`;
    let cl = clusters.get(key);
    if (!cl) {
      // In-plane basis from the first triangle's exact normal — the bucket's
      // normals differ by < FACE_NORMAL_Q, so {u,v,n} stays orthonormal enough.
      const u = (Math.abs(n.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0))
        .cross(n).normalize();
      const v = new THREE.Vector3().crossVectors(n, u).normalize();
      cl = {
        nsum: n.clone().multiplyScalar(area), osum: off * area, area: 0, u, v,
        uMin: Infinity, uMax: -Infinity, vMin: Infinity, vMax: -Infinity,
      };
      clusters.set(key, cl);
    } else {
      cl.nsum.addScaledVector(n, area);
      cl.osum += off * area;
    }
    cl.area += area;
    for (const pt of [a, b, c]) {
      const du = pt.dot(cl.u), dv = pt.dot(cl.v);
      if (du < cl.uMin) cl.uMin = du;
      if (du > cl.uMax) cl.uMax = du;
      if (dv < cl.vMin) cl.vMin = dv;
      if (dv > cl.vMax) cl.vMax = dv;
    }
  }

  const minArea = Math.max(total * FACE_MIN_FRAC, FACE_MIN_AREA);
  const out = [];
  for (const cl of clusters.values()) {
    if (cl.area < minArea) continue;
    const w = cl.uMax - cl.uMin, h = cl.vMax - cl.vMin;
    if (!(w > 1e-4) || !(h > 1e-4)) continue;
    const normal = cl.nsum.clone().normalize();
    const offset = cl.osum / cl.area;
    const center = new THREE.Vector3()
      .addScaledVector(cl.u, (cl.uMin + cl.uMax) / 2)
      .addScaledVector(cl.v, (cl.vMin + cl.vMax) / 2)
      .addScaledVector(normal, offset);
    out.push({ normal, center, u: cl.u, v: cl.v, w, h, area: cl.area });
  }
  out.sort((p, q) => q.area - p.area);
  return out.slice(0, FACE_MAX);
}
