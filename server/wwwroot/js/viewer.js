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

// Wave-2 viewport constants.
const SELECT_DRAG_PX = 4;      // pointer travel under which a pointerup counts as a click
const CUBE_PX = 96;            // view-cube overlay size (top-right corner)
const CUBE_MARGIN = 12;        // px inset of the cube from the viewport corner
const CUBE_CAM_DIST = 3.4;     // orthographic cube camera distance
const SNAP_MS = 250;           // view-cube snap animation duration
// EULER round-trip self-test flag. Flipped true during Stage-4 verification to
// print the hand-chain-vs-proxy matrix proof to the console, then returned to
// false. The method (`_selfTestEuler`) stays available for on-demand re-runs.
const EULER_SELFTEST = false;

// Ghost meshes take their colour from the shared role map (roles.js) so a part's
// 3D preview always matches its sidebar row accent: Part = --primary orange,
// Positive = --green, Negative = --primary orange. Uploaded parts render
// translucent; the generated result is solid light gray (--fg) with a sheen.
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

// Render-order lanes. Stencil writers and caps MUST interleave strictly
// (writers → cap → clearStencil → next mesh), so every section object is forced
// transparent: three.js sorts the transparent list by renderOrder first, which
// is the only way to guarantee that order across several clipped meshes.
const RO_STENCIL = 20;   // + 2·i writers, + 2·i + 1 cap
const RO_RECT    = 200;  // manipulator plane rect / triad / face quads
const RO_ARROW   = 210;  // arrow (depthTest off — always grabbable)

