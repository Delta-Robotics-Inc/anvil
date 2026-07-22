//
// ui.js — DOM references, rendering, and small view helpers.
//
// main.js owns app state + orchestration and calls into these. This module
// only touches the DOM; it holds no application state beyond cached elements.
//

export const els = {
  viewport:     document.getElementById('viewport'),
  viewportHint: document.getElementById('viewport-hint'),

  dropzone:   document.getElementById('dropzone'),
  fileInput:  document.getElementById('file-input'),

  partsList:  document.getElementById('parts-list'),
  partsEmpty: document.getElementById('parts-empty'),
  partsCount: document.getElementById('parts-count'),

  pattern:  document.getElementById('p-pattern'),
  cell:     document.getElementById('p-cell'),
  wall:     document.getElementById('p-wall'),
  voxel:    document.getElementById('p-voxel'),
  overlap:  document.getElementById('p-overlap'),
  overlapField: document.getElementById('overlap-field'),
  smooth:   document.getElementById('p-smooth'),
  stepTris: document.getElementById('p-steptris'),

  generate: document.getElementById('generate-btn'),
  modeNote: document.getElementById('mode-note'),
  progressWrap:  document.getElementById('progress-wrap'),
  progressFill:  document.getElementById('progress-fill'),
  progressStage: document.getElementById('progress-stage'),
  cancel:   document.getElementById('cancel-btn'),

  resultCard: document.getElementById('result-card'),
  statVolume: document.getElementById('stat-volume'),
  statInfill: document.getElementById('stat-infill'),
  statTris:   document.getElementById('stat-tris'),
  exportStl:  document.getElementById('export-stl-btn'),
  exportStep: document.getElementById('export-step-btn'),
  stepSpinner: document.getElementById('step-spinner'),
  stepStatus: document.getElementById('step-status'),

  connDot: document.getElementById('conn-dot'),
  connTxt: document.getElementById('conn-txt'),
  toastStack:  document.getElementById('toast-stack'),
};

const ROLE_LABEL = { part: 'Part', positive: 'Positive', negative: 'Negative' };
const ROLE_CSS   = { part: 'var(--role-part)', positive: 'var(--role-pos)', negative: 'var(--role-neg)' };

// ── Parts list ────────────────────────────────────────────────────────
export function renderParts(parts, handlers) {
  const list = els.partsList;
  list.innerHTML = '';
  els.partsCount.textContent = String(parts.length);

  if (parts.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'parts-empty';
    empty.textContent = 'No parts uploaded yet.';
    list.appendChild(empty);
    return;
  }

  for (const p of parts) {
    const row = document.createElement('div');
    row.className = 'part-row';
    row.style.setProperty('--role-color', ROLE_CSS[p.role] || 'var(--border-strong)');

    const main = document.createElement('div');
    main.className = 'part-main';
    const name = document.createElement('div');
    name.className = 'part-name';
    name.textContent = p.name;
    name.title = p.name;
    const meta = document.createElement('div');
    meta.className = 'part-meta';
    meta.textContent = `${fmtInt(p.triangles)} tris` + (p.sourceFormat ? ` · ${p.sourceFormat.toUpperCase()}` : '');
    main.append(name, meta);

    // wrapper supplies the two-layer chamfer rim (a <select> can't carry
    // ::before/::after, and a real border would drop on the corner cuts).
    const roleWrap = document.createElement('span');
    roleWrap.className = 'field field-role';
    const role = document.createElement('select');
    role.className = 'part-role';
    role.name = `role-${p.id}`;
    role.setAttribute('aria-label', `Role for ${p.name}`);
    role.title = 'Role — determines single vs fuse mode';
    for (const key of ['part', 'positive', 'negative']) {
      const opt = document.createElement('option');
      opt.value = key;
      opt.textContent = ROLE_LABEL[key];
      if (p.role === key) opt.selected = true;
      role.appendChild(opt);
    }
    role.addEventListener('change', () => handlers.onRoleChange(p.id, role.value));
    roleWrap.appendChild(role);

    const tools = document.createElement('div');
    tools.className = 'part-tools';

    const eye = document.createElement('button');
    eye.type = 'button';
    eye.className = 'icon-btn' + (p.visible ? '' : ' off');
    eye.title = p.visible ? 'Hide' : 'Show';
    eye.setAttribute('aria-label', p.visible ? 'Hide part' : 'Show part');
    eye.innerHTML = p.visible ? ICON_EYE : ICON_EYE_OFF;
    eye.addEventListener('click', () => handlers.onToggleVisible(p.id));

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'icon-btn danger';
    del.title = 'Remove';
    del.setAttribute('aria-label', 'Remove part');
    del.innerHTML = ICON_X;
    del.addEventListener('click', () => handlers.onDelete(p.id));

    tools.append(eye, del);
    row.append(main, roleWrap, tools);
    list.appendChild(row);
  }
}

