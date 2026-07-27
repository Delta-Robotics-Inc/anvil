//
// main.js — Infill App controller. Owns app state, wires events, drives the
// upload → parameters → generate → poll → export loop.
//
import * as api from './api.js';
import * as ui from './ui.js';
import * as tools from './tools.js';
import * as scriptsView from './scripts.js';
import * as history from './history.js';
import { Viewer, UP_AXIS_DEFAULT, UP_AXIS_KEYS } from './viewer.js';
import { isBaseRole, isZoneRole, effectiveColorHex } from './roles.js';

// ── State ─────────────────────────────────────────────────────────────
const state = {
  parts: [],        // { id, name, triangles, sourceFormat, role, visible }
  pending: [],      // { tempId, name, kind } placeholder rows for in-flight uploads
  job: null,        // { id } of the last successful generation
  poll: null,       // interval handle for generation polling
  stepPoll: null,   // interval handle for STEP-export polling
  resultFresh: false, // Fix 1 — shown result matches current params (drives accent budget)
  latticePartId: null, // the CURRENT generated lattice part (one at a time)

  // Wave-2/6 viewport selection / gizmo. Selection is an ORDERED MULTI-SET and
  // the single source of truth: rows re-derive `.selected`/`.primary` from it on
  // every renderParts, the viewer tints from it, the gizmo attaches to it.
  //   · order = the order the user picked them (drives boolean A/B later)
  //   · the LAST element is the PRIMARY — the part numeric entry, LAY FLAT and
  //     the XFORM readout bind to.
  selection: [],        // string[] of part ids
  gizmoMode: null,      // 'translate' | 'rotate' | 'scale' | null
  layFlatArmed: false,  // LAY FLAT one-shot pick armed
  draggingGizmo: false, // true mid-drag → freeze refreshParts

  // Derived, read-only: the primary. Kept so every pre-Wave-6 reader that asks
  // "which part is selected" still gets the right answer.
  get selectedPartId() { return this.selection.length ? this.selection[this.selection.length - 1] : null; },
};
let pendingSeq = 0; // monotonic id source for placeholder rows

// ── MODEL UP (display convention, persisted) ──────────────────────────
// Which world direction reads screen-up. A pure presentation choice: it moves
// the camera, the plate and the view-cube labels and NOTHING else, so exports
// are identical in all four modes. Read BEFORE the viewer is constructed so the
// very first frame is already in the user's convention.
// v2: the key was bumped when the default reverted from '-y' to '+y'. The old
// default was written to storage on first load, so every existing user carries a
// stored '-y' they never chose — a new key is the only way to land them all on
// the corrected default without special-casing one value.
// v3: same move for the '+y' → '+z' default (Z IS UP). A stored '+y' is
// indistinguishable from a deliberate '+y' choice, so the key is bumped again
// rather than migrated; anyone who really wants ±Y is one chip away.
const UP_KEY = 'anvil.upAxis.v3';
function storedUpAxis() {
  let v = null;
  try { v = localStorage.getItem(UP_KEY); } catch { /* private mode */ }
  return UP_AXIS_KEYS.includes(v) ? v : UP_AXIS_DEFAULT;
}

const viewer = new Viewer(ui.els.viewport, { upAxis: storedUpAxis() });
viewer.setTheme(ui.isDarkTheme());

// ── Theme ─────────────────────────────────────────────────────────────
ui.initTheme((isDark) => viewer.setTheme(isDark));

// ── Uploads ───────────────────────────────────────────────────────────
ui.els.dropzone.addEventListener('click', () => ui.els.fileInput.click());
ui.els.dropzone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); ui.els.fileInput.click(); }
});
ui.els.fileInput.addEventListener('change', () => {
  handleFiles(Array.from(ui.els.fileInput.files || []));
  ui.els.fileInput.value = '';
});

['dragenter', 'dragover'].forEach((ev) =>
  ui.els.dropzone.addEventListener(ev, (e) => {
    e.preventDefault(); e.stopPropagation();
    ui.els.dropzone.classList.add('dragover');
  }));
['dragleave', 'dragend', 'drop'].forEach((ev) =>
  ui.els.dropzone.addEventListener(ev, (e) => {
    e.preventDefault(); e.stopPropagation();
    ui.els.dropzone.classList.remove('dragover');
  }));
ui.els.dropzone.addEventListener('drop', (e) => {
  const files = Array.from(e.dataTransfer?.files || []);
  clearDragActive();
  handleFiles(files);
});

// ── Window-wide drag & drop ───────────────────────────────────────────
// A file dropped ANYWHERE on the page (viewport included) routes to the same
// upload path. While a file is dragged over the window both drop affordances
// light up (sidebar zone + viewport hint). preventDefault on dragover is
// required so the browser doesn't navigate to the dropped file. The dropzone's
// own drop handler stopPropagation()s, so window drops never double-handle a
// drop that already landed on the zone.
let dragLeaveTimer = 0;
function hasFiles(e) {
  const t = e.dataTransfer;
  return !!t && Array.from(t.types || []).includes('Files');
}
function clearDragActive() {
  clearTimeout(dragLeaveTimer);
  document.body.classList.remove('drag-active');
}
window.addEventListener('dragover', (e) => {
  e.preventDefault();
  if (!hasFiles(e)) return;
  document.body.classList.add('drag-active');
  // Debounced leave: dragover stops firing once the cursor exits the window or
  // a drop lands, so a short timeout clears the glow without child flicker.
  clearTimeout(dragLeaveTimer);
  dragLeaveTimer = setTimeout(() => document.body.classList.remove('drag-active'), 160);
});
window.addEventListener('drop', (e) => {
  e.preventDefault();
  clearDragActive();
  const files = Array.from(e.dataTransfer?.files || []);
  if (files.length) handleFiles(files);
});

async function handleFiles(files) {
  const accepted = files.filter((f) => /\.(stl|step|stp)$/i.test(f.name));
  const rejected = files.filter((f) => !/\.(stl|step|stp)$/i.test(f.name));
  for (const f of rejected) ui.toast(`Skipped "${f.name}" — only STL / STEP are supported.`, 'warn');
  if (accepted.length === 0) return;

  // Synchronously stand up a placeholder row per file BEFORE any await, so a
  // drop shows instant feedback while the STEP→STL sidecar spins up (1–3s).
  const jobs = accepted.map((file) => {
    const tempId = `pending-${++pendingSeq}`;
    state.pending.push({
      tempId, name: file.name,
      kind: /\.stl$/i.test(file.name) ? 'stl' : 'step',
    });
    return { file, tempId };
  });
  refreshParts(); // paints placeholders + flips the drop zone to PROCESSING_

  for (const { file, tempId } of jobs) {
    let part;
    try {
      part = await api.uploadPart(file);
    } catch (err) {
      removePending(tempId);
      refreshParts();
      ui.toast(`Upload failed for "${file.name}": ${err.message}`, 'error', 9000);
      continue;
    }

    const rec = {
      id: part.id, name: part.name, triangles: part.triangles,
      sourceFormat: part.sourceFormat, role: 'part', visible: true,
      volumeMM3: part.volumeMM3, bbox: part.bbox, derived: null, trs: null,
      stlUrl: part.stlUrl || api.partMeshUrl(part.id),   // undo re-adds from here
    };
    // Swap placeholder → real row the instant conversion returns, then flash.
    const flagsBefore = flagsSnapshot();   // the auto-role flip rides this command
    removePending(tempId);
    state.parts.push(rec);
    applyAutoRoles();
    refreshParts();
    ui.flashPartRow(rec.id);

    try {
      await viewer.addPart(part.id, rec.stlUrl, rec.role);
      // Nothing is added to the part here. The plate is ADAPTIVE (it draws at
      // the scene's resting height along the display up axis), so an import
      // lands untouched and still reads as sitting on the bed.
      // Roles may have changed via applyAutoRoles — sync viewer colors.
      syncViewerRoles();
      updateDims();
      updateOrbitPivot();   // new geometry shifts the centre of mass
    } catch (err) {
      ui.toast(`"${part.name}" loaded, but its 3D preview failed: ${err.message}`, 'warn');
    }
    // ONE command per file: the row, its mesh, and the auto pos/neg flip it caused.
    const tx = history.begin(`Import ${rec.name}`);
    pushCreateCommand(rec.id, `Import ${rec.name}`);
    pushFlagsCommand(flagsBefore, 'Auto roles');
    history.end(tx);
  }
}

function removePending(tempId) {
  state.pending = state.pending.filter((p) => p.tempId !== tempId);
}

// First part → Part. When exactly two BASE-role parts exist and both are still
// the default "Part", switch them to positive/negative (bumpmesh-simple default).
// Only BASE-role uploads count — derived and zone parts never trigger the flip.
// Assignment is by SIZE, not upload order: the bigger part (the body that
// contains the cavity) becomes Positive, the smaller becomes Negative — drop
// order must never decide which part gets latticed.
function applyAutoRoles() {
  const base = state.parts.filter((p) => isBaseRole(p.role) && !p.isResult);
  if (base.length === 2 && base.every((p) => p.role === 'part')) {
    const vol = (p) => {
      const b = p.bbox;
      if (!b || !b.min || !b.max) return 0;
      return Math.abs((b.max.x - b.min.x) * (b.max.y - b.min.y) * (b.max.z - b.min.z));
    };
    const [big, small] = vol(base[0]) >= vol(base[1]) ? [base[0], base[1]] : [base[1], base[0]];
    big.role = 'positive';
    small.role = 'negative';
  }
}
function syncViewerRoles() {
  for (const p of state.parts) {
    viewer.setPartRole(p.id, p.role);
    // Colour is pushed with the role, not instead of it: setPartRole re-sorts the
    // draw lane and only repaints when the part has no override, so this pair is
    // the single "make the scene match state" call every history path can use.
    viewer.setPartColor(p.id, p.colorHex || null);
  }
}

// ── Per-part colour (session state, undoable) ─────────────────────────
// `rec.colorHex` is an OVERRIDE: null means "draw me in my role's colour". It
// survives role changes on purpose — only RESET (onColorChange with null) drops
// it — because a colour a user picked to tell two parts apart must not be undone
// by re-roling one of them.
//
// One value, four surfaces, all fed from here:
//   · the ghost mesh tint + its selection emissive basis (viewer.setPartColor)
//   · the SOLID lattice mesh of a latticed row (same call, on the lattice id)
//   · the row's --role-color (accent bar, selection rim, the colour dot itself)
//   · the EXPORT row dot
// The last two fall out of refreshExport/refreshParts reading rec.colorHex.
function applyPartColor(rowId, hex) {
  const p = partById(rowId);
  if (!p) return;
  p.colorHex = hex || null;
  viewer.setPartColor(rowId, p.colorHex);
  // A latticed row is ONE object drawn as two meshes — colour them together, or
  // the solid lattice would keep the old tint while its ghost shell changed.
  const lat = latticeOf(p);
  if (lat) { lat.colorHex = p.colorHex; viewer.setPartColor(lat.id, p.colorHex); }
  refreshParts();
}
function setPartColor(rowId, hex) {
  const p = partById(rowId);
  if (!p) return;
  const prev = p.colorHex || null;
  const next = hex || null;
  if (prev === next) return;
  applyPartColor(rowId, next);
  if (history.isBusy()) return;
  history.push({
    label: next ? `Colour ${p.name} ${next}` : `Reset colour ${p.name}`,
    undo: () => { applyPartColor(rowId, prev); afterHistory(); },
    redo: () => { applyPartColor(rowId, next); afterHistory(); },
  });
}

// ── Transforms (non-destructive per-part TRS) ─────────────────────────
// Scale is included end-to-end (epsilon 1e-6) so a gizmo/panel scale reaches
// the worker (BuildMatrix reads translateMM/rotateDeg/scale).
const TRS_EPS = 1e-6;
function nonIdentityTrs(trs) {
  if (!trs) return null;
  const t = trs.translateMM || {}, r = trs.rotateDeg || {}, s = trs.scale || {};
  const moved  = ['x', 'y', 'z'].some((k) => Math.abs(t[k] || 0) > TRS_EPS || Math.abs(r[k] || 0) > TRS_EPS);
  const scaled = ['x', 'y', 'z'].some((k) => Math.abs((s[k] ?? 1) - 1) > TRS_EPS);
  if (!moved && !scaled) return null;
  return {
    translateMM: { x: t.x || 0, y: t.y || 0, z: t.z || 0 },
    rotateDeg:   { x: r.x || 0, y: r.y || 0, z: r.z || 0 },
    scale:       { x: s.x ?? 1, y: s.y ?? 1, z: s.z ?? 1 },
  };
}
// { partId -> {translateMM, rotateDeg} } for the parts referenced by this
// generate (base + zone), identity transforms skipped. Field is translateMM
// (the worker deserializes with no aliases).
function collectTransforms(m) {
  const ids = new Set();
  if (m.mode === 'single') ids.add(m.partId);
  else { ids.add(m.positiveId); ids.add(m.negativeId); }
  if (m.zones) for (const arr of [m.zones.latticeIds, m.zones.keepIds, m.zones.voidIds])
    for (const id of arr) ids.add(id);
  const out = {};
  for (const id of ids) {
    const t = nonIdentityTrs(state.parts.find((x) => x.id === id)?.trs);
    if (t) out[id] = t;
  }
  return out;
}

// ── Op orchestration (tool CONFIRM → /api/ops → poll → new part) ──────
// `duplicate` returns the PartInfo DIRECTLY (200); every other op returns
// 202 {jobId,partId} — poll GET /jobs/{id} until .part appears. Returns the
// registered part (or null). onProgress(stageText) feeds the tool inline line.
// Wave-4 undo: the whole op is ONE command. tools.js runs `afterConfirm` (BOOL's
// source removal, TRANSFORM's source reset) synchronously right after this
// promise resolves, so the group is closed a macrotask later — late enough for
// those mutations to join, early enough that nothing unrelated can slip in.
async function runOpFlow(body, onProgress) {
  const tx = history.begin(`${(body.op || 'op').toUpperCase()}`);
  const closeSoon = () => setTimeout(() => history.end(tx), 0);
  try {
    const resp = await api.runOp(body);
    if (resp && resp.id && !resp.jobId) {          // synchronous duplicate
      await addOpPart(resp);
      closeSoon();
      return resp;
    }
    if (resp.warning) ui.toast(resp.warning, 'warn', 8000);
    const part = await pollOpJob(resp.jobId, onProgress);
    if (part) await addOpPart(part);
    closeSoon();
    return part;
  } catch (err) {
    history.end(tx);   // nothing was created — record whatever (if anything) landed
    throw err;
  }
}
function pollOpJob(jobId, onProgress) {
  // The server flips an op job to `done` and registers the derived part a moment
  // later (mass-props read of the output mesh). So on `done` we wait for st.part
  // to appear rather than resolving null on the first done poll (a race that
  // otherwise drops big-mesh results like a mirror of a dense boolean).
  return new Promise((resolve, reject) => {
    let doneWaits = 0;
    const h = setInterval(async () => {
      let st;
      try { st = await api.getJob(jobId); }
      catch (err) { clearInterval(h); reject(new Error(`lost contact with job: ${err.message}`)); return; }
      onProgress?.(prettyStage(st.stage, st.state));
      if (st.state === 'done') {
        if (st.part) { clearInterval(h); resolve(st.part); }
        else if (++doneWaits > 24) { clearInterval(h); resolve(null); }  // ~12s grace
      }
      else if (st.state === 'failed' || st.state === 'error') { clearInterval(h); reject(new Error(st.error || 'op failed')); }
      else if (st.state === 'cancelled') { clearInterval(h); reject(new Error('op cancelled')); }
    }, 500);
  });
}
/** Which parts draw with the SOLID material (opaque, RESULT-gray unless tinted)
 *  rather than the translucent role-coloured ghost:
 *    · a baked LATTICE (isResult) — it is the finished object;
 *    · a SCRIPT output — the script BUILT that model, so it reads as a finished
 *      part, not as a ghost of something still to be made.
 *  A script part that becomes a lattice SOURCE gives the solid look back for as
 *  long as it belongs to that lattice: the unit is then the lattice, and its
 *  sources are its shell. */