export class Viewer {
  constructor(container) {
    this.container = container;
    this.parts = new Map();   // id -> { mesh, role, visible }
    this.result = null;       // THREE.Mesh | null
    this._volumeHint = null;  // { partId -> volumeMM3 } published by main.js (COM weights)
    this._loader = new STLLoader();

    const scene = new THREE.Scene();
    this.scene = scene;

    const cam = new THREE.PerspectiveCamera(45, 1, 0.1, 5000);
    // Z-up world (PicoGK/CAD convention; the view cube labels +Z TOP and lay-flat
    // rests faces on Z=0). camera.up MUST be set BEFORE OrbitControls is built —
    // the controls snapshot the up vector to derive their spherical orbit basis.
    cam.up.set(0, 0, 1);
    cam.position.set(80, -80, 55);   // front-right-top (−Y is FRONT per the cube)
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

    // Lighting: hemisphere fill + a key directional. Z-up aimed — the key sits
    // high on +Z (front-right) so TOP faces read brightest and the two visible
    // side faces stay distinct; the fill lifts the back-left shadow side.
    this.hemi = new THREE.HemisphereLight(0xffffff, 0x40404a, 1.05);
    this.hemi.position.set(0, 0, 1);   // hemisphere axis is +Z, not +Y
    scene.add(this.hemi);
    this.key = new THREE.DirectionalLight(0xffffff, 1.35);
    this.key.position.set(0.6, -0.5, 1);
    scene.add(this.key);
    this.fill = new THREE.DirectionalLight(0xffffff, 0.4);
    this.fill.position.set(-0.7, 0.5, -0.3);
    scene.add(this.fill);

    // Subtle ground grid (adaptive: repositioned by _updateGrid on each fit).
    this.grid = null;
    this._gridMeta = { size: 0 };

    this._resize();
    this._ro = new ResizeObserver(() => this._resize());
    this._ro.observe(container);

    // ── Wave-2 selection + transform gizmo + view cube ──────────────────
    // Callbacks wired by main.js (viewer stays state-free; main owns app state).
    this.onPick = null;            // (id|null)      → click-select / empty-click clear
    this.onTransformLive = null;   // (id, trs)      → gizmo drag (rebuild only, no fit)
    this.onTransformCommit = null; // (id, trs)      → gizmo drag END (single commit)
    this.onDragChange = null;      // (bool)         → freeze refreshParts while dragging
    this.onLayFlat = null;         // (id, trs|null) → lay-flat one-shot result
    this.onSectionChange = null;   // (sectionState) → HUD readout + chip sync

    this._selectedId = null;
    this._gizmoActive = false;
    this._layFlatArmed = false;
    this._raycaster = new THREE.Raycaster();
    this._cubeAnim = null;

    // Hidden proxy Object3D the gizmo drives: part meshes use matrixAutoUpdate=
    // false hand-built matrices, so TransformControls cannot attach to them.
    // proxy.matrix == the part's TRS matrix M = T·Rz·Ry·Rx·S at all times.
    this._proxy = new THREE.Object3D();
    this._proxy.matrixAutoUpdate = true;
    this._proxy.visible = false;
    scene.add(this._proxy);

    const gizmo = new TransformControls(cam, renderer.domElement);
    gizmo.size = 0.82;
    gizmo.space = 'world';
    this.gizmo = gizmo;
    scene.add(gizmo.getHelper());   // r170: add the helper root, not the control
    gizmo.addEventListener('objectChange', () => {
      if (!this._gizmoActive || !this._selectedId) return;
      this.onTransformLive?.(this._selectedId, this._readProxyTrs());
    });
    gizmo.addEventListener('dragging-changed', (e) => {
      this.controls.enabled = !e.value;
      this.onDragChange?.(e.value);
      if (!e.value && this._selectedId) this.onTransformCommit?.(this._selectedId, this._readProxyTrs());
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

    if (EULER_SELFTEST) { try { this._selfTestEuler(); } catch (err) { console.error('[anvil] euler self-test threw', err); } }

    this._running = true;
    this._tick = this._tick.bind(this);
    requestAnimationFrame(this._tick);
  }

  // ── Parts ───────────────────────────────────────────────────────────
  // opts.solid → the SOLID result look (light gray, opaque, sheen) instead of the
  // translucent role-coloured ghost. A generated lattice is a normal part in every
  // other respect: selectable, gizmo-drivable, section-capped, COM-weighted.
  addPart(id, url, role, opts = {}) {
    const solid = !!opts.solid;
    return new Promise((resolve, reject) => {
      this._loader.load(url, (geometry) => {
        geometry.computeVertexNormals();
        const mat = solid
          ? new THREE.MeshStandardMaterial({
              color: RESULT_COLOR,
              metalness: 0.35,   // slight metallic look
              roughness: 0.45,
              side: THREE.DoubleSide,
            })
          : new THREE.MeshStandardMaterial({
              color: roleColorInt(role),
              metalness: 0.05,
              roughness: 0.65,
              transparent: true,
              opacity: this._dimmed ? DIM_OPACITY : UP_OPACITY,
              depthWrite: false,
              side: THREE.DoubleSide,
            });
        const mesh = new THREE.Mesh(geometry, mat);   // no transform — world coords preserved
        mesh.renderOrder = solid ? 2 : 1;
        mesh.userData._solid = solid;   // the cap builder reads this for full-strength hatch
        if (this._ghostsHidden && !solid) mesh.visible = false;
        this.scene.add(mesh);
        this.parts.set(id, { id, mesh, role, visible: true, solid });
        this._sectionDirty();
        this.fitView();
        resolve();
      }, undefined, (err) => reject(err instanceof Error ? err : new Error('STL load failed')));
    });
  }

  setPartRole(id, role) {
    const p = this.parts.get(id);
    if (!p) return;
    p.role = role;
    if (p.solid) return;   // a solid result keeps RESULT_COLOR whatever its data role says
    p.mesh.material.color.setHex(roleColorInt(role));
    if (id === this._selectedId) this._applySelTint(p);   // keep the emissive glow hued to the new role
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
  setPartTransform(id, trs) {
    const p = this.parts.get(id);
    if (!p) return;
    p.trs = trs || null;
    this._applyPartMatrix(p);
    this._secQuadsFrozen = false;   // commit → re-detect faces at the new pose
    this._syncFaceQuads();
    this.fitView();
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
    this._syncFaceQuads();
    this.fitView();
  }
  /** The part's OWN TRS matrix — M = T·Rz·Ry·Rx·S, no link composition. */
  _ownMatrix(p) {
    const trs = p.trs || {};
    const t = trs.translateMM || { x: 0, y: 0, z: 0 };
    const r = trs.rotateDeg   || { x: 0, y: 0, z: 0 };
    const s = trs.scale       || { x: 1, y: 1, z: 1 };
    const D = Math.PI / 180;
    const m = new THREE.Matrix4().makeScale(s.x || 1, s.y || 1, s.z || 1);
    m.premultiply(new THREE.Matrix4().makeRotationX((r.x || 0) * D));
    m.premultiply(new THREE.Matrix4().makeRotationY((r.y || 0) * D));
    m.premultiply(new THREE.Matrix4().makeRotationZ((r.z || 0) * D));
    m.premultiply(new THREE.Matrix4().makeTranslation(t.x || 0, t.y || 0, t.z || 0));
    return m;
  }
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
    if (id === this._selectedId) { this.stopGizmo(); this._selectedId = null; this._syncFaceQuads(); }
    this.unlinkGhosts(id);   // a removed lattice releases its ghosts…
    if (p.linkHostId) this.parts.get(p.linkHostId)?.links?.delete(id);   // …a removed ghost leaves its host
    this.scene.remove(p.mesh);
    disposeMesh(p.mesh);
    this.parts.delete(id);
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
        mesh.renderOrder = 2;
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

  _makeOverlayQuad(opacity) {
    const m = new THREE.Mesh(this._quadGeo, new THREE.MeshBasicMaterial({
      color: COL_LINE, transparent: true, opacity, side: THREE.DoubleSide,
      depthWrite: false, depthTest: false,
    }));
    m.matrixAutoUpdate = false;
    m.frustumCulled = false;
    m.renderOrder = RO_RECT;
    m.userData.baseOpacity = opacity;
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

  // Face quads: shown on the SELECTED part when SECTION is on (pick a plane) or
  // LAY FLAT is armed (pick a resting face). Same objects, different verb.
  _faceQuadsWanted() {
    if (!this._selectedId || this._secQuadsFrozen) return false;
    return this._layFlatArmed || this._section.enabled;
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
      const quad = this._makeOverlayQuad(0.13);
      quad.userData.secFace = f;
      const q = new THREE.Quaternion().setFromUnitVectors(Z, f.normal);
      const c = f.center.clone().addScaledVector(f.normal, FACE_LIFT_MM);
      quad.matrix.compose(c, q, new THREE.Vector3(f.w, f.h, 1));
      const edge = new THREE.LineSegments(this._edgeGeo, new THREE.LineBasicMaterial({
        color: COL_LINE, transparent: true, opacity: 0.85, depthWrite: false, depthTest: false,
      }));
      edge.matrixAutoUpdate = false;
      edge.matrix.copy(quad.matrix);
      edge.renderOrder = RO_RECT + 1;
      quad.userData.edge = edge;
      this._secOverlay.add(quad, edge);
      this._faceQuads.push(quad);
    }
  }

  /** Planar face clusters of a part in WORLD space (cached per matrixWorld). */
  _facesFor(id) {
    const p = id ? this.parts.get(id) : null;
    if (!p || !p.mesh) return [];
    const key = p.mesh.matrixWorld.elements.join(',');
    if (p._faceCache && p._faceCache.key === key) return p._faceCache.faces;
    const faces = detectPlanarFaces(p.mesh);
    p._faceCache = { key, faces };
    return faces;
  }

  // ── Section pointer picking ──────────────────────────────────────────
  // Strict priority, not nearest-hit: arrow → face quads → triad. A detected
  // face is a deliberate pick and must beat the big generic triad quads, which
  // span the anchor and would otherwise swallow every click near the part.
  _secPick(cx, cy) {
    if (!this._section.enabled && !this._layFlatArmed) return null;
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
      m.color.setHex(COL_LINE);
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
  fitView() {
    const union = this._visibleBox();
    if (!union) return;

    const sel = this._selectedId ? this.parts.get(this._selectedId) : null;
    let selBox = (sel && sel.mesh.visible) ? new THREE.Box3().setFromObject(sel.mesh) : null;
    if (selBox && selBox.isEmpty()) selBox = null;
    const box = selBox || union;

    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z) || 1;

    const fov = this.camera.fov * Math.PI / 180;
    let dist = (maxDim / 2) / Math.tan(fov / 2);
    dist *= 1.7;

    // Z-up isometric-ish direction: front-right-top (+X right, −Y front, +Z up).
    const dir = new THREE.Vector3(1, -0.9, 0.65).normalize();
    const pivot = selBox ? center : (this.computeCenterOfMass(this._volumeHint) || center);
    // A TOP/BOTTOM cube snap parks camera.up on ±Y (a top-down view has no Z-up
    // basis); an oblique fit must stand it back up or the whole world renders
    // rolled. Drop any in-flight snap too — FIT is an explicit camera command.
    this._cubeAnim = null;
    this.camera.up.set(0, 0, 1);
    this.camera.position.copy(center).add(dir.multiplyScalar(dist));
    this.camera.near = Math.max(dist / 1000, 0.01);
    this.camera.far = dist * 100;
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(pivot);
    this.controls.update();

    const uSize = union.getSize(new THREE.Vector3());
    this._updateGrid(union, union.getCenter(new THREE.Vector3()),
      Math.max(uSize.x, uSize.y, uSize.z) || 1);
  }

  _updateGrid(box, center, maxDim) {
    const size = Math.max(maxDim * 2.4, 10);
    // Z-up world: GridHelper is authored in the XZ plane (normal +Y), so rotate
    // it into XY (normal +Z) or it renders as a vertical wall. Sit it a hair
    // BELOW box.min.z — lay-flat parts rest exactly on z=0 and a coplanar grid
    // z-fights with the part's bottom face.
    const zEps = Math.max(0.05, size * 0.0008);
    if (this.grid && Math.abs(this._gridMeta.size - size) < size * 0.01) {
      this.grid.rotation.x = Math.PI / 2;
      this.grid.position.set(center.x, center.y, box.min.z - zEps);
      return;
    }
    if (this.grid) { this.scene.remove(this.grid); this.grid.geometry.dispose(); this.grid.material.dispose(); }
    const divisions = 20;
    // Dark-only HUD grid tones: --line centerlines over --muted lines.
    const grid = new THREE.GridHelper(size, divisions, 0x353535, 0x2a2a2a);
    grid.material.transparent = true;
    grid.material.opacity = 0.5;
    grid.rotation.x = Math.PI / 2;
    grid.position.set(center.x, center.y, box.min.z - zEps);
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

  // ══ Wave-2 · Selection ═══════════════════════════════════════════════
  // Selection is state-derived in main.js; the viewer only reflects it: an
  // emissive tint on the selected mesh (original emissive stored/restored).
  setSelected(id) {
    const nid = id || null;
    if (this._selectedId === nid) return;
    const prev = this._selectedId ? this.parts.get(this._selectedId) : null;
    if (prev) this._clearSelTint(prev);
    this._selectedId = nid;
    const p = nid ? this.parts.get(nid) : null;
    if (p) this._applySelTint(p);
    else this.stopGizmo();
    this._secQuadsFrozen = false;   // a cancelled live transform must not strand the freeze
    this._syncFaceQuads();          // face quads belong to the selected part only
    if (this._section.enabled && !this._section.hasPlane) this._buildTriad();   // re-anchor
  }
  selectedId() { return this._selectedId; }
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

  // ══ Wave-2 · Transform gizmo (proxy-bridged) ═════════════════════════
  // proxy.matrix == compose(T, quat[ZYX], S) == the hand chain T·Rz·Ry·Rx·S
  // (see _selfTestEuler). Reading it back → the same TRS the worker consumes.
  _readProxyTrs() {
    const t = this._proxy.position, s = this._proxy.scale;
    const e = new THREE.Euler().setFromQuaternion(this._proxy.quaternion, 'ZYX');
    const R2D = 180 / Math.PI;
    return {
      translateMM: { x: t.x, y: t.y, z: t.z },
      rotateDeg:   { x: e.x * R2D, y: e.y * R2D, z: e.z * R2D },
      scale:       { x: s.x, y: s.y, z: s.z },
    };
  }
  _writeProxyFromTrs(trs) {
    const t = (trs && trs.translateMM) || { x: 0, y: 0, z: 0 };
    const r = (trs && trs.rotateDeg)   || { x: 0, y: 0, z: 0 };
    const s = (trs && trs.scale)       || { x: 1, y: 1, z: 1 };
    const D = Math.PI / 180;
    this._proxy.position.set(t.x || 0, t.y || 0, t.z || 0);
    this._proxy.quaternion.setFromEuler(new THREE.Euler((r.x || 0) * D, (r.y || 0) * D, (r.z || 0) * D, 'ZYX'));
    this._proxy.scale.set(s.x || 1, s.y || 1, s.z || 1);
    this._proxy.updateMatrixWorld(true);
  }
  startGizmo(mode) {
    if (!this._selectedId) return;
    const p = this.parts.get(this._selectedId);
    if (!p) return;
    this._layFlatArmed = false;
    this._writeProxyFromTrs(p.trs);
    this.gizmo.mode = mode || 'translate';
    this.gizmo.attach(this._proxy);
    this._gizmoActive = true;
  }
  setGizmoMode(mode) {
    if (!this._selectedId) return;
    if (!this._gizmoActive) { this.startGizmo(mode); return; }
    // Already active: re-sync the proxy from the part's committed TRS before
    // switching modes. Between drags the proxy always equals the committed TRS,
    // so this is a no-op in the common case but corrects a proxy left stale by
    // an external TRS change (transform panel / lay-flat) on the selected part.
    const p = this.parts.get(this._selectedId);
    if (p) this._writeProxyFromTrs(p.trs);
    this.gizmo.mode = mode;
  }
  stopGizmo() {
    if (this.gizmo) this.gizmo.detach();
    this._gizmoActive = false;
  }
  isGizmoActive() { return this._gizmoActive; }
  gizmoMode() { return this._gizmoActive ? this.gizmo.mode : null; }

  // ══ Wave-2 · Lay flat ════════════════════════════════════════════════
  armLayFlat() {
    if (!this._selectedId) return;
    this.stopGizmo();          // gizmo off during the one-shot face pick
    this._layFlatArmed = true;
    this._syncFaceQuads();     // detected flat faces become clickable targets
  }
  cancelLayFlat() { this._layFlatArmed = false; this._syncFaceQuads(); }
  isLayFlatArmed() { return this._layFlatArmed; }
  // Raycast ONLY the selected mesh, then hand its world face normal to the
  // shared lay-flat solver. Returns a TRS (or null if the click missed).
  computeLayFlat(id, cx, cy) {
    const p = id ? this.parts.get(id) : null;
    if (!p || !p.mesh || !p.mesh.visible) return null;
    this._raycaster.setFromCamera(this._ndcFromClient(cx, cy), this.camera);
    const hits = this._raycaster.intersectObject(p.mesh, false);
    if (!hits.length || !hits[0].face) return null;
    const nWorld = hits[0].face.normal.clone()
      .applyMatrix3(new THREE.Matrix3().getNormalMatrix(p.mesh.matrixWorld)).normalize();
    return this._layFlatFromNormal(p, nWorld);
  }
  /** Same solver, fed a detected planar-cluster normal instead of a ray hit. */
  computeLayFlatFromNormal(id, nWorld) {
    const p = id ? this.parts.get(id) : null;
    if (!p || !p.mesh || !p.mesh.visible) return null;
    return this._layFlatFromNormal(p, new THREE.Vector3().copy(nWorld).normalize());
  }
  // Rotate the given world face normal onto (0,0,−1), compose with the current
  // rotation, then translate so the rotated bbox min.z = 0 while preserving the
  // current bbox XY centre.
  _layFlatFromNormal(p, nWorld) {
    const q = new THREE.Quaternion().setFromUnitVectors(nWorld, new THREE.Vector3(0, 0, -1));

    const cur = p.trs || {};
    const r = cur.rotateDeg || { x: 0, y: 0, z: 0 };
    const s = cur.scale || { x: 1, y: 1, z: 1 };
    const D = Math.PI / 180, R2D = 180 / Math.PI;
    const qCur = new THREE.Quaternion().setFromEuler(
      new THREE.Euler((r.x || 0) * D, (r.y || 0) * D, (r.z || 0) * D, 'ZYX'));
    const qNew = q.multiply(qCur);   // world-space: apply the lay-flat spin AFTER the current rotation
    const eNew = new THREE.Euler().setFromQuaternion(qNew, 'ZYX');
    const rotateDeg = { x: eNew.x * R2D, y: eNew.y * R2D, z: eNew.z * R2D };

    // Current world bbox XY centre (preserved) and the rotated+scaled AABB.
    const curCenter = new THREE.Box3().setFromObject(p.mesh).getCenter(new THREE.Vector3());
    if (!p.mesh.geometry.boundingBox) p.mesh.geometry.computeBoundingBox();
    const gb = p.mesh.geometry.boundingBox;
    const RS = new THREE.Matrix4().makeRotationFromQuaternion(qNew)
      .scale(new THREE.Vector3(s.x || 1, s.y || 1, s.z || 1));   // R·S (no translate)
    const rbox = new THREE.Box3();
    const c = new THREE.Vector3();
    for (let xi = 0; xi < 2; xi++) for (let yi = 0; yi < 2; yi++) for (let zi = 0; zi < 2; zi++) {
      c.set(xi ? gb.max.x : gb.min.x, yi ? gb.max.y : gb.min.y, zi ? gb.max.z : gb.min.z).applyMatrix4(RS);
      rbox.expandByPoint(c);
    }
    const rc = rbox.getCenter(new THREE.Vector3());
    return {
      translateMM: { x: curCenter.x - rc.x, y: curCenter.y - rc.y, z: -rbox.min.z },
      rotateDeg,
      scale: { x: s.x || 1, y: s.y || 1, z: s.z || 1 },
    };
  }

  // ══ Wave-2 · View cube (2nd scene + ortho, drawn inside _tick) ════════
  _initViewCube() {
    const scene = new THREE.Scene();
    const cam = new THREE.OrthographicCamera(-1.35, 1.35, 1.35, -1.35, 0.1, 100);
    cam.position.set(0, 0, CUBE_CAM_DIST);
    cam.up.set(0, 1, 0);
    cam.lookAt(0, 0, 0);
    // BoxGeometry material index order: +X, −X, +Y, −Y, +Z, −Z. Z-up world
    // labels: +Z TOP, −Z BOTTOM, −Y FRONT, +Y BACK, +X RIGHT, −X LEFT.
    const labels = ['RIGHT', 'LEFT', 'BACK', 'FRONT', 'TOP', 'BOTTOM'];
    const mats = labels.map((t) => new THREE.MeshBasicMaterial({ map: this._makeCubeFaceTexture(t) }));
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1.5, 1.5, 1.5), mats);
    scene.add(mesh);
    this._cube = { scene, camera: cam, mesh };
  }
  _makeCubeFaceTexture(text) {
    const s = 128;
    const cv = document.createElement('canvas');
    cv.width = s; cv.height = s;
    const g = cv.getContext('2d');
    g.fillStyle = '#242424';                 // dark face (~ --card)
    g.fillRect(0, 0, s, s);
    g.strokeStyle = '#565656'; g.lineWidth = 6;  // neutral gray edges/corners (between --line and --dim)
    g.strokeRect(3, 3, s - 6, s - 6);
    g.fillStyle = '#d9d9d9';                 // --fg label
    g.font = '700 21px "Kode Mono", ui-monospace, monospace';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(text, s / 2, s / 2 + 1);
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
  _handleCubeClick(cx, cy) {
    const cube = this._cube;
    if (!cube) return;
    const r = this.container.getBoundingClientRect();
    const left = r.right - CUBE_MARGIN - CUBE_PX;
    const top = r.top + CUBE_MARGIN;
    const nx = ((cx - left) / CUBE_PX) * 2 - 1;
    const ny = -(((cy - top) / CUBE_PX) * 2 - 1);
    this._raycaster.setFromCamera(new THREE.Vector2(nx, ny), cube.camera);
    const hits = this._raycaster.intersectObject(cube.mesh, false);
    if (!hits.length || !hits[0].face) return;
    const n = hits[0].face.normal;
    const ax = Math.abs(n.x), ay = Math.abs(n.y), az = Math.abs(n.z);
    let dir;
    if (ax >= ay && ax >= az) dir = new THREE.Vector3(Math.sign(n.x) || 1, 0, 0);
    else if (ay >= az)        dir = new THREE.Vector3(0, Math.sign(n.y) || 1, 0);
    else                      dir = new THREE.Vector3(0, 0, Math.sign(n.z) || 1);
    this._snapToAxis(dir);
  }
  _snapToAxis(dir) {
    const target = this.controls.target.clone();
    const dist = this.camera.position.distanceTo(target) || 1;
    this._cubeAnim = {
      t0: performance.now(), dur: SNAP_MS, target,
      fromPos: this.camera.position.clone(), toPos: target.clone().add(dir.clone().multiplyScalar(dist)),
      fromUp: this.camera.up.clone(), toUp: this._upForDir(dir),
    };
  }
  _upForDir(dir) {
    // Z-up world: TOP/BOTTOM (dir≈±Z) use a Y-based up (avoids a degenerate
    // up∥view flip); every side view stands Z up.
    if (Math.abs(dir.z) > 0.5) return new THREE.Vector3(0, dir.z > 0 ? 1 : -1, 0);
    return new THREE.Vector3(0, 0, 1);
  }
  _stepCubeAnim() {
    const a = this._cubeAnim;
    if (!a) return;
    let k = (performance.now() - a.t0) / a.dur;
    const done = k >= 1;
    if (done) k = 1;
    const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;   // easeInOutQuad
    this.camera.position.lerpVectors(a.fromPos, a.toPos, e);
    this.camera.up.copy(a.fromUp).lerp(a.toUp, e);
    if (this.camera.up.lengthSq() > 1e-9) this.camera.up.normalize();
    this.camera.lookAt(a.target);
    if (done) {
      this.camera.up.copy(a.toUp);
      this.camera.lookAt(a.target);
      this.controls.target.copy(a.target);
      this.controls.update();   // re-sync OrbitControls spherical + up basis
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
      st.mode = (this.gizmo && this.gizmo.axis) ? 'gizmo' : 'select';
    }, { capture: true });

    c.addEventListener('pointermove', (e) => {
      if (st.mode === 'secdrag') { e.stopPropagation(); this._updateArrowDrag(e); return; }
      if (st.mode === 'none' && onCanvas(e)) {
        // Hover glow on whatever section overlay is under the cursor.
        const h = this._secPick(e.clientX, e.clientY);
        this._setSecHover(h && h.obj ? h.obj : null);
      }
      if (st.mode === 'none') return;
      if (!st.moved && Math.hypot(e.clientX - st.downX, e.clientY - st.downY) > SELECT_DRAG_PX) st.moved = true;
    }, { capture: true });

    c.addEventListener('pointerup', (e) => {
      const mode = st.mode;
      st.mode = 'none';
      if (mode === 'secdrag') { e.stopPropagation(); this._endArrowDrag(e); return; }
      if (mode === 'secpick') {
        e.stopPropagation();
        const pending = this._secPending;
        this._secPending = null;
        if (st.moved || !pending) return;
        if (pending.kind === 'triad') { this.pickAxisPlane(pending.axis); return; }
        const f = pending.face;
        if (!f) return;
        if (this._layFlatArmed) {                       // LAY FLAT owns the click
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
        this.onPick?.(this._pickPart(e.clientX, e.clientY));   // id or null (empty click clears)
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

    const w = this.container.clientWidth || 1, h = this.container.clientHeight || 1;
    const r = this.renderer;
    r.setViewport(0, 0, w, h);
    r.setScissorTest(false);
    r.autoClear = true;
    r.render(this.scene, this.camera);

    // View-cube overlay — same rAF, corner viewport/scissor (no 2nd rAF loop).
    this._renderViewCube(w, h);

    requestAnimationFrame(this._tick);
  }
}

function disposeMesh(mesh) {
  mesh.geometry?.dispose();
  if (Array.isArray(mesh.material)) mesh.material.forEach((m) => m.dispose());
  else mesh.material?.dispose();
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
