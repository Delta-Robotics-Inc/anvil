//
// main.js — Infill App controller. Owns app state, wires events, drives the
// upload → parameters → generate → poll → export loop.
//
import * as api from './api.js';
import * as ui from './ui.js';
import * as tools from './tools.js';
import * as scriptsPanel from './scripts.js';
import * as history from './history.js';
import { Viewer } from './viewer.js';
import { isBaseRole, isZoneRole } from './roles.js';

// ── State ─────────────────────────────────────────────────────────────
const state = {
  parts: [],        // { id, name, triangles, sourceFormat, role, visible }
  pending: [],      // { tempId, name, kind } placeholder rows for in-flight uploads
  job: null,        // { id } of the last successful generation
  poll: null,       // interval handle for generation polling
  stepPoll: null,   // interval handle for STEP-export polling
  resultFresh: false, // Fix 1 — shown result matches current params (drives accent budget)
  latticePartId: null, // the CURRENT generated lattice part (one at a time)

  // Wave-2 viewport selection / gizmo (selection is state-derived; rows re-derive
  // `.selected` from selectedPartId on every renderParts).
  selectedPartId: null, // id of the click/row-selected part, or null
  gizmoMode: null,      // 'translate' | 'rotate' | 'scale' | null
  layFlatArmed: false,  // LAY FLAT one-shot pick armed
  draggingGizmo: false, // true mid-drag → freeze refreshParts
};
let pendingSeq = 0; // monotonic id source for placeholder rows

const viewer = new Viewer(ui.els.viewport);
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
function applyAutoRoles() {
  const base = state.parts.filter((p) => isBaseRole(p.role) && !p.isResult && !p.consumed);
  if (base.length === 2 && base.every((p) => p.role === 'part')) {
    base[0].role = 'positive';
    base[1].role = 'negative';
  }
}
function syncViewerRoles() {
  for (const p of state.parts) viewer.setPartRole(p.id, p.role);
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
// source consume, TRANSFORM's source reset) synchronously right after this
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
// Register a freshly-created derived part into app state + the viewer (role Part,
// translucent orange ghost). Flash the new row.
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
    await viewer.addPart(part.id, rec.stlUrl, rec.role);
    syncViewerRoles();
    updateDims();
    updateOrbitPivot();   // new geometry shifts the centre of mass
  } catch (err) {
    ui.toast(`"${part.name}" created, but its 3D preview failed: ${err.message}`, 'warn');
  }
  pushCreateCommand(rec.id, `Create ${rec.name}`);
}

// ── Scripting (SCRIPTS panel → /api/scripts/run → poll → new parts) ────
// A script job registers EVERY part it SavePart-ed; on `done` the server has
// already populated st.parts (registered before the job flips to done), so we
// add each through the normal derived-part flow. Returns the added parts.
async function runScriptFlow(scriptId, name, onProgress) {
  const { code } = await api.getScript(scriptId);
  const resp = await api.runScript({ code, name });
  const parts = await pollScriptJob(resp.jobId, onProgress);
  // Every part a script emitted is ONE command — a script run undoes as a unit.
  const tx = history.begin(`Script ${name}`);
  try { for (const p of parts) await addOpPart(p); }
  finally { history.end(tx); }
  return parts;
}
function pollScriptJob(jobId, onProgress) {
  return new Promise((resolve, reject) => {
    const h = setInterval(async () => {
      let st;
      try { st = await api.getJob(jobId); }
      catch (err) { clearInterval(h); reject(new Error(`lost contact with job: ${err.message}`)); return; }
      onProgress?.(prettyStage(st.stage, st.state));
      if (st.state === 'done') { clearInterval(h); resolve(st.parts || []); }
      else if (st.state === 'failed' || st.state === 'error') { clearInterval(h); reject(new Error(st.error || 'script failed')); }
      else if (st.state === 'cancelled') { clearInterval(h); reject(new Error('script cancelled')); }
    }, 500);
  });
}
scriptsPanel.initScripts({ runScript: runScriptFlow, toast: (m, k, ms) => ui.toast(m, k, ms) });