function rendersSolid(rec) {
  return !!rec && (!!rec.isResult || (rec.derived?.op === 'script' && !rec.ghosted));
}

// Register a freshly-created derived part into app state + the viewer (role Part;
// a script output lands solid, every other op lands as a translucent ghost).
// Flash the new row.
async function addOpPart(part) {
  const rec = {
    id: part.id, name: part.name, triangles: part.triangles,
    sourceFormat: part.sourceFormat || 'derived', role: 'part', visible: true,
    volumeMM3: part.volumeMM3, bbox: part.bbox, derived: part.derived || null, trs: null,
    stlUrl: part.stlUrl || api.partMeshUrl(part.id),   // undo re-adds from here
  };
  state.parts.push(rec);
  refreshParts();
  ui.flashPartRow(rec.id);
  try {
    await viewer.addPart(part.id, rec.stlUrl, rec.role, { solid: rendersSolid(rec), lattice: false });
    syncViewerRoles();
    updateDims();
    updateOrbitPivot();   // new geometry shifts the centre of mass
  } catch (err) {
    ui.toast(`"${part.name}" created, but its 3D preview failed: ${err.message}`, 'warn');
  }
  pushCreateCommand(rec.id, `Create ${rec.name}`);
}

// ── Scripting (SCRIPTS view → /api/scripts/run → poll → new parts) ─────
// A script job registers EVERY part it SavePart-ed; on `done` the server has
// already populated st.parts (registered before the job flips to done), so we
// add each through the normal derived-part flow. Returns the added parts.
// The SOURCE now comes from the editor, not from a library id: the view owns the
// text, so the same flow serves an example, an upload and a hand-written script.
// `onJob` hands the jobId back the moment it exists so the view's CANCEL button
// has something to cancel.
async function runScriptFlow(code, name, onProgress, onJob) {
  const resp = await api.runScript({ code, name });
  onJob?.(resp.jobId);
  const parts = await pollScriptJob(resp.jobId, onProgress);
  // Every part a script emitted is ONE command — a script run undoes as a unit.
  const tx = history.begin(`Script ${name}`);
  try { for (const p of parts) await addOpPart(p); }
  finally { history.end(tx); }
  return parts;
}
// A compile failure comes back as the worker's whole error JSON in
// JobStatus.errorData — {error, scriptError:[{line,character,severity,message}]}.
// Normalised here so the editor can list them and place a caret per row.
function scriptDiagnostics(errorData) {
  const arr = errorData?.scriptError;
  if (!Array.isArray(arr)) return [];
  return arr.map((d) => ({
    line: Number(d?.line) || 0,
    character: Number(d?.character) || 0,
    severity: d?.severity || 'error',
    message: String(d?.message ?? ''),
  }));
}
function pollScriptJob(jobId, onProgress) {
  return new Promise((resolve, reject) => {
    const fail = (h, st, fallback) => {
      clearInterval(h);
      const err = new Error(st?.error || fallback);
      err.diagnostics = scriptDiagnostics(st?.errorData);
      reject(err);
    };
    const h = setInterval(async () => {
      let st;
      try { st = await api.getJob(jobId); }
      catch (err) { clearInterval(h); reject(new Error(`lost contact with job: ${err.message}`)); return; }
      onProgress?.(prettyStage(st.stage, st.state));
      if (st.state === 'done') { clearInterval(h); resolve(st.parts || []); }
      else if (st.state === 'failed' || st.state === 'error') fail(h, st, 'script failed');
      else if (st.state === 'cancelled') fail(h, st, 'script cancelled');
    }, 500);
  });
}
scriptsView.initScriptsView({
  runScript: runScriptFlow,
  toast: (m, k, ms) => ui.toast(m, k, ms),
  onStateChange: () => updateAccents(),
});

// ── Tool controller (passed to tools.initTools) ───────────────────────
const toolCtx = {
  // The selection speaks in UNIT ids (a latticed row IS its lattice mesh).
  // `unitId` resolves a row id to the mesh an op must read; `rowId` goes back the
  // other way, to the app object a consume/delete has to take with it.
  unitId: (id) => unitIdOf(id),
  rowId: (id) => rowIdOf(id),
  // Wave-6/7 — NO tool has a part dropdown: they all BIND to the live selection
  // (pick order for BOOLEAN's A/B, the primary for everything else).
  selection: () => state.selection.slice(),
  primaryId: () => state.selectedPartId,
  partName: (id) => partById(id)?.name || '',
  partColor: (id) => { const p = partById(id); return p ? effectiveColorHex(p.colorHex, p.role) : null; },
  selectionBox: () => viewer.selectionBoxInfo(),
  unionCenter: () => viewer.getVisibleCenter(),
  // Where a fresh primitive of the given display height must be AUTHORED so it
  // stands display-up on the plate, plus the convention TRS (or null) that gets
  // it there. The viewer owns the axis math; the tool just reads it.
  primitiveSpawn: (sizeY, standing) => viewer.primitiveSpawn(sizeY, standing),
  voxelDefault: () => ui.readParams().voxelSizeMM,
  getPartTrs: (id) => state.parts.find((p) => p.id === id)?.trs || null,
  partBbox: (id) => state.parts.find((p) => p.id === id)?.bbox || null,
  // TRANSFORM panel live edit. Every keystroke lands here, so the command
  // COALESCES: successive edits to the same part fold into the one entry (its
  // `prev` stays the TRS the panel opened on) until some other action intervenes.
  setPartTransform: (id, trs, opts = {}) => {
    const p = state.parts.find((x) => x.id === id);
    if (!p) return;
    const prev = cloneTrs(p.trs);
    applyPanelTrs(id, trs);
    pushTrsCommand(id, prev, cloneTrs(trs), {
      label: opts.label || 'Transform (panel)',
      panel: true,
      // A one-shot write (the primitive's convention pose) must not fold into
      // the next panel keystroke, so it opts out of coalescing.
      coalesceKey: opts.once ? null : `panel-trs:${id}`,
    });
  },
  clearPartTransform: (id) => {
    const p = state.parts.find((x) => x.id === id);
    if (!p) return;
    const prev = cloneTrs(p.trs);
    applyPanelTrs(id, null);
    pushTrsCommand(id, prev, null, { label: 'Reset transform', panel: true });
  },
  runOp: (body, onProgress) => runOpFlow(body, onProgress),
  consumeSources: (ids, resultId, kind) => consumeSources(ids, resultId, kind),
  // SHELL · OPEN FACES. The VIEWER owns the picked set (it owns the face
  // geometry the ids name); the tool reads the count and, on CONFIRM, the
  // world-frame rectangles. Arming cancels SECTION / LAY FLAT inside the viewer,
  // so only one thing can ever mean "click a face".
  armOpenFaces: (id) => viewer.armOpenFacePick(id ? unitIdOf(id) : null),
  cancelOpenFaces: () => viewer.cancelOpenFacePick(),
  isOpenFacesArmed: () => viewer.isOpenFacePickArmed(),
  openFaceIds: () => viewer.openFaceIds(),
  clearOpenFaces: () => viewer.clearOpenFaces(),
  faceQuadData: (quadId) => viewer.getFaceQuadData(quadId),
  onStateChange: () => updateAccents(),
  toast: (msg, kind, ms) => ui.toast(msg, kind, ms),
};

// ══ The lattice IS the part — ONE object, ONE row ═════════════════════
// A finished generate does NOT add a second row. The SOURCE part absorbs its
// lattice:
//   source rec .latticePartId → the server-registered derived lattice part
//   lattice rec .hostPartId   → back-reference to the row that owns it
// The lattice stays a full part RECORD (mesh, TRS, export, history, server file)
// because everything downstream — viewer keys, undo snapshots, the export
// pipeline — addresses parts by id. What it is not is a ROW: the objects list,
// the mode logic and the context menu all speak in rows, and a latticed row
// shows the source's name with the lattice's numbers and a LATTICE badge.
//
// The viewer linkage is unchanged: the lattice mesh is the transform HOST and
// the source mesh rides it as a ghost, so moving the unit moves both. Selection
// therefore holds the LATTICE id for a latticed unit (routeSelection maps the
// row to it) and every row-facing reader maps back through rowIdOf.
function latticeOf(p) {
  const id = p && p.latticePartId;
  return id ? partById(id) : null;
}
/** Rows = everything that is its own object. A lattice is not (its source owns
 *  it) — unless its host is gone, in which case it stands alone rather than
 *  becoming an invisible object. */
function rowParts() {
  return state.parts.filter((p) => !p.isResult || !partById(p.hostPartId));
}
/** The ROW (app object) a part id belongs to: a lattice belongs to its source. */
function rowIdOf(id) {
  const p = partById(id);
  return (p && p.hostPartId && partById(p.hostPartId)) ? p.hostPartId : id;
}
/** The mesh a row's unit is keyed by in the viewer: its lattice when latticed. */
function unitIdOf(id) {
  const p = partById(id);
  return latticeOf(p)?.id || id;
}
/** "GYROID" / "SCHWARZ P" … for a lattice part, from its replay snapshot. */
function patternLabelOf(lat) {
  const patt = String(lat?.derived?.opParams?.pattern || '');
  return PATTERN_LABEL[patt] || (patt ? patt.toUpperCase() : 'TPMS');
}

// Row view-models for the objects list. A latticed row keeps the SOURCE's
// identity (name, role colour, row id) and shows the LATTICE's numbers: that
// mesh is what the eye toggles, what exports, and what a regenerate replaces.
function partRowVMs() {
  return rowParts().map((p) => {
    const lat = latticeOf(p);
    if (!lat) return p;
    return {
      ...p,
      latticed: true,
      latticeLabel: patternLabelOf(lat),
      triangles: lat.triangles,
      volumeMM3: lat.volumeMM3,
      sourceFormat: null,
      visible: lat.visible !== false,      // eye        → the lattice mesh
      ghostVisible: p.visible !== false,   // ghost icon → the source shell
      derived: { label: lat.derived?.label || `TPMS · ${patternLabelOf(lat)}` },
    };
  });
}

// ── Parts list interactions ───────────────────────────────────────────
function refreshParts() {
  // Frozen mid-gizmo-drag: rows rebuild on every refreshParts, which would tear
  // down the selection row under the cursor. The drag commits once on release,
  // where a single refreshParts runs.
  if (state.draggingGizmo) return;
  ui.renderParts(partRowVMs(), state.pending, {
    // drives the `.selected` (member) / `.primary` (last picked) row classes.
    // The selection speaks in unit ids; rows speak in row ids.
    selectedIds: state.selection.map(rowIdOf),
    primaryId: state.selectedPartId ? rowIdOf(state.selectedPartId) : null,
    // Row click mirrors the canvas exactly: plain = replace, Ctrl/Shift = toggle,
    // and neither touches the camera. Double-click focuses, also as in the canvas.
    onSelect: (id, mods) => pickSelect(id, mods || {}),
    onFocus: (id) => focusPart(id),
    onRoleChange: (id, role) => {
      const p = state.parts.find((x) => x.id === id);
      if (!p) return;
      const before = flagsSnapshot();   // whole role map — cascades ride along
      p.role = role;
      viewer.setPartRole(id, role);
      refreshParts();
      pushFlagsCommand(before, `Role → ${role}`);
    },
    // The eye owns the UNIT's mesh (the lattice when latticed); the ghost icon
    // owns the source shell behind it. Both are plain per-part visibility.
    onToggleVisible: (id) => toggleMeshVisible(unitIdOf(id)),
    onToggleGhost: (id) => toggleMeshVisible(id, 'ghost'),
    onColorChange: (id, hex) => setPartColor(id, hex),
    onRevertLattice: (id) => revertLattice(id),
    onDelete: (id) => deleteRow(id),
  });
  viewer.setVolumeHint(volumeMap());   // COM weights for fitView's no-selection pivot
  ui.setDropzoneBusy(state.pending.length > 0);
  updateMode();
  updateDims();   // union-bbox readout + SECTION availability track the visible set
  updateAccents();          // Fix 1 — refresh the single-fill slot for the new part/role set
  updateViewportContext();  // Fix 6 — mode may have changed with roles
  refreshExport();          // Wave-3 — the EXPORT tile lists the live part set
}

/** Flip one mesh's visibility (row eye, ghost icon) as one undoable flag change. */
function toggleMeshVisible(id, what) {
  const p = partById(id);
  if (!p) return;
  const before = flagsSnapshot();
  p.visible = p.visible === false;
  viewer.setPartVisible(id, p.visible);
  refreshParts();
  const noun = what === 'ghost' ? 'ghost' : 'part';
  pushFlagsCommand(before, `${p.visible ? 'Show' : 'Hide'} ${noun}`);
}

// ── BOOL / SMOOTH consume: the sources are GONE ───────────────────────
// A BOOL/SMOOTH result REPLACES its two inputs, and "replaces" is now literal:
// the source rows are REMOVED from the list, leaving exactly ONE part where
// there were two. Two boxes unioned therefore leave one row, one active base
// part, and GENERATE runs on the combined result immediately.
//
// This used to leave the sources listed as dimmed, locked "USED · BOOL" rows so
// deleting the result could hand them back. That made every op leave litter
// behind, and the restore path was a second, weaker undo that only the DELETE
// verb could reach. Undo is the restore path now — the ONE it should always
// have been:
//
//   the whole op is ONE history command (runOpFlow opens the group, tools.js
//   calls this synchronously on resolve, the group closes a macrotask later)
//   = create result + role flip + delete source A + delete source B.
//   Ctrl+Z runs that in reverse: both sources come back with their exact TRS,
//   role, colour and row position, and the result disappears.
//
// The server FILE outlives the delete exactly as it does for a hand delete —
// pushDeleteCommand defers it until the command falls off the stack — so an
// undone BOOL restores from the source's own mesh, not from a re-upload.
function consumeSources(ids, resultId, kind) {
  const res = partById(resultId);
  if (!res) return;
  const before = flagsSnapshot();
  res.role = 'part';                     // the combined part IS the new base
  viewer.setPartRole(res.id, 'part');
  // Joins the op's open group (see runOpFlow), ahead of the deletes so undo
  // unwinds them first and the roles land on parts that are back in the list.
  pushFlagsCommand(before, `${kind || 'BOOL'} result → part`);

  // A latticed row went in as ONE object, so the whole unit leaves: its lattice
  // mesh is what the op actually read (tools resolve inputs through unitId), and
  // leaving it behind would draw the same geometry twice. The lattice is deleted
  // FIRST so undo restores the source before the lattice that hangs off it.
  const victims = [];
  for (const sid of new Set(ids)) {
    const src = partById(sid);
    if (!src || src.id === resultId) continue;
    const lat = latticeOf(src);
    if (lat && lat.id !== resultId) victims.push(lat.id);
    victims.push(src.id);
  }
  for (const vid of victims) deletePart(vid);
  updateOrbitPivot();                    // the departed sources leave the COM
}

// Local removal — everything deleting a part does EXCEPT the server-side file
// delete, which is deferred so undo can put the part back from its own mesh.
function removePartLocal(id) {
  dropFromSelection(id);   // leave the selection first (the viewer drops it too)
  const rec = partById(id);
  // Deleting the lattice un-ghosts its sources; deleting a ghosted source only
  // detaches that one (the viewer drops the link either way in removePart).
  if (rec?.isResult) releaseLattice(rec);
  else if (rec?.ghosted) rec.ghosted = false;
  state.parts = state.parts.filter((x) => x.id !== id);
  viewer.removePart(id);
  refreshParts();
  updateOrbitPivot();       // one fewer mass in the COM
  syncSelToolbar();         // the toolbar may have just lost its last member
  tools.onPartsChanged();   // an open picker tool refreshes its part list
  tools.onSelectionChanged();
}

function deletePart(id) {
  const snap = snapshotPart(id);
  if (!snap) return;
  removePartLocal(id);
  pushDeleteCommand(snap);
}

