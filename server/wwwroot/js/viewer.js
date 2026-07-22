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
import { STLLoader } from 'three/addons/loaders/STLLoader.js';

// HUD palette (sRGB hex of the oklch tokens). Uploaded Part/Positive read as
// translucent cyan, Negative as translucent orange (--primary); the generated
// result is solid light gray (--fg) with a faint metallic sheen.
const ROLE_COLOR = {
  part:     0x49bfd9,  // --cyan
  positive: 0x49bfd9,  // --cyan
  negative: 0xff5c00,  // --primary (orange)
};
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
    this.renderer = renderer;
    container.appendChild(renderer.domElement);

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
          color: ROLE_COLOR[role] ?? ROLE_COLOR.part,
          metalness: 0.05,
          roughness: 0.65,
          transparent: true,
          opacity: this.result ? DIM_OPACITY : UP_OPACITY,
          depthWrite: false,
          side: THREE.DoubleSide,
        });
        const mesh = new THREE.Mesh(geometry, mat);   // no transform — world coords preserved
        mesh.renderOrder = 1;
        this.scene.add(mesh);
        this.parts.set(id, { mesh, role, visible: true });
        this.fitView();
        resolve();
      }, undefined, (err) => reject(err instanceof Error ? err : new Error('STL load failed')));
    });
  }

  setPartRole(id, role) {
    const p = this.parts.get(id);
    if (!p) return;
    p.role = role;
    p.mesh.material.color.setHex(ROLE_COLOR[role] ?? ROLE_COLOR.part);
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

  // ── Camera fit (Box3 union of visible objects) ──────────────────────
  fitView() {
    const box = new THREE.Box3();
    let has = false;
    for (const p of this.parts.values()) {
      if (p.visible) { box.expandByObject(p.mesh); has = true; }
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

  // ── internals ───────────────────────────────────────────────────────
  _resize() {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  _tick() {
    if (!this._running) return;
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    requestAnimationFrame(this._tick);
  }
}

function disposeMesh(mesh) {
  mesh.geometry?.dispose();
  if (Array.isArray(mesh.material)) mesh.material.forEach((m) => m.dispose());
  else mesh.material?.dispose();
}
