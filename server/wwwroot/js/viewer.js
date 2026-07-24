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

export class Viewer {
  constructor(container) {
    this.container = container;
    this.parts = new Map();   // id -> { mesh, role, visible }
    this.result = null;       // THREE.Mesh | null
    this._loader = new STLLoader();

    const scene = new THREE.Scene();
    this.scene = scene;

    const cam = new THREE.PerspectiveCamera(45, 1, 0.1, 5000);
    cam.position.set(80, 64, 80);
    this.camera = cam;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.localClippingEnabled = true;   // enables the SECTION clip plane
    this.renderer = renderer;
    container.appendChild(renderer.domElement);

    // View-strip state: GHOSTS (bulk-hide uploaded parts) + SECTION (axis clip).
    // `sign` (+1/−1) parameterises which side of the plane is kept (invert button).
    this._ghostsHidden = false;
    this._section = { enabled: false, axis: 'z', t: 0.5, sign: 1 };
    this._clipPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);

    const controls = new OrbitControls(cam, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.09;
    controls.rotateSpeed = 0.9;
    this.controls = controls;

    // Lighting: hemisphere fill + a key directional.
    this.hemi = new THREE.HemisphereLight(0xffffff, 0x40404a, 1.05);
    scene.add(this.hemi);
    this.key = new THREE.DirectionalLight(0xffffff, 1.35);
    this.key.position.set(0.6, 1, 0.55);
    scene.add(this.key);
    this.fill = new THREE.DirectionalLight(0xffffff, 0.4);
    this.fill.position.set(-0.7, 0.3, -0.5);
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
    this.onSectionScrub = null;    // (pct 0..100)   → Alt+wheel → sync the slider

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

    this._initViewCube();
    this._initPointer();

    if (EULER_SELFTEST) { try { this._selfTestEuler(); } catch (err) { console.error('[anvil] euler self-test threw', err); } }

    this._running = true;
    this._tick = this._tick.bind(this);
    requestAnimationFrame(this._tick);
  }

  // ── Parts ───────────────────────────────────────────────────────────
  addPart(id, url, role) {
    return new Promise((resolve, reject) => {
      this._loader.load(url, (geometry) => {
        geometry.computeVertexNormals();
        const mat = new THREE.MeshStandardMaterial({
          color: roleColorInt(role),
          metalness: 0.05,
          roughness: 0.65,
          transparent: true,
          opacity: this.result ? DIM_OPACITY : UP_OPACITY,
          depthWrite: false,
          side: THREE.DoubleSide,
        });
        const mesh = new THREE.Mesh(geometry, mat);   // no transform — world coords preserved
        mesh.renderOrder = 1;
        if (this._ghostsHidden) mesh.visible = false;
        this.scene.add(mesh);
        this.parts.set(id, { mesh, role, visible: true });
        this._applyClip();
        this.fitView();
        resolve();
      }, undefined, (err) => reject(err instanceof Error ? err : new Error('STL load failed')));
    });
  }

  setPartRole(id, role) {
    const p = this.parts.get(id);
    if (!p) return;
    p.role = role;
    p.mesh.material.color.setHex(roleColorInt(role));
    if (id === this._selectedId) this._applySelTint(p);   // keep the emissive glow hued to the new role
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
  }
  clearPartTransform(id) {
    const p = this.parts.get(id);
    if (!p) return;
    p.trs = null;
    const m = p.mesh;
    m.matrixAutoUpdate = false;
    m.matrix.identity();
    m.updateMatrixWorld(true);
    this.fitView();
  }
  _applyPartMatrix(p) {
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
    p.mesh.matrixAutoUpdate = false;
    p.mesh.matrix.copy(m);
    p.mesh.updateMatrixWorld(true);   // fitView/_visibleBox read matrixWorld
  }

  setPartVisible(id, visible) {
    const p = this.parts.get(id);
    if (!p) return;
    p.visible = visible;
    p.mesh.visible = visible;
    this.fitView();
  }