// ── Parameters ────────────────────────────────────────────────────────
export function readParams() {
  return {
    pattern: els.pattern.value,
    cellSizeMM: numOr(els.cell.value, 8),
    wallThicknessMM: numOr(els.wall.value, 1.2),
    voxelSizeMM: numOr(els.voxel.value, 0.3),
    overlapMM: numOr(els.overlap.value, 0.3),
    smoothOffsetMM: numOr(els.smooth.value, 0),
    stepTargetTriangles: Math.max(1, Math.round(numOr(els.stepTris.value, 60000))),
  };
}

export function setOverlapEnabled(enabled) {
  els.overlap.disabled = !enabled;
  els.overlapField.classList.toggle('disabled', !enabled);
}

// ── Number-input steppers ─────────────────────────────────────────────
// The native spin buttons are hidden in CSS; each numeric input is flanked
// by chamfered −/＋ buttons. A click steps the input by its `step` attribute
// (respecting min/max, fallback step 1), then fires input + change so the
// app's mode/validation logic stays in sync with typed entry. The flanking
// buttons mirror the input's disabled state (e.g. Overlap in single mode).
export function initSteppers() {
  for (const group of document.querySelectorAll('.step-group')) {
    const input = group.querySelector('input[type="number"]');
    if (!input) continue;
    const btns = group.querySelectorAll('.step-btn');

    for (const btn of btns) {
      const dir = Number(btn.dataset.step) || 0;
      btn.addEventListener('click', () => {
        if (input.disabled) return;
        stepNumberInput(input, dir);
      });
    }

    const sync = () => btns.forEach((b) => { b.disabled = input.disabled; });
    sync();
    new MutationObserver(sync).observe(input, { attributes: true, attributeFilter: ['disabled'] });
  }
}