// ── Tool controller (passed to tools.initTools) ───────────────────────
const toolCtx = {
  listParts: () => state.parts.map((p) => ({ id: p.id, name: p.name, role: p.role })),
  unionCenter: () => viewer.getVisibleCenter(),
  voxelDefault: () => ui.readParams().voxelSizeMM,
  getPartTrs: (id) => state.parts.find((p) => p.id === id)?.trs || null,
  partBbox: (id) => state.parts.find((p) => p.id === id)?.bbox || null,
  // TRANSFORM panel live edit. Every keystroke lands here, so the command
  // COALESCES: successive edits to the same part fold into the one entry (its
  // `prev` stays the TRS the panel opened on) until some other action intervenes.
  setPartTransform: (id, trs) => {
    const p = state.parts.find((x) => x.id === id);
    if (!p) return;
    const prev = cloneTrs(p.trs);
    applyPanelTrs(id, trs);
    pushTrsCommand(id, prev, cloneTrs(trs), {
      label: 'Transform (panel)', panel: true, coalesceKey: `panel-trs:${id}`,
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
  onStateChange: () => updateAccents(),
  toast: (msg, kind, ms) => ui.toast(msg, kind, ms),
};

// ── Parts list interactions ───────────────────────────────────────────
function refreshParts() {
  // Frozen mid-gizmo-drag: rows rebuild on every refreshParts, which would tear
  // down the selection row under the cursor. The drag commits once on release,
  // where a single refreshParts runs.
  if (state.draggingGizmo) return;
  ui.renderParts(state.parts, state.pending, {
    selectedId: state.selectedPartId,           // drives the `.selected` row class
    onSelect: (id) => selectPart(id),
    onRoleChange: (id, role) => {
      const p = state.parts.find((x) => x.id === id);
      if (!p) return;
      const before = flagsSnapshot();   // whole role map — cascades ride along
      p.role = role;
      viewer.setPartRole(id, role);
      refreshParts();
      pushFlagsCommand(before, `Role → ${role}`);
    },
    onToggleVisible: (id) => {
      const p = state.parts.find((x) => x.id === id);
      if (!p) return;
      const before = flagsSnapshot();
      p.visible = !p.visible;
      viewer.setPartVisible(id, p.visible);
      refreshParts();
      pushFlagsCommand(before, p.visible ? 'Show part' : 'Hide part');
    },
    onDelete: (id) => deletePart(id),
  });
  viewer.setVolumeHint(volumeMap());   // COM weights for fitView's no-selection pivot
  ui.setDropzoneBusy(state.pending.length > 0);
  ui.setViewportHint(state.parts.length === 0 && !state.job);
  updateMode();
  updateDims();   // union-bbox readout + SECTION availability track the visible set
  updateAccents();          // Fix 1 — refresh the single-fill slot for the new part/role set
  updateViewportContext();  // Fix 6 — mode may have changed with roles
  refreshExport();          // Wave-3 — the EXPORT tile lists the live part set
}

// ── Wave-4 · consumed sources ─────────────────────────────────────────
// A BOOL/SMOOTH result REPLACES its two inputs. The sources stay listed (so the
// op stays reversible) but are hidden, locked, and — the point of the exercise —
// dropped from computeMode exactly like a lattice `isResult` part is. Two boxes
// unioned therefore leave ONE active base part, and GENERATE runs on the
// combined result straight away. Deleting the result restores them.
function consumeSources(ids, resultId, kind) {
  const res = partById(resultId);
  if (!res) return;
  const before = flagsSnapshot();   // undo of the BOOL hands the sources straight back
  const taken = [];
  for (const sid of new Set(ids)) {
    const src = partById(sid);
    if (!src || src.id === resultId || src.consumed) continue;
    src.consumed = true;
    src.consumedBy = resultId;
    src.consumedKind = kind || 'BOOL';   // row regmark: USED · BOOL | USED · SMOOTH
    src.prevVisible = src.visible !== false;
    src.visible = false;
    viewer.setPartVisible(src.id, false);
    taken.push(src.id);
  }
  res.consumedIds = taken;
  res.role = 'part';                     // the combined part IS the new base
  viewer.setPartRole(res.id, 'part');
  refreshParts();
  updateOrbitPivot();                    // the hidden sources leave the COM
  // Joins the op's open group, so ONE Ctrl+Z removes the result AND restores
  // the sources (see runOpFlow).
  pushFlagsCommand(before, `Consume → ${kind || 'BOOL'}`);
}

// Give a result's sources back (delete-the-result undo).
function releaseConsumed(rec) {
  for (const sid of rec.consumedIds || []) {
    const src = partById(sid);
    if (!src || src.consumedBy !== rec.id) continue;
    src.consumed = false;
    src.consumedBy = null;
    src.consumedKind = null;
    src.visible = src.prevVisible !== false;
    viewer.setPartVisible(src.id, src.visible);
    src.prevVisible = undefined;
  }
  rec.consumedIds = [];
}

// A consumed source deleted on its own just leaves its result's list.
function forgetConsumed(rec) {
  const host = rec.consumedBy ? partById(rec.consumedBy) : null;
  if (host) host.consumedIds = (host.consumedIds || []).filter((x) => x !== rec.id);
}

// Local removal — everything deleting a part does EXCEPT the server-side file
// delete, which is deferred so undo can put the part back from its own mesh.
function removePartLocal(id) {
  if (id === state.selectedPartId) clearSelection();   // drop selection + gizmo first
  const rec = partById(id);
  // Deleting the lattice un-ghosts its sources; deleting a ghosted source only
  // detaches that one (the viewer drops the link either way in removePart).
  if (rec?.isResult) releaseLattice(rec);
  else if (rec?.ghosted) rec.ghosted = false;
  // Same contract one level down: deleting a BOOL/SMOOTH result hands its
  // sources back; deleting a consumed source just forgets it.
  if (rec?.consumedIds?.length) releaseConsumed(rec);
  if (rec?.consumed) forgetConsumed(rec);
  state.parts = state.parts.filter((x) => x.id !== id);
  viewer.removePart(id);
  refreshParts();
  updateOrbitPivot();       // one fewer mass in the COM
  tools.onPartsChanged();   // an open picker tool refreshes its part list
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
//     sources, deleting a boolean result un-consumes its inputs, an upload can
//     flip two parts to positive/negative — so commands snapshot the flag map
//     (role · visible · ghost · consume) whole and restore it wholesale.
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

// ── flag map (role · visibility · ghost · consume, for every part) ────
// Used for role changes, visibility toggles and BOOL consume alike: snapshot
// before, snapshot after, restore wholesale. Cascades and lock states that a
// single-field diff would miss come along for free.
function flagsSnapshot() {
  const parts = {};
  for (const p of state.parts) {
    parts[p.id] = {
      role: p.role,
      visible: p.visible !== false,
      ghosted: !!p.ghosted,
      consumed: !!p.consumed,
      consumedBy: p.consumedBy || null,
      consumedKind: p.consumedKind || null,
      prevVisible: p.prevVisible,
      consumedIds: (p.consumedIds || []).slice(),
      sourceIds: (p.sourceIds || []).slice(),
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
    p.consumed = f.consumed;
    p.consumedBy = f.consumedBy;
    p.consumedKind = f.consumedKind;
    p.prevVisible = f.prevVisible;
    p.consumedIds = f.consumedIds.slice();
    if (p.isResult) p.sourceIds = f.sourceIds.slice();
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
  tools.onPartsChanged();   // re-prefill an open TRANSFORM tool (TRS panel sync)
}
// TRANSFORM panel path — keeps the panel's fit-on-commit and its stale-source note.
function applyPanelTrs(id, trs) {
  const p = partById(id);
  if (p) p.trs = cloneTrs(trs);
  viewer.setPartTransform(id, cloneTrs(trs));
  updateDims();
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
  const host = rec.consumedBy ? partById(rec.consumedBy) : null;
  return {
    id,
    index: state.parts.findIndex((p) => p.id === id),
    rec: cloneJson(rec),
    stlUrl: rec.stlUrl || api.partMeshUrl(id),
    solid: !!rec.isResult,
    wasLattice: state.latticePartId === id,
    // lattice host: which sources it currently holds as ghosts
    ghostIds: rec.isResult ? (rec.sourceIds || []).filter((sid) => partById(sid)?.ghosted) : [],
    // boolean/smooth result: the consume state of every source it absorbed
    consumed: (rec.consumedIds || []).map((sid) => {
      const s = partById(sid);
      return s ? {
        id: sid, consumed: !!s.consumed, consumedBy: s.consumedBy,
        consumedKind: s.consumedKind, prevVisible: s.prevVisible, visible: s.visible !== false,
      } : null;
    }).filter(Boolean),
    // consumed source: the host's list, so putting it back re-links it
    hostId: host ? host.id : null,
    hostConsumedIds: host ? (host.consumedIds || []).slice() : null,
  };
}

async function restorePart(snap) {
  if (!snap || partById(snap.id)) return;
  const rec = cloneJson(snap.rec);
  const at = Math.min(Math.max(snap.index, 0), state.parts.length);
  state.parts.splice(at, 0, rec);                 // same row position as before
  try {
    // The server file was never deleted — the mesh streams straight back.
    await viewer.addPart(snap.id, snap.stlUrl, rec.role, { solid: snap.solid });
  } catch (err) {
    ui.toast(`Could not restore "${rec.name}": ${err.message}`, 'error', 9000);
    state.parts = state.parts.filter((p) => p.id !== snap.id);
    throw err;
  }
  if (rec.trs) viewer.setPartTransform(snap.id, cloneTrs(rec.trs), { fit: false });
  if (rec.visible === false) viewer.setPartVisible(snap.id, false);

  if (snap.wasLattice) state.latticePartId = snap.id;
  if (rec.isResult) {                              // lattice: re-ghost + re-link
    for (const sid of snap.ghostIds) { const s = partById(sid); if (s) s.ghosted = true; }
    viewer.linkGhosts(snap.id, snap.ghostIds);
    viewer.dimUploaded();
  }
  for (const c of snap.consumed) {                 // boolean result: re-consume
    const s = partById(c.id);
    if (!s) continue;
    s.consumed = c.consumed; s.consumedBy = c.consumedBy; s.consumedKind = c.consumedKind;
    s.prevVisible = c.prevVisible; s.visible = c.visible;
    viewer.setPartVisible(c.id, c.visible);
  }
  if (snap.hostId) {                               // consumed source: host takes it back
    const h = partById(snap.hostId);
    if (h) h.consumedIds = (snap.hostConsumedIds || []).slice();
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
  refreshParts();
  updateOrbitPivot();
  syncSelToolbar();
  tools.onPartsChanged();
}

// ── keyboard + header buttons ─────────────────────────────────────────
function isTypingTarget(el) {
  if (!el) return false;
  const tag = (el.tagName || '').toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable === true;
}
/** A HUD dialog is up (MCP, or any future .hud-modal) — it owns the keyboard. */
function modalOpen() {
  return !!document.querySelector('.hud-overlay:not([hidden]), .hud-modal:not([hidden])');
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

// ── Mode logic (roles → single | fuse | disabled) ─────────────────────
// BASE roles (part/positive/negative) decide the mode exactly as before; ZONE
// roles (lattice/keep/void) layer on top and require a valid base part. Generate
// is gated on FULL validity (base valid AND, if zones exist, a base to hang them
// on). computeMode returns { mode, valid, partId|positiveId+negativeId, zones? }.
// A generated lattice is NEVER a generate input: regeneration always derives
// from the ORIGINAL sources (which stay in the list, ghosted), so GENERATE
// re-runs the same recipe and replaces the lattice part.
function computeMode() {
  const base = state.parts.filter((p) => !p.isResult && !p.consumed && isBaseRole(p.role));
  const zones = state.parts.filter((p) => !p.isResult && !p.consumed && isZoneRole(p.role));
  const part = base.filter((p) => p.role === 'part');
  const pos  = base.filter((p) => p.role === 'positive');
  const neg  = base.filter((p) => p.role === 'negative');

  if (state.parts.length === 0)
    return { valid: false, note: 'Upload an STL or STEP part to begin.' };

  // Resolve the base mode (or null if the base roles are not a valid combo).
  let baseMode = null, baseInfo = {};
  if (part.length === 1 && pos.length === 0 && neg.length === 0) {
    baseMode = 'single'; baseInfo = { partId: part[0].id };
  } else if (pos.length === 1 && neg.length === 1 && part.length === 0) {
    baseMode = 'fuse'; baseInfo = { positiveId: pos[0].id, negativeId: neg[0].id };
  }

  if (!baseMode) {
    // Invalid base. If zones exist with no valid base, say so first (the gate the
    // plan calls out); otherwise diagnose the base-role combination as before.
    let note;
    if (base.length === 0 && zones.length > 0)
      note = 'Zones need a base part. Set one part to "Part" (single) or one Positive + one Negative (fuse).';
    else if (part.length > 1)
      note = `Single mode needs exactly one "Part" — ${part.length} are set. Change the extras to a zone role or remove them.`;
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
  const zoneNote = zones.length ? ` · ${zones.length} zone${zones.length > 1 ? 's' : ''}` : '';
  m.note = (baseMode === 'single'
    ? 'Single mode — gyroidize the whole part.'
    : 'Fuse mode — lattice the cavity and merge into the positive.') + zoneNote;
  return m;
}

function updateMode() {
  const m = computeMode();
  ui.setMode(m.valid, m.note);
  ui.setOverlapEnabled(m.mode === 'fuse');
  // Progressive disclosure: the ZONES tile appears once any zone role exists.
  ui.setZonesVisible(state.parts.some((p) => !p.consumed && isZoneRole(p.role)));
  return m;
}

// ── Accent budget + live viewport context (Fix 1 / Fix 6) ──────────────
// The solid --primary fill is a single-occupancy slot tied to the next primary
// action: pinned GENERATE while armed/generating, EXPORT STL once a fresh result
// exists. Empty & invalid states carry no fill (ghost GENERATE via CSS).
function updateAccents() {
  // toolOpen wins the single solid fill: an open, valid tool's CONFIRM holds it
  // while GENERATE + EXPORT ghost; the slot returns to the generate/export
  // machine the moment the tool closes. Exactly one solid fill at all times.
  if (tools.isOpen()) {
    ui.setToolConfirmFilled(tools.isValid());
    ui.setGenerateFilled(false);
    ui.setExportStlFilled(false);
    return;
  }
  ui.setToolConfirmFilled(false);
  const generating = ui.isGenerating();
  const fresh = state.resultFresh && !generating;
  const genEnabled = !ui.els.generate.disabled;   // false while generating (disabled) or invalid
  ui.setGenerateFilled(generating || (genEnabled && !fresh));
  ui.setExportStlFilled(fresh);
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
// result is no longer fresh). STEP target is export-only, so it's excluded.
function markParamsDirty(e) {
  if (e && e.target && e.target.id === 'p-steptris') return;
  state.resultFresh = false;
  updateAccents();
  updateViewportContext();
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
  state.job = { id: jobId, stepTarget };   // STEP legacy + flow stats still key off the job
  state.resultStats = st.stats || null;   // Wave-3 — the EXPORT tile's RESULT row reads its tri count
  state.resultFresh = true;   // Fix 1 — result matches current params: EXPORT takes the fill
  ui.showResult(st.stats);
  ui.setViewportHint(false);
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
// ingest it like any op output but flagged `isResult`, draw it SOLID, and link
// the sources it was built from as ghosts that ride its transform. One lattice
// at a time: regenerating replaces the previous one.
async function adoptLatticePart(part) {
  if (state.latticePartId) await dropLatticePart(state.latticePartId);

  const rec = {
    id: part.id, name: part.name, triangles: part.triangles,
    sourceFormat: part.sourceFormat || 'derived', role: 'part', visible: true,
    volumeMM3: part.volumeMM3, bbox: part.bbox, derived: part.derived || null, trs: null,
    isResult: true, sourceIds: (part.derived?.sourceIds || []).slice(),
  };
  state.parts.push(rec);
  state.latticePartId = rec.id;

  // Sources stay visible at ghost opacity, with their role select locked while
  // they belong to this lattice (eye + delete stay live).
  const ghostIds = [];
  for (const sid of rec.sourceIds) {
    const src = partById(sid);
    if (!src || src.isResult) continue;
    src.ghosted = true;
    ghostIds.push(sid);
  }

  refreshParts();
  ui.flashPartRow(rec.id);
  try {
    await viewer.addPart(part.id, part.stlUrl, rec.role, { solid: true });
    viewer.linkGhosts(rec.id, ghostIds);
    viewer.dimUploaded();     // the sources read as ghosts behind the solid lattice
    updateDims();
    updateOrbitPivot();       // the lattice joins the COM
  } catch (err) {
    ui.toast(`Lattice generated but its 3D preview failed: ${err.message}`, 'warn');
  }
  refreshExport();            // the lattice row replaces the jobId RESULT row
}

// App-state half of dropping a lattice: sources un-ghost, the ghost dim lifts.
function releaseLattice(rec) {
  for (const sid of rec.sourceIds || []) {
    const src = partById(sid);
    if (src) src.ghosted = false;
  }
  if (state.latticePartId === rec.id) state.latticePartId = null;
  viewer.undimUploaded();
}

// Remove the previous lattice entirely (state + viewer + server) so a regenerate
// leaves exactly one lattice row behind.
async function dropLatticePart(id) {
  const rec = partById(id);
  if (!rec) { state.latticePartId = null; return; }
  if (id === state.selectedPartId) clearSelection();
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
  const items = state.parts.map((p) => ({
    id: p.id, kind: 'part', role: p.role, name: p.name,
    meta: `${(p.triangles ?? 0).toLocaleString('en-US')} tris`,
    stem: p.isResult ? latticeStem(p) : nameStem(p.name),
  }));
  if (state.job && !state.latticePartId) {
    const patt = PATTERN_LABEL[ui.els.pattern.value] || 'LATTICE';
    const tris = state.resultStats?.triangles;
    items.push({
      id: `job:${state.job.id}`, kind: 'job', jobId: state.job.id, role: null,
      name: `RESULT · ${patt}`,
      meta: tris != null ? `${tris.toLocaleString('en-US')} tris` : 'lattice result',
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
  if (state.selectedPartId && items.some((i) => i.id === state.selectedPartId))
    return new Set([state.selectedPartId]);
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
  const format = ui.getExportFormat();
  ui.setExportOutputVisible(checked.size > 1);
  ui.setExportStepVisible(format === 'step');
  ui.setExportStepTris(ui.readParams().stepTargetTriangles);
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
    // Reveal the FEEDBACK → GitHub issues link once the server reports a repoUrl.
    const fb = ui.els.feedbackBtn;
    if (fb) {
      const repoUrl = (h.repoUrl || '').trim();
      if (repoUrl) {
        fb.href = repoUrl.replace(/\/+$/, '') + '/issues/new';
        fb.hidden = false;
      } else {
        fb.hidden = true;
      }
    }
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
function volumeMap() {
  const m = {};
  for (const p of state.parts) if (p.volumeMM3 != null) m[p.id] = p.volumeMM3;
  return m;
}
function updateOrbitPivot() {
  const vol = volumeMap();
  viewer.setVolumeHint(vol);
  const sel = state.selectedPartId ? partById(state.selectedPartId) : null;
  if (sel && sel.visible) viewer.setOrbitPivot(viewer.getPartCenter(sel.id));
  else viewer.setOrbitPivot(viewer.computeCenterOfMass(vol));
}

ui.initPanels();

// Grouped pipeline toolbar (ADD PART · TPMS · ORIENT · GENERATE · FLOW · STL · STEP).
// GENERATE/FLOW/STL/STEP reuse the existing handlers/buttons — no duplicated state.
ui.els.tbImport?.addEventListener('click', () => ui.els.fileInput.click());
// Wave-1 tool buttons open/close their contextual panel (js/tools.js).
ui.els.tbPrim?.addEventListener('click', () => tools.toggle('primitive'));
// BOOL carries all four combine modes (union/difference/intersect/smooth) — the
// old MERGE button was the same tool with the fillet exposed, so it is gone.
ui.els.tbBool?.addEventListener('click', () => tools.toggle('boolean'));
ui.els.tbShell?.addEventListener('click', () => tools.toggle('shell'));
ui.els.tbOffset?.addEventListener('click', () => tools.toggle('offset'));
ui.els.tbXform?.addEventListener('click', () => tools.toggle('transform'));
ui.els.tbMirror?.addEventListener('click', () => tools.toggle('mirror'));
ui.els.tbDupe?.addEventListener('click', () => tools.toggle('duplicate'));
ui.els.tbTpms?.addEventListener('click', () => ui.focusSection('tpms'));
ui.els.tbOrient?.addEventListener('click', () => ui.focusSection('orient'));
ui.els.tbGenerate?.addEventListener('click', () => { if (ui.isGenerating()) onCancel(); else onGenerate(); });
ui.els.tbFlow?.addEventListener('click', () => ui.focusSection('flow'));
// EXPORT is parts-gated (not result-gated): it opens the right panel and flashes
// the EXPORT tile, and reopening resets the filename back to auto-tracking.
ui.els.tbExport?.addEventListener('click', () => {
  exportUi.nameDirty = false;
  refreshExport();
  ui.focusSection('export');
});

// The nested OBJECTS op line ("└ TPMS · GYROID · PART") reflects the pattern.
ui.els.pattern?.addEventListener('change', refreshParts);

// Re-arm the primary action (and refresh the viewport context) on any
// generation-param change (Fix 1 / Fix 6). input/change bubble from every
// stepper input and select; the SHEET/SKELETAL + X/Y/Z toggles fire click.
ui.els.panelLeft?.addEventListener('input', markParamsDirty);
ui.els.panelLeft?.addEventListener('change', markParamsDirty);
ui.els.panelLeft?.addEventListener('click', (e) => {
  if (e.target.closest?.('.seg-btn, .fchip')) markParamsDirty();
});

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
  const on = !ui.els.vpSection.classList.contains('active');
  ui.els.vpSection.classList.toggle('active', on);
  ui.els.vpSection.setAttribute('aria-pressed', on ? 'true' : 'false');
  if (ui.els.vpSectionWrap) ui.els.vpSectionWrap.hidden = !on;
  viewer.setSection(on);   // ON → triad pick mode (no plane preselected)
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

// The floating selection toolbar mirrors selection + active gizmo mode. Neutral
// styling (outside the accent machine) — the active mode reads via a --fg tint.
function syncSelToolbar() {
  const p = state.selectedPartId ? partById(state.selectedPartId) : null;
  if (!p) { if (selBar) selBar.hidden = true; return; }
  if (selName) selName.textContent = p.name;
  if (selBar) selBar.hidden = false;
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
function routeSelection(id) {
  const host = latticeHosting(id ? partById(id) : null);
  if (!host) return id;
  if (!ghostRouteToasted) {
    ghostRouteToasted = true;
    ui.toast('Ghost is linked to the lattice — they move together.', 'info', 4500);
  }
  return host.id;
}

// Select a part (id) or clear (null). Selection is the single source of truth:
// rows (`.selected`), the viewer emissive tint, and the gizmo all derive from it.
// Selecting ALWAYS arms MOVE: a selected part is in transform mode, with the
// arrows sitting on the part itself (viewer pivots the gizmo on the bbox centre).
function selectPart(id) {
  const p = id ? partById(routeSelection(id)) : null;
  const nextId = p ? p.id : null;
  if (nextId !== state.selectedPartId) {   // changing/clearing selection resets the gizmo
    state.gizmoMode = null;
    state.layFlatArmed = false;
    viewer.stopGizmo();
    viewer.cancelLayFlat();
    document.body.classList.remove('layflat-armed');
  }
  state.selectedPartId = nextId;
  viewer.setSelected(nextId);
  if (nextId && !state.gizmoMode) { state.gizmoMode = 'translate'; viewer.setGizmoMode('translate'); }
  updateOrbitPivot();   // pivot follows the selection (camera stays put)
  syncSelToolbar();
  refreshParts();   // re-derive the `.selected` row class from state
}
function clearSelection() { selectPart(null); }

function setGizmoMode(mode) {
  if (!state.selectedPartId) return;
  state.layFlatArmed = false;
  viewer.cancelLayFlat();
  document.body.classList.remove('layflat-armed');
  state.gizmoMode = mode;
  viewer.setGizmoMode(mode);   // attach the gizmo (proxy ← part TRS) / switch mode
  syncSelToolbar();
}
function armLayFlat() {
  if (!state.selectedPartId) return;
  state.layFlatArmed = true;
  state.gizmoMode = null;
  viewer.armLayFlat();
  document.body.classList.add('layflat-armed');
  syncSelToolbar();
  ui.toast('LAY FLAT — click a highlighted face plane (or any face) to rest it on Z = 0.', 'info', 4500);
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
// DROP — Z0 is the print bed: ground the selection (and any ghosts riding it).
selDrop?.addEventListener('click', () => {
  if (!state.selectedPartId) return;
  const trs = viewer.dropToPlate(state.selectedPartId);
  if (!trs) return;
  commitTransform(state.selectedPartId, trs);
  ui.toast('Dropped to Z = 0.', 'success', 2200);
});

// ── viewer callbacks — the viewer owns pointer routing (cube → section →
//    lay-flat → gizmo → plate-drag → selection); main owns app state + the
//    commit path. ──
// Every in-canvas commit is `fit: false`: a direct manipulation must not yank
// the camera back to the iso framing the user just orbited away from. (The
// TRANSFORM panel keeps fit-on-commit.)
// Wave-4: every commit is ONE undo entry. A rotate that auto-drops arrives here
// as a single grounded TRS, so one Ctrl+Z takes back the rotation AND the drop.
function commitTransform(id, trs) {
  const prev = cloneTrs(partById(id)?.trs);
  const next = cloneTrs(trs);
  applyCommitTrs(id, next);
  pushTrsCommand(id, prev, next, { label: 'Move / rotate' });
}

viewer.onPick = (id) => selectPart(id);                     // id or null (empty click clears)
viewer.onDragChange = (dragging) => { state.draggingGizmo = dragging; };
viewer.onTransformLive = (id, trs) => {                     // mid-drag: rebuild only, no fit
  viewer.setPartTransformLive(id, trs);
  updateDims();
};
viewer.onTransformCommit = (id, trs) => commitTransform(id, trs);   // drag END: single commit

// Moving a SOURCE out from under its lattice makes the lattice stale, so
// GENERATE re-takes the fill. Wave-4: the gizmo/plate/lay-flat paths can no
// longer reach a linked ghost (selection routes to the lattice, and the lattice
// carries its ghosts), so the only caller left is the TRANSFORM tool.
function markSourceMoved(p) {
  if (!p || p.isResult || !p.ghosted || !state.resultFresh) return;
  state.resultFresh = false;
  updateAccents();
}
viewer.onLayFlat = (id, trs) => {                           // one-shot face pick result
  state.layFlatArmed = false;
  document.body.classList.remove('layflat-armed');
  if (trs) {
    commitTransform(id, trs);
    ui.toast('Laid flat on Z = 0.', 'success', 2500);
  }
  syncSelToolbar();
};

// Escape clears selection — but only when no contextual tool owns Escape
// (tools.js closes an open tool first) and no HUD dialog is up. One keypress =
// one action: with the MCP modal open, Escape closes the modal and NOTHING else.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || tools.isOpen() || modalOpen()) return;
  if (state.layFlatArmed) { cancelLayFlat(); return; }
  if (state.selectedPartId) clearSelection();
});

// Expose for Stage-4 browser verification (selection/gizmo/section checks).
window.__anvil = {
  viewer, state, selectPart, setGizmoMode, armLayFlat,
  history, commitTransform, deletePart, consumeSources, partById, flagsSnapshot,
};

// ── init ──────────────────────────────────────────────────────────────
ui.initSteppers();
ui.initLatticeControls();
ui.initTooltips();
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