  removePart(id) {
    const p = this.parts.get(id);
    if (!p) return;
    if (id === this._selectedId) { this.stopGizmo(); this._selectedId = null; }
    this.scene.remove(p.mesh);
    disposeMesh(p.mesh);
    this.parts.delete(id);
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
        this._applyClip();
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
    }
  }

  dimUploaded() {
    for (const p of this.parts.values()) p.mesh.material.opacity = DIM_OPACITY;
  }
  undimUploaded() {
    for (const p of this.parts.values()) p.mesh.material.opacity = UP_OPACITY;
  }

  // ── Ghosts (bulk-toggle uploaded-part visibility; result stays) ──────
  toggleGhosts() {
    this._ghostsHidden = !this._ghostsHidden;
    for (const p of this.parts.values()) p.mesh.visible = this._ghostsHidden ? false : p.visible;
    this.fitView();
    return this._ghostsHidden;   // true = uploaded parts hidden
  }

  // ── Section clip plane (along the current flow axis) ─────────────────
  setSection(enabled, axis) {
    this._section.enabled = enabled;
    if (axis) this._section.axis = axis;
    this._updateClipPlane();
    this._applyClip();
  }
  setSectionAxis(axis) { this._section.axis = axis; this._updateClipPlane(); }
  setSectionPosition(t) { this._section.t = Math.max(0, Math.min(1, t)); this._updateClipPlane(); }
  /** Section side: +1 keeps the high-coordinate half, −1 the low half (invert ⇄). */
  setSectionSign(sign) { this._section.sign = sign < 0 ? -1 : 1; this._updateClipPlane(); }
  toggleSectionSign() { this.setSectionSign(-(this._section.sign || 1)); return this._section.sign; }
  getSectionState() { return { ...this._section }; }

  _updateClipPlane() {
    const box = this._visibleBox();
    if (!box) return;
    const a = this._section.axis;
    const sign = this._section.sign || 1;
    const n = new THREE.Vector3(a === 'x' ? 1 : 0, a === 'y' ? 1 : 0, a === 'z' ? 1 : 0).multiplyScalar(sign);
    const min = box.min[a], max = box.max[a];
    const value = min + this._section.t * (max - min);
    // Keep fragments where n·p + constant >= 0. sign=+1 keeps p_a >= value
    // (constant = -value); sign=-1 flips the normal and keeps p_a <= value.
    this._clipPlane.normal.copy(n);
    this._clipPlane.constant = -sign * value;
  }
  _applyClip() {
    const planes = this._section.enabled ? [this._clipPlane] : null;
    const set = (mat) => { if (mat) { mat.clippingPlanes = planes; mat.needsUpdate = true; } };
    for (const p of this.parts.values()) set(p.mesh.material);
    if (this.result) set(this.result.material);
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

  // ── Camera fit (Box3 union of visible objects) ──────────────────────
  fitView() {
    const box = new THREE.Box3();
    let has = false;
    for (const p of this.parts.values()) {
      if (p.mesh.visible) { box.expandByObject(p.mesh); has = true; }
    }
    if (this.result) { box.expandByObject(this.result); has = true; }
    if (!has || box.isEmpty()) return;

    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z) || 1;

    const fov = this.camera.fov * Math.PI / 180;
    let dist = (maxDim / 2) / Math.tan(fov / 2);
    dist *= 1.7;

    const dir = new THREE.Vector3(1, 0.7, 1).normalize();
    this.camera.position.copy(center).add(dir.multiplyScalar(dist));
    this.camera.near = Math.max(dist / 1000, 0.01);
    this.camera.far = dist * 100;
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(center);
    this.controls.update();

    this._updateGrid(box, center, maxDim);
  }

  _updateGrid(box, center, maxDim) {
    const size = Math.max(maxDim * 2.4, 10);
    if (this.grid && Math.abs(this._gridMeta.size - size) < size * 0.01) {
      this.grid.position.set(center.x, box.min.y, center.z);
      return;
    }
    if (this.grid) { this.scene.remove(this.grid); this.grid.geometry.dispose(); this.grid.material.dispose(); }
    const divisions = 20;
    // Dark-only HUD grid tones: --line centerlines over --muted lines.
    const grid = new THREE.GridHelper(size, divisions, 0x353535, 0x2a2a2a);
    grid.material.transparent = true;
    grid.material.opacity = 0.5;
    grid.position.set(center.x, box.min.y, center.z);
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
  }
  cancelLayFlat() { this._layFlatArmed = false; }
  isLayFlatArmed() { return this._layFlatArmed; }
  // Raycast ONLY the selected mesh; rotate its picked world face normal onto
  // (0,0,−1), compose with the current rotation, then translate so the rotated
  // bbox min.z = 0 while preserving the current bbox XY centre. Returns a TRS
  // (or null if the click missed the mesh).
  computeLayFlat(id, cx, cy) {
    const p = id ? this.parts.get(id) : null;
    if (!p || !p.mesh || !p.mesh.visible) return null;
    this._raycaster.setFromCamera(this._ndcFromClient(cx, cy), this.camera);
    const hits = this._raycaster.intersectObject(p.mesh, false);
    if (!hits.length || !hits[0].face) return null;

    const nWorld = hits[0].face.normal.clone()
      .applyMatrix3(new THREE.Matrix3().getNormalMatrix(p.mesh.matrixWorld)).normalize();
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
    g.strokeStyle = '#ff5c00'; g.lineWidth = 6;  // orange edges (--primary)
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
      if (this._layFlatArmed) { st.mode = 'layflat'; return; }
      st.mode = (this.gizmo && this.gizmo.axis) ? 'gizmo' : 'select';
    }, { capture: true });

    c.addEventListener('pointermove', (e) => {
      if (st.mode === 'none') return;
      if (!st.moved && Math.hypot(e.clientX - st.downX, e.clientY - st.downY) > SELECT_DRAG_PX) st.moved = true;
    }, { capture: true });

    c.addEventListener('pointerup', (e) => {
      const mode = st.mode;
      st.mode = 'none';
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

    // Alt+wheel over the canvas scrubs the section plane (±2/notch, Shift ±0.5).
    // preventDefault ONLY while the section is active AND Alt is held, so a plain
    // wheel keeps orbit-zoom.
    this.renderer.domElement.addEventListener('wheel', (e) => {
      if (!this._section.enabled || !e.altKey) return;
      e.preventDefault();
      const stepPct = e.shiftKey ? 0.5 : 2;
      const dir = e.deltaY < 0 ? 1 : -1;
      const pct = Math.max(0, Math.min(100, this._section.t * 100 + dir * stepPct));
      this.setSectionPosition(pct / 100);
      this.onSectionScrub?.(pct);
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
