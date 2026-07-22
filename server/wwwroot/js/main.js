//
// main.js — Infill App controller. Owns app state, wires events, drives the
// upload → parameters → generate → poll → export loop.
//
import * as api from './api.js';
import * as ui from './ui.js';
import { Viewer } from './viewer.js';

// ── State ─────────────────────────────────────────────────────────────
const state = {
  parts: [],        // { id, name, triangles, sourceFormat, role, visible }
  job: null,        // { id } of the last successful generation
  poll: null,       // interval handle for generation polling
  stepPoll: null,   // interval handle for STEP-export polling
};

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
  handleFiles(files);
});
// Prevent the browser from navigating when a file is dropped outside the zone.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

async function handleFiles(files) {
  const accepted = files.filter((f) => /\.(stl|step|stp)$/i.test(f.name));
  const rejected = files.filter((f) => !/\.(stl|step|stp)$/i.test(f.name));
  for (const f of rejected) ui.toast(`Skipped "${f.name}" — only STL / STEP are supported.`, 'warn');

  for (const file of accepted) {
    try {
      const part = await api.uploadPart(file);
      const rec = {
        id: part.id, name: part.name, triangles: part.triangles,
        sourceFormat: part.sourceFormat, role: 'part', visible: true,
      };
      state.parts.push(rec);
      applyAutoRoles();
      await viewer.addPart(part.id, part.stlUrl, rec.role);
      // Roles may have changed via applyAutoRoles — sync viewer colors.
      syncViewerRoles();
      refreshParts();
    } catch (err) {
      ui.toast(`Upload failed for "${file.name}": ${err.message}`, 'error', 9000);
    }
  }
}

// First part → Part. When exactly two parts exist, switch to positive/negative
// (bumpmesh-simple default). Beyond two, new parts default to Part.
function applyAutoRoles() {
  if (state.parts.length === 2) {
    // Only auto-assign if the user hasn't already carved out a fuse pair.
    state.parts[0].role = 'positive';
    state.parts[1].role = 'negative';
  }
}
function syncViewerRoles() {
  for (const p of state.parts) viewer.setPartRole(p.id, p.role);
}

// ── Parts list interactions ───────────────────────────────────────────
function refreshParts() {
  ui.renderParts(state.parts, {
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
  ui.setViewportHint(state.parts.length === 0 && !state.job);
  updateMode();
}

async function deletePart(id) {
  state.parts = state.parts.filter((x) => x.id !== id);
  viewer.removePart(id);
  refreshParts();
  try { await api.deletePart(id); } catch { /* best effort */ }
}

// ── Mode logic (roles → single | fuse | disabled) ─────────────────────
function computeMode() {
  const part = state.parts.filter((p) => p.role === 'part');
  const pos  = state.parts.filter((p) => p.role === 'positive');
  const neg  = state.parts.filter((p) => p.role === 'negative');

  if (state.parts.length === 0)
    return { valid: false, note: 'Upload an STL or STEP part to begin.' };

  if (part.length === 1 && pos.length === 0 && neg.length === 0)
    return { mode: 'single', valid: true, partId: part[0].id,
             note: 'Single mode — gyroidize the whole part.' };

  if (pos.length === 1 && neg.length === 1 && part.length === 0)
    return { mode: 'fuse', valid: true, positiveId: pos[0].id, negativeId: neg[0].id,
             note: 'Fuse mode — lattice the cavity and merge into the positive.' };

  // Diagnose the invalid combination.
  let note;
  if (part.length > 1)
    note = `Single mode needs exactly one "Part" — ${part.length} are set. Change the extras to Positive/Negative or remove them.`;
  else if (pos.length + neg.length > 0 && part.length > 0)
    note = 'Mixed roles: use one Part (single) OR one Positive + one Negative (fuse).';
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

function updateMode() {
  const m = computeMode();
  ui.setMode(m.valid, m.note);
  ui.setOverlapEnabled(m.mode === 'fuse');
  return m;
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
  };
  if (m.mode === 'single') body.partId = m.partId;
  else { body.positiveId = m.positiveId; body.negativeId = m.negativeId; }

  stopPolling();
  ui.hideResult();
  ui.showProgress(true);
  ui.setProgress(0, 'Queued…');

  let jobId;
  try {
    const res = await api.createJob(body);
    jobId = res.jobId;
    if (res.warning) ui.toast(res.warning, 'warn', 9000);
  } catch (err) {
    ui.showProgress(false);
    ui.toast(err.message, 'error', 11000);   // surfaces the resolution-guard 400
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
      ui.toast(`Generation failed: ${st.error || 'unknown error'}`, 'error', 12000);
    } else if (st.state === 'cancelled') {
      stopPolling();
      ui.showProgress(false);
      ui.toast('Generation cancelled.', 'warn');
    }
  }, 500);
}

async function onJobDone(jobId, st, stepTarget) {
  state.job = { id: jobId, stepTarget };
  ui.showResult(st.stats);
  ui.setViewportHint(false);
  try {
    await viewer.showResult(api.previewUrl(jobId));
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
  triggerDownload(api.previewUrl(state.job.id, true), `${state.job.id}_infill.stl`);
});

// ── Export STEP (async: kick off, poll job.step, then link the file) ──
ui.els.exportStep.addEventListener('click', onExportStep);

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
      triggerDownload(url, `${jobId}_infill.step`);
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

// ── init ──────────────────────────────────────────────────────────────
refreshParts();
pollHealth();
setInterval(pollHealth, 10000);
