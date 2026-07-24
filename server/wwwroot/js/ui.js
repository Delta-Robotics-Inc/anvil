//
// ui.js — DOM references, rendering, and small view helpers.
//
// main.js owns app state + orchestration and calls into these. This module
// only touches the DOM; it holds no application state beyond cached elements.
//
import { roleColorHex, roleLabel, ROLE_GROUPS, isZoneRole } from './roles.js';

export const els = {
  viewport:     document.getElementById('viewport'),
  viewportHint: document.getElementById('viewport-hint'),
  vpContext:    document.getElementById('vp-context'),   // top-left live context line (Fix 6)

  dropzone:   document.getElementById('dropzone'),
  dropzoneTitle: document.querySelector('#dropzone .dropzone-title'),
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

  // flow-metrics v1 parameter controls
  latticeSeg:  document.getElementById('lattice-seg'),
  latticeHint: document.getElementById('lattice-hint'),
  lblWall:  document.getElementById('lbl-wall'),
  lblBias:  document.getElementById('lbl-bias'),
  flowAxis: document.getElementById('flow-axis'),
  advToggle: document.getElementById('lattice-adv-toggle'),
  advBody:   document.getElementById('lattice-adv-body'),
  rotX: document.getElementById('p-rot-x'),
  rotY: document.getElementById('p-rot-y'),
  rotZ: document.getElementById('p-rot-z'),
  phaseX: document.getElementById('p-phase-x'),
  phaseY: document.getElementById('p-phase-y'),
  phaseZ: document.getElementById('p-phase-z'),
  cellSeg: document.getElementById('cell-seg'),
  cellXYZ: document.getElementById('cell-xyz'),
  cellX: document.getElementById('p-cell-x'),
  cellY: document.getElementById('p-cell-y'),
  cellZ: document.getElementById('p-cell-z'),
  refFlow: document.getElementById('p-refflow'),

  // flow-metrics v1 result tile
  flowCard:   document.getElementById('flow-card'),
  flPorosity: document.getElementById('fl-porosity'),
  flFreeVol:  document.getElementById('fl-freevol'),
  flChoke:    document.getElementById('fl-choke'),
  flChokeRatio: document.getElementById('fl-chokeratio'),
  flDh:       document.getElementById('fl-dh'),
  flSparkLabel: document.getElementById('fl-spark-label'),
  flSparkAxis:  document.getElementById('fl-spark-axis'),
  flSpark:    document.getElementById('fl-spark'),
  flPosMin:   document.getElementById('fl-pos-min'),
  flPosMax:   document.getElementById('fl-pos-max'),
  flAreaMax:  document.getElementById('fl-area-max'),
  flSv:       document.getElementById('fl-sv'),
  flSurface:  document.getElementById('fl-surface'),
  flPerm:     document.getElementById('fl-perm'),
  flDp:       document.getElementById('fl-dp'),
  flDpUnit:   document.getElementById('fl-dp-unit'),
  flRefFlow:  document.getElementById('fl-refflow'),
  flLength:   document.getElementById('fl-length'),
  flWarnings: document.getElementById('fl-warnings'),

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
  exportBtn:  document.getElementById('export-btn'),
  stepSpinner: document.getElementById('step-spinner'),
  stepStatus: document.getElementById('step-status'),

  connDot: document.getElementById('conn-dot'),
  connTxt: document.getElementById('conn-txt'),
  feedbackBtn: document.getElementById('feedback-btn'),
  toastStack:  document.getElementById('toast-stack'),

  // ── CAD workspace shell (toolbar · panels · viewport chrome) ──────────
  tbImport:   document.getElementById('tb-import'),
  tbPrim:     document.getElementById('tb-prim'),
  tbBool:     document.getElementById('tb-bool'),
  tbMerge:    document.getElementById('tb-merge'),
  tbShell:    document.getElementById('tb-shell'),
  tbOffset:   document.getElementById('tb-offset'),
  tbXform:    document.getElementById('tb-xform'),
  tbMirror:   document.getElementById('tb-mirror'),
  tbDupe:     document.getElementById('tb-dupe'),
  tbTpms:     document.getElementById('tb-tpms'),
  tbOrient:   document.getElementById('tb-orient'),
  tbGenerate: document.getElementById('tb-generate'),
  tbFlow:     document.getElementById('tb-flow'),
  tbStl:      document.getElementById('tb-stl'),
  tbStep:     document.getElementById('tb-step'),

  // ── Contextual tool panel (#sec-tool — top of the left panel) ─────────
  secTool:      document.getElementById('sec-tool'),
  toolTitle:    document.getElementById('tool-title'),
  toolTitleJp:  document.getElementById('tool-title-jp'),
  toolBody:     document.getElementById('tool-body'),
  toolConfirm:  document.getElementById('tool-confirm'),
  toolCancel:   document.getElementById('tool-cancel'),
  toolNote:     document.getElementById('tool-note'),
  toolProgress: document.getElementById('tool-progress'),
  toolProgStage: document.getElementById('tool-prog-stage'),

  // ── ZONES tile (#sec-zones — revealed when a zone role exists) ────────
  secZones:    document.getElementById('sec-zones'),
  zSkin:       document.getElementById('z-skin'),
  zTransition: document.getElementById('z-transition'),
  zKeepOut:    document.getElementById('z-keepout'),

  panelLeft:    document.getElementById('panel-left'),
  panelRight:   document.getElementById('panel-right'),
  leftChevron:  document.getElementById('left-chevron'),
  rightChevron: document.getElementById('right-chevron'),
  secTpms:      document.getElementById('sec-tpms'),
  secOrient:    document.getElementById('sec-orient'),

  vpFit:           document.getElementById('vp-fit'),
  vpGhosts:        document.getElementById('vp-ghosts'),
  vpSection:       document.getElementById('vp-section'),
  vpSectionWrap:   document.getElementById('vp-section-wrap'),
  vpSectionSlider: document.getElementById('vp-section-slider'),
  vpDims:          document.getElementById('vp-dims'),
};

