//
// main.js — Infill App controller. Owns app state, wires events, drives the
// upload → parameters → generate → poll → export loop.
//
import * as api from './api.js';
import * as ui from './ui.js';
import * as tools from './tools.js';
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
    };
    // Swap placeholder → real row the instant conversion returns, then flash.
    removePending(tempId);
    state.parts.push(rec);
    applyAutoRoles();
    refreshParts();
    ui.flashPartRow(rec.id);

    try {
      await viewer.addPart(part.id, part.stlUrl, rec.role);
      // Roles may have changed via applyAutoRoles — sync viewer colors.
      syncViewerRoles();
      updateDims();
    } catch (err) {
      ui.toast(`"${part.name}" loaded, but its 3D preview failed: ${err.message}`, 'warn');
    }
  }
}

function removePending(tempId) {
  state.pending = state.pending.filter((p) => p.tempId !== tempId);
}

// First part → Part. When exactly two BASE-role parts exist and both are still
// the default "Part", switch them to positive/negative (bumpmesh-simple default).
// Only BASE-role uploads count — derived and zone parts never trigger the flip.
function applyAutoRoles() {
  const base = state.parts.filter((p) => isBaseRole(p.role));
  if (base.length === 2 && base.every((p) => p.role === 'part')) {
    base[0].role = 'positive';
    base[1].role = 'negative';
  }
}
function syncViewerRoles() {
  for (const p of state.parts) viewer.setPartRole(p.id, p.role);
}

// ── Transforms (non-destructive per-part TRS) ─────────────────────────
function nonIdentityTrs(trs) {
  if (!trs) return null;
  const t = trs.translateMM || {}, r = trs.rotateDeg || {};
  const any = ['x', 'y', 'z'].some((k) => (t[k] || 0) !== 0 || (r[k] || 0) !== 0);
  return any ? {
    translateMM: { x: t.x || 0, y: t.y || 0, z: t.z || 0 },
    rotateDeg:   { x: r.x || 0, y: r.y || 0, z: r.z || 0 },
  } : null;
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
async function runOpFlow(body, onProgress) {
  const resp = await api.runOp(body);
  if (resp && resp.id && !resp.jobId) {          // synchronous duplicate
    await addOpPart(resp);
    return resp;
  }
  if (resp.warning) ui.toast(resp.warning, 'warn', 8000);
  const part = await pollOpJob(resp.jobId, onProgress);
  if (part) await addOpPart(part);
  return part;
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
  };
  state.parts.push(rec);
  refreshParts();
  ui.flashPartRow(rec.id);
  try {
    await viewer.addPart(part.id, part.stlUrl, rec.role);
    syncViewerRoles();
    updateDims();
  } catch (err) {
    ui.toast(`"${part.name}" created, but its 3D preview failed: ${err.message}`, 'warn');
  }
}

// ── Tool controller (passed to tools.initTools) ───────────────────────
const toolCtx = {
  listParts: () => state.parts.map((p) => ({ id: p.id, name: p.name, role: p.role })),
  unionCenter: () => viewer.getVisibleCenter(),
  voxelDefault: () => ui.readParams().voxelSizeMM,
  getPartTrs: (id) => state.parts.find((p) => p.id === id)?.trs || null,
  partBbox: (id) => state.parts.find((p) => p.id === id)?.bbox || null,
  setPartTransform: (id, trs) => {
    const p = state.parts.find((x) => x.id === id);
    if (!p) return;
    p.trs = trs;
    viewer.setPartTransform(id, trs);
    updateDims();
  },
  clearPartTransform: (id) => {
    const p = state.parts.find((x) => x.id === id);
    if (p) p.trs = null;
    viewer.clearPartTransform(id);
    updateDims();
  },
  runOp: (body, onProgress) => runOpFlow(body, onProgress),
  onStateChange: () => updateAccents(),
  toast: (msg, kind, ms) => ui.toast(msg, kind, ms),
};