function stepNumberInput(input, dir) {
  const step = parseFloat(input.step) || 1;
  const min  = input.min !== '' ? parseFloat(input.min) : null;
  const max  = input.max !== '' ? parseFloat(input.max) : null;
  const cur  = parseFloat(input.value);
  const base = Number.isFinite(cur) ? cur : (min ?? 0);
  // Round to the step's precision so 0.3 − 0.05 lands on 0.25, not 0.2499….
  let next = Number((base + dir * step).toFixed(decimalsOf(step)));
  if (min !== null && next < min) next = min;
  if (max !== null && next > max) next = max;
  input.value = String(next);
  input.dispatchEvent(new Event('input',  { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

function decimalsOf(n) {
  const s = String(n);
  const dot = s.indexOf('.');
  return dot < 0 ? 0 : s.length - dot - 1;
}

// ── Mode note + generate ──────────────────────────────────────────────
export function setMode(valid, note) {
  els.generate.disabled = !valid;
  els.modeNote.textContent = note;
  els.modeNote.classList.toggle('ok', valid);
}

// ── Progress ──────────────────────────────────────────────────────────
export function showProgress(show) {
  els.progressWrap.classList.toggle('hidden', !show);
  els.generate.disabled = show;
  // HUD treatment: the primary button pulses + relabels while a job runs.
  els.generate.classList.toggle('generating', show);
  els.generate.textContent = show ? 'Generating…' : 'Generate';
}
export function setProgress(fraction, stage) {
  const f = els.progressFill;
  if (fraction == null || Number.isNaN(fraction) || fraction <= 0) {
    f.classList.add('indeterminate');
  } else {
    f.classList.remove('indeterminate');
    f.style.width = `${Math.min(100, Math.max(2, fraction * 100))}%`;
  }
  els.progressStage.textContent = stage || 'Working…';
}

// ── Result card ───────────────────────────────────────────────────────
export function showResult(stats) {
  els.resultCard.classList.remove('hidden');
  const volCm3 = (stats?.volumeMM3 ?? 0) / 1000;
  els.statVolume.textContent = fmtNum(volCm3, volCm3 >= 100 ? 0 : volCm3 >= 10 ? 1 : 2);
  els.statInfill.textContent = stats?.infillPct != null ? `${fmtNum(stats.infillPct, 1)}%` : '—';
  els.statTris.textContent   = stats?.triangles != null ? fmtInt(stats.triangles) : '—';
}
export function hideResult() {
  els.resultCard.classList.add('hidden');
  clearStepStatus();
}

// ── STEP export UI ────────────────────────────────────────────────────
export function setStepBusy(busy) {
  els.stepSpinner.classList.toggle('hidden', !busy);
  els.exportStep.disabled = busy;
}
export function setStepStatus(kind, html) {
  els.stepStatus.className = 'step-status' + (kind ? ` ${kind}` : '');
  els.stepStatus.innerHTML = html;
}
export function clearStepStatus() {
  els.stepStatus.className = 'step-status hidden';
  els.stepStatus.innerHTML = '';
}

// ── Viewport hint ─────────────────────────────────────────────────────
export function setViewportHint(show) {
  els.viewportHint.classList.toggle('hidden', !show);
}

// ── Toasts (styled as HUD warnbars: hazard-stripe block + message) ─────
const HZ_COLOR = { error: 'var(--red)', warn: 'var(--amber)', success: 'var(--green)', info: 'var(--primary)' };

export function toast(message, kind = 'info', timeout = 6000) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.style.setProperty('--hzc', HZ_COLOR[kind] || HZ_COLOR.info);

  const hz = document.createElement('div');
  hz.className = 'hz';

  const msg = document.createElement('div');
  msg.className = 'wt';
  msg.textContent = message;

  const close = document.createElement('button');
  close.className = 'toast-close';
  close.setAttribute('aria-label', 'Dismiss');
  close.innerHTML = '&times;';
  const dismiss = () => { el.remove(); };
  close.addEventListener('click', dismiss);

  el.append(hz, msg, close);
  els.toastStack.appendChild(el);
  if (timeout > 0) setTimeout(dismiss, timeout);
  return el;
}

// ── Server / worker health indicator (header conn dot) ────────────────
export function setHealth(kind, label) {
  if (!els.connDot) return;
  els.connDot.className = 'conn-dot' + (kind ? ` ${kind}` : '');
  if (els.connTxt) els.connTxt.textContent = label;
}

// ── Theme ─────────────────────────────────────────────────────────────
// Dark-only HUD: the light theme + toggle were removed. These are kept as
// no-ops so main.js's existing calls stay valid.
export function initTheme(/* onChange */) { /* dark-only: nothing to wire */ }
export function isDarkTheme() { return true; }

// ── formatting ────────────────────────────────────────────────────────
function numOr(v, fallback) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}
function fmtInt(n) { return (n ?? 0).toLocaleString('en-US'); }
function fmtNum(n, dp) { return (n ?? 0).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp }); }

// ── inline icons ──────────────────────────────────────────────────────
const ICON_EYE = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>';
const ICON_EYE_OFF = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.7 5.1A9.7 9.7 0 0 1 12 5c6.5 0 10 7 10 7a15.8 15.8 0 0 1-2.8 3.6M6.6 6.6A15.8 15.8 0 0 0 2 12s3.5 7 10 7a9.7 9.7 0 0 0 4.2-.9"/><path d="m3 3 18 18"/></svg>';
const ICON_X = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';