const ROLE_TIP = 'BASE: Part = gyroidize the whole part; one Positive + one Negative = fuse. '
               + 'ZONES: Lattice (blue) / Keep-solid (green) / Void (red) regions layered on a base part.';
const ROLE_GROUP_LABEL = { base: 'BASE', zone: 'ZONES' };

// ── Parts list ────────────────────────────────────────────────────────
// `pending` are synchronous, not-yet-uploaded placeholders (one per dropped
// file) rendered below the loaded parts so a drop shows instant feedback while
// the server shells out to the STEP→STL sidecar. See buildPendingRow.
export function renderParts(parts, pending, handlers) {
  const list = els.partsList;
  const queued = pending || [];
  list.innerHTML = '';
  els.partsCount.textContent = String(parts.length);

  if (parts.length === 0 && queued.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'parts-empty';
    empty.textContent = 'No parts uploaded yet.';
    list.appendChild(empty);
    return;
  }

  for (const p of parts) {
    const row = document.createElement('div');
    row.className = 'part-row';
    row.dataset.id = p.id;
    row.style.setProperty('--role-color', roleColorHex(p.role));

    const main = document.createElement('div');
    main.className = 'part-main';
    const name = document.createElement('div');
    name.className = 'part-name';
    name.textContent = p.name;
    name.title = p.name;
    const meta = document.createElement('div');
    meta.className = 'part-meta';
    meta.textContent = `${fmtInt(p.triangles)} tris`
      + (p.sourceFormat ? ` · ${p.sourceFormat.toUpperCase()}` : '')
      + (p.volumeMM3 != null ? ` · ${fmtVolume(p.volumeMM3)}` : '');
    main.append(name, meta);

    // wrapper supplies the two-layer chamfer rim (a <select> can't carry
    // ::before/::after, and a real border would drop on the corner cuts).
    const roleWrap = document.createElement('span');
    roleWrap.className = 'field field-role';
    roleWrap.setAttribute('data-tip', ROLE_TIP);   // HUD hover tooltip
    const role = document.createElement('select');
    role.className = 'part-role';
    role.name = `role-${p.id}`;
    role.setAttribute('aria-label', `Role for ${p.name}`);
    role.title = 'Role — BASE decides single/fuse; ZONES mark lattice/keep/void regions';
    role.style.color = roleColorHex(p.role);   // Fix 1 — role colour as text, no orange fill
    // Two optgroups: BASE (part/positive/negative) then ZONES (lattice/keep/void).
    for (const group of ['base', 'zone']) {
      const og = document.createElement('optgroup');
      og.label = ROLE_GROUP_LABEL[group];
      for (const key of ROLE_GROUPS[group]) {
        const opt = document.createElement('option');
        opt.value = key;
        opt.textContent = roleLabel(key);
        if (p.role === key) opt.selected = true;
        og.appendChild(opt);
      }
      role.appendChild(og);
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

    // Nested tree node — one-line provenance/operation child. Three cases:
    //   derived part  → the op label verbatim ("└ BOOLEAN · A − B", "└ PRIM · BOX…")
    //   zone role     → "└ ZONE · LATTICE|KEEP|VOID", coloured by the zone role
    //   base upload   → "└ TPMS · <PATTERN> · <ROLE>" (the legacy lattice line)
    const node = document.createElement('div');
    node.className = 'part-node';
    node.style.setProperty('--role-color', roleColorHex(p.role));
    if (isZoneRole(p.role)) {
      // Zone marker takes priority (a derived primitive used AS a zone reads as a
      // zone). Whole line in the zone colour so the provenance is unmistakable.
      const zk = p.role.replace('zone-', '').toUpperCase();
      node.classList.add('zone-node');
      node.style.color = roleColorHex(p.role);
      node.innerHTML = `└ <span class="nk">ZONE</span> · <span class="nr">${zk}</span>`;
    } else if (p.derived && p.derived.label) {
      node.innerHTML = `└ <span class="nk">${escapeHtml(p.derived.label)}</span>`;
    } else {
      const patt = (els.pattern?.value || 'gyroid').toUpperCase();
      node.innerHTML = `└ <span class="nk">TPMS · ${patt}</span> · <span class="nr">${(p.role || 'part').toUpperCase()}</span>`;
    }

    row.append(main, roleWrap, tools, node);
    list.appendChild(row);
  }

  // Pending placeholders — one per in-flight upload, below the loaded parts.
  for (const q of queued) list.appendChild(buildPendingRow(q));
}

// A placeholder row shown the instant a file is dropped, before the upload
// resolves. Mirrors .part-row's shape but carries the pulsing accent bar,
// a "CONVERTING STEP_ / READING STL_" state line, and a small spinner.
function buildPendingRow(q) {
  const row = document.createElement('div');
  row.className = 'part-row pending';
  row.setAttribute('aria-busy', 'true');

  const main = document.createElement('div');
  main.className = 'part-main';

  const name = document.createElement('div');
  name.className = 'part-name';
  name.textContent = q.name;
  name.title = q.name;

  const state = document.createElement('div');
  state.className = 'part-meta part-pending-state';
  state.textContent = q.kind === 'stl' ? 'READING STL' : 'CONVERTING STEP';
  const cur = document.createElement('span');
  cur.className = 'cursor';
  cur.textContent = '_';
  state.appendChild(cur);

  main.append(name, state);

  const spin = document.createElement('span');
  spin.className = 'spinner';
  spin.setAttribute('aria-hidden', 'true');

  row.append(main, spin);
  return row;
}

// Single ease-out accent highlight on a just-landed part row, so a fast
// conversion still registers visibly as "done".
export function flashPartRow(id) {
  const row = els.partsList.querySelector(`.part-row[data-id="${CSS.escape(String(id))}"]`);
  if (!row) return;
  row.classList.remove('flash');
  void row.offsetWidth; // force reflow so the animation restarts every time
  row.classList.add('flash');
  row.addEventListener('animationend', () => row.classList.remove('flash'), { once: true });
}

// Drop-zone busy state: pulse the rim --primary and relabel to PROCESSING_
// while any upload is in flight. Keeps accepting further drops/clicks.
export function setDropzoneBusy(busy) {
  els.dropzone.classList.toggle('busy', busy);
  const title = els.dropzoneTitle;
  if (!title) return;
  if (busy) {
    title.innerHTML = 'PROCESSING<span class="cursor">_</span>';
  } else {
    title.innerHTML = 'DROP OR IMPORT PARTS<span class="cursor">_</span>';
  }
}

// ── Parameters ────────────────────────────────────────────────────────
export function readParams() {
  const latticeType = getLatticeType();
  const cellMode = getCellMode();
  // The wall field carries a dual meaning: wall thickness (sheet) or field bias
  // (skeletal). Read it once; route it to the right key by the current mode.
  const wallOrBias = numOr(els.wall.value, latticeType === 'skeletal' ? 0 : 1.2);
  const cell = numOr(els.cell.value, 8);
  return {
    pattern: els.pattern.value,
    cellSizeMM: cell,
    wallThicknessMM: latticeType === 'skeletal' ? 1.2 : wallOrBias,
    voxelSizeMM: numOr(els.voxel.value, 0.3),
    overlapMM: numOr(els.overlap.value, 0.3),
    smoothOffsetMM: numOr(els.smooth.value, 0),
    stepTargetTriangles: Math.max(1, Math.round(numOr(els.stepTris.value, 60000))),

    // flow-metrics v1 additions
    latticeType,
    biasMM: latticeType === 'skeletal' ? wallOrBias : 0,
    flowAxis: getFlowAxis(),
    rotationDeg: {
      x: numOr(els.rotX.value, 0), y: numOr(els.rotY.value, 0), z: numOr(els.rotZ.value, 0),
    },
    phaseOffset: {
      x: numOr(els.phaseX.value, 0), y: numOr(els.phaseY.value, 0), z: numOr(els.phaseZ.value, 0),
    },
    cellMode,
    cellSizeXYZ: cellMode === 'peraxis' ? {
      x: numOr(els.cellX.value, cell), y: numOr(els.cellY.value, cell), z: numOr(els.cellZ.value, cell),
    } : null,
    refFlowLpm: Math.max(1, Math.min(1000, numOr(els.refFlow.value, 10))),
  };
}

export function setOverlapEnabled(enabled) {
  els.overlap.disabled = !enabled;
  els.overlapField.classList.toggle('disabled', !enabled);
}

// ── Lattice-type + flow-axis + advanced controls ──────────────────────
// These are read at generate time by readParams(); wiring here only maintains
// each control's own visual state (+ the wall↔bias field morph). None of them
// affect single/fuse validity, so no callback into main.js's mode logic.
export function initLatticeControls() {
  // SHEET | SKELETAL segmented — morphs the wall field into a bias field.
  wireSeg(els.latticeSeg, (val) => setLatticeType(val));

  // X / Y / Z flow-axis chips (single-select; wireSeg maintains active state).
  wireSeg(els.flowAxis, () => {}, '.fchip');

  // UNIFORM | PER-AXIS cell mode — reveals the per-axis triplet, prefilled.
  wireSeg(els.cellSeg, (val) => setCellMode(val));

  // Advanced disclosure.
  els.advToggle.addEventListener('click', () => {
    const open = els.advToggle.getAttribute('aria-expanded') === 'true';
    els.advToggle.setAttribute('aria-expanded', open ? 'false' : 'true');
    els.advBody.hidden = open;
  });
}

// Generic single-select group: clicking a button activates it (and only it).
function wireSeg(group, onPick, sel = '.seg-btn') {
  if (!group) return;
  for (const btn of group.querySelectorAll(sel)) {
    btn.addEventListener('click', () => {
      for (const b of group.querySelectorAll(sel)) {
        const on = b === btn;
        b.classList.toggle('active', on);
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
      }
      onPick(btn.dataset.val);
    });
  }
}
function activeVal(group, sel) {
  const on = group?.querySelector(`${sel}.active`);
  return on ? on.dataset.val : null;
}
export function getLatticeType() { return activeVal(els.latticeSeg, '.seg-btn') || 'sheet'; }
export function getFlowAxis()    { return activeVal(els.flowAxis, '.fchip') || 'z'; }
export function getCellMode()    { return activeVal(els.cellSeg, '.seg-btn') || 'uniform'; }

// Wall thickness (sheet) ↔ field bias (skeletal). The same input serves both;
// switching swaps its min/max/step + label and preserves each mode's last value.
function setLatticeType(type) {
  const skeletal = type === 'skeletal';
  els.latticeHint.textContent = skeletal
    ? 'solid network · one air channel'
    : 'wall lattice · two air networks';
  els.lblWall.hidden = skeletal;
  els.lblBias.hidden = !skeletal;

  const inp = els.wall;
  if ((inp.dataset.mode || 'sheet') === type) return;
  if (skeletal) {
    inp.dataset.wallVal = inp.value;                 // stash wall thickness
    inp.min = '-5'; inp.max = '5'; inp.step = '0.1';
    inp.value = inp.dataset.biasVal ?? '0';          // restore / default bias
  } else {
    inp.dataset.biasVal = inp.value;                 // stash bias
    inp.min = '0.2'; inp.removeAttribute('max'); inp.step = '0.1';
    inp.value = inp.dataset.wallVal ?? '1.2';        // restore / default wall
  }
  inp.dataset.mode = type;
  inp.dispatchEvent(new Event('input', { bubbles: true }));
}

// UNIFORM ↔ PER-AXIS. Per-axis reveals three cell inputs, prefilled from the
// uniform value so the switch never blanks the lattice period.
function setCellMode(mode) {
  const perAxis = mode === 'peraxis';
  if (perAxis) {
    const v = els.cell.value;
    els.cellX.value = v; els.cellY.value = v; els.cellZ.value = v;
  }
  els.cellXYZ.hidden = !perAxis;
}

// ── Number-input steppers ─────────────────────────────────────────────
// The native spin buttons are hidden in CSS; each numeric input is flanked
// by chamfered −/＋ buttons. A click steps the input by its `step` attribute
// (respecting min/max, fallback step 1), then fires input + change so the
// app's mode/validation logic stays in sync with typed entry. The flanking
// buttons mirror the input's disabled state (e.g. Overlap in single mode).
export function initSteppers(root = document) {
  for (const group of root.querySelectorAll('.step-group')) {
    const input = group.querySelector('input[type="number"]');
    if (!input) continue;
    const btns = group.querySelectorAll('.step-btn');

    for (const btn of btns) {
      const dir = Number(btn.dataset.step) || 0;
      btn.addEventListener('click', () => {
        if (input.disabled) return;
        stepNumberInput(input, dir);
      });
      // Fix 4 — the two-layer chamfer owns ::before/::after, so a transparent
      // child extends the hit box past the 22/30px visual (clicks bubble here).
      if (!btn.querySelector('.step-hit')) {
        const hit = document.createElement('i');
        hit.className = 'step-hit';
        hit.setAttribute('aria-hidden', 'true');
        btn.appendChild(hit);
      }
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
  syncTbGenerate();
}

// ── Progress ──────────────────────────────────────────────────────────
export function showProgress(show) {
  _genRunning = show;
  if (!show) _genPct = null;
  els.progressWrap.classList.toggle('hidden', !show);
  els.generate.disabled = show;
  // HUD treatment: the primary button pulses + relabels while a job runs.
  els.generate.classList.toggle('generating', show);
  els.generate.textContent = show ? 'Generating…' : 'Generate';
  syncTbGenerate();
}
export function setProgress(fraction, stage) {
  const f = els.progressFill;
  if (fraction == null || Number.isNaN(fraction) || fraction <= 0) {
    f.classList.add('indeterminate');
    _genPct = null;
  } else {
    f.classList.remove('indeterminate');
    f.style.width = `${Math.min(100, Math.max(2, fraction * 100))}%`;
    _genPct = Math.round(Math.min(100, Math.max(0, fraction * 100)));
  }
  els.progressStage.textContent = stage || 'Working…';
  syncTbGenerate();
}

// ── Result card ───────────────────────────────────────────────────────
export function showResult(stats) {
  els.resultCard.classList.remove('hidden');
  setResultTools(true);   // FLOW · STL · STEP toolbar buttons come alive
  const volCm3 = (stats?.volumeMM3 ?? 0) / 1000;
  els.statVolume.textContent = fmtNum(volCm3, volCm3 >= 100 ? 0 : volCm3 >= 10 ? 1 : 2);
  els.statInfill.textContent = stats?.infillPct != null ? `${fmtNum(stats.infillPct, 1)}%` : '—';
  els.statTris.textContent   = stats?.triangles != null ? fmtInt(stats.triangles) : '—';

  // Flow tile renders only when the server returned a bin profile.
  if (stats?.profile?.positionsMM?.length) showFlow(stats);
  else hideFlow();
}
export function hideResult() {
  els.resultCard.classList.add('hidden');
  setResultTools(false);   // no result → FLOW/STL/STEP toolbar buttons disabled
  hideFlow();
  clearStepStatus();
}

// ── Flow-metrics tile ─────────────────────────────────────────────────
let flowState = null;   // last rendered stats, kept so the sparkline can redraw on resize

function showFlow(s) {
  flowState = s;
  els.flowCard.classList.remove('hidden');

  const axis = (s.flowAxis || 'z').toUpperCase();
  const freeCm3 = (s.airVolumeMM3 ?? 0) / 1000;

  // Stat row
  els.flPorosity.textContent = s.porosityPct != null ? fmtNum(s.porosityPct, 1) : '—';
  els.flFreeVol.textContent  = fmtNum(freeCm3, freeCm3 >= 100 ? 0 : freeCm3 >= 10 ? 1 : 2);
  els.flChoke.textContent    = s.minOpenAreaMM2 != null ? fmtNum(s.minOpenAreaMM2, 2) : '—';
  els.flChokeRatio.textContent = s.chokeRatio != null
    ? `${fmtNum(chokePct(s.chokeRatio), 0)}% of gross · @${fmtNum(s.minAtMM ?? 0, 1)} mm`
    : '';
  els.flDh.textContent = s.hydraulicDiameterMM != null ? fmtNum(s.hydraulicDiameterMM, 2) : '—';

  // Sparkline heading + axis tag
  els.flSparkLabel.textContent = `OPEN AREA · ${axis} AXIS`;
  els.flSparkAxis.textContent  = axis;

  // Secondary metric list
  els.flSv.textContent      = s.specificSurfaceInvMM != null ? fmtNum(s.specificSurfaceInvMM, 3) : '—';
  els.flSurface.textContent = s.surfaceAreaMM2 != null ? fmtNum(s.surfaceAreaMM2 / 100, 1) : '—';
  els.flPerm.textContent    = s.permeabilityM2 != null ? sci(s.permeabilityM2) : '—';
  setDeltaP(s.deltaPKPa);
  els.flRefFlow.textContent = fmtNum(s.refFlowLpm ?? 10, 0);
  els.flLength.textContent  = s.flowLengthMM != null ? fmtNum(s.flowLengthMM, 1) : '—';

  renderFlowWarnings(s.warnings || []);
  drawFlowSpark();
}

function hideFlow() {
  flowState = null;
  els.flowCard.classList.add('hidden');
}

// chokeRatio may arrive as a fraction (0–1) or an already-scaled percent;
// normalise to a percent for the sub-label either way.
function chokePct(r) { return r <= 1.5 ? r * 100 : r; }

function renderFlowWarnings(warnings) {
  const box = els.flWarnings;
  box.innerHTML = '';
  for (const w of warnings) {
    const severe = /severe/i.test(w);
    const chip = document.createElement('div');
    chip.className = 'chip fl-warn';
    chip.style.color = severe ? 'var(--red)' : 'var(--amber)';
    chip.textContent = w;
    box.appendChild(chip);
  }
}

// Sparkline — HUD TREND style (see apps/hud drawGraph): --primary open-area
// line with a subtle fill, a dim envelope reference line, and a red choke
// marker (vertical tick + dot) at minAtMM. Crisp on devicePixelRatio.
export function drawFlowSpark() {
  const cv = els.flSpark;
  if (!cv || !flowState) return;
  const p = flowState.profile;
  const pos = p.positionsMM || [], open = p.openAreaMM2 || [], env = p.envelopeAreaMM2 || [];
  if (pos.length < 2) return;

  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth || 300, H = 120;
  cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);

  const padL = 6, padR = 6, padT = 10, padB = 8;
  const xL = padL, xR = W - padR, yT = padT, yB = H - padB;
  const pMin = pos[0], pMax = pos[pos.length - 1];
  const pSpan = (pMax - pMin) || 1;
  let aMax = 0;
  for (const v of env) if (v > aMax) aMax = v;
  for (const v of open) if (v > aMax) aMax = v;
  if (aMax <= 0) aMax = 1;

  const X = (v) => xL + ((v - pMin) / pSpan) * (xR - xL);
  const Y = (a) => yB - (Math.max(0, Math.min(a, aMax)) / aMax) * (yB - yT);
  const c = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const prim = c('--primary'), dim = c('--dim'), line = c('--line'), red = c('--red');

  // baseline
  g.strokeStyle = line; g.lineWidth = 1; g.globalAlpha = 0.6;
  g.beginPath(); g.moveTo(xL, yB); g.lineTo(xR, yB); g.stroke(); g.globalAlpha = 1;

  // envelope reference (dim)
  g.strokeStyle = dim; g.lineWidth = 1.2; g.globalAlpha = 0.75;
  traceLine(g, pos, env, X, Y);
  g.globalAlpha = 1;

  // open-area fill (subtle) then line (glow)
  g.beginPath();
  for (let i = 0; i < pos.length; i++) { const x = X(pos[i]), y = Y(open[i]); i ? g.lineTo(x, y) : g.moveTo(x, y); }
  g.lineTo(X(pMax), yB); g.lineTo(X(pMin), yB); g.closePath();
  g.globalAlpha = 0.15; g.fillStyle = prim; g.fill(); g.globalAlpha = 1;

  g.strokeStyle = prim; g.lineWidth = 1.8; g.shadowColor = prim; g.shadowBlur = 6;
  traceLine(g, pos, open, X, Y);
  g.shadowBlur = 0;

  // choke marker — vertical tick + dot at (minAtMM, minOpenAreaMM2)
  const cx = flowState.minAtMM;
  if (cx != null && cx >= pMin && cx <= pMax) {
    const mx = X(cx);
    g.strokeStyle = red; g.lineWidth = 1; g.setLineDash([3, 3]); g.globalAlpha = 0.85;
    g.beginPath(); g.moveTo(mx, yT); g.lineTo(mx, yB); g.stroke();
    g.setLineDash([]); g.globalAlpha = 1;
    const my = Y(flowState.minOpenAreaMM2 ?? 0);
    g.fillStyle = red; g.shadowColor = red; g.shadowBlur = 6;
    g.beginPath(); g.arc(mx, my, 3, 0, Math.PI * 2); g.fill(); g.shadowBlur = 0;
  }

  // axis regmarks
  els.flPosMin.textContent = `${fmtNum(pMin, pMax - pMin >= 100 ? 0 : 1)} mm`;
  els.flPosMax.textContent = `${fmtNum(pMax, pMax - pMin >= 100 ? 0 : 1)} mm`;
  els.flAreaMax.textContent = `max ${fmtNum(aMax, aMax >= 100 ? 0 : 1)} mm²`;
}

function traceLine(g, xs, ys, X, Y) {
  g.beginPath();
  for (let i = 0; i < xs.length; i++) { const x = X(xs[i]), y = Y(ys[i]); i ? g.lineTo(x, y) : g.moveTo(x, y); }
  g.stroke();
}

function sci(v) {
  if (!Number.isFinite(v)) return '—';
  if (v === 0) return '0';
  return v.toExponential(2);               // standard scientific notation, e.g. "3.14e-8"
}

// Fix 5 — adaptive ΔP precision so sub-0.01 kPa drops don't collapse to "0.00 kPa".
// ≥0.01 kPa → "X.XX kPa"; <0.01 kPa → Pa with 2 sig figs ("0.84 Pa"); <0.1 Pa →
// "<0.1 Pa". Writes the number into #fl-dp and the unit into #fl-dp-unit; the EST
// tag is a separate sibling and is left untouched.
function setDeltaP(kPa) {
  let val = '—', unit = 'kPa';
  if (kPa != null && Number.isFinite(kPa)) {
    if (kPa >= 0.01) {
      val = fmtNum(kPa, 2);
    } else {
      const pa = kPa * 1000;
      unit = 'Pa';
      val = pa < 0.1 ? '<0.1' : String(pa.toPrecision(2));
    }
  }
  els.flDp.textContent = val;
  if (els.flDpUnit) els.flDpUnit.textContent = unit;
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

// ══ CAD workspace shell (toolbar mirroring · panels · sections · dims) ══
// Pure DOM/localStorage view helpers driven from main.js. The GENERATE
// toolbar button mirrors the pinned panel button's state without holding a
// second copy of app state: setMode/showProgress/setProgress push into here.
let _genRunning = false;   // job in flight (toolbar button acts as CANCEL)
let _genPct = null;        // last progress %, shown inline on the CANCEL label

function syncTbGenerate() {
  const b = els.tbGenerate;
  if (!b) return;
  b.classList.toggle('generating', _genRunning);
  b.classList.toggle('armed', !_genRunning && !els.generate.disabled);
  b.disabled = _genRunning ? false : els.generate.disabled;   // clickable to cancel while running
  const lbl = b.querySelector('.tb-label');
  if (lbl) lbl.textContent = _genRunning ? (_genPct != null ? `CANCEL ${_genPct}%` : 'CANCEL') : 'GENERATE';
}

/** True while a generation job is running (toolbar GENERATE → CANCEL). */
export function isGenerating() { return _genRunning; }

/** Enable/disable the result-dependent toolbar buttons (FLOW · STL · STEP). */
export function setResultTools(enabled) {
  for (const b of [els.tbFlow, els.tbStl, els.tbStep]) if (b) b.disabled = !enabled;
}

// ── Accent budget (Fix 1) — the single solid --primary fill per screen state ──
// main.js's state machine calls these; exactly one is ever `true` at a time
// (pinned GENERATE while armed/generating, EXPORT STL while the result is fresh).
/** Pinned GENERATE solid fill (armed or generating) vs outline. */
export function setGenerateFilled(filled) { els.generate.classList.toggle('solid', filled); }
/** EXPORT STL solid fill — only when the currently-shown result is fresh. */
export function setExportStlFilled(filled) { els.exportBtn.classList.toggle('solid', filled); }
/** Tool CONFIRM solid fill — holds the single fill while an open tool is valid
 *  (GENERATE / EXPORT ghost meanwhile). See main.updateAccents' toolOpen branch. */
export function setToolConfirmFilled(filled) { els.toolConfirm?.classList.toggle('solid', !!filled); }

// ── ZONES tile (progressive disclosure; revealed when a zone role exists) ──
/** Show/hide the #sec-zones tile (skin · transition · keep-out grow steppers). */
export function setZonesVisible(show) { els.secZones?.classList.toggle('hidden', !show); }
/** Read the zone offset steppers → { skinThicknessMM, transitionMM, keepOutGrowMM }. */
export function readZones() {
  return {
    skinThicknessMM: Math.max(0, numOr(els.zSkin?.value, 0)),
    transitionMM:    Math.max(0, numOr(els.zTransition?.value, 0)),
    keepOutGrowMM:   Math.max(0, numOr(els.zKeepOut?.value, 0)),
  };
}

/** Fix 6 — top-left viewport context line: "PATTERN · LATTICE · MODE". */
export function setViewportContext(text) { if (els.vpContext) els.vpContext.textContent = text; }

/** Bottom-right live bounding-dimensions readout (union bbox of visible meshes). */
export function setDims(size) {
  const el = els.vpDims;
  if (!el) return;
  if (!size) { el.hidden = true; el.innerHTML = ''; return; }
  const f = (n) => n.toLocaleString('en-US', { maximumFractionDigits: n >= 100 ? 0 : 1 });
  el.hidden = false;
  el.innerHTML = `<b>${f(size.x)}</b> × <b>${f(size.y)}</b> × <b>${f(size.z)}</b> mm`;
}

// ── Collapsible panels (edge chevron + localStorage) ──────────────────
const PANEL_KEY = { left: 'infill.panel.left', right: 'infill.panel.right' };

export function setPanelCollapsed(side, collapsed, persist = true) {
  const panel = side === 'left' ? els.panelLeft : els.panelRight;
  const chev  = side === 'left' ? els.leftChevron : els.rightChevron;
  if (!panel) return;
  panel.classList.toggle('collapsed', collapsed);
  if (chev) chev.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  if (persist) {
    try { localStorage.setItem(PANEL_KEY[side], collapsed ? 'collapsed' : 'open'); } catch { /* private mode */ }
  }
  // The sparkline lives in the right panel — redraw once expanded so it fills width.
  if (side === 'right' && !collapsed) requestAnimationFrame(() => drawFlowSpark());
}

export function initPanels() {
  const narrow = window.matchMedia('(max-width:1000px)').matches;
  for (const side of ['left', 'right']) {
    let stored = null;
    try { stored = localStorage.getItem(PANEL_KEY[side]); } catch { /* private mode */ }
    // Narrow screens overlay the viewport → default collapsed, but don't overwrite
    // the desktop preference. Desktop honours the stored choice, else defaults open.
    const collapsed = narrow ? true : (stored ? stored === 'collapsed' : false);
    setPanelCollapsed(side, collapsed, false);   // apply only; user toggles persist
  }
  els.leftChevron?.addEventListener('click', () =>
    setPanelCollapsed('left', !els.panelLeft.classList.contains('collapsed')));
  els.rightChevron?.addEventListener('click', () =>
    setPanelCollapsed('right', !els.panelRight.classList.contains('collapsed')));

  // Toolbar active-section highlight (button lit while its section scrolls into view).
  observeActiveSection(els.panelLeft?.querySelector('.panel-scroll'), [
    { sec: els.secTpms,   btn: els.tbTpms },
    { sec: els.secOrient, btn: els.tbOrient },
  ]);
  observeActiveSection(els.panelRight?.querySelector('.panel-scroll'), [
    { sec: els.flowCard,  btn: els.tbFlow },
  ]);
}

// Highlight the toolbar button whose panel section is most in view.
function observeActiveSection(root, entries) {
  if (!root || !window.IntersectionObserver) return;
  const list = entries.filter((e) => e.sec && e.btn);
  if (!list.length) return;
  const ratio = new Map();
  const io = new IntersectionObserver((records) => {
    for (const r of records) ratio.set(r.target, r.isIntersecting ? r.intersectionRatio : 0);
    let best = null, bestR = 0;
    for (const { sec } of list) { const v = ratio.get(sec) || 0; if (v > bestR) { bestR = v; best = sec; } }
    for (const { sec, btn } of list) btn.classList.toggle('active', sec === best && bestR > 0.05);
  }, { root, threshold: [0, 0.15, 0.35, 0.6, 0.9] });
  for (const { sec } of list) io.observe(sec);
}

// Scroll a left/right-panel section into view, flash it, expanding as needed.
// TPMS/ORIENT live in the left panel (ORIENT also opens the LATTICE disclosure);
// FLOW lives in the right panel. Called from the toolbar buttons in main.js.
export function focusSection(name) {
  const MAP = {
    tpms:   { sec: els.secTpms,   side: 'left'  },
    orient: { sec: els.secOrient, side: 'left', disclosure: true },
    flow:   { sec: els.flowCard,  side: 'right' },
  };
  const t = MAP[name];
  if (!t || !t.sec) return;
  const panel = t.side === 'left' ? els.panelLeft : els.panelRight;
  if (panel?.classList.contains('collapsed')) setPanelCollapsed(t.side, false);
  if (t.disclosure && els.advToggle && els.advToggle.getAttribute('aria-expanded') !== 'true') {
    els.advToggle.click();   // reuse initLatticeControls' toggle so state stays consistent
  }
  // Next frame: let the expand relayout settle before scrolling + flashing.
  requestAnimationFrame(() => {
    t.sec.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    t.sec.classList.remove('flash-sec');
    void t.sec.offsetWidth;
    t.sec.classList.add('flash-sec');
    t.sec.addEventListener('animationend', () => t.sec.classList.remove('flash-sec'), { once: true });
  });
}

// ── HUD tooltips ──────────────────────────────────────────────────────
// One floating panel (appended to <body>, pointer-events:none) shared by every
// element carrying a `data-tip` attribute — parameter labels, FLOW metric
// labels, and the per-row role select. Positioning is measured from the target
// so the panel escapes the sidebar's overflow clip and flips below / clamps
// horizontally near the viewport edges instead of clipping. Mirrors the HUD
// .ledtip look (chamfered --card panel, --line rim, small text, no text-shadow).
export function initTooltips() {
  const tip = document.createElement('div');
  tip.className = 'hud-tip';
  tip.setAttribute('role', 'tooltip');
  document.body.appendChild(tip);
  let current = null, pending = null, timer = null;
  const DELAY = 600;   // long-hover intent before a tip appears

  // Tooltips attach ONLY to text carrying `.has-tip` (parameter + metric labels) —
  // never to inputs, selects, or buttons.
  const tipTarget = (el) => el?.closest?.('.has-tip[data-tip]') || null;

  function place(el) {
    const r = el.getBoundingClientRect();
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    const margin = 8, gap = 9;
    let top = r.top - th - gap;
    let below = false;
    if (top < margin) { top = r.bottom + gap; below = true; }
    let left = r.left + r.width / 2 - tw / 2;
    left = Math.max(margin, Math.min(left, window.innerWidth - tw - margin));
    tip.style.left = `${Math.round(left)}px`;
    tip.style.top  = `${Math.round(top)}px`;
    tip.classList.toggle('below', below);
  }
  function show(el) {
    const text = el.getAttribute('data-tip');
    if (!text) return;
    current = el;
    tip.textContent = text;
    tip.classList.add('show');
    place(el);
  }
  function hide() {
    clearTimeout(timer); timer = null; pending = null; current = null;
    tip.classList.remove('show');
  }

  document.addEventListener('pointerover', (e) => {
    const t = tipTarget(e.target);
    if (!t || t === current || t === pending) return;
    clearTimeout(timer);
    pending = t;
    timer = setTimeout(() => { show(t); pending = null; }, DELAY);
  });
  document.addEventListener('pointerout', (e) => {
    const t = tipTarget(e.target);
    if (t && (!e.relatedTarget || !t.contains(e.relatedTarget))) hide();
  });
  // Keep the panel pinned to a scrolling label; drop it if the row scrolls off.
  window.addEventListener('scroll', () => { if (current) place(current); }, true);
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
// Volume readout for part rows: cm³ once ≥ 1000 mm³, else mm³.
function fmtVolume(mm3) {
  if (!Number.isFinite(mm3)) return '';
  if (mm3 >= 1000) { const cm3 = mm3 / 1000; return `${fmtNum(cm3, cm3 >= 100 ? 0 : cm3 >= 10 ? 1 : 2)} cm³`; }
  return `${fmtNum(mm3, mm3 >= 100 ? 0 : 1)} mm³`;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ── inline icons ──────────────────────────────────────────────────────
const ICON_EYE = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>';
const ICON_EYE_OFF = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.7 5.1A9.7 9.7 0 0 1 12 5c6.5 0 10 7 10 7a15.8 15.8 0 0 1-2.8 3.6M6.6 6.6A15.8 15.8 0 0 0 2 12s3.5 7 10 7a9.7 9.7 0 0 0 4.2-.9"/><path d="m3 3 18 18"/></svg>';
const ICON_X = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';