// ══ Wave-4 · UNDO / REDO ══════════════════════════════════════════════
// Every user-visible mutation records a {undo, redo} pair on the history stack
// (js/history.js). Two rules make the hard cases work:
//
//  1. The server file OUTLIVES a local delete. `api.deletePart` is no longer
//     fired when a part is removed — the command holds a deferred delete that
//     runs only when the command falls off the stack (depth cap / clear / page
//     unload). Until then undo re-adds the part straight from its own mesh URL.
//  2. Side effects travel INSIDE the command. Deleting a lattice un-ghosts its
//     sources and an upload can flip two parts to positive/negative — so
//     commands snapshot the flag map (role · visible · ghost) whole and restore
//     it wholesale. A BOOL is a COMPOSITE instead: create result + delete both
//     sources, so one Ctrl+Z puts the sources back and takes the result away.
//
// Excluded on purpose: lattice ADOPTION (adoptLatticePart). A generate already
// replaces the previous lattice as part of its own recipe; making "undo the
// generate" a stack entry would fight regeneration, so the lattice is managed by
// GENERATE alone. Deleting a lattice by hand IS undoable.

const cloneJson = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));
const cloneTrs = cloneJson;

// Parts whose server file has already been released (never fire twice).
const flushedDeletes = new Set();
function flushServerDelete(id) {
  if (flushedDeletes.has(id)) return;
  flushedDeletes.add(id);
  // keepalive so a pagehide flush survives the navigation (DELETE is not
  // beaconable). Fire-and-forget: a failure just leaves a stale file behind.
  try { fetch(`/api/parts/${encodeURIComponent(id)}`, { method: 'DELETE', keepalive: true }).catch(() => {}); }
  catch { /* best effort */ }
}

// ── flag map (role · visibility · ghost, for every part) ─────────────
// Used for role changes, visibility toggles and the BOOL role flip alike: snapshot
// before, snapshot after, restore wholesale. Cascades and lock states that a
// single-field diff would miss come along for free.
function flagsSnapshot() {
  const parts = {};
  for (const p of state.parts) {
    parts[p.id] = {
      role: p.role,
      visible: p.visible !== false,
      ghosted: !!p.ghosted,
      sourceIds: (p.sourceIds || []).slice(),
      // unit linkage: which lattice this row absorbed / which row owns this lattice
      latticePartId: p.latticePartId || null,
      hostPartId: p.hostPartId || null,
    };
  }
  return { parts, latticePartId: state.latticePartId };
}
function applyFlags(snap) {
  if (!snap) return;
  for (const p of state.parts) {
    const f = snap.parts[p.id];
    if (!f) continue;                       // created after the snapshot — left alone
    if (p.role !== f.role) { p.role = f.role; viewer.setPartRole(p.id, f.role); }
    if ((p.visible !== false) !== f.visible) { p.visible = f.visible; viewer.setPartVisible(p.id, f.visible); }
    p.ghosted = f.ghosted;
    p.latticePartId = f.latticePartId;
    if (p.isResult) { p.sourceIds = f.sourceIds.slice(); p.hostPartId = f.hostPartId; }
  }
  state.latticePartId = snap.latticePartId;
  // The scene-wide ghost dim follows whether a lattice is on the plate.
  if (state.latticePartId && partById(state.latticePartId)) viewer.dimUploaded();
  else viewer.undimUploaded();
}
function pushFlagsCommand(before, label) {
  if (history.isBusy()) return;
  const after = flagsSnapshot();
  if (JSON.stringify(before) === JSON.stringify(after)) return;   // no-op
  history.push({
    label,
    undo: () => { applyFlags(before); afterHistory(); },
    redo: () => { applyFlags(after);  afterHistory(); },
  });
}

// ── TRS commands ──────────────────────────────────────────────────────
// In-canvas commit (gizmo drag, plate drag, lay-flat, DROP, auto-drop-after-
// rotate): one command per commit — the viewer already grounds a rotation into
// the SAME trs it hands to onTransformCommit, so a rotate+drop is one entry.
function applyCommitTrs(id, trs) {
  const p = partById(id);
  if (p) p.trs = cloneTrs(trs);
  viewer.setPartTransform(id, cloneTrs(trs), { fit: false });
  updateDims();
  updateOrbitPivot();       // commit only — never inside onTransformLive
  tools.onSelectionChanged();   // re-sync an open XFORM tool (fields + readout)
}
// TRANSFORM panel path — keeps the panel's fit-on-commit and its stale-source note.
function applyPanelTrs(id, trs) {
  const p = partById(id);
  if (p) p.trs = cloneTrs(trs);
  viewer.setPartTransform(id, cloneTrs(trs));
  updateDims();
  tools.onSelectionChanged();   // readout rows follow (the focused field is skipped)
  if (p) markSourceMoved(p);
}
function trsEqual(a, b) { return JSON.stringify(nonIdentityTrs(a)) === JSON.stringify(nonIdentityTrs(b)); }

function pushTrsCommand(id, prev, next, opts = {}) {
  if (history.isBusy() || trsEqual(prev, next)) return;
  const apply = opts.panel ? applyPanelTrs : applyCommitTrs;
  const cmd = {
    label: opts.label || 'Transform',
    key: opts.coalesceKey || null,
    prev, next,
    undo: () => { apply(id, cloneTrs(cmd.prev)); afterHistory(); },
    redo: () => { apply(id, cloneTrs(cmd.next)); afterHistory(); },
  };
  // Panel edits fire per keystroke: fold into the entry this editing session
  // already owns (its `prev` is the TRS the panel opened on) instead of flooding
  // the stack. Any other action ends the run — the key no longer matches the top.
  if (cmd.key) {
    const top = history.peekUndo();
    if (top && top.key === cmd.key) { top.next = cmd.next; history.touch(); return; }
  }
  history.push(cmd);
}

// ── part snapshot / restore (delete ⇄ create) ─────────────────────────
// Everything needed to put a part back exactly as it was: the record, its mesh
// URL, its slot in the list, and the side-effect state its removal unwound.
function snapshotPart(id) {
  const rec = partById(id);
  if (!rec) return null;
  return {
    id,
    index: state.parts.findIndex((p) => p.id === id),
    rec: cloneJson(rec),   // carries trs · role · colorHex · visibility verbatim
    stlUrl: rec.stlUrl || api.partMeshUrl(id),
    solid: rendersSolid(rec),   // a lattice, or an un-latticed script output
    wasLattice: state.latticePartId === id,
    // lattice host: which sources it currently holds as ghosts
    ghostIds: rec.isResult ? (rec.sourceIds || []).filter((sid) => partById(sid)?.ghosted) : [],
  };
}

async function restorePart(snap) {
  if (!snap || partById(snap.id)) return;
  const rec = cloneJson(snap.rec);
  const at = Math.min(Math.max(snap.index, 0), state.parts.length);
  state.parts.splice(at, 0, rec);                 // same row position as before
  try {
    // The server file was never deleted — the mesh streams straight back, with
    // the part's own colour override (if any) applied at load, so a restored
    // part is the SAME colour it was, not its role's.
    await viewer.addPart(snap.id, snap.stlUrl, rec.role, {
      solid: snap.solid, lattice: !!rec.isResult, colorHex: rec.colorHex || null,
    });
  } catch (err) {
    ui.toast(`Could not restore "${rec.name}": ${err.message}`, 'error', 9000);
    state.parts = state.parts.filter((p) => p.id !== snap.id);
    throw err;
  }
  if (rec.trs) viewer.setPartTransform(snap.id, cloneTrs(rec.trs), { fit: false });
  if (rec.visible === false) viewer.setPartVisible(snap.id, false);

  if (snap.wasLattice) state.latticePartId = snap.id;
  if (rec.isResult) {                              // lattice: re-ghost + re-link
    for (const sid of snap.ghostIds) {
      const s = partById(sid);
      if (!s) continue;
      s.ghosted = true;
      viewer.setPartSolid(sid, false);   // a solid script source is a shell again
    }
    viewer.linkGhosts(snap.id, snap.ghostIds);
    viewer.dimUploaded();
    // …and the row that owns it takes it back, so the pair reads as one object
    // again (a deleted unit restores linked, in one Ctrl+Z).
    const host = rec.hostPartId ? partById(rec.hostPartId) : null;
    if (host) host.latticePartId = snap.id;
  }
  if (rec.ghosted && !rec.isResult) {              // ghost source: rejoin its lattice
    const lat = state.parts.find((x) => x.isResult && (x.sourceIds || []).includes(snap.id));
    if (lat) viewer.linkGhosts(lat.id, (lat.sourceIds || []).filter((sid) => partById(sid)?.ghosted));
  }
  syncViewerRoles();
}

// DELETE — currently removed; undo restores, redo removes again, and the server
// file is released only once the command can never be reached again.
function pushDeleteCommand(snap) {
  if (history.isBusy()) return;
  const st = { snap, removed: true };
  history.push({
    label: `Delete ${snap.rec.name}`,
    undo: async () => { await restorePart(st.snap); st.removed = false; afterHistory(); },
    redo: () => { st.snap = snapshotPart(st.snap.id) || st.snap; removePartLocal(st.snap.id); st.removed = true; afterHistory(); },
    dispose: () => { if (st.removed) flushServerDelete(st.snap.id); },
  });
}
// CREATE — the mirror image: currently present; undo removes (deferring the
// server delete through the same mechanism), redo re-adds.
function pushCreateCommand(id, label) {
  if (history.isBusy()) return;
  const snap = snapshotPart(id);
  if (!snap) return;
  const st = { snap, removed: false };
  history.push({
    label: label || `Create ${snap.rec.name}`,
    undo: () => { st.snap = snapshotPart(id) || st.snap; removePartLocal(id); st.removed = true; afterHistory(); },
    redo: async () => { await restorePart(st.snap); st.removed = false; afterHistory(); },
    dispose: () => { if (st.removed) flushServerDelete(id); },
  });
}

// Single refresh entry point after any undo/redo: rows, mode note, dims, accent
// budget, viewport context, export tile, orbit pivot, selection toolbar, and an
// open tool's part list all re-derive from state here.
function afterHistory() {
  syncViewerRoles();
  // Undo/redo adds and removes parts under the selection — re-derive it so the
  // set can never hold an id that no longer exists, and so a row that just
  // became (or stopped being) a lattice unit points at the right mesh again.
  const live = normalizeSelection(state.selection, { quiet: true });
  if (live.join('|') !== state.selection.join('|')) {
    state.selection = live;
    viewer.setSelected(live);
    if (!live.length) { state.gizmoMode = null; viewer.stopGizmo(); }
  }
  refreshParts();
  updateOrbitPivot();
  syncSelToolbar();
  tools.onPartsChanged();
  tools.onSelectionChanged();
}

// ── keyboard + header buttons ─────────────────────────────────────────
function isTypingTarget(el) {
  if (!el) return false;
  const tag = (el.tagName || '').toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable === true;
}
/** A HUD dialog is up (MCP, or any future .hud-modal) — it owns the keyboard.
 *  The PROJECT OPEN guard counts: while it is asking, ESC is its answer and
 *  Ctrl+Z would be editing a scene the user is about to replace. */
function modalOpen() {
  return ui.isProjectAskOpen()
      || !!document.querySelector('.hud-overlay:not([hidden]), .hud-modal:not([hidden])');
}

document.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
  const k = (e.key || '').toLowerCase();
  const isUndo = k === 'z' && !e.shiftKey;
  const isRedo = (k === 'z' && e.shiftKey) || k === 'y';
  if (!isUndo && !isRedo) return;
  // A text field keeps its NATIVE undo — typing in the filename box is not a
  // model edit. Same for an open dialog.
  if (isTypingTarget(e.target) || isTypingTarget(document.activeElement)) return;
  if (modalOpen()) return;
  e.preventDefault();
  if (isUndo) history.undo(); else history.redo();
});

history.setErrorHandler((msg) => ui.toast(msg, 'error', 9000));
ui.els.undoBtn?.addEventListener('click', () => history.undo());
ui.els.redoBtn?.addEventListener('click', () => history.redo());
history.onChange((s) => {
  const u = ui.els.undoBtn, r = ui.els.redoBtn;
  if (u) { u.disabled = !s.canUndo; u.title = s.canUndo ? `Undo ${s.undoLabel} (Ctrl+Z)` : 'Nothing to undo (Ctrl+Z)'; }
  if (r) { r.disabled = !s.canRedo; r.title = s.canRedo ? `Redo ${s.redoLabel} (Ctrl+Shift+Z)` : 'Nothing to redo (Ctrl+Shift+Z)'; }
});

// Leaving the page settles the deferred server deletes: every command still on
// the stack disposes, and the ones holding a removed part release its file.
window.addEventListener('pagehide', () => history.clear());

// ══ PROJECT SAVE / OPEN — the whole session as ONE `.anvil` file ═══════
// An `.anvil` is a ZIP: `project.json` (the row manifest, the LATTICE panel
// values and the UP convention) plus one binary STL per row and, for a latticed
// row, its lattice mesh alongside. See server\Api\ProjectEndpoints.cs.
//
// The contract that makes it worth having:
//   · COORDINATES ARE VERBATIM. The STL bytes are copied untransformed and each
//     row's non-destructive TRS travels in the manifest, so an export taken
//     after an open is byte-identical to one taken before the save.
//   · A LATTICED ROW SURVIVES AS ONE OBJECT. The lattice mesh, its host, the
//     ghost linkage and both visibility flags come back, so the reopened unit
//     still moves as a body and REVERT still gives the plain part back.
//   · SCRIPTS ARE NOT BUNDLED. They live in the server-side library (SCRIPTS
//     view) and are shared across projects on purpose.
//   · OPENING RESETS UNDO. It is a new document; an undo stack that could
//     "unwind" past the open into the previous session would be a lie. The
//     success toast says so.
// Saving pushes NOTHING onto the history stack — it is a read of the scene.

/** The save payload: one entry per ROW, in objects-list order. */
function buildProjectPayload() {
  const rows = rowParts();
  const rowIndex = new Map(rows.map((p, i) => [p.id, i]));
  const parts = rows.map((p, i) => {
    const lat = latticeOf(p);
    const entry = {
      partId: p.id,
      latticePartId: lat ? lat.id : null,
      name: p.name,
      role: p.role,
      colorHex: p.colorHex || null,
      sourceFormat: p.sourceFormat || null,
      // The eye owns the UNIT mesh (the lattice when latticed); the ghost icon
      // owns the source shell behind it — exactly as partRowVMs reads them.
      visible: lat ? lat.visible !== false : p.visible !== false,
      ghostVisible: p.visible !== false,
      trs: nonIdentityTrs(p.trs),
    };
    if (lat) {
      // A latticed unit is transformed through its LATTICE (the viewer's link
      // host), so that record holds the pose the user sees.
      entry.latticeTrs = nonIdentityTrs(lat.trs);
      // Which ROWS ride this lattice as ghosts — a fuse or zoned generate has
      // more than one. Stored as row INDICES because part ids are re-minted on
      // open, and an index is stable across that.
      const idx = [...new Set((lat.sourceIds || [])
        .map((sid) => rowIndex.get(rowIdOf(sid)))
        .filter((n) => n != null))];
      entry.latticeSourceRows = idx.length ? idx : [i];
    }
    return entry;
  });
  return { parts, upAxis: viewer.upAxis(), latticeParams: ui.readParams() };
}

function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

async function onProjectSave() {
  const rows = rowParts();
  if (!rows.length) { ui.toast('Nothing to save yet - add a part first.', 'warn'); return; }
  ui.closeProjectAsk();
  try {
    const { blob, fileName } = await api.saveProject(buildProjectPayload());
    downloadBlob(blob, fileName);
    ui.toast(`Project saved - ${rows.length} ${rows.length === 1 ? 'part' : 'parts'} in ${fileName}`,
      'success', 5500);
  } catch (err) {
    ui.toast(`Save failed: ${err.message}`, 'error', 11000);
  }
}