// ── Parts list interactions ───────────────────────────────────────────
function refreshParts() {
  ui.renderParts(state.parts, state.pending, {
    onRoleChange: (id, role) => {
      const p = state.parts.find((x) => x.id === id);
      if (!p) return;
      p.role = role;
      viewer.setPartRole(id, role);
      refreshParts();
    },
    onToggleVisible: (id) => {
      const p = state.parts.find((x) => x.id === id);
      if (!p) return;
      p.visible = !p.visible;
      viewer.setPartVisible(id, p.visible);
      refreshParts();
    },
    onDelete: (id) => deletePart(id),
  });
  ui.setDropzoneBusy(state.pending.length > 0);
  ui.setViewportHint(state.parts.length === 0 && !state.job);
  updateMode();
  updateDims();   // union-bbox readout + SECTION availability track the visible set
  updateAccents();          // Fix 1 — refresh the single-fill slot for the new part/role set
  updateViewportContext();  // Fix 6 — mode may have changed with roles
}

async function deletePart(id) {
  state.parts = state.parts.filter((x) => x.id !== id);
  viewer.removePart(id);
  refreshParts();
  tools.onPartsChanged();   // an open picker tool refreshes its part list
  try { await api.deletePart(id); } catch { /* best effort */ }
}

// ── Mode logic (roles → single | fuse | disabled) ─────────────────────
// BASE roles (part/positive/negative) decide the mode exactly as before; ZONE
// roles (lattice/keep/void) layer on top and require a valid base part. Generate
// is gated on FULL validity (base valid AND, if zones exist, a base to hang them
// on). computeMode returns { mode, valid, partId|positiveId+negativeId, zones? }.
function computeMode() {
  const base = state.parts.filter((p) => isBaseRole(p.role));
  const zones = state.parts.filter((p) => isZoneRole(p.role));
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
  ui.setZonesVisible(state.parts.some((p) => isZoneRole(p.role)));
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
  state.job = { id: jobId, stepTarget };
  state.resultFresh = true;   // Fix 1 — result matches current params: EXPORT STL takes the fill
  ui.showResult(st.stats);
  ui.setViewportHint(false);
  updateAccents();
  try {
    await viewer.showResult(api.previewUrl(jobId));
    updateDims();
  } catch (err) {
    ui.toast(`Result generated but preview failed to load: ${err.message}`, 'warn');
  }
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

// ── Export STL ────────────────────────────────────────────────────────
ui.els.exportStl.addEventListener('click', () => {
  if (!state.job) return;
  triggerDownload(api.previewUrl(state.job.id, true), `${state.job.id}_anvil.stl`);
});

// ── Export STEP (async: kick off, poll job.step, then link the file) ──
ui.els.exportStep.addEventListener('click', onExportStep);

// Export split-menu: one Export button reveals the STL / STEP options.
const exportBtnEl = document.getElementById('export-btn');
const exportOptsEl = document.getElementById('export-opts');
function closeExportMenu() { exportOptsEl.classList.add('hidden'); exportBtnEl.setAttribute('aria-expanded', 'false'); }
exportBtnEl.addEventListener('click', (e) => {
  e.stopPropagation();
  const open = exportOptsEl.classList.contains('hidden');
  exportOptsEl.classList.toggle('hidden', !open);
  exportBtnEl.setAttribute('aria-expanded', String(open));
});
exportOptsEl.addEventListener('click', closeExportMenu);   // picking an option runs its handler, then closes
document.addEventListener('click', (e) => { if (!e.target.closest('#export-menu')) closeExportMenu(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeExportMenu(); });

async function onExportStep() {
  if (!state.job) return;
  const target = ui.readParams().stepTargetTriangles;

  ui.setStepBusy(true);
  ui.setStepStatus('', 'Converting to faceted STEP… this can take a while for dense meshes.');

  try {
    await api.startStepExport(state.job.id, target);
  } catch (err) {
    ui.setStepBusy(false);
    ui.setStepStatus('err', `STEP export could not start: ${escapeHtml(err.message)}`);
    return;
  }
  pollStep(state.job.id);
}

function pollStep(jobId) {
  if (state.stepPoll) clearInterval(state.stepPoll);
  state.stepPoll = setInterval(async () => {
    let st;
    try {
      st = await api.getJob(jobId);
    } catch (err) {
      clearInterval(state.stepPoll); state.stepPoll = null;
      ui.setStepBusy(false);
      ui.setStepStatus('err', `Lost contact during STEP export: ${escapeHtml(err.message)}`);
      return;
    }

    const step = st.step || {};
    if (step.state === 'done') {
      clearInterval(state.stepPoll); state.stepPoll = null;
      ui.setStepBusy(false);
      const tri = step.triangles != null ? `${step.triangles.toLocaleString('en-US')} triangles` : '';
      const warn = step.warning ? `<br><span class="chip" style="color:var(--amber)">${escapeHtml(step.warning)}</span>` : '';
      const url = api.resultStepUrl(jobId, true);
      ui.setStepStatus('ok',
        `STEP ready${tri ? ` (${tri})` : ''}. <a href="${url}" download>Download result.step</a>${warn}`);
      // Auto-start the download via a plain anchor (large file — no fetch into memory).
      triggerDownload(url, `${jobId}_anvil.step`);
    } else if (step.state === 'failed' || step.state === 'error') {
      clearInterval(state.stepPoll); state.stepPoll = null;
      ui.setStepBusy(false);
      ui.setStepStatus('err', `STEP export failed: ${escapeHtml(step.error || 'unknown error')}`);
    }
    // else: none | running → keep the spinner going.
  }, 500);
}

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

ui.initPanels();

// Grouped pipeline toolbar (IMPORT · TPMS · ORIENT · GENERATE · FLOW · STL · STEP).
// GENERATE/FLOW/STL/STEP reuse the existing handlers/buttons — no duplicated state.
ui.els.tbImport?.addEventListener('click', () => ui.els.fileInput.click());
// Wave-1 tool buttons open/close their contextual panel (js/tools.js).
ui.els.tbPrim?.addEventListener('click', () => tools.toggle('primitive'));
ui.els.tbBool?.addEventListener('click', () => tools.toggle('boolean'));
ui.els.tbMerge?.addEventListener('click', () => tools.toggle('merge'));
ui.els.tbShell?.addEventListener('click', () => tools.toggle('shell'));
ui.els.tbOffset?.addEventListener('click', () => tools.toggle('offset'));
ui.els.tbXform?.addEventListener('click', () => tools.toggle('transform'));
ui.els.tbMirror?.addEventListener('click', () => tools.toggle('mirror'));
ui.els.tbDupe?.addEventListener('click', () => tools.toggle('duplicate'));
ui.els.tbTpms?.addEventListener('click', () => ui.focusSection('tpms'));
ui.els.tbOrient?.addEventListener('click', () => ui.focusSection('orient'));
ui.els.tbGenerate?.addEventListener('click', () => { if (ui.isGenerating()) onCancel(); else onGenerate(); });
ui.els.tbFlow?.addEventListener('click', () => ui.focusSection('flow'));
ui.els.tbStl?.addEventListener('click', () => ui.els.exportStl.click());
ui.els.tbStep?.addEventListener('click', () => ui.els.exportStep.click());

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

// Floating view strip — FIT · GHOSTS · SECTION.
ui.els.vpFit?.addEventListener('click', () => viewer.fitView());
ui.els.vpGhosts?.addEventListener('click', () => {
  const hidden = viewer.toggleGhosts();
  ui.els.vpGhosts.classList.toggle('active', hidden);
  ui.els.vpGhosts.setAttribute('aria-pressed', hidden ? 'true' : 'false');
  updateDims();
});
ui.els.vpSection?.addEventListener('click', () => {
  const on = !ui.els.vpSection.classList.contains('active');
  ui.els.vpSection.classList.toggle('active', on);
  ui.els.vpSection.setAttribute('aria-pressed', on ? 'true' : 'false');
  if (ui.els.vpSectionWrap) ui.els.vpSectionWrap.hidden = !on;
  viewer.setSection(on, ui.getFlowAxis());
  if (on) viewer.setSectionPosition(Number(ui.els.vpSectionSlider.value) / 100);
});
ui.els.vpSectionSlider?.addEventListener('input', () =>
  viewer.setSectionPosition(Number(ui.els.vpSectionSlider.value) / 100));
// Keep an active section plane aligned to the flow axis if the user changes it.
ui.els.flowAxis?.addEventListener('click', () => {
  if (ui.els.vpSection?.classList.contains('active')) viewer.setSectionAxis(ui.getFlowAxis());
});

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