/** Wipe the session down to an empty document. Undo is CLEARED, not rewritten. */
function clearSceneForOpen() {
  stopPolling();
  if (state.stepPoll) { clearInterval(state.stepPoll); state.stepPoll = null; }
  stopPreview(null);
  history.clear();          // opening resets undo (and settles deferred deletes)

  const gone = state.parts.map((p) => p.id);
  state.selection = [];
  viewer.setSelected([]);
  state.gizmoMode = null;
  state.layFlatArmed = false;
  viewer.stopGizmo();
  for (const id of gone) viewer.removePart(id);
  state.parts = [];
  state.pending = [];
  state.latticePartId = null;
  state.job = null;
  state.resultStats = null;
  state.resultFresh = false;
  viewer.undimUploaded();
  ui.hideResult();
  ui.showProgress(false);
  exportUi.dirty.clear();
  exportUi.nameDirty = false;
  refreshParts();
  // The previous session's server-side meshes are unreachable now (no undo can
  // ask for them back), so release their files.
  for (const id of gone) flushServerDelete(id);
}

/** Rebuild the whole session from a /project/open response. */
async function rebuildFromProject(doc) {
  clearSceneForOpen();
  const rows = doc.parts || [];

  // ── pass 1 — every SOURCE part becomes a row, in the saved order ──────
  const newIdByRow = [];
  for (const row of rows) {
    const part = row.part;
    if (!part) { newIdByRow.push(null); continue; }
    const rec = {
      id: part.id,
      name: row.name || part.name,
      triangles: part.triangles,
      sourceFormat: row.sourceFormat || part.sourceFormat,
      role: row.role || 'part',
      // A latticed row's eye drives the LATTICE mesh; the source shell answers
      // to the ghost icon, so its visibility comes from ghostVisible.
      visible: row.latticed ? row.ghostVisible !== false : row.visible !== false,
      volumeMM3: part.volumeMM3,
      bbox: part.bbox,
      derived: part.derived || null,
      trs: row.trs || null,
      colorHex: row.colorHex || null,
      stlUrl: part.stlUrl || api.partMeshUrl(part.id),
    };
    state.parts.push(rec);
    newIdByRow.push(rec.id);
    try {
      // A saved script output comes back solid; pass 2 turns it into a ghost
      // shell again if the row it belongs to is latticed.
      await viewer.addPart(rec.id, rec.stlUrl, rec.role, {
        solid: rendersSolid(rec), lattice: false, colorHex: rec.colorHex,
      });
      if (rec.trs) viewer.setPartTransform(rec.id, cloneTrs(rec.trs), { fit: false });
      if (rec.visible === false) viewer.setPartVisible(rec.id, false);
    } catch (err) {
      ui.toast(`"${rec.name}" loaded, but its 3D preview failed: ${err.message}`, 'warn');
    }
  }

  // ── pass 2 — re-adopt each lattice (needs every source row to exist) ──
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const lp = row.latticePart;
    const host = newIdByRow[i] ? partById(newIdByRow[i]) : null;
    if (!row.latticed || !lp || !host) continue;

    const ghostIds = [...new Set((row.latticeSourceRows || [i])
      .map((n) => newIdByRow[n])
      .filter(Boolean))];
    if (!ghostIds.includes(host.id)) ghostIds.unshift(host.id);

    const lrec = {
      id: lp.id,
      name: host.name,          // the row's identity — the lattice IS the part
      serverName: lp.name,
      triangles: lp.triangles,
      sourceFormat: lp.sourceFormat || 'derived',
      role: host.role,
      visible: row.visible !== false,
      volumeMM3: lp.volumeMM3,
      bbox: lp.bbox,
      derived: lp.derived || null,
      trs: row.latticeTrs || null,
      stlUrl: lp.stlUrl || api.partMeshUrl(lp.id),
      isResult: true, hostPartId: host.id, sourceIds: ghostIds,
      colorHex: host.colorHex || null,
    };
    state.parts.push(lrec);
    state.latticePartId = lrec.id;
    host.latticePartId = lrec.id;
    for (const gid of ghostIds) {
      const g = partById(gid);
      if (!g) continue;
      g.ghosted = true;
      viewer.setPartSolid(gid, false);   // a solid script source reverts to a shell
    }

    try {
      await viewer.addPart(lrec.id, lrec.stlUrl, lrec.role, { solid: true, colorHex: lrec.colorHex });
      // The lattice's own pose lands FIRST: linkGhosts captures each ghost's own
      // matrix as its base and composes it under the host matrix already set here.
      if (lrec.trs) viewer.setPartTransform(lrec.id, cloneTrs(lrec.trs), { fit: false });
      if (lrec.visible === false) viewer.setPartVisible(lrec.id, false);
      viewer.linkGhosts(lrec.id, ghostIds);
      viewer.dimUploaded();
    } catch (err) {
      ui.toast(`"${lrec.name}" lattice loaded, but its 3D preview failed: ${err.message}`, 'warn');
    }
  }

  // ── document-level state: UP convention + the LATTICE panel ───────────
  if (doc.upAxis && doc.upAxis !== viewer.upAxis()) {
    const applied = viewer.setUpAxis(doc.upAxis);
    try { localStorage.setItem(UP_KEY, applied); } catch { /* private mode */ }
    syncUpChips(applied);
  }
  ui.applyParams(doc.latticeParams);
  pushPreviewParams();

  // NOT applyAutoRoles(): the saved roles ARE the answer. Two plain "Part" rows
  // in a bundle were saved that way on purpose, and the auto positive/negative
  // flip would silently overrule the user's own document.
  syncViewerRoles();
  refreshParts();
  refreshExport();
  updateOrbitPivot();
  updateDims();
  syncSelToolbar();
  tools.onPartsChanged();
  tools.onSelectionChanged();
  viewer.fitView({ union: true });
}

async function openProjectFile(file) {
  if (!/\.anvil$/i.test(file.name)) {
    ui.toast(`"${file.name}" is not a .anvil project file.`, 'warn');
    return;
  }
  let doc;
  // The upload happens BEFORE anything is cleared: a malformed bundle leaves the
  // current scene exactly as it was, with only a toast to show for it.
  try {
    doc = await api.openProject(file);
  } catch (err) {
    ui.toast(`Could not open "${file.name}": ${err.message}`, 'error', 11000);
    return;
  }
  try {
    await rebuildFromProject(doc);
  } catch (err) {
    ui.toast(`Project opened with errors: ${err.message}`, 'error', 11000);
    return;
  }
  const n = doc.parts?.length || 0;
  ui.toast(`Project opened - ${n} ${n === 1 ? 'part' : 'parts'}. Undo history was cleared.`,
    'success', 6500);
}

ui.initProjectAsk();
ui.els.projectSaveBtn?.addEventListener('click', (e) => { e.preventDefault(); onProjectSave(); });
ui.els.projectOpenBtn?.addEventListener('click', (e) => {
  e.preventDefault();
  if (ui.isProjectAskOpen()) { ui.closeProjectAsk(); return; }
  // An empty plate has nothing to lose — no question asked.
  if (rowParts().length === 0) { ui.els.projectFile?.click(); return; }
  ui.askProjectOpen('Opening replaces the current scene - continue?', (go) => {
    if (go) ui.els.projectFile?.click();
  });
});
ui.els.projectFile?.addEventListener('change', () => {
  const f = ui.els.projectFile.files?.[0] || null;
  ui.els.projectFile.value = '';
  if (f) openProjectFile(f);
});

// ── Mode logic (roles → single | fuse | disabled) ─────────────────────
// BASE roles (part/positive/negative) decide the mode exactly as before; ZONE
// roles (lattice/keep/void) layer on top and require a valid base part. Generate
// is gated on FULL validity (base valid AND, if zones exist, a base to hang them
// on). computeMode returns { mode, valid, partId|positiveId+negativeId, zones? }.
// A generated lattice is NEVER a generate input: regeneration always derives
// from the ORIGINAL sources (which stay in the list, ghosted), so GENERATE
// re-runs the same recipe and replaces the lattice part.
// What the SELECTION targets, as row records: base-role, not a lattice mesh,
// de-duplicated, in pick order. Zone parts are dropped — zones
// always layer on by role, they are never the thing being latticed.
function selectionTargets() {
  const seen = new Set();
  const out = [];
  for (const sid of state.selection) {
    const id = rowIdOf(sid);
    if (seen.has(id)) continue;
    seen.add(id);
    const p = partById(id);
    if (!p || p.isResult || !isBaseRole(p.role)) continue;
    out.push(p);
  }
  return out;
}

function computeMode() {
  const base = state.parts.filter((p) => !p.isResult && isBaseRole(p.role));
  const zones = state.parts.filter((p) => !p.isResult && isZoneRole(p.role));
  const part = base.filter((p) => p.role === 'part');
  const pos  = base.filter((p) => p.role === 'positive');
  const neg  = base.filter((p) => p.role === 'negative');

  if (state.parts.length === 0)
    return { valid: false, note: 'Upload an STL or STEP part to begin.' };

  // Resolve the base mode (or null if the base roles are not a valid combo).
  let baseMode = null, baseInfo = {}, pickedNote = '';

  // ── Selection first: pick a part, lattice THAT part ──────────────────
  // One eligible part selected → single mode on it. Two selected holding
  // positive + negative → fuse those two. Anything else falls through to the
  // role-derived logic below, so the roles-only workflow is untouched.
  const picked = selectionTargets();
  if (picked.length === 1) {
    baseMode = 'single'; baseInfo = { partId: picked[0].id };
    // "lattice", not "gyroidize": the pattern picker offers five TPMS surfaces
    // and only one of them is a gyroid (matches the PATTERN tooltip copy).
    pickedNote = `SELECTED: ${picked[0].name} - lattice this part`;
  } else if (picked.length === 2) {
    const pp = picked.find((p) => p.role === 'positive');
    const nn = picked.find((p) => p.role === 'negative');
    if (pp && nn) {
      baseMode = 'fuse'; baseInfo = { positiveId: pp.id, negativeId: nn.id };
      pickedNote = `SELECTED: ${nn.name} into ${pp.name} - lattice the cavity and fuse`;
    }
  }

  if (!baseMode && part.length === 1 && pos.length === 0 && neg.length === 0) {
    baseMode = 'single'; baseInfo = { partId: part[0].id };
  } else if (!baseMode && pos.length === 1 && neg.length === 1 && part.length === 0) {
    baseMode = 'fuse'; baseInfo = { positiveId: pos[0].id, negativeId: neg[0].id };
  }

  if (!baseMode) {
    // Invalid base. If zones exist with no valid base, say so first (the gate the
    // plan calls out); otherwise diagnose the base-role combination as before.
    let note;
    if (base.length === 0 && zones.length > 0)
      note = 'Zones need a base part. Set one part to "Part" (single) or one Positive + one Negative (fuse).';
    else if (part.length > 1)
      note = `${part.length} parts are set to "Part" — select the one to lattice, or change the extras to a zone role.`;
    else if (pos.length + neg.length > 0 && part.length > 0)
      note = 'Mixed base roles: use one Part (single) OR one Positive + one Negative (fuse).';
    else if (pos.length === 1 && neg.length === 0)
      note = 'Add a Negative (cavity) part to fuse — or set the Positive to "Part" for single mode.';
    else if (neg.length === 1 && pos.length === 0)
      note = 'Add a Positive part to fuse — or set the Negative to "Part" for single mode.';
    else if (pos.length > 1 || neg.length > 1)
      note = 'Fuse needs exactly one Positive and one Negative.';
    else
      note = 'Set one Part (single) or one Positive + one Negative (fuse).';
    return { valid: false, note };
  }

  // Base is valid. Assemble zone membership (empty arrays are fine).
  const m = { mode: baseMode, valid: true, ...baseInfo };
  if (zones.length) {
    m.zones = {
      latticeIds: zones.filter((p) => p.role === 'zone-lattice').map((p) => p.id),
      keepIds:    zones.filter((p) => p.role === 'zone-keep').map((p) => p.id),
      voidIds:    zones.filter((p) => p.role === 'zone-void').map((p) => p.id),
    };
  }
  // The note ALWAYS names the target, so it is never a guess what GENERATE is
  // about to lattice — whether the target came from the selection or the roles.
  const nameOf = (id) => partById(id)?.name || 'part';
  const zoneNote = zones.length ? ` · ${zones.length} zone${zones.length > 1 ? 's' : ''}` : '';
  m.note = (pickedNote || (baseMode === 'single'
    ? `Single mode: lattice ${nameOf(m.partId)}.`
    : `Fuse mode: lattice ${nameOf(m.negativeId)} and merge into ${nameOf(m.positiveId)}.`)) + zoneNote;
  return m;
}

function updateMode() {
  const m = computeMode();
  ui.setMode(m.valid, m.note);
  ui.setOverlapEnabled(m.mode === 'fuse');
  // Progressive disclosure: the ZONES tile appears once any zone role exists.
  ui.setZonesVisible(state.parts.some((p) => isZoneRole(p.role)));
  // The live preview always previews what GENERATE would build, so the target
  // re-derives from the SAME mode result (selection, roles and part set alike).
  syncPreviewTarget(m);
  return m;
}

// ── Accent budget + live viewport context (Fix 1 / Fix 6) ──────────────
// The solid --primary fill is a single-occupancy slot tied to the next primary
// action: pinned GENERATE while armed/generating, EXPORT once a fresh result
// exists. Empty & invalid states carry no fill (ghost GENERATE via CSS).
//
// The invariant is exactly one VISIBLE solid fill, and "visible" is the load-
// bearing word now that EXPORT is a right-panel VIEW rather than a tile that is
// always on screen. With a fresh result the export slot has two possible
// holders and precisely one of them is showing at any moment:
//   · EXPORT view open   → the in-panel #export-btn (toolbar EXPORT lit-active)
//   · EXPORT view closed → the TOOLBAR EXPORT button, which is always visible
//                          and is itself the way into the view
// Never both, never neither. Anything that changes which view the right panel
// shows (or collapses it) has to re-run this — see the setRightView callers and
// the right-chevron listener.
function updateAccents() {
  const exportShowing = ui.isExportViewVisible();
  // Sets the ONE export fill on whichever button is currently on screen.
  const exportFill = (on) => {
    ui.setExportStlFilled(on && exportShowing);
    ui.setTbExportFilled(on && !exportShowing);
  };
  // toolOpen wins the single solid fill: an open, valid tool's CONFIRM holds it
  // while GENERATE + EXPORT ghost; the slot returns to the generate/export
  // machine the moment the tool closes. Exactly one solid fill at all times.
  if (tools.isOpen()) {
    ui.setToolConfirmFilled(tools.isValid());
    scriptsView.setRunFilled(false);
    ui.setAddPartFilled(false);
    ui.setGenerateFilled(false);
    exportFill(false);
    return;
  }
  ui.setToolConfirmFilled(false);
  // The SCRIPTS view sits at the same rung as an open tool: its RUN is that
  // view's CONFIRM, so it holds the single fill whenever there is code to run.
  // While a run is in flight RUN paints its own .generating pulse instead (CSS
  // steps every other .solid back for the duration).
  if (scriptsView.isOpen()) {
    scriptsView.setRunFilled(scriptsView.canRun());
    ui.setAddPartFilled(false);
    ui.setGenerateFilled(false);
    exportFill(false);
    return;
  }
  scriptsView.setRunFilled(false);
  // EMPTY scene: the only useful next action is ADD PART, so it takes the slot
  // (GENERATE is disabled anyway and ghosts via CSS). Same predicate as the
  // viewport hint, so the hint and the lit button always appear together — and
  // it deliberately stays lit through an in-flight import, since dropping it
  // there would leave a frame with NO solid fill at all.
  if (state.parts.length === 0 && !state.job) {
    ui.setAddPartFilled(true);
    ui.setGenerateFilled(false);
    exportFill(false);
    return;
  }
  ui.setAddPartFilled(false);
  const generating = ui.isGenerating();
  const fresh = state.resultFresh && !generating;
  const genEnabled = !ui.els.generate.disabled;   // false while generating (disabled) or invalid
  ui.setGenerateFilled(generating || (genEnabled && !fresh));
  exportFill(fresh);
}

const PATTERN_LABEL = {
  gyroid: 'GYROID', schwarzP: 'SCHWARZ P', schwarzD: 'SCHWARZ D',
  lidinoid: 'LIDINOID', neovius: 'NEOVIUS',
};
// Top-left viewport line: "PATTERN · LATTICE · MODE", from live state.
function updateViewportContext() {
  const patt = PATTERN_LABEL[ui.els.pattern.value] || (ui.els.pattern.value || '').toUpperCase();
  const lat  = ui.getLatticeType().toUpperCase();
  const mode = (computeMode().mode || 'single').toUpperCase();
  ui.setViewportContext(`${patt} · ${lat} · ${mode}`);
}

// Any generation-affecting param change re-arms the primary action (the shown
// result is no longer fresh). Only the LEFT panel feeds this, so the STEP target
// (an export-only budget, and now a control of the EXPORT tile) never does.
function markParamsDirty() {
  state.resultFresh = false;
  updateAccents();
  updateViewportContext();
}

// ── LIVE PREVIEW (GPU raymarch of the TPMS field) ─────────────────────
// The preview previews GENERATE, so its target is whatever GENERATE would
// lattice: the selected/role part in single mode, the NEGATIVE in fuse mode
// (the cavity IS the volume that gets filled). Everything else the preview needs
// lives in the viewer; main only owns "what" and "when".
//
// State is SESSION ONLY. Nothing here is written to localStorage, and nothing
// here touches the accent budget: both controls are segmented groups, which
// carry --primary as INK on a --muted seat, never as a fill.
function previewTargetId(m) {
  const mm = m || computeMode();
  if (!mm.valid) return null;
  return mm.mode === 'fuse' ? (mm.negativeId || null) : (mm.partId || null);
}

// The preview STANDS IN for the target, so while it is up:
//   · the target's own ghost drops to DIM (two coincident volumes otherwise);
//   · any BAKED lattice hides — the same object at two fidelities must never be
//     drawn on top of itself.
function applyPreviewScene() {
  const on = viewer.preview.isEnabled();
  viewer.setPreviewDim(on ? viewer.preview.getTarget() : null);
  viewer.setResultHidden(on && !!(state.latticePartId || viewer.result));
}

function syncPreviewTarget(m) {
  viewer.preview.setTarget(previewTargetId(m));
  applyPreviewScene();
}

/** Turn the preview off from OUTSIDE the seg (a finished bake). */
function stopPreview(note) {
  if (!viewer.preview.isEnabled()) return false;
  viewer.preview.setEnabled(false);
  ui.setPreviewOn(false);
  ui.setPreviewNote(null);
  applyPreviewScene();
  if (note) ui.toast(note, 'info', 4500);
  return true;
}

ui.initPreviewControls(
  (on) => {
    if (on) {
      viewer.preview.setParams(ui.readParams());
      viewer.preview.setTarget(previewTargetId());
    }
    viewer.preview.setEnabled(on);
    applyPreviewScene();
    if (!on) ui.setPreviewNote(null);
  },
  (q) => viewer.preview.setQuality(q),
);
viewer.preview.onNote = (text) => ui.setPreviewNote(viewer.preview.isEnabled() ? text : null);
viewer.preview.setQuality(ui.getPreviewQuality());
viewer.preview.setParams(ui.readParams());

// Every LATTICE control feeds the shader on `input` — the steppers fire it
// continuously, which is what makes a cell-size scrub grow the cells frame by
// frame instead of on release.
function pushPreviewParams() {
  if (viewer.preview.isEnabled()) viewer.preview.setParams(ui.readParams());
}

// ── Generate ──────────────────────────────────────────────────────────
ui.els.generate.addEventListener('click', onGenerate);
ui.els.cancel.addEventListener('click', onCancel);

async function onGenerate() {
  const m = updateMode();
  if (!m.valid) return;
  const params = ui.readParams();

  const body = {
    mode: m.mode,
    pattern: params.pattern,
    cellSizeMM: params.cellSizeMM,
    wallThicknessMM: params.wallThicknessMM,
    voxelSizeMM: params.voxelSizeMM,
    overlapMM: params.overlapMM,
    smoothOffsetMM: params.smoothOffsetMM,
    cleanup: params.cleanup,

    // flow-metrics v1
    latticeType: params.latticeType,
    flowAxis: params.flowAxis,
    rotationDeg: params.rotationDeg,
    phaseOffset: params.phaseOffset,
    refFlowLpm: params.refFlowLpm,
  };
  // Skeletal lattices bias the field instead of setting a wall thickness.
  if (params.latticeType === 'skeletal') body.biasMM = params.biasMM;
  // Per-axis cell sizes are only sent when the user opted in (omit → uniform).
  if (params.cellSizeXYZ) body.cellSizeXYZ = params.cellSizeXYZ;

  if (m.mode === 'single') body.partId = m.partId;
  else { body.positiveId = m.positiveId; body.negativeId = m.negativeId; }

  // Wave-1 zoned generate: attach zone membership + the zone-offset steppers.
  if (m.zones) {
    const z = ui.readZones();
    body.zones = {
      latticeIds: m.zones.latticeIds,
      keepIds: m.zones.keepIds,
      voidIds: m.zones.voidIds,
      skinThicknessMM: z.skinThicknessMM,
      transitionMM: z.transitionMM,
      keepOutGrowMM: z.keepOutGrowMM,
    };
  }
  // Per-part non-destructive TRS, keyed by part id — only non-identity ones, and
  // only for parts actually in this job (base + zone). Field is translateMM.
  const transforms = collectTransforms(m);
  if (Object.keys(transforms).length) body.transforms = transforms;

  stopPolling();
  state.resultFresh = false;   // Fix 1 — old result hidden; GENERATE is the sole fill now
  ui.hideResult();
  ui.showProgress(true);
  ui.setProgress(0, 'Queued…');
  updateAccents();

  let jobId;
  try {
    const res = await api.createJob(body);
    jobId = res.jobId;
    if (res.warning) ui.toast(res.warning, 'warn', 9000);
  } catch (err) {
    ui.showProgress(false);
    ui.toast(err.message, 'error', 11000);   // surfaces the resolution-guard 400
    updateAccents();
    return;
  }

  state.currentJobId = jobId;
  pollJob(jobId, params.stepTargetTriangles);
}

function pollJob(jobId, stepTarget) {
  state.poll = setInterval(async () => {
    let st;
    try {
      st = await api.getJob(jobId);
    } catch (err) {
      stopPolling();
      ui.showProgress(false);
      ui.toast(`Lost contact with job: ${err.message}`, 'error');
      return;
    }

    ui.setProgress(st.progress, prettyStage(st.stage, st.state));

    if (st.state === 'done') {
      stopPolling();
      ui.showProgress(false);
      onJobDone(jobId, st, stepTarget);
    } else if (st.state === 'failed' || st.state === 'error') {
      stopPolling();
      ui.showProgress(false);
      updateAccents();   // Fix 1 — back to armed (GENERATE refills)
      ui.toast(`Generation failed: ${st.error || 'unknown error'}`, 'error', 12000);
    } else if (st.state === 'cancelled') {
      stopPolling();
      ui.showProgress(false);
      updateAccents();
      ui.toast('Generation cancelled.', 'warn');
    }
  }, 500);
}

async function onJobDone(jobId, st, stepTarget) {
  // A finished bake supersedes its own preview: the approximation steps aside so
  // the real mesh is what the user is looking at (and measuring, and exporting).
  stopPreview('preview replaced by the baked result');
  state.job = { id: jobId, stepTarget };   // STEP legacy + flow stats still key off the job
  state.resultStats = st.stats || null;   // Wave-3 — the EXPORT tile's RESULT row reads its tri count
  state.resultFresh = true;   // Fix 1 — result matches current params: EXPORT takes the fill
  ui.showResult(st.stats);
  updateAccents();
  refreshExport();            // a new result adds/refreshes the RESULT source row
  if (!st.part) {
    ui.toast('Result generated but the server did not register it as a part.', 'warn', 9000);
    return;
  }
  await adoptLatticePart(st.part);
}

// ── The lattice IS the part ───────────────────────────────────────────
// A finished generate registers its result as a derived part server-side; we
// ingest it flagged `isResult` and draw it SOLID, then hand it to the row it was
// built from: the SOURCE absorbs it (latticePartId) instead of standing up a
// second row, and the sources ride the lattice as linked ghosts. One lattice at
// a time: regenerating replaces the previous one in place.
async function adoptLatticePart(part) {
  // Which ROWS were selected: re-applied at the end so a regenerate keeps the
  // same objects selected even though the unit's mesh id just changed.
  const keepRows = [...new Set(state.selection.map(rowIdOf))];
  if (state.latticePartId) await dropLatticePart(state.latticePartId);

  const sourceIds = (part.derived?.sourceIds || []).slice();
  // The row that ABSORBS the lattice is the first base source: the part itself
  // in single mode, the positive in fuse mode (JobManager writes base sources
  // first, zones after). Any other source stays its own ghosted row.
  const hostId = sourceIds.find((sid) => { const s = partById(sid); return s && !s.isResult; }) || null;
  const host = hostId ? partById(hostId) : null;

  const rec = {
    id: part.id,
    // The lattice record carries the ROW's name, so every name reader (the XFORM
    // bind line, the selection toolbar, toasts) says what the objects list says.
    name: host ? host.name : part.name,
    serverName: part.name,
    triangles: part.triangles,
    sourceFormat: part.sourceFormat || 'derived', role: 'part', visible: true,
    volumeMM3: part.volumeMM3, bbox: part.bbox, derived: part.derived || null, trs: null,
    stlUrl: part.stlUrl || api.partMeshUrl(part.id),
    isResult: true, hostPartId: hostId, sourceIds,
    // …and the row's COLOUR, so a part coloured before GENERATE keeps that
    // colour once it becomes a lattice. The row is one object drawn as two
    // meshes; they must not disagree about what colour it is.
    colorHex: host ? (host.colorHex || null) : null,
  };
  state.parts.push(rec);
  state.latticePartId = rec.id;
  if (host) host.latticePartId = rec.id;

  // Sources stay visible at ghost opacity, with their role select locked while
  // they belong to this lattice (eye + delete stay live).
  const ghostIds = [];
  for (const sid of rec.sourceIds) {
    const src = partById(sid);
    if (!src || src.isResult) continue;
    src.ghosted = true;
    // A SCRIPT source was drawing solid — as a lattice source it is the shell
    // around the unit now, so it hands the solid look to the lattice.
    viewer.setPartSolid(sid, false);
    ghostIds.push(sid);
  }

  refreshParts();
  if (hostId) ui.flashPartRow(hostId);
  try {
    await viewer.addPart(part.id, rec.stlUrl, rec.role, { solid: true, colorHex: rec.colorHex });
    viewer.linkGhosts(rec.id, ghostIds);
    viewer.dimUploaded();     // the sources read as ghosts behind the solid lattice
    updateDims();
    updateOrbitPivot();       // the lattice joins the COM
  } catch (err) {
    ui.toast(`Lattice generated but its 3D preview failed: ${err.message}`, 'warn');
  }
  // A selection that pointed at the source now points at the unit it became.
  if (keepRows.length) setSelection(keepRows);
  refreshParts();
  refreshExport();            // the latticed row exports the lattice mesh
}

// App-state half of dropping a lattice: sources un-ghost, the row that owned it
// becomes a plain part again, the ghost dim lifts.
function releaseLattice(rec) {
  for (const sid of rec.sourceIds || []) {
    const src = partById(sid);
    if (!src) continue;
    src.ghosted = false;
    viewer.setPartSolid(sid, rendersSolid(src));   // a script source is solid again
  }
  const host = rec.hostPartId ? partById(rec.hostPartId) : null;
  if (host && host.latticePartId === rec.id) host.latticePartId = null;
  if (state.latticePartId === rec.id) state.latticePartId = null;
  viewer.undimUploaded();
}

// ── REVERT — give the plain part back ─────────────────────────────────
// Undoable, and it is exactly "delete the lattice mesh": removePartLocal already
// un-ghosts the sources and unhooks the row. The selection survives, moved from
// the unit's lattice id back onto the part it came from.
function revertLattice(rowId) {
  const src = partById(rowId);
  const lat = latticeOf(src);
  if (!src || !lat) return;
  const keep = state.selection.slice();
  deletePart(lat.id);
  setSelection(keep.map((sid) => (sid === lat.id ? rowId : sid)));
  ui.toast(`${src.name} reverted — the lattice was removed.`, 'info', 3500);
}

// ── DELETE a row ──────────────────────────────────────────────────────
// A latticed row is ONE object: its lattice mesh and its source part leave
// together, and a single Ctrl+Z brings the pair back still linked (the lattice
// is restored second, so its sources are already there to re-ghost).
function deleteRow(id) {
  const p = partById(id);
  const lat = latticeOf(p);
  if (!lat) { deletePart(id); return; }
  const tx = history.begin(`Delete ${p.name}`);
  try { deletePart(lat.id); deletePart(id); }
  finally { history.end(tx); }
}

// Remove the previous lattice entirely (state + viewer + server) so a regenerate
// leaves exactly one lattice row behind.
async function dropLatticePart(id) {
  const rec = partById(id);
  if (!rec) { state.latticePartId = null; return; }
  dropFromSelection(id);
  releaseLattice(rec);
  state.parts = state.parts.filter((x) => x.id !== id);
  viewer.removePart(id);
  try { await api.deletePart(id); } catch { /* best effort */ }
}

async function onCancel() {
  if (!state.currentJobId) return;
  const id = state.currentJobId;
  ui.els.cancel.disabled = true;
  try { await api.cancelJob(id); } catch { /* poll will report final state */ }
  setTimeout(() => { ui.els.cancel.disabled = false; }, 800);
}

function stopPolling() {
  if (state.poll) { clearInterval(state.poll); state.poll = null; }
  state.currentJobId = null;
}

function prettyStage(stage, jobState) {
  if (jobState === 'queued') return 'Queued…';
  const s = (stage || '').replace(/[_-]/g, ' ').trim();
  if (!s || s === 'starting') return 'Starting…';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ══ Wave-3 · unified EXPORT ═══════════════════════════════════════════
// ONE export path for everything. Sources = any mix of loaded parts and the
// current generate result; format = STL | STEP; 2+ sources choose SEPARATE (zip)
// or COMBINED (one file); the filename tracks the selection until the user types
// one. Per-part TRS travels with the request so the file lands exactly where the
// viewport shows the part — the server bakes it into the exported copy.
const exportUi = {
  dirty: new Map(),    // id -> the user's explicit tick (survives re-renders)
  nameDirty: false,    // user typed a filename → stop auto-tracking until reopen
  poll: null,          // export status poll handle
  stepWarned: false,   // one-shot "first STEP warms up Python" notice
};

// Filename stem from a display name: "PRIM · BOX 60×40×20" → "prim_box_60x40x20".
function nameStem(name) {
  const s = String(name || '')
    .replace(/\.(stl|step|stp)$/i, '')
    .toLowerCase()
    .replace(/[×✕]/g, 'x')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return s || 'part';
}
// Light mirror of the server's sanitizer, for the live "→ file.ext" hint.
function safeName(v) {
  const s = String(v || '')
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[._]+|[._]+$/g, '');
  return s || 'anvil_export';
}
// Stem of the part this generate is built on (for the RESULT row's default name).
function baseStem() {
  const m = computeMode();
  const id = m.partId || m.positiveId || state.parts[0]?.id;
  const p = id ? partById(id) : null;
  return p ? nameStem(p.name) : 'anvil';
}

// The lattice part's filename stem: `{source-stem-slug}_{pattern}` — the same
// name the old jobId RESULT row produced, so exports keep their identity.
function latticeStem(rec) {
  const src = (rec.sourceIds || []).map(partById).find(Boolean);
  const patt = String(rec.derived?.opParams?.pattern || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const stem = src ? nameStem(src.name) : nameStem(rec.name);
  return patt ? `${stem}_${patt}` : nameStem(rec.name);
}

// Everything exportable, in panel order: loaded parts, then the result row. The
// jobId RESULT row only appears when the lattice is NOT a registered part
// (otherwise the same mesh would be listed twice).
function exportItems() {
  // ONE entry per ROW. A latticed row exports the LATTICE mesh — that is the
  // geometry the object now is — under the row's own name plus its pattern.
  const items = rowParts().map((p) => {
    const lat = latticeOf(p);
    if (lat) return {
      id: lat.id, kind: 'part', role: p.role, colorHex: p.colorHex || null,
      name: `${p.name} · ${patternLabelOf(lat)}`,
      meta: `${(lat.triangles ?? 0).toLocaleString('en-US')} tris`,
      tris: lat.triangles ?? 0,
      stem: latticeStem(lat),
    };
    return {
      id: p.id, kind: 'part', role: p.role, colorHex: p.colorHex || null, name: p.name,
      meta: `${(p.triangles ?? 0).toLocaleString('en-US')} tris`,
      tris: p.triangles ?? 0,
      stem: p.isResult ? latticeStem(p) : nameStem(p.name),
    };
  });
  if (state.job && !state.latticePartId) {
    const patt = PATTERN_LABEL[ui.els.pattern.value] || 'LATTICE';
    const tris = state.resultStats?.triangles;
    items.push({
      id: `job:${state.job.id}`, kind: 'job', jobId: state.job.id, role: null,
      name: `RESULT · ${patt}`,
      meta: tris != null ? `${tris.toLocaleString('en-US')} tris` : 'lattice result',
      tris: tris ?? 0,
      stem: `${baseStem()}_${patt.toLowerCase().replace(/[^a-z0-9]+/g, '')}`,
    });
  }
  return items;
}

// Preselect: a fresh result exports itself; otherwise the selected part; other-
// wise every visible part. The user's own ticks (dirty map) always win.
function defaultChecked(items) {
  const result = items.filter((i) => i.kind === 'job' || i.id === state.latticePartId);
  if (state.resultFresh && result.length) return new Set(result.map((i) => i.id));
  // A selection — one part or several — preselects exactly itself.
  const sel = state.selection.filter((id) => items.some((i) => i.id === id));
  if (sel.length) return new Set(sel);
  const visible = items.filter((i) => i.kind === 'part' && partById(i.id)?.visible);
  return new Set((visible.length ? visible : items).map((i) => i.id));
}
function checkedIds(items) {
  const set = defaultChecked(items);
  for (const it of items) {
    const d = exportUi.dirty.get(it.id);
    if (d === true) set.add(it.id);
    else if (d === false) set.delete(it.id);
  }
  return set;
}

function defaultName(items, checked) {
  const sel = items.filter((i) => checked.has(i.id));
  if (sel.length === 0) return 'anvil_export';
  if (sel.length === 1) return sel[0].stem;
  const d = new Date();
  const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return `anvil_${sel.length}parts_${iso}`;
}
function outputHint(items, checked, format) {
  const n = checked.size;
  if (n === 0) return '→ nothing selected';
  const stem = safeName(ui.getExportName() || defaultName(items, checked));
  if (n === 1) return `→ ${stem}.${format}`;
  return ui.getExportOutput() === 'combined'
    ? `→ ${stem}.${format} · merged`
    : `→ ${stem}.zip · ${n} files`;
}

// Repaint the whole tile from state. Cheap + idempotent; called on every parts
// change, selection change, result, and control interaction.
function refreshExport() {
  const items = exportItems();
  const checked = checkedIds(items);
  ui.renderExportSources(items, checked, (id, on) => {
    exportUi.dirty.set(id, on);
    refreshExport();
  });
  // TOTAL line — the sum of the TICKED sources, live on every tick/untick.
  const picked = items.filter((i) => checked.has(i.id));
  ui.setExportTotal(picked.length, picked.reduce((n, i) => n + (i.tris || 0), 0));
  const format = ui.getExportFormat();
  ui.setExportOutputVisible(checked.size > 1);
  ui.setExportStepVisible(format === 'step');   // the STEP target stepper lives in that row
  if (!exportUi.nameDirty) ui.setExportName(defaultName(items, checked));
  ui.setExportHint(outputHint(items, checked, format));
  if (!exportUi.poll) ui.setExportEnabled(items.length > 0, items.length > 0 && checked.size > 0);
}

async function runExport() {
  const items = exportItems();
  const checked = checkedIds(items);
  const sel = items.filter((i) => checked.has(i.id));
  if (!sel.length) { ui.toast('Tick at least one object to export.', 'warn'); return; }

  const format = ui.getExportFormat();
  const combined = sel.length > 1 && ui.getExportOutput() === 'combined';
  const name = safeName(ui.getExportName() || defaultName(items, checked));

  // Only non-identity part transforms travel. A lattice part is born in world
  // coordinates (the worker baked its inputs) but can be moved afterwards like
  // any part, so it goes through the same TRS path; a jobId source never does.
  const transforms = {};
  for (const it of sel) {
    if (it.kind !== 'part') continue;
    const t = nonIdentityTrs(partById(it.id)?.trs);
    if (t) transforms[it.id] = t;
  }

  const body = {
    sources: sel.map((i) => (i.kind === 'job' ? { jobId: i.jobId } : { partId: i.id })),
    format, combined, name,
  };
  if (Object.keys(transforms).length) body.transforms = transforms;
  if (format === 'step') body.targetTriangles = ui.readParams().stepTargetTriangles;

  if (format === 'step' && !exportUi.stepWarned) {
    exportUi.stepWarned = true;
    ui.toast('First STEP conversion warms up Python — allow about a minute.', 'info', 9000);
  }

  ui.setExportBusy(true);
  ui.setExportStatus('', `Preparing ${format.toUpperCase()} export…`);

  let exportId;
  try {
    exportId = (await api.startExport(body)).exportId;
  } catch (err) {
    ui.setExportBusy(false);
    ui.setExportStatus('err', `Export could not start: ${escapeHtml(err.message)}`);
    ui.toast(`Export failed: ${err.message}`, 'error', 11000);
    refreshExport();
    return;
  }
  pollExport(exportId);
}

function stopExportPoll() {
  if (exportUi.poll) { clearInterval(exportUi.poll); exportUi.poll = null; }
}

function pollExport(id) {
  stopExportPoll();
  exportUi.poll = setInterval(async () => {
    let st;
    try {
      st = await api.getExport(id);
    } catch (err) {
      stopExportPoll();
      ui.setExportBusy(false);
      ui.setExportStatus('err', `Lost contact during export: ${escapeHtml(err.message)}`);
      refreshExport();
      return;
    }

    if (st.state === 'done') {
      stopExportPoll();
      ui.setExportBusy(false);
      const url = api.exportFileUrl(id);
      const tri = st.triangles ? ` · ${st.triangles.toLocaleString('en-US')} tris` : '';
      const warn = st.warning ? `<br><span class="ex-warn">${escapeHtml(st.warning)}</span>` : '';
      ui.setExportStatus('ok',
        `<a href="${url}" download>${escapeHtml(st.fileName || 'download')}</a> ready${tri}${warn}`);
      // Plain anchor click — large files never get fetched into memory, and the
      // server's Content-Disposition supplies the human filename.
      triggerDownload(url);
      refreshExport();
    } else if (st.state === 'failed') {
      stopExportPoll();
      ui.setExportBusy(false);
      ui.setExportStatus('err', `Export failed: ${escapeHtml(st.error || 'unknown error')}`);
      ui.toast(`Export failed: ${st.error || 'unknown error'}`, 'error', 12000);
      refreshExport();
    } else {
      ui.setExportStatus('', escapeHtml(st.note || 'working…'));
    }
  }, 500);
}

ui.els.exportBtn?.addEventListener('click', runExport);
ui.els.exName?.addEventListener('input', () => { exportUi.nameDirty = true; refreshExport(); });
ui.els.stepTris?.addEventListener('input', () => refreshExport());
ui.initExportControls(() => refreshExport());

// ── helpers ───────────────────────────────────────────────────────────
function triggerDownload(url, filename) {
  const a = document.createElement('a');
  a.href = url;
  if (filename) a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ── Server / worker health (header conn indicator) ────────────────────
async function pollHealth() {
  try {
    const h = await api.health();
    if (h.ok && h.workerExists) ui.setHealth('ok', 'local · ready');
    else if (h.ok)              ui.setHealth('warn', 'no worker');
    else                        ui.setHealth('err', 'error');
    // Reveal the FEEDBACK → GitHub-issues and GitHub-repo links once the
    // server reports a repoUrl (the Discord button is static markup).
    const fb = ui.els.feedbackBtn;
    const gh = document.getElementById('github-btn');
    const repoUrl = (h.repoUrl || '').trim().replace(/\/+$/, '');
    if (fb) {
      if (repoUrl) { fb.href = repoUrl + '/issues/new'; fb.hidden = false; }
      else fb.hidden = true;
    }
    if (gh) {
      if (repoUrl) { gh.href = repoUrl; gh.hidden = false; }
      else gh.hidden = true;
    }
    // …and the SCRIPTS view's TOOLS ? link points at the scripting reference in
    // the same repo (hidden until the server reports where that repo is).
    scriptsView.setDocsUrl(repoUrl ? `${repoUrl}/blob/main/docs/scripting.md` : '');
  } catch {
    ui.setHealth('err', 'offline');
  }
}

// ── CAD workspace shell (toolbar · view strip · panels · dims) ────────
// Bottom-right dims readout = union bbox of visible meshes. Also gates the
// SECTION button (nothing visible → nothing to clip → reset + disable).
function updateDims() {
  const size = viewer.getVisibleSize();
  ui.setDims(size);
  const sec = ui.els.vpSection;
  if (!sec) return;
  if (!size) {
    if (sec.classList.contains('active')) {
      sec.classList.remove('active');
      sec.setAttribute('aria-pressed', 'false');
      if (ui.els.vpSectionWrap) ui.els.vpSectionWrap.hidden = true;
      viewer.setSection(false);
    }
    sec.disabled = true;
  } else {
    sec.disabled = false;
  }
}

// ── Orbit pivot ───────────────────────────────────────────────────────
// What the view rotates about: the SELECTED part's bbox centre, or — with
// nothing selected — the volume-weighted centre of mass of every visible mesh.
// Only controls.target moves (the camera never jumps), so this is safe to call
// on every commit. Not called mid-gizmo-drag: onTransformLive stays untouched.
//
// SELECTING DOES NOT CALL THIS. Re-pivoting on every pick swung the view each
// time the user clicked a part just to see what it was, which is the opposite of
// what a pick is for. The pivot now moves only on an explicit camera command
// (FIT · HOME · double-click focus) or when the SCENE ITSELF changes under it
// (a part added, removed, hidden, latticed, transformed, or the up axis
// switched) — the callers below, all of which are geometry events, not
// selection events.
function volumeMap() {
  const m = {};
  for (const p of state.parts) if (p.volumeMM3 != null) m[p.id] = p.volumeMM3;
  return m;
}
function updateOrbitPivot() {
  const vol = volumeMap();
  viewer.setVolumeHint(vol);
  // With a selection the view orbits its COMBINED centre (one part or twenty);
  // with none, the volume-weighted centre of mass of everything visible.
  const visible = state.selection.filter((id) => partById(id)?.visible);
  const box = visible.length ? viewer.selectionBoxInfo() : null;
  if (box) viewer.setOrbitPivot(box.center);
  else viewer.setOrbitPivot(viewer.computeCenterOfMass(vol));
}

ui.initPanels();

// Grouped pipeline toolbar (ADD PART · tools · LATTICE · FLOW · EXPORT).
//
// ── Panel-button toggle contract (Wave-7) ──────────────────────────────
// Every button that OWNS a panel view behaves like a real toggle, so one button
// is both the way in and the way out and the panel never has to be chased with
// the chevron:
//   · panel COLLAPSED           → expand it AND show that button's view
//   · panel open, view SHOWING  → leave the view (home view) AND collapse
//   · anything else             → just switch to that view
// The chevrons still work on their own, and the ESC ✕ inside each view is the
// explicit "close this view" control (a sub-view returns to its home view; the
// HOME view's ✕ collapses, because there is nothing behind it).
ui.els.tbImport?.addEventListener('click', () => ui.els.fileInput.click());

// Which tool is on screen. tools.js owns the open/close lifecycle and lights the
// matching toolbar button on every switch, so the lit button IS the answer — no
// second copy of that state lives here.
const TOOL_BUTTONS = [
  ['primitive', 'tbPrim'], ['boolean', 'tbBool'], ['shell', 'tbShell'],
  ['offset', 'tbOffset'], ['transform', 'tbXform'], ['mirror', 'tbMirror'],
  ['duplicate', 'tbDupe'],
];
function openToolId() {
  if (!tools.isOpen()) return null;
  for (const [id, key] of TOOL_BUTTONS) {
    if (ui.els[key]?.classList.contains('active')) return id;
  }
  return null;
}

// A left-panel TOOL button (PRIM · BOOL · SHELL · OFFSET · XFORM · MIRROR · DUPE).
function toolButton(id) {
  const showing = ui.getLeftView() === 'tool' && openToolId() === id;
  if (ui.isPanelCollapsed('left')) {
    ui.setPanelCollapsed('left', false);
    if (!showing) tools.openTool(id);
    return;
  }
  if (showing) { tools.close(); ui.setPanelCollapsed('left', true); return; }
  tools.openTool(id);
}
ui.els.tbPrim?.addEventListener('click', () => toolButton('primitive'));
// BOOL carries all four combine modes (union/difference/intersect/smooth) — the
// old MERGE button was the same tool with the fillet exposed, so it is gone.
ui.els.tbBool?.addEventListener('click', () => toolButton('boolean'));
ui.els.tbShell?.addEventListener('click', () => toolButton('shell'));
ui.els.tbOffset?.addEventListener('click', () => toolButton('offset'));
ui.els.tbXform?.addEventListener('click', () => toolButton('transform'));
ui.els.tbMirror?.addEventListener('click', () => toolButton('mirror'));
ui.els.tbDupe?.addEventListener('click', () => toolButton('duplicate'));

// SCRIPTS is a left-panel view on the SAME toggle contract as the tools:
// collapsed → expand and open; open → close it and collapse; any other state →
// open it (closing whichever tool held the panel first).
ui.els.tbScripts?.addEventListener('click', () => {
  const showing = scriptsView.isOpen();
  if (ui.isPanelCollapsed('left')) {
    ui.setPanelCollapsed('left', false);
    if (!showing) { tools.close(); scriptsView.open(); }
    return;
  }
  if (showing) { scriptsView.close(); ui.setPanelCollapsed('left', true); return; }
  tools.close();
  scriptsView.open();
});

// LATTICE is the HOME view: it closes whatever tool owns the panel and brings
// the lattice parameters (and GENERATE) back — and, being the home view, its
// second click collapses the panel rather than switching anywhere.
function showLatticeView(flash) {
  // Whichever view held the panel has to be told, not just hidden: an open tool
  // and the SCRIPTS editor both hold the single accent fill while they are up,
  // and tools.close() is a no-op when no tool is open. The explicit
  // updateAccents() closes that gap either way.
  tools.close();
  scriptsView.close();
  ui.setLeftView('lattice');
  updateAccents();
  if (flash) ui.focusSection('lattice');
}
ui.els.tbLattice?.addEventListener('click', () => {
  if (ui.isPanelCollapsed('left')) {
    ui.setPanelCollapsed('left', false);
    showLatticeView(false);
    return;
  }
  if (ui.getLeftView() === 'lattice') { ui.setPanelCollapsed('left', true); return; }
  showLatticeView(true);
});
// ESC ✕ on the LATTICE view — the same explicit close every other view carries.
// There is no view behind the home view, so closing it collapses the panel.
ui.els.latticeClose?.addEventListener('click', () => ui.setPanelCollapsed('left', true));

ui.els.tbGenerate?.addEventListener('click', () => { if (ui.isGenerating()) onCancel(); else onGenerate(); });

// FLOW and EXPORT are whole right-panel VIEWS on the same toggle contract.
// Leaving either one lands back on OBJECTS, which is the right panel's home.
function rightViewButton(view, onOpen) {
  const showing = ui.getRightView() === view;
  if (ui.isPanelCollapsed('right')) {
    ui.setPanelCollapsed('right', false);
    if (!showing) { onOpen?.(); ui.setRightView(view); }
    updateAccents();
    return;
  }
  if (showing) {
    ui.setRightView('objects');
    ui.setPanelCollapsed('right', true);
    updateAccents();
    return;
  }
  onOpen?.();
  ui.setRightView(view);
  updateAccents();   // the export fill hands over between tb-export and #export-btn
}
// FLOW stays result-gated (the button is disabled until a result exists) and is
// never auto-opened: a fresh result lights it, the user walks in deliberately.
ui.els.tbFlow?.addEventListener('click', () => rightViewButton('flow'));
ui.els.flowClose?.addEventListener('click', () => { ui.setRightView('objects'); updateAccents(); });
// EXPORT is parts-gated (not result-gated). Opening resets the filename back to
// auto-tracking, as it always did when the tile was revealed.
ui.els.tbExport?.addEventListener('click', () => rightViewButton('export', () => {
  exportUi.nameDirty = false;
  refreshExport();
}));
function closeExportView() {
  ui.setRightView('objects');
  updateAccents();   // …and the fill hands back to the toolbar button
}
ui.els.exportClose?.addEventListener('click', closeExportView);
// Collapsing/expanding the right panel changes whether the in-panel EXPORT
// button is on screen, which changes who holds the export fill. ui.initPanels
// registered its own chevron listener first, so this runs after the toggle.
ui.els.rightChevron?.addEventListener('click', () => updateAccents());

// The nested OBJECTS op line ("└ TPMS · GYROID · PART") reflects the pattern.
ui.els.pattern?.addEventListener('change', refreshParts);

// Re-arm the primary action (and refresh the viewport context) on any
// generation-param change (Fix 1 / Fix 6). input/change bubble from every
// stepper input and select; the SHEET/SKELETAL + X/Y/Z toggles fire click.
// The SCRIPTS view shares the panel but owns NO generation parameter — typing
// code (or picking an example) must not un-freshen a result, so its events are
// filtered out before either handler sees them.
const notScripts = (fn) => (e) => { if (e.target?.closest?.('#view-scripts')) return; fn(e); };
ui.els.panelLeft?.addEventListener('input', notScripts(markParamsDirty));
ui.els.panelLeft?.addEventListener('change', notScripts(markParamsDirty));
ui.els.panelLeft?.addEventListener('click', notScripts((e) => {
  // PREVIEW / QUALITY are view controls, not generation parameters: toggling
  // them must not un-freshen a result and hand the accent fill back to GENERATE.
  if (e.target.closest?.('#preview-seg, #quality-seg')) return;
  if (e.target.closest?.('.seg-btn, .fchip')) markParamsDirty();
}));
// …and the same three events drive the preview's uniforms (cheap: a handful of
// scalar writes, no allocation, no fetch).
ui.els.panelLeft?.addEventListener('input', notScripts(pushPreviewParams));
ui.els.panelLeft?.addEventListener('change', notScripts(pushPreviewParams));
ui.els.panelLeft?.addEventListener('click', notScripts((e) => {
  if (e.target.closest?.('.seg-btn, .fchip')) pushPreviewParams();
}));

// Floating view strip — HOME · FIT · GHOSTS · SECTION.
// HOME is the documented default camera: iso (1, −0.9, 0.65), up +Z, framed on
// everything visible. FIT still frames the SELECTION when there is one.
document.getElementById('vp-home')?.addEventListener('click', () => viewer.homeView());
ui.els.vpFit?.addEventListener('click', () => viewer.fitView());
ui.els.vpGhosts?.addEventListener('click', () => {
  const hidden = viewer.toggleGhosts();
  ui.els.vpGhosts.classList.toggle('active', hidden);
  ui.els.vpGhosts.setAttribute('aria-pressed', hidden ? 'true' : 'false');
  updateDims();
});
// SECTION (Wave-3) — the slider is gone. Turning the tool on shows an in-canvas
// pick triad; a plane comes from a triad quad, an X/Y/Z chip, or a flat face on
// the selected part. Push/pull the orange arrow to offset it; click the arrow
// (or ⇄) to flip the kept side. The viewer owns all of that — main only wires
// the strip and mirrors viewer state into the chips + the offset readout.
const secAxisChips = document.getElementById('sec-axis');
const secInvertBtn = document.getElementById('sec-invert');
const secReadout   = document.getElementById('vp-section-readout');
function syncSectionChips(axis) {
  if (!secAxisChips) return;
  for (const b of secAxisChips.querySelectorAll('.sec-chip[data-ax]')) {
    const on = !!axis && b.dataset.ax === axis;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
  }
}
ui.els.vpSection?.addEventListener('click', () => {
  // ON → triad pick mode (no plane preselected). The button's own lit state is
  // written by onSectionChange above, from the viewer, so the two cannot drift.
  viewer.setSection(!viewer.getSectionState().enabled);
});
// X / Y / Z chips = the same pick the triad quads perform, through the anchor.
secAxisChips?.addEventListener('click', (e) => {
  const chip = e.target.closest('.sec-chip[data-ax]');
  if (!chip || !ui.els.vpSection?.classList.contains('active')) return;
  viewer.pickAxisPlane(chip.dataset.ax);
});
// Invert (⇄) — flip which half of the model the plane keeps.
secInvertBtn?.addEventListener('click', () => {
  if (!ui.els.vpSection?.classList.contains('active')) return;
  viewer.toggleSectionSign();
});
// Single sync point: chips, invert state and the offset readout all derive from
// whatever the viewer reports (chip / triad / face pick / arrow drag / Alt+wheel).
viewer.onSectionChange = (s) => {
  // The viewer can turn SECTION off on its own now (arming SHELL's OPEN FACES
  // takes the face quads over), so the strip button mirrors the VIEWER's state
  // rather than assuming its own click was the only way in or out.
  if (ui.els.vpSection) {
    ui.els.vpSection.classList.toggle('active', s.enabled);
    ui.els.vpSection.setAttribute('aria-pressed', s.enabled ? 'true' : 'false');
    if (ui.els.vpSectionWrap) ui.els.vpSectionWrap.hidden = !s.enabled;
  }
  syncSectionChips(s.hasPlane ? s.axis : null);
  secInvertBtn?.classList.toggle('active', s.sign < 0);
  if (!secReadout) return;
  if (!s.enabled) { secReadout.hidden = true; return; }
  secReadout.hidden = false;
  secReadout.classList.toggle('is-pick', !s.hasPlane);
  if (!s.hasPlane) {
    secReadout.innerHTML = '<span class="sr-k">SECTION · </span><span class="sr-v">PICK A PLANE</span>';
    return;
  }
  const label = s.axis ? s.axis.toUpperCase() : 'FACE';
  const mm = s.offsetMM;
  const txt = `${mm < 0 ? '−' : '+'}${Math.abs(mm).toFixed(1)} mm`;
  secReadout.innerHTML = `<span class="sr-k">SECTION · ${label} · OFFSET </span><span class="sr-v">${txt}</span>`;
};
// MODEL UP — the display convention chips (+Y · −Y · +Z · −Z). Changing this
// re-presents the SAME scene from a different frame: no geometry moves, no part
// TRS changes, and every export is byte-identical across the four modes. The
// choice persists so a shop that always works in one CAD convention sets it once.
const upChips = document.getElementById('vp-up');
function syncUpChips(axis) {
  if (!upChips) return;
  for (const b of upChips.querySelectorAll('.up-chip[data-up]')) {
    const on = b.dataset.up === axis;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
  }
}
upChips?.addEventListener('click', (e) => {
  const chip = e.target.closest('.up-chip[data-up]');
  if (!chip) return;
  const want = chip.dataset.up;
  if (want === viewer.upAxis()) return;
  const applied = viewer.setUpAxis(want);
  try { localStorage.setItem(UP_KEY, applied); } catch { /* private mode */ }
  syncUpChips(applied);
  updateOrbitPivot();   // the camera re-homed; keep the pivot on the same body
  updateDims();
  ui.toast('display convention only - exports unchanged', 'info', 3500);
});
syncUpChips(viewer.upAxis());

// Changing the FLOW axis re-aligns an axis-picked section (a face-picked plane
// is the user's own choice — leave it alone).
ui.els.flowAxis?.addEventListener('click', () => {
  if (!ui.els.vpSection?.classList.contains('active')) return;
  if (viewer.getSectionState().axis) viewer.pickAxisPlane(ui.getFlowAxis());
});

// ══ Wave-2 — selection · transform gizmo · lay-flat ═══════════════════
const selBar   = document.getElementById('sel-toolbar');
const selName  = document.getElementById('sel-name');
const selMove  = document.getElementById('sel-move');
const selRot   = document.getElementById('sel-rotate');
const selScale = document.getElementById('sel-scale');
const selFlat  = document.getElementById('sel-layflat');
const selDrop  = document.getElementById('sel-drop');

function partById(id) { return state.parts.find((p) => p.id === id) || null; }

/**
 * Disable a HUD-tipped button and say why IN ITS TIP. The authored copy is
 * stashed on first call so the reason can be appended and taken away again
 * without the original wording drifting.
 */
function setDisabledReason(btn, disabled, reason) {
  if (!btn) return;
  if (btn.dataset.tipBase == null) btn.dataset.tipBase = btn.getAttribute('data-tip') || '';
  btn.disabled = !!disabled;
  const base = btn.dataset.tipBase;
  btn.setAttribute('data-tip', disabled ? `${base} ${reason}` : base);
}

// The floating selection toolbar mirrors selection + active gizmo mode. Neutral
// styling (outside the accent machine) — the active mode reads via a --fg tint.
// Multi-selection: the name reads "N PARTS", SCALE and LAY FLAT go disabled
// (a world-axis group scale is a shear; lay flat is a one-part face pick).
function syncSelToolbar() {
  const n = state.selection.length;
  const p = state.selectedPartId ? partById(state.selectedPartId) : null;
  if (!n || !p) { if (selBar) selBar.hidden = true; return; }
  if (selName) selName.textContent = n > 1 ? `${n} PARTS` : p.name;
  if (selBar) selBar.hidden = false;
  const multi = n > 1;
  // These five buttons carry HUD tips (index.html), so the "why is this off?"
  // line is APPENDED to the tip rather than added as a native title: one
  // element never holds both (tooltip convention, see ui.initTooltips).
  setDisabledReason(selScale, multi, 'Off while more than one part is selected.');
  setDisabledReason(selFlat, multi, 'Off while more than one part is selected.');
  const map = { translate: selMove, rotate: selRot, scale: selScale };
  for (const [mode, btn] of Object.entries(map))
    btn?.classList.toggle('active', state.gizmoMode === mode && !state.layFlatArmed);
  selFlat?.classList.toggle('active', state.layFlatArmed);
}

// ── Ghost + lattice = ONE selectable unit ─────────────────────────────
// A ghosted source belongs to the lattice that consumed it: the lattice carries
// its ghosts (viewer linkGhosts), so transforming a ghost alone would tear the
// pair apart. Every selection path — viewer picks AND row clicks — routes
// through here, so a ghost click lands on its lattice instead. Deleting the
// lattice frees the sources again.
let ghostRouteToasted = false;
function latticeHosting(p) {
  if (!p || p.isResult || !p.ghosted) return null;
  return state.parts.find((x) => x.isResult && (x.sourceIds || []).includes(p.id)) || null;
}
function routeSelection(id, opts = {}) {
  const p = id ? partById(id) : null;
  if (!p) return id;
  // A latticed row IS its lattice — one object — so the row and its mesh resolve
  // to the same unit, silently. There is nothing to explain.
  const own = latticeOf(p);
  if (own) return own.id;
  // Any OTHER source riding the lattice (the negative in fuse mode) belongs to
  // the same unit, so a click on its ghost lands on the lattice too.
  const host = latticeHosting(p);
  if (!host) return id;
  if (!opts.quiet && !ghostRouteToasted) {
    ghostRouteToasted = true;
    ui.toast('Ghost is linked to the lattice — they move together.', 'info', 4500);
  }
  return host.id;
}

// ── Selection API (ordered multi-set) ─────────────────────────────────
//   setSelection(ids, opts)   replace the whole set
//   selectPart(id)            replace with one (or clear when null)
//   toggleSelection(id)       Ctrl/Shift click — add to the end, or drop
//   clearSelection()          empty it
// Every path routes ghosted sources to their lattice host and de-duplicates, so
// the set can never hold a ghost or the same id twice.
function normalizeSelection(ids, opts = {}) {
  const out = [];
  for (const raw of ids || []) {
    const id = routeSelection(raw, opts);
    if (!id || !partById(id) || out.includes(id)) continue;
    out.push(id);
  }
  return out;
}

// The single selection funnel. Selecting ALWAYS arms MOVE: a selection is in
// transform mode, with the arrows sitting on the body itself (the viewer pivots
// the gizmo on the COMBINED unit bbox centre).
// Bring the OBJECTS view back on screen: expand the right panel if it is
// collapsed, and leave whichever sub-view (EXPORT / FLOW) is showing. Cheap and
// idempotent — a no-op when OBJECTS is already up.
function revealObjects() {
  if (!ui.isPanelCollapsed('right') && ui.getRightView() === 'objects') return;
  ui.setRightView('objects');            // auto-expands a collapsed panel
  ui.setPanelCollapsed('right', false);
  updateAccents();                       // who holds the export fill just changed
}

function setSelection(ids, opts = {}) {
  const next = normalizeSelection(ids);
  if (next.join('|') === state.selection.join('|')) { syncSelToolbar(); return; }
  const primaryBefore = state.selectedPartId;
  // Any change to the SET cancels a one-shot lay-flat arm (it belonged to the
  // part that was selected when it was armed).
  if (state.layFlatArmed) {
    state.layFlatArmed = false;
    viewer.cancelLayFlat();
    document.body.classList.remove('layflat-armed');
  }
  state.selection = next;
  if (!next.length) { state.gizmoMode = null; viewer.stopGizmo(); }
  else if (state.gizmoMode === 'scale' && next.length > 1) state.gizmoMode = 'translate';
  else if (!state.gizmoMode) state.gizmoMode = 'translate';
  viewer.setSelected(next);                                   // tints + re-seats the proxy
  if (next.length && state.gizmoMode) viewer.setGizmoMode(state.gizmoMode);
  // NO camera work here — not the position, not the orbit target. Selecting is
  // free; double-click (focusPart) is what frames. refreshParts below still
  // republishes the volume hint, which is all the viewer needed from this path.
  syncSelToolbar();
  // Picking something makes OBJECTS the panel worth looking at — it is where the
  // part you just clicked lives, and where "how many are in this scene" is
  // answered. Only ever on a real CHANGE to a non-empty set (the guard above
  // already returned for a no-op), so it can never fight a user mid-export.
  if (next.length) revealObjects();
  refreshParts();       // re-derive the `.selected`/`.primary` row classes from state
  tools.onSelectionChanged();   // the XFORM tool binds to the primary, live
  // A canvas pick moves the primary — bring its row into view in the objects list.
  if (opts.scrollToPrimary && state.selectedPartId && state.selectedPartId !== primaryBefore)
    ui.scrollPartRowIntoView(rowIdOf(state.selectedPartId));   // the ROW, not the unit's mesh
}
function selectPart(id) { setSelection(id ? [id] : []); }
function clearSelection() { setSelection([]); }
function toggleSelection(id, opts = {}) {
  const routed = routeSelection(id);
  if (!routed || !partById(routed)) return;
  setSelection(state.selection.includes(routed)
    ? state.selection.filter((x) => x !== routed)
    : state.selection.concat(routed), opts);
}
/** A click that carries Ctrl (primary) or Shift toggles; a plain click replaces. */
function pickSelect(id, mods = {}, opts = {}) {
  if (id && (mods.ctrl || mods.shift)) toggleSelection(id, opts);
  else setSelection(id ? [id] : [], opts);
}
/** FOCUS — double-click a part in the canvas or double-click its row. The one
 *  selection-adjacent gesture that IS allowed to move the camera: it selects the
 *  part (if the two clicks that preceded it somehow didn't) and then runs the
 *  ordinary fit-to-selection path, which parks the orbit pivot on the unit's
 *  centre and frames it. Nothing bespoke — FIT with a selection does exactly
 *  this, so focus and FIT can never drift apart. */
function focusPart(id) {
  const routed = routeSelection(id);
  if (!routed || !partById(routed)) return;
  if (!state.selection.includes(routed)) setSelection([routed], { scrollToPrimary: true });
  viewer.fitView();   // pivot → selection centre, camera → framed on it
}
/** A part is leaving the scene — drop it from the set without a full re-render
 *  (the caller's refreshParts covers that). */
function dropFromSelection(id) {
  if (!state.selection.includes(id)) return;
  state.selection = state.selection.filter((x) => x !== id);
  if (!state.selection.length) {
    state.gizmoMode = null;
    state.layFlatArmed = false;
    document.body.classList.remove('layflat-armed');
  }
}

function setGizmoMode(mode) {
  if (!state.selectedPartId) return;
  if (mode === 'scale' && state.selection.length > 1) return;   // group scale is a shear
  state.layFlatArmed = false;
  viewer.cancelLayFlat();
  document.body.classList.remove('layflat-armed');
  state.gizmoMode = mode;
  viewer.setGizmoMode(mode);   // attach the gizmo (proxy ← part TRS) / switch mode
  syncSelToolbar();
}
function armLayFlat() {
  if (!state.selectedPartId || state.selection.length > 1) return;
  state.layFlatArmed = true;
  state.gizmoMode = null;
  viewer.armLayFlat();
  document.body.classList.add('layflat-armed');
  syncSelToolbar();
  ui.toast('LAY FLAT — click a highlighted face plane (or any face) to rest it on the plate.', 'info', 4500);
}
function cancelLayFlat() {
  state.layFlatArmed = false;
  viewer.cancelLayFlat();
  document.body.classList.remove('layflat-armed');
  syncSelToolbar();
}

selMove?.addEventListener('click', () => setGizmoMode('translate'));
selRot?.addEventListener('click', () => setGizmoMode('rotate'));
selScale?.addEventListener('click', () => setGizmoMode('scale'));
selFlat?.addEventListener('click', () => (state.layFlatArmed ? cancelLayFlat() : armLayFlat()));
// DROP — ground the WHOLE selection (and any ghosts riding it) on the plate as
// one body: the combined bbox min lands on the plate, every member moves by the
// same delta, and the lot is ONE undo entry.
selDrop?.addEventListener('click', () => dropSelection());
function dropSelection() {
  if (!state.selection.length) return;
  const entries = viewer.dropSelectionToPlate();
  if (!entries.length) return;
  commitTransforms(entries, state.selection.length > 1 ? 'Drop selection' : 'Drop to plate');
  ui.toast('Dropped to the plate.', 'success', 2200);
}

// ── viewer callbacks — the viewer owns pointer routing (cube → section →
//    lay-flat → gizmo → plate-drag → selection); main owns app state + the
//    commit path. ──
// Every in-canvas commit is `fit: false`: a direct manipulation must not yank
// the camera back to the iso framing the user just orbited away from. (The
// TRANSFORM panel keeps fit-on-commit.)
// Wave-4: every commit is ONE undo entry. A rotate that auto-drops arrives here
// as a single grounded TRS, so one Ctrl+Z takes back the rotation AND the drop.
function commitTransform(id, trs, label) {
  const prev = cloneTrs(partById(id)?.trs);
  const next = cloneTrs(trs);
  applyCommitTrs(id, next);
  pushTrsCommand(id, prev, next, { label: label || 'Move / rotate' });
}
// Wave-6 — a GROUP commit is ONE history entry: the per-part TRS changes are
// collected inside a transaction, so a single Ctrl+Z takes the whole group move
// back. One member → the plain single command (no composite wrapper).
function commitTransforms(entries, label) {
  if (!entries || !entries.length) return;
  if (entries.length === 1) { commitTransform(entries[0].id, entries[0].trs, label); return; }
  const tx = history.begin(label || `Move ${entries.length} parts`);
  try { for (const e of entries) commitTransform(e.id, e.trs, label || 'Move / rotate group'); }
  finally { history.end(tx); }
}

// id or null (empty click clears); mods carry Ctrl/Shift → toggle membership.
viewer.onPick = (id, mods) => pickSelect(id, mods || {}, { scrollToPrimary: true });
viewer.onFocus = (id) => focusPart(id);
viewer.onDragChange = (dragging) => { state.draggingGizmo = dragging; };
viewer.onTransformLive = (entries) => {                     // mid-drag: rebuild only, no fit
  for (const e of entries) viewer.setPartTransformLive(e.id, e.trs);
  updateDims();
  tools.onTransformLive(entries);   // XFORM fields tick live under the drag
};
viewer.onTransformCommit = (entries) => commitTransforms(entries);   // drag END: one commit

// Moving a SOURCE out from under its lattice makes the lattice stale, so
// GENERATE re-takes the fill. Wave-4: the gizmo/plate/lay-flat paths can no
// longer reach a linked ghost (selection routes to the lattice, and the lattice
// carries its ghosts), so the only caller left is the TRANSFORM tool.
function markSourceMoved(p) {
  if (!p || p.isResult || !p.ghosted || !state.resultFresh) return;
  state.resultFresh = false;
  updateAccents();
}
// SHELL · OPEN FACES — a quad click toggled the set, or another armer took the
// quads. Either way the tool's row repaints from the viewer's own state.
viewer.onOpenFacesChange = () => tools.onOpenFacesChanged();
viewer.onQuadArmerCancel = () => tools.onOpenFacesChanged();
viewer.onLayFlat = (id, trs) => {                           // one-shot face pick result
  state.layFlatArmed = false;
  document.body.classList.remove('layflat-armed');
  if (trs) {
    commitTransform(id, trs);
    ui.toast('Laid flat on the plate.', 'success', 2500);
  }
  syncSelToolbar();
};

// Escape clears selection — but only when no contextual tool owns Escape
// (tools.js closes an open tool first) and no HUD dialog is up. One keypress =
// one action: with the MCP modal open, Escape closes the modal and NOTHING else.
// The EXPORT view is a panel view like a tool, so it sits at the same rung: it
// closes before an armed lay-flat or the selection is touched.
document.addEventListener('keydown', (e) => {
  // tools.js and scripts.js each close their own view on Escape first.
  if (e.key !== 'Escape' || tools.isOpen() || scriptsView.isOpen() || modalOpen()) return;
  // A right-panel sub-view (EXPORT or FLOW) closes back to OBJECTS first. The
  // LATTICE home view is deliberately NOT on this ladder: Escape never collapses
  // a panel, that is what its ESC ✕ button and the chevron are for.
  if (ui.getRightView() !== 'objects') { closeExportView(); return; }
  if (state.layFlatArmed) { cancelLayFlat(); return; }
  if (state.selectedPartId) clearSelection();
});

// ══ Wave-6 · canvas context menu ══════════════════════════════════════
// Right-click owns the verbs that used to need a trip to a panel: duplicate,
// delete, hide, drop, fit, select all. It operates on the SELECTION, so with
// several parts picked every verb applies to all of them — as ONE undo entry.
// Right-clicking an unselected part selects it first (replace), which makes the
// menu's subject unambiguous before a single item is read.

const DUP_STEP_MM = 10;   // RIGHT-ward offset per copy, so copies never stack invisibly

/** Everything selectable, ghosts routed to their lattice host, de-duplicated. */
function selectableIds() { return normalizeSelection(state.parts.map((p) => p.id)); }
function selectAll() { setSelection(selectableIds()); }

/** A TRS with every field present (a part may carry null or a partial one). */
function fullTrs(t) {
  const tt = t?.translateMM || {}, rr = t?.rotateDeg || {}, ss = t?.scale || {};
  return {
    translateMM: { x: tt.x || 0, y: tt.y || 0, z: tt.z || 0 },
    rotateDeg:   { x: rr.x || 0, y: rr.y || 0, z: rr.z || 0 },
    scale:       { x: ss.x ?? 1, y: ss.y ?? 1, z: ss.z ?? 1 },
  };
}

/** DELETE the whole selection — one composite command, one Ctrl+Z. The server
 *  files survive (the deferred-delete design in pushDeleteCommand). */
function deleteSelection() {
  // Rows, not meshes: deleting a latticed unit takes its lattice AND its source.
  const ids = [...new Set(state.selection.map(rowIdOf))];
  if (!ids.length) return;
  if (ids.length === 1) { deleteRow(ids[0]); return; }
  const tx = history.begin(`Delete ${ids.length} parts`);
  try { for (const id of ids) deleteRow(id); }
  finally { history.end(tx); }
}

/** HIDE/SHOW the whole selection. Mixed visibility hides (the menu label says
 *  HIDE whenever anything is still visible), and it rides ONE flags command. */
function toggleSelectionVisible() {
  const ids = state.selection.slice();
  if (!ids.length) return;
  const before = flagsSnapshot();
  const anyVisible = ids.some((id) => partById(id)?.visible !== false);
  for (const id of ids) {
    const p = partById(id);
    if (!p) continue;
    p.visible = !anyVisible;
    viewer.setPartVisible(id, p.visible);
  }
  refreshParts();
  pushFlagsCommand(before, anyVisible ? 'Hide selection' : 'Show selection');
}

// DUPLICATE… — N copies of every selected part. `duplicate` is the one op that
// returns its PartInfo synchronously, so this is a straight loop; each copy
// inherits its source's TRS plus i × 10 mm along the display RIGHT axis, and the
// whole batch is ONE history entry (runOpFlow's own transaction nests into it).
// The copies become the selection.
async function duplicateSelection(copies) {
  const ids = state.selection.slice();
  const n = Math.max(1, Math.min(20, Math.round(copies) || 1));
  if (!ids.length) return;
  const right = viewer.rightAxis();
  const made = [];
  const tx = history.begin(`Duplicate ×${n}`);
  try {
    for (const id of ids) {
      const src = partById(id);
      if (!src) continue;
      const base = fullTrs(src.trs);
      for (let i = 1; i <= n; i++) {
        let part = null;
        try { part = await runOpFlow({ op: 'duplicate', inputs: [{ partId: id }] }); }
        catch (err) { ui.toast(`Duplicate failed: ${err.message}`, 'error', 9000); continue; }
        if (!part) continue;
        made.push(part.id);
        const d = DUP_STEP_MM * i;
        commitTransform(part.id, {
          translateMM: {
            x: base.translateMM.x + right.x * d,
            y: base.translateMM.y + right.y * d,
            z: base.translateMM.z + right.z * d,
          },
          rotateDeg: { ...base.rotateDeg },
          scale: { ...base.scale },
        }, 'Offset copy');
      }
    }
  } finally { history.end(tx); }
  if (!made.length) return;
  setSelection(made);
  ui.toast(`${made.length} cop${made.length === 1 ? 'y' : 'ies'} created.`, 'success', 3000);
}

// Right-drag is OrbitControls' pan, and Windows fires `contextmenu` on the
// RELEASE — so a pan that ends in place would otherwise pop the menu. Track the
// press and suppress the menu when the pointer travelled.
let rightDownAt = null;
ui.els.viewport?.addEventListener('pointerdown', (e) => {
  if (e.button === 2) rightDownAt = { x: e.clientX, y: e.clientY };
}, { capture: true });

ui.els.viewport?.addEventListener('contextmenu', (e) => {
  e.preventDefault();                       // never the browser menu over the canvas
  const from = rightDownAt;
  rightDownAt = null;
  if (from && Math.hypot(e.clientX - from.x, e.clientY - from.y) > 4) return;   // that was a pan
  if (viewer.isOverCube(e.clientX, e.clientY)) return;   // the nav cube owns its rect
  if (modalOpen()) return;
  openViewportMenu(e.clientX, e.clientY);
});

function openViewportMenu(x, y) {
  const raw = viewer.pickAt(x, y);
  const hit = raw ? routeSelection(raw) : null;
  // Right-clicking a part that is NOT in the selection makes it the selection.
  if (hit && !state.selection.includes(hit)) setSelection([hit], { scrollToPrimary: true });

  const sel = state.selection.slice();
  const n = sel.length;
  const anyVisible = sel.some((id) => partById(id)?.visible !== false);
  const items = [];

  if (hit) {
    const many = n > 1 ? ` ${n} PARTS` : '';
    items.push({ label: `DUPLICATE${many}…`, disabled: !n, onSelect: (mx, my) => openDuplicatePopover(mx, my) });
    items.push({ label: `DELETE${many}`, disabled: !n, onSelect: () => deleteSelection() });
    items.push({ label: anyVisible ? `HIDE${many}` : `SHOW${many}`, disabled: !n, onSelect: () => toggleSelectionVisible() });
    // LAY FLAT is a one-part face pick — it HIDES on a multi-selection rather
    // than sitting there dimmed (every other verb dims instead).
    if (n === 1) items.push({ label: 'LAY FLAT', onSelect: () => armLayFlat() });
    items.push({ label: 'DROP', disabled: !n, onSelect: () => dropSelection() });
    // Unit verbs — only on a single latticed object, where they mean something.
    if (n === 1) {
      const row = partById(rowIdOf(sel[0]));
      if (latticeOf(row)) {
        items.push({ sep: true });
        items.push({
          label: row.visible === false ? 'SHOW GHOST' : 'HIDE GHOST',
          onSelect: () => toggleMeshVisible(row.id, 'ghost'),
        });
        items.push({ label: 'REVERT LATTICE', onSelect: () => revertLattice(row.id) });
      }
    }
    items.push({ label: 'FIT SELECTION', disabled: !n, onSelect: () => viewer.fitView() });
    items.push({ sep: true });
  } else {
    items.push({ label: 'FIT ALL', onSelect: () => viewer.fitView({ union: true }) });
    items.push({ sep: true });
  }
  items.push({ label: 'SELECT ALL', disabled: !selectableIds().length, onSelect: () => selectAll() });
  items.push({ label: 'DESELECT ALL', disabled: !n, onSelect: () => clearSelection() });

  ui.openContextMenu(x, y, items);
}

function openDuplicatePopover(x, y) {
  ui.openCountPopover(x, y, {
    label: 'COPIES', value: 1, min: 1, max: 20,
    onConfirm: (count) => { duplicateSelection(count); },
  });
}

// Expose for Stage-4 browser verification (selection/gizmo/section checks).
window.__anvil = {
  viewer, state, selectPart, setSelection, toggleSelection, pickSelect, selectAll,
  clearSelection, setGizmoMode, armLayFlat, dropSelection, deleteSelection,
  toggleSelectionVisible, duplicateSelection, openViewportMenu,
  history, commitTransform, commitTransforms, deletePart, consumeSources, partById, flagsSnapshot,
  // lattice unity (one object, one row) + selection targeting
  deleteRow, revertLattice, toggleMeshVisible, rowParts, rowIdOf, unitIdOf, latticeOf,
  partRowVMs, computeMode, selectionTargets, exportItems,
  // per-part colour (swatch/hex picker)
  setPartColor, applyPartColor,
  // project save / open (.anvil) — the payload builder is also the session
  // fingerprint a round-trip test compares before-save against after-open.
  buildProjectPayload, openProjectFile, rebuildFromProject,
};

// ── init ──────────────────────────────────────────────────────────────
ui.initSteppers();
ui.initLatticeControls();
ui.initTooltips();
ui.setLeftView('lattice');   // the home view is the boot state (LATTICE lit)
tools.initTools(toolCtx);
// Keep the flow sparkline crisp + inside its tile when the window resizes.
let sparkResizeRAF = 0;
window.addEventListener('resize', () => {
  if (sparkResizeRAF) return;
  sparkResizeRAF = requestAnimationFrame(() => { sparkResizeRAF = 0; ui.drawFlowSpark(); });
});
refreshParts();
pollHealth();
setInterval(pollHealth, 10000);
