//
// ui.js — DOM references, rendering, and small view helpers.
//
// main.js owns app state + orchestration and calls into these. This module
// only touches the DOM; it holds no application state beyond cached elements.
//
import {
  roleColorHex, roleLabel, ROLE_GROUPS, isZoneRole,
  PART_SWATCHES, normalizeHex, effectiveColorHex,
} from './roles.js';

export const els = {
  viewport:     document.getElementById('viewport'),
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
  cleanupSeg: document.getElementById('cleanup-seg'),
  stepTris: document.getElementById('p-steptris'),

  // live-preview controls (session only — never persisted)
  previewSeg:  document.getElementById('preview-seg'),
  qualitySeg:  document.getElementById('quality-seg'),
  previewNote: document.getElementById('preview-note'),

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
  resultChips: document.getElementById('result-chips'),
  wtChip:     document.getElementById('wt-chip'),
  cleanupNote: document.getElementById('cleanup-note'),
  // ── Wave-3 EXPORT tile (#sec-export-panel — one tile owns every export) ──
  secExportPanel: document.getElementById('sec-export-panel'),
  exSources:     document.getElementById('ex-sources'),
  exFormat:      document.getElementById('ex-format'),
  exOutput:      document.getElementById('ex-output'),
  exOutputBlock: document.getElementById('ex-output-block'),
  exName:        document.getElementById('ex-name'),
  exOut:         document.getElementById('ex-out'),
  exStepBlock:   document.getElementById('ex-step-block'),
  exTotal:       document.getElementById('ex-total'),      // live TOTAL of the ticked sources
  exportBtn:  document.getElementById('export-btn'),        // KEEPS the accent-budget contract
  exportSpinner: document.getElementById('step-spinner'),
  exportStatus:  document.getElementById('step-status'),

  connDot: document.getElementById('conn-dot'),
  connTxt: document.getElementById('conn-txt'),
  undoBtn:     document.getElementById('undo-btn'),   // Wave-4 UNDO — header ↶
  redoBtn:     document.getElementById('redo-btn'),   // Wave-4 UNDO — header ↷
  // ── PROJECT save / open (the .anvil bundle) ───────────────────────────
  projectSaveBtn: document.getElementById('project-save-btn'),
  projectOpenBtn: document.getElementById('project-open-btn'),
  projectFile:    document.getElementById('project-file'),
  pjAsk:      document.getElementById('pj-ask'),
  pjAskMsg:   document.getElementById('pj-ask-msg'),
  pjAskNo:    document.getElementById('pj-ask-no'),
  pjAskYes:   document.getElementById('pj-ask-yes'),
  feedbackBtn: document.getElementById('feedback-btn'),
  mcpBtn:      document.getElementById('mcp-btn'),
  toastStack:  document.getElementById('toast-stack'),

  // ── CAD workspace shell (toolbar · panels · viewport chrome) ──────────
  tbImport:   document.getElementById('tb-import'),
  tbPrim:     document.getElementById('tb-prim'),
  tbBool:     document.getElementById('tb-bool'),
  tbShell:    document.getElementById('tb-shell'),
  tbOffset:   document.getElementById('tb-offset'),
  tbXform:    document.getElementById('tb-xform'),
  tbMirror:   document.getElementById('tb-mirror'),
  tbDupe:     document.getElementById('tb-dupe'),
  tbScripts:  document.getElementById('tb-scripts'),   // SCRIPTS view (code-to-geometry)
  tbLattice:  document.getElementById('tb-lattice'),   // home view (was TPMS; ORIENT is gone)
  tbGenerate: document.getElementById('tb-generate'),
  tbFlow:     document.getElementById('tb-flow'),
  tbExport:   document.getElementById('tb-export'),

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
  // Left panel = a single-view host: exactly one of these is on screen.
  viewLattice:  document.getElementById('view-lattice'),
  viewTool:     document.getElementById('view-tool'),
  viewScripts:  document.getElementById('view-scripts'),
  leftFoot:     document.getElementById('left-foot'),   // GENERATE — rides the LATTICE view
  latticeClose: document.getElementById('lattice-close'),  // ESC ✕ on the home view → collapse
  // Right panel = a single-view host too: OBJECTS (default), FLOW or EXPORT.
  viewObjects:  document.getElementById('view-objects'),
  viewFlow:     document.getElementById('view-flow'),
  viewExport:   document.getElementById('view-export'),
  flowClose:    document.getElementById('flow-close'),
  exportClose:  document.getElementById('export-close'),
  secTpms:      document.getElementById('sec-tpms'),
  secPosition:  document.getElementById('sec-position'),

  vpFit:           document.getElementById('vp-fit'),
  vpGhosts:        document.getElementById('vp-ghosts'),
  vpBanana:        document.getElementById('vp-banana'),
  vpSection:       document.getElementById('vp-section'),
  vpSectionWrap:   document.getElementById('vp-section-wrap'),
  vpDims:          document.getElementById('vp-dims'),
};

const ROLE_TIP = 'What this part is to GENERATE. BASE roles: Part fills the whole part with lattice; '
               + 'one Positive plus one Negative fuses them. ZONE roles layer regions on a base part: '
               + 'Lattice (blue) is filled, Keep-solid (green) stays solid, Void (white) is left empty.';
const GHOST_TIP = 'Locked: this part is a source of the current lattice. Delete the lattice to edit it again.';
const LATTICED_TIP = 'This part IS its lattice, one object and one row. Use REVERT to get the plain part back.';
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

  // Wave-6 — selection is an ordered multi-set: every member row is `.selected`,
  // and the PRIMARY (the last one picked — what numeric entry binds to) also
  // carries `.primary` for a stronger accent bar.
  const selected = new Set(handlers.selectedIds || (handlers.selectedId ? [handlers.selectedId] : []));
  const primaryId = handlers.primaryId
    ?? (handlers.selectedIds?.length ? handlers.selectedIds[handlers.selectedIds.length - 1] : handlers.selectedId)
    ?? null;

  for (const p of parts) {
    // A part's own colour (when it has one) is what the whole row reads in:
    // accent bar, selection rim and the dot on the colour button all follow
    // --role-color, so setting it once here recolours every one of them.
    const partColor = effectiveColorHex(p.colorHex, p.role);
    const row = document.createElement('div');
    row.className = 'part-row'
      + (selected.has(p.id) ? ' selected' : '')
      + (primaryId === p.id ? ' primary' : '')
      + (p.isResult ? ' is-result' : '')
      + (p.latticed ? ' latticed' : '')
      + (p.ghosted && !p.latticed ? ' ghosted' : '');
    row.dataset.id = p.id;
    row.style.setProperty('--role-color', partColor);
    // Row click selects the part (state-derived `.selected` class + viewer tint).
    // Ctrl (primary) and Shift both TOGGLE membership — identical semantics to a
    // canvas click. Clicks on the role select, eye/delete buttons, or the tools
    // cluster are theirs.
    row.addEventListener('click', (e) => {
      if (e.target.closest('button, select, .field-role, .part-tools')) return;
      handlers.onSelect?.(p.id, { ctrl: !!(e.ctrlKey || e.metaKey), shift: !!e.shiftKey });
    });
    // DOUBLE click FOCUSES — the row mirrors the canvas exactly: a single click
    // only selects (the camera never moves), a double click frames the part.
    // The two selects a dblclick fires first are idempotent, so they are simply
    // let through.
    row.addEventListener('dblclick', (e) => {
      if (e.target.closest('button, select, .field-role, .part-tools')) return;
      handlers.onFocus?.(p.id);
    });

    const main = document.createElement('div');
    main.className = 'part-main';
    const name = document.createElement('div');
    name.className = 'part-name';
    name.textContent = p.name;
    name.title = p.name;   // truncation reveal only — the allowed non-icon title
    const meta = document.createElement('div');
    meta.className = 'part-meta';
    meta.textContent = `${fmtInt(p.triangles)} tris`
      + (p.sourceFormat ? ` · ${p.sourceFormat.toUpperCase()}` : '')
      + (p.volumeMM3 != null ? ` · ${fmtVolume(p.volumeMM3)}` : '');
    main.append(name, meta);

    // wrapper supplies the two-layer chamfer rim (a <select> can't carry
    // ::before/::after, and a real border would drop on the corner cuts).
    const roleWrap = document.createElement('span');
    roleWrap.className = 'field field-role has-tip';
    // HUD hover tooltip on the WRAPPER (a <select> can't be the tip host and a
    // native title would double up on it) — a locked row explains WHY it is
    // locked. The select itself carries only its aria-label.
    roleWrap.setAttribute('data-tip',
      p.latticed ? LATTICED_TIP : p.ghosted ? GHOST_TIP : ROLE_TIP);
    const role = document.createElement('select');
    role.className = 'part-role';
    role.name = `role-${p.id}`;
    role.setAttribute('aria-label', `Role for ${p.name}`);
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

    // Role column, four shapes:
    //   LATTICED part  → a LATTICE · <PATTERN> badge. The part IS its lattice —
    //                    one object, one row — so the role is locked until REVERT.
    //   lattice part   → a static LATTICE tag (only reachable through a restore)
    //   ghosted source → GHOST regmark + a LOCKED role select (it feeds the lattice)
    //   anything else  → the plain role select
    // (There is no "consumed" shape any more: a BOOL/SMOOTH now REMOVES its
    // sources outright, so there is no surviving row to mark USED. Undo brings
    // the real rows back.)
    let roleSlot = roleWrap;
    if (p.latticed) {
      // Stacked so the badge costs no more width than the role select it
      // replaces — the name column is worth more than one wide chip.
      const cell = document.createElement('div');
      cell.className = 'role-cell lattice-cell has-tip';
      cell.setAttribute('data-tip', LATTICED_TIP);
      const mark = document.createElement('span');
      mark.className = 'regmark';
      mark.textContent = 'LATTICE';
      const tag = document.createElement('span');
      tag.className = 'tag lattice-tag';
      tag.textContent = p.latticeLabel || 'TPMS';
      cell.append(mark, tag);
      roleSlot = cell;
    } else if (p.isResult) {
      const tag = document.createElement('span');
      tag.className = 'tag lattice-tag has-tip';
      tag.textContent = 'LATTICE';
      tag.setAttribute('data-tip',
        `Generated by GENERATE, not imported. Recipe: ${p.derived?.label || 'lattice'}.`);
      roleSlot = tag;
    } else if (p.ghosted) {
      role.disabled = true;
      const cell = document.createElement('div');
      cell.className = 'role-cell';
      const mark = document.createElement('span');
      mark.className = 'regmark ghost-mark';
      mark.textContent = 'GHOST';
      cell.append(mark, roleWrap);
      roleSlot = cell;
    }

    const tools = document.createElement('div');
    tools.className = 'part-tools';

    // A latticed row carries two extra verbs, because it is two meshes in one
    // object: the GHOST toggle (the source shell drawn behind the lattice) and
    // REVERT (drop the lattice, get the plain part back). Both are undoable.
    if (p.latticed) {
      const ghost = document.createElement('button');
      ghost.type = 'button';
      ghost.className = 'icon-btn' + (p.ghostVisible ? '' : ' off');
      // Icon-only row buttons: short verb-first native title, no HUD tip.
      ghost.title = p.ghostVisible ? 'Hide the ghost shell' : 'Show the ghost shell';
      ghost.setAttribute('aria-label', ghost.title);
      ghost.innerHTML = ICON_GHOST;
      ghost.addEventListener('click', () => handlers.onToggleGhost?.(p.id));

      const revert = document.createElement('button');
      revert.type = 'button';
      revert.className = 'icon-btn';
      revert.title = 'Revert the lattice, back to the plain part';
      revert.setAttribute('aria-label', revert.title);
      revert.innerHTML = ICON_REVERT;
      revert.addEventListener('click', () => handlers.onRevertLattice?.(p.id));

      tools.append(ghost, revert);
    }

    // COLOUR — a chamfered swatch filled with the part's effective colour, left
    // of the eye. Opens the anchored swatch/hex popover; the picked value comes
    // back through onColorChange (null = back to the role colour).
    const dot = document.createElement('button');
    dot.type = 'button';
    dot.className = 'icon-btn color-btn';
    dot.title = p.colorHex ? `Change the part colour (now ${p.colorHex})` : 'Change the part colour';
    dot.setAttribute('aria-label', `Change the colour of ${p.name}`);
    dot.innerHTML = '<i class="color-chip" aria-hidden="true"></i>';
    dot.addEventListener('click', (e) => {
      const r = dot.getBoundingClientRect();
      openColorPopover(r.left, r.bottom + 6, {
        value: p.colorHex || null,
        role: p.role,
        name: p.name,
        onPick: (hex) => handlers.onColorChange?.(p.id, hex),
      });
      e.stopPropagation();
    });

    const eye = document.createElement('button');
    eye.type = 'button';
    eye.className = 'icon-btn' + (p.visible ? '' : ' off');
    eye.title = p.latticed
      ? (p.visible ? 'Hide the lattice' : 'Show the lattice')
      : (p.visible ? 'Hide this part' : 'Show this part');
    eye.setAttribute('aria-label', eye.title);
    eye.innerHTML = p.visible ? ICON_EYE : ICON_EYE_OFF;
    eye.addEventListener('click', () => handlers.onToggleVisible(p.id));

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'icon-btn danger';
    del.title = 'Delete this part';
    del.setAttribute('aria-label', 'Delete this part');
    del.innerHTML = ICON_X;
    del.addEventListener('click', () => handlers.onDelete(p.id));

    tools.append(dot, eye, del);

    // Nested tree node — one-line provenance/operation child. Three cases:
    //   derived part  → the op label verbatim ("└ BOOLEAN · A − B", "└ PRIM · BOX…")
    //   zone role     → "└ ZONE · LATTICE|KEEP|VOID", coloured by the zone role
    //   base upload   → "└ TPMS · <PATTERN> · <ROLE>" (the legacy lattice line)
    const node = document.createElement('div');
    node.className = 'part-node';
    node.style.setProperty('--role-color', partColor);
    if (isZoneRole(p.role)) {
      // Zone marker takes priority (a derived primitive used AS a zone reads as a
      // zone). Whole line in the zone colour so the provenance is unmistakable.
      const zk = p.role.replace('zone-', '').toUpperCase();
      node.classList.add('zone-node');
      node.style.color = partColor;
      node.innerHTML = `└ <span class="nk">ZONE</span> · <span class="nr">${zk}</span>`;
    } else if (p.derived && p.derived.label) {
      node.innerHTML = `└ <span class="nk">${escapeHtml(p.derived.label)}</span>`;
    } else {
      const patt = (els.pattern?.value || 'gyroid').toUpperCase();
      node.innerHTML = `└ <span class="nk">TPMS · ${patt}</span> · <span class="nr">${(p.role || 'part').toUpperCase()}</span>`;
    }

    row.append(main, roleSlot, tools, node);
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

// Bring a row into view when the canvas made it the primary selection — a pick
// in the viewport must be findable in the objects list without hunting.
export function scrollPartRowIntoView(id) {
  const row = els.partsList.querySelector(`.part-row[data-id="${CSS.escape(String(id))}"]`);
  if (!row) return;
  const box = els.partsList.getBoundingClientRect();
  const r = row.getBoundingClientRect();
  if (r.top >= box.top && r.bottom <= box.bottom) return;   // already visible — no jolt
  row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
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
    title.innerHTML = 'DROP OR ADD PARTS<span class="cursor">_</span>';
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
    cleanup: getCleanup(),
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

  // CLEANUP ON | OFF — read at generate time by readParams(); no side effects.
  wireSeg(els.cleanupSeg, () => {});

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
// ── Live preview (session state — deliberately NOT persisted) ─────────
// Both are plain segmented groups, so they carry no fill and never touch the
// accent budget. main.js wires their picks straight into viewer.preview.
export function initPreviewControls(onPreview, onQuality) {
  wireSeg(els.previewSeg, (val) => onPreview(val === 'on'));
  wireSeg(els.qualitySeg, (val) => onQuality(val === 'low' ? 'low' : 'high'));
}
export function getPreviewOn()      { return activeVal(els.previewSeg, '.seg-btn') === 'on'; }
export function getPreviewQuality() { return activeVal(els.qualitySeg, '.seg-btn') || 'high'; }
/** Force the PREVIEW seg without firing its callback (a finished bake turns the
 *  preview off from outside the UI). */
export function setPreviewOn(on) {
  if (!els.previewSeg) return;
  for (const b of els.previewSeg.querySelectorAll('.seg-btn')) {
    const active = (b.dataset.val === 'on') === !!on;
    b.classList.toggle('active', active);
    b.setAttribute('aria-pressed', active ? 'true' : 'false');
  }
}
/** The "BAKING PART FIELD_" regmark under the row. null/'' hides it. */
export function setPreviewNote(text) {
  const el = els.previewNote;
  if (!el) return;
  if (!text) { el.hidden = true; return; }
  el.hidden = false;
  el.innerHTML = `${String(text).replace(/\.\.\.$/, '')}<span class="cursor">_</span>`;
}
export function getFlowAxis()    { return activeVal(els.flowAxis, '.fchip') || 'y'; }
export function getCellMode()    { return activeVal(els.cellSeg, '.seg-btn') || 'uniform'; }
// Cleanup toggle: default ON (removes floating islands before export).
export function getCleanup()     { return activeVal(els.cleanupSeg, '.seg-btn') !== 'off'; }

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

// ── Write the LATTICE panel back (project OPEN) ───────────────────────
// The exact inverse of readParams: every field it reads, this writes. Used by
// PROJECT OPEN so a reopened project asks the same question of the geometry it
// asked before it was saved. Unknown/absent keys are LEFT ALONE, so a bundle
// written by an older build never blanks a control it never knew about.
function forceSeg(group, val, sel = '.seg-btn') {
  if (!group || val == null) return;
  const btns = [...group.querySelectorAll(sel)];
  if (!btns.some((b) => b.dataset.val === String(val))) return;   // unknown value
  for (const b of btns) {
    const on = b.dataset.val === String(val);
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
  }
}
function setNum(input, v) {
  if (!input || v == null || Number.isNaN(Number(v))) return;
  input.value = String(v);
}
export function applyParams(p) {
  if (!p) return;
  // SHEET | SKELETAL first: the mode morph swaps the wall field's min/max and
  // stashes the other mode's value, so it must land BEFORE the number is written.
  if (p.latticeType) {
    forceSeg(els.latticeSeg, p.latticeType);
    setLatticeType(p.latticeType);
  }
  if (els.pattern && p.pattern) {
    if ([...els.pattern.options].some((o) => o.value === p.pattern)) els.pattern.value = p.pattern;
  }
  setNum(els.cell, p.cellSizeMM);
  // One input, two meanings — write whichever the restored mode is showing.
  setNum(els.wall, p.latticeType === 'skeletal' ? p.biasMM : p.wallThicknessMM);
  setNum(els.voxel, p.voxelSizeMM);
  setNum(els.overlap, p.overlapMM);
  setNum(els.smooth, p.smoothOffsetMM);
  setNum(els.stepTris, p.stepTargetTriangles);
  setNum(els.refFlow, p.refFlowLpm);
  if (p.cleanup != null) forceSeg(els.cleanupSeg, p.cleanup ? 'on' : 'off');
  forceSeg(els.flowAxis, p.flowAxis, '.fchip');

  if (p.rotationDeg) {
    setNum(els.rotX, p.rotationDeg.x); setNum(els.rotY, p.rotationDeg.y); setNum(els.rotZ, p.rotationDeg.z);
  }
  if (p.phaseOffset) {
    setNum(els.phaseX, p.phaseOffset.x); setNum(els.phaseY, p.phaseOffset.y); setNum(els.phaseZ, p.phaseOffset.z);
  }
  // PER-AXIS cell: setCellMode prefills the triplet from the uniform value, so
  // the saved triplet is written after it.
  const cellMode = p.cellMode || (p.cellSizeXYZ ? 'peraxis' : 'uniform');
  forceSeg(els.cellSeg, cellMode);
  setCellMode(cellMode);
  if (p.cellSizeXYZ) {
    setNum(els.cellX, p.cellSizeXYZ.x); setNum(els.cellY, p.cellSizeXYZ.y); setNum(els.cellZ, p.cellSizeXYZ.z);
  }
  // One synthetic `input` so anything listening (the live preview, the wall-vs-
  // cell advisory) re-reads the panel as if the user had typed the values.
  els.cell?.dispatchEvent(new Event('input', { bubbles: true }));
}

// ── PROJECT OPEN guard (inline, never a browser confirm()) ────────────
// The header's one destructive verb asks first. `then(true|false)` fires exactly
// once; ESC and CANCEL are the same answer.
let pjAsk = null;
export function askProjectOpen(message, then) {
  if (!els.pjAsk) { then(true); return; }
  els.pjAskMsg.textContent = message;
  els.pjAsk.hidden = false;
  pjAsk = then;
  els.pjAskYes?.focus();
}
export function closeProjectAsk() { pjAsk = null; if (els.pjAsk) els.pjAsk.hidden = true; }
export function isProjectAskOpen() { return !!pjAsk; }
export function initProjectAsk() {
  const resolve = (go) => { const then = pjAsk; closeProjectAsk(); then?.(go); };
  els.pjAskNo?.addEventListener('click', () => resolve(false));
  els.pjAskYes?.addEventListener('click', () => resolve(true));
  document.addEventListener('keydown', (e) => {
    if (!pjAsk || e.key !== 'Escape') return;
    e.preventDefault();
    resolve(false);
  });
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
  setResultTools(true);   // FLOW toolbar button comes alive
  const volCm3 = (stats?.volumeMM3 ?? 0) / 1000;
  els.statVolume.textContent = fmtNum(volCm3, volCm3 >= 100 ? 0 : volCm3 >= 10 ? 1 : 2);
  els.statInfill.textContent = stats?.infillPct != null ? `${fmtNum(stats.infillPct, 1)}%` : '—';
  els.statTris.textContent   = stats?.triangles != null ? fmtInt(stats.triangles) : '—';

  renderWatertight(stats);

  // Flow tile renders only when the server returned a bin profile.
  if (stats?.profile?.positionsMM?.length) showFlow(stats);
  else hideFlow();
}

// Watertight chip (green ✓ / --primary N OPEN EDGES) + optional island-removal note.
function renderWatertight(stats) {
  if (els.wtChip && stats?.watertight != null) {
    const ok = !!stats.watertight;
    els.wtChip.textContent = ok
      ? 'WATERTIGHT ✓'
      : `${fmtInt(stats.openEdges ?? 0)} OPEN EDGE${(stats.openEdges === 1) ? '' : 'S'}`;
    els.wtChip.classList.toggle('ok', ok);
    els.wtChip.classList.toggle('warn', !ok);
    els.resultChips.hidden = false;
  } else if (els.resultChips) {
    els.resultChips.hidden = true;
  }

  const c = stats?.cleanup;
  if (els.cleanupNote) {
    if (c && c.removedComponents > 0) {
      const n = c.removedComponents;
      const vol = fmtNum(c.removedVolumeMM3 ?? 0, 1);
      els.cleanupNote.textContent = `cleanup: removed ${n} island${n === 1 ? '' : 's'} (${vol} mm³)`;
      els.cleanupNote.classList.remove('hidden');
    } else {
      els.cleanupNote.classList.add('hidden');
    }
  }
}

export function hideResult() {
  els.resultCard.classList.add('hidden');
  if (els.resultChips) els.resultChips.hidden = true;
  els.cleanupNote?.classList.add('hidden');
  setResultTools(false);   // no result → the FLOW toolbar button goes dark
  hideFlow();
  clearExportStatus();
}

// ── Flow-metrics tile ─────────────────────────────────────────────────
let flowState = null;   // last rendered stats, kept so the sparkline can redraw on resize

function showFlow(s) {
  flowState = s;
  els.flowCard.classList.remove('hidden');

  const axis = (s.flowAxis || 'y').toUpperCase();
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
  flowHover = null;      // a new result invalidates any hovered bin
  wireSparkHover();      // idempotent — guarded by cv._sparkWired
  drawFlowSpark();
}

function hideFlow() {
  flowState = null;
  flowHover = null;
  els.flowCard.classList.add('hidden');
  // FLOW owns a whole right-panel view now: with no profile to show, standing in
  // it would mean staring at an empty panel — fall back to OBJECTS.
  if (_rightView === 'flow') setRightView('objects');
}

// chokeRatio may arrive as a fraction (0–1) or an already-scaled percent;
// normalise to a percent for the sub-label either way.
function chokePct(r) { return r <= 1.5 ? r * 100 : r; }

// Flow notes read as calm advisories, not alarms: one neutral block per note,
// no severity colour-coding (the copy already says how bad it is). Styling lives
// entirely in .fl-warn — no inline colour here.
function renderFlowWarnings(warnings) {
  const box = els.flWarnings;
  box.innerHTML = '';
  for (const w of warnings) {
    const note = document.createElement('div');
    note.className = 'fl-warn';
    note.textContent = w;
    box.appendChild(note);
  }
}

// Sparkline — HUD TREND style (see apps/hud drawGraph): --primary open-area
// line with a subtle fill, a --dim envelope reference line, and a CYAN choke
// marker (dashed tick + dot) at minAtMM. Cyan is the cool "measurement" hue —
// it separates cleanly from the warm --primary trace without reading as an
// alarm (the HUD carries no red/amber at all). Crisp on devicePixelRatio.
//
// Hover: pointermove snaps a --line crosshair to the nearest profile bin and
// paints an on-canvas readout (position · open · gross · % open). The plot
// geometry from the last paint is cached in sparkGeom so the hit-test is a
// plain inverse-map, and the listeners are wired once (cv._sparkWired).
let flowHover = null;   // index into the profile arrays, or null when not hovering
let sparkGeom = null;   // { xL,xR,yT,yB,pMin,pSpan } from the last paint

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
  sparkGeom = { xL, xR, yT, yB, pMin, pSpan };

  const X = (v) => xL + ((v - pMin) / pSpan) * (xR - xL);
  const Y = (a) => yB - (Math.max(0, Math.min(a, aMax)) / aMax) * (yB - yT);
  const c = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const prim = c('--primary'), dim = c('--dim'), line = c('--line'), choke = c('--cyan');

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

  // choke marker — dashed vertical + dot at (minAtMM, minOpenAreaMM2)
  const cx = flowState.minAtMM;
  if (cx != null && cx >= pMin && cx <= pMax) {
    const mx = X(cx);
    g.strokeStyle = choke; g.lineWidth = 1; g.setLineDash([3, 3]); g.globalAlpha = 0.85;
    g.beginPath(); g.moveTo(mx, yT); g.lineTo(mx, yB); g.stroke();
    g.setLineDash([]); g.globalAlpha = 1;
    const my = Y(flowState.minOpenAreaMM2 ?? 0);
    g.fillStyle = choke; g.shadowColor = choke; g.shadowBlur = 6;
    g.beginPath(); g.arc(mx, my, 3, 0, Math.PI * 2); g.fill(); g.shadowBlur = 0;
  }

  // hover crosshair + readout
  const hi = flowHover;
  if (hi != null && hi >= 0 && hi < pos.length) {
    const hx = X(pos[hi]);
    g.strokeStyle = line; g.lineWidth = 1;
    g.beginPath(); g.moveTo(hx, yT); g.lineTo(hx, yB); g.stroke();

    // sample dots so the eye lands on the two series being read out
    g.fillStyle = dim;
    g.beginPath(); g.arc(hx, Y(env[hi] ?? 0), 2, 0, Math.PI * 2); g.fill();
    g.fillStyle = prim;
    g.beginPath(); g.arc(hx, Y(open[hi] ?? 0), 2.5, 0, Math.PI * 2); g.fill();

    drawSparkReadout(g, {
      W, xL, xR, yT, hx,
      posMM: pos[hi], openMM2: open[hi] ?? 0, grossMM2: env[hi] ?? 0,
      card: c('--card'), line, fg: c('--fg'),
    });
  }

  // axis regmarks
  els.flPosMin.textContent = `${fmtNum(pMin, pMax - pMin >= 100 ? 0 : 1)} mm`;
  els.flPosMax.textContent = `${fmtNum(pMax, pMax - pMin >= 100 ? 0 : 1)} mm`;
  els.flAreaMax.textContent = `max ${fmtNum(aMax, aMax >= 100 ? 0 : 1)} mm²`;
}

// On-canvas HUD readout: chamfered --card plate with a --line hairline rim and
// --fg monospace text. Pinned to the top of the plot, flipping to whichever side
// the cursor is NOT on so it never covers the crosshair it describes.
function drawSparkReadout(g, o) {
  const a = (v) => fmtNum(v, v >= 100 ? 0 : 1);
  const pct = o.grossMM2 > 0 ? Math.round((o.openMM2 / o.grossMM2) * 100) : 0;
  const txt = `${fmtNum(o.posMM, 1)} mm · open ${a(o.openMM2)} mm² · gross ${a(o.grossMM2)} mm² · ${pct}%`;

  g.font = '10px "Kode Mono", ui-monospace, monospace';
  g.textBaseline = 'middle';
  const padX = 7, padY = 4, ch = 7;
  const tw = g.measureText(txt).width;
  const bw = Math.min(tw + padX * 2, o.xR - o.xL);
  const bh = 10 + padY * 2;
  // flip to the far side from the cursor, then clamp inside the plot
  let bx = o.hx > (o.xL + o.xR) / 2 ? o.xL : o.xR - bw;
  bx = Math.max(o.xL, Math.min(bx, o.xR - bw));
  const by = o.yT;

  g.beginPath();
  g.moveTo(bx, by); g.lineTo(bx + bw - ch, by); g.lineTo(bx + bw, by + ch);
  g.lineTo(bx + bw, by + bh); g.lineTo(bx + ch, by + bh); g.lineTo(bx, by + bh - ch);
  g.closePath();
  g.globalAlpha = 0.94; g.fillStyle = o.card; g.fill(); g.globalAlpha = 1;
  g.strokeStyle = o.line; g.lineWidth = 1; g.stroke();

  g.save();
  g.clip();
  g.fillStyle = o.fg;
  g.fillText(txt, bx + padX, by + bh / 2 + 0.5);
  g.restore();
}

// Pointer wiring for the sparkline. Idempotent — showFlow calls this on every
// result, so the _sparkWired flag keeps a single set of listeners on the canvas.
function wireSparkHover() {
  const cv = els.flSpark;
  if (!cv || cv._sparkWired) return;
  cv._sparkWired = true;

  const nearest = (clientX) => {
    if (!flowState || !sparkGeom) return null;
    const pos = flowState.profile?.positionsMM;
    if (!pos || pos.length < 2) return null;
    const { xL, xR, pMin, pSpan } = sparkGeom;
    const x = clientX - cv.getBoundingClientRect().left;
    const t = Math.max(0, Math.min(1, (x - xL) / ((xR - xL) || 1)));
    const target = pMin + t * pSpan;
    // positionsMM is monotonic and evenly spaced — index directly, then nudge.
    let i = Math.round((target - pMin) / (pSpan / (pos.length - 1)));
    i = Math.max(0, Math.min(pos.length - 1, i));
    for (const j of [i - 1, i + 1]) {
      if (j >= 0 && j < pos.length && Math.abs(pos[j] - target) < Math.abs(pos[i] - target)) i = j;
    }
    return i;
  };

  cv.addEventListener('pointermove', (e) => {
    const i = nearest(e.clientX);
    if (i === flowHover) return;
    flowHover = i;
    drawFlowSpark();
  });
  const clear = () => { if (flowHover == null) return; flowHover = null; drawFlowSpark(); };
  cv.addEventListener('pointerleave', clear);
  cv.addEventListener('pointercancel', clear);
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

// ══ Wave-3 · EXPORT tile ══════════════════════════════════════════════
// One tile owns every export: WHICH objects (checkbox list of parts + the
// result), WHICH format (STL|STEP), separate-vs-combined for multi-selects, and
// the filename. main.js holds the selection/dirty state; this module only paints
// and reads the DOM.

/**
 * Paint the source checkbox list.
 * @param items    [{ id, kind:'part'|'job', name, meta, role, colorHex }]
 * @param checked  Set of checked ids
 * @param onToggle (id, checked) => void
 */
export function renderExportSources(items, checked, onToggle) {
  const box = els.exSources;
  if (!box) return;
  box.innerHTML = '';

  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'parts-empty';
    empty.textContent = 'Nothing to export yet';
    box.appendChild(empty);
    return;
  }

  for (const it of items) {
    const row = document.createElement('label');
    row.className = 'ex-src' + (it.kind === 'job' ? ' ex-src-result' : '');
    row.dataset.id = it.id;
    // Same colour the OBJECTS row reads in: the part's own colour when it has
    // one, else its role's. The jobId RESULT row has neither, so it stays --primary.
    row.style.setProperty('--role-color',
      it.kind === 'job' ? 'var(--primary)' : effectiveColorHex(it.colorHex, it.role));

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'ex-cb';
    cb.checked = checked.has(it.id);
    cb.addEventListener('change', () => onToggle(it.id, cb.checked));

    const mark = document.createElement('i');
    mark.className = 'ex-box';
    mark.setAttribute('aria-hidden', 'true');

    const dot = document.createElement('i');
    dot.className = 'ex-dot';
    dot.setAttribute('aria-hidden', 'true');

    const name = document.createElement('span');
    name.className = 'ex-src-name';
    name.textContent = it.name;
    name.title = it.name;   // truncation reveal only

    const meta = document.createElement('span');
    meta.className = 'ex-src-meta';
    meta.textContent = it.meta || '';

    row.append(cb, mark, dot, name, meta);
    box.appendChild(row);
  }
}

/**
 * The live TOTAL line under the source list: `TOTAL · N parts · X,XXX,XXX tris`.
 * Per-row triangle counts stay where they are — this only answers the question
 * a multi-select creates, which is what the whole export weighs. Hidden when
 * nothing is ticked (the "→ nothing selected" hint already says so).
 */
export function setExportTotal(parts, triangles) {
  const el = els.exTotal;
  if (!el) return;
  if (!parts) { el.hidden = true; el.textContent = ''; return; }
  el.hidden = false;
  el.innerHTML = `TOTAL <span class="ex-total-sep">·</span> <b class="num">${parts}</b> part${parts === 1 ? '' : 's'} `
    + `<span class="ex-total-sep">·</span> <b class="num">${fmtInt(triangles)}</b> tris`;
}

/** Wire the FORMAT / OUTPUT segmented controls (onChange fires for both). */
export function initExportControls(onChange) {
  wireSeg(els.exFormat, () => onChange());
  wireSeg(els.exOutput, () => onChange());
}
export function getExportFormat() { return activeVal(els.exFormat, '.seg-btn') || 'stl'; }
export function getExportOutput() { return activeVal(els.exOutput, '.seg-btn') || 'separate'; }

/** OUTPUT seg only makes sense with 2+ objects ticked. */
export function setExportOutputVisible(show) { if (els.exOutputBlock) els.exOutputBlock.hidden = !show; }
/** STEP options row (target-triangle stepper + weight warning). */
export function setExportStepVisible(show) { if (els.exStepBlock) els.exStepBlock.hidden = !show; }

/** The `→ name.ext · 3 files` line under the filename field. */
export function setExportHint(text) { if (els.exOut) els.exOut.textContent = text; }
export function getExportName() { return (els.exName?.value || '').trim(); }
export function setExportName(v) { if (els.exName) els.exName.value = v; }

/**
 * Enable/disable the EXPORT affordances. The TOOLBAR button is parts-gated (any
 * part or a result → it can open the tile); the tile's own EXPORT button also
 * needs at least one ticked source, so unticking everything never strands the
 * user with no way back into the panel.
 */
export function setExportEnabled(hasSources, canRun = hasSources) {
  if (els.exportBtn) els.exportBtn.disabled = !canRun;
  if (els.tbExport) els.tbExport.disabled = !hasSources;
}

/** Spinner + locked button while an export job runs. */
export function setExportBusy(busy) {
  els.exportSpinner?.classList.toggle('hidden', !busy);
  if (els.exportBtn) {
    els.exportBtn.classList.toggle('busy', busy);
    els.exportBtn.disabled = busy;
  }
}
export function setExportStatus(kind, html) {
  if (!els.exportStatus) return;
  els.exportStatus.className = 'step-status' + (kind ? ` ${kind}` : '');
  els.exportStatus.innerHTML = html;
}
export function clearExportStatus() {
  if (!els.exportStatus) return;
  els.exportStatus.className = 'step-status hidden';
  els.exportStatus.innerHTML = '';
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

/** Enable/disable the result-dependent toolbar buttons (FLOW). EXPORT is NOT
 *  result-gated any more — it is parts-gated via setExportEnabled. */
export function setResultTools(enabled) {
  if (els.tbFlow) els.tbFlow.disabled = !enabled;
}

// ── Accent budget (Fix 1) — the single solid --primary fill per screen state ──
// main.js's state machine calls these; exactly one is ever `true` at a time
// (pinned GENERATE while armed/generating, EXPORT STL while the result is fresh).
/** Pinned GENERATE solid fill (armed or generating) vs outline. */
export function setGenerateFilled(filled) { els.generate.classList.toggle('solid', filled); }
/** EXPORT solid fill (#export-btn, inside the EXPORT view) — carried only while
 *  that view is actually on screen. Name kept for the accent-machine contract. */
export function setExportStlFilled(filled) { els.exportBtn?.classList.toggle('solid', filled); }
/** TOOLBAR EXPORT solid fill. With a fresh result and the EXPORT view CLOSED,
 *  the in-panel button is not on screen to carry the fill — but exporting is
 *  still the next action, and this button is always visible, so it takes the
 *  slot and doubles as the way in. Handed straight back to #export-btn the
 *  moment the view opens. */
export function setTbExportFilled(filled) { els.tbExport?.classList.toggle('solid', !!filled); }
/** Tool CONFIRM solid fill — holds the single fill while an open tool is valid
 *  (GENERATE / EXPORT ghost meanwhile). See main.updateAccents' toolOpen branch. */
export function setToolConfirmFilled(filled) { els.toolConfirm?.classList.toggle('solid', !!filled); }
/** ADD PART solid fill — the EMPTY-scene state. With nothing loaded there is no
 *  valid next action but "bring geometry in", so the toolbar's import button
 *  holds the single fill; it hands it straight back once a part lands. */
export function setAddPartFilled(filled) { els.tbImport?.classList.toggle('solid', !!filled); }

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
  if (chev) {
    chev.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    // Icon-only button → its NAME is a native title, and it has to name the
    // NEXT action, not the current state (tooltip convention, initTooltips).
    const what = side === 'left' ? 'parameters' : 'objects';
    const name = `${collapsed ? 'Expand' : 'Collapse'} the ${what} panel`;
    chev.title = name;
    chev.setAttribute('aria-label', name);
  }
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

  // No scroll-spy anywhere any more: BOTH panels are single-view hosts, so
  // setLeftView / setRightView light the matching toolbar button directly.
}

// ── Left panel · single-view host ─────────────────────────────────────
// 'lattice' = the home view (TPMS parameters + ZONES + POSITION + the pinned
// GENERATE foot); 'tool' = whichever tool js/tools.js has open, full height;
// 'scripts' = the SCRIPTS editor (js/scripts.js), also full height. Exactly one
// is ever on screen, so a tool can never scroll into the lattice parameters and
// GENERATE exists only while the LATTICE view is showing.
const LEFT_VIEWS = ['lattice', 'tool', 'scripts'];
let _leftView = 'lattice';
export function setLeftView(view) {
  _leftView = LEFT_VIEWS.includes(view) ? view : 'lattice';
  const home = _leftView === 'lattice';
  els.viewLattice?.classList.toggle('hidden', !home);
  els.leftFoot?.classList.toggle('hidden', !home);
  els.viewTool?.classList.toggle('hidden', _leftView !== 'tool');
  els.viewScripts?.classList.toggle('hidden', _leftView !== 'scripts');
  // SCRIPTS is the one view that reads CODE, so the panel widens for it
  // (--panel-w-wide) and returns to the standard width on the way out. Collapse
  // still wins: .panel.collapsed is declared after .panel-left.wide.
  els.panelLeft?.classList.toggle('wide', _leftView === 'scripts');
  // Each toolbar button reads as the active view while the panel shows it
  // (tools.js lights its own button on the same switch).
  els.tbLattice?.classList.toggle('active', home);
  els.tbScripts?.classList.toggle('active', _leftView === 'scripts');
  // A view swap resets the scroll position of the view being shown.
  const shown = _leftView === 'tool' ? els.viewTool
    : _leftView === 'scripts' ? els.viewScripts : els.viewLattice;
  if (shown) shown.scrollTop = 0;
}
/** Which view the left panel is showing: 'lattice' | 'tool' | 'scripts'. */
export function getLeftView() { return _leftView; }

// ── Right panel · single-view host ────────────────────────────────────
// Same pattern as the left, three views wide now: 'objects' = the default stack
// (objects tree + RESULT), 'flow' = the open-area profile and its metrics alone,
// 'export' = the EXPORT tile alone. The toolbar FLOW / EXPORT buttons switch;
// ✕ / ESC / pressing the same button again come back.
const RIGHT_VIEWS = ['objects', 'flow', 'export'];
let _rightView = 'objects';
export function setRightView(view) {
  _rightView = RIGHT_VIEWS.includes(view) ? view : 'objects';
  els.viewObjects?.classList.toggle('hidden', _rightView !== 'objects');
  els.viewFlow?.classList.toggle('hidden', _rightView !== 'flow');
  els.viewExport?.classList.toggle('hidden', _rightView !== 'export');
  // The toolbar buttons read as the active view while the panel shows it (lit,
  // not filled — the accent machine decides separately who carries the fill).
  els.tbFlow?.classList.toggle('active', _rightView === 'flow');
  els.tbExport?.classList.toggle('active', _rightView === 'export');
  const shown = _rightView === 'export' ? els.viewExport
    : _rightView === 'flow' ? els.viewFlow : els.viewObjects;
  if (shown) shown.scrollTop = 0;
  // Switching INTO a collapsed panel would show nothing at all.
  if (els.panelRight?.classList.contains('collapsed')) setPanelCollapsed('right', false);
  // The sparkline is sized from its clientWidth, which is 0 while the view is
  // hidden — repaint once the new view has been laid out.
  if (_rightView === 'flow') requestAnimationFrame(() => drawFlowSpark());
}
/** Which view the right panel is showing: 'objects' | 'flow' | 'export'. */
export function getRightView() { return _rightView; }
/** Is a panel collapsed? The toolbar's toggle semantics are built on this. */
export function isPanelCollapsed(side) {
  const panel = side === 'left' ? els.panelLeft : els.panelRight;
  return !!panel?.classList.contains('collapsed');
}
/** True only when the EXPORT view is actually ON SCREEN — the view is selected
 *  AND the right panel is expanded. The accent machine asks this, not
 *  getRightView(), because a solid fill inside a collapsed panel is a fill the
 *  user cannot see (and would break the one-visible-fill invariant). */
export function isExportViewVisible() {
  return _rightView === 'export' && !els.panelRight?.classList.contains('collapsed');
}

// Scroll a panel section into view, flash it, expanding the panel as needed.
// LATTICE, FLOW and EXPORT are all whole VIEWS now (setLeftView / setRightView)
// rather than scroll targets; this is left for the in-view flash only.
export function focusSection(name) {
  const MAP = {
    lattice: { sec: els.secTpms, side: 'left' },
  };
  const t = MAP[name];
  if (!t || !t.sec) return;
  const panel = t.side === 'left' ? els.panelLeft : els.panelRight;
  if (panel?.classList.contains('collapsed')) setPanelCollapsed(t.side, false);
  // Next frame: let the expand relayout settle before scrolling + flashing.
  requestAnimationFrame(() => {
    t.sec.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    t.sec.classList.remove('flash-sec');
    void t.sec.offsetWidth;
    t.sec.classList.add('flash-sec');
    t.sec.addEventListener('animationend', () => t.sec.classList.remove('flash-sec'), { once: true });
  });
}

// ══ TOOLTIP CONVENTION — read this before adding any tooltip anywhere ══
//
// The app has TWO tooltip systems and they do NOT overlap. Which one a control
// gets is decided by ONE question: does it show text the user might not
// understand, or is it a bare glyph that needs a name?
//
//   1. HUD TIP  `class="has-tip" data-tip="…"`  (this module)
//      Explanatory copy, 600 ms long-hover, styled like the rest of the HUD.
//      Goes on anything that CARRIES VISIBLE TEXT and needs explaining:
//        · parameter and metric labels        (Cell size, Porosity, ΔP …)
//        · status readouts                    (LOCAL · READY, the vp-context line)
//        · text or icon+text buttons          (toolbar ops, MOVE / LAY FLAT, RUN)
//        · a labelled cluster                 (the UP chips, a part row's role field)
//      Write it as prose: what the control does, then the consequence or the
//      catch. No em dashes (house style); a colon or a second sentence instead.
//      Disabled controls still show theirs, so "why is this greyed out?" has an
//      answer exactly where the question gets asked.
//
//   2. NATIVE `title="…"`
//      Only ever TWO jobs:
//        a) the NAME of an ICON-ONLY button — short, verb-first, and carrying
//           the hotkey in parens when one exists: "Undo (Ctrl+Z)",
//           "Fit the camera to everything visible". A stateful button names the
//           NEXT action, not the current state ("Collapse …" / "Expand …").
//           Keep it identical to the button's aria-label.
//        b) revealing text that is visually TRUNCATED (a long part name in a
//           narrow row). Here the title IS the text, nothing more.
//
//   NEVER BOTH on one element — audit with
//       document.querySelectorAll('[title][data-tip]').length === 0
//   and a `data-tip` without `.has-tip` is dead weight, since this module only
//   matches `.has-tip[data-tip]`:
//       document.querySelectorAll('[data-tip]:not(.has-tip)').length === 0
//
//   NEITHER, for self-evident controls: OK / CANCEL / SAVE-name rows, − and ＋
//   steppers, a text input sitting under its own label, the X/Y/Z axis chips.
//   A tooltip that only restates the label is noise.
//
// ── implementation ────────────────────────────────────────────────────
// One floating panel (appended to <body>, pointer-events:none) shared by every
// `.has-tip[data-tip]` element. Positioning is measured from the target so the
// panel escapes the sidebar's overflow clip and flips below / clamps
// horizontally near the viewport edges instead of clipping. Mirrors the HUD
// .ledtip look (chamfered --card panel, --line rim, small text, no text-shadow).
export function initTooltips() {
  const tip = document.createElement('div');
  tip.className = 'hud-tip';
  tip.setAttribute('role', 'tooltip');
  document.body.appendChild(tip);
  let current = null, pending = null, timer = null;
  const DELAY = 600;   // long-hover intent before a tip appears

  // The ONE selector that decides what has a HUD tip. `closest` means a tip may
  // be hosted on a wrapper (the role FIELD, the UP cluster) and still fire when
  // the pointer is over the control inside it.
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
// The feedback layer carries NO hazard hue: errors are bright neutral --fg
// stripes, warnings drop to --dim. Severity is read from the copy and from how
// long the toast sticks around, not from a colour the user has to decode.
const HZ_COLOR = { error: 'var(--fg)', warn: 'var(--dim)', success: 'var(--green)', info: 'var(--primary)' };

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
  close.title = 'Dismiss';
  close.setAttribute('aria-label', 'Dismiss');
  close.innerHTML = '&times;';
  const dismiss = () => { el.remove(); };
  close.addEventListener('click', dismiss);

  el.append(hz, msg, close);
  els.toastStack.appendChild(el);
  if (timeout > 0) setTimeout(dismiss, timeout);
  return el;
}

// ══ Wave-6 · canvas context menu + anchored count popover ═════════════
// The same HUD vocabulary as the dialogs, at menu scale: a chamfered --card
// panel behind a --line rim, Kode Mono rows, hover = a --muted row tint. It
// takes NO share of the solid --primary accent budget — every row is text on a
// neutral fill, so the one solid fill in the app stays where it belongs.
//
// One popup at a time. It closes on: an item, a click outside, Escape, a wheel,
// a window resize, or any pointerdown that starts an orbit.

let ctxEl = null;         // the open menu/popover element
let ctxCleanup = null;    // its listener teardown

/** Close whatever popup is open (safe to call when none is). */
export function closeContextMenu() {
  if (ctxCleanup) { ctxCleanup(); ctxCleanup = null; }
  if (ctxEl) { ctxEl.remove(); ctxEl = null; }
}

// Park a floating panel at (x, y), flipped/clamped so it always lands on screen.
function placePopup(el, x, y) {
  el.style.left = '0px';
  el.style.top = '0px';
  const r = el.getBoundingClientRect();
  const pad = 8;
  const left = Math.max(pad, Math.min(x, window.innerWidth - r.width - pad));
  const top = Math.max(pad, Math.min(y, window.innerHeight - r.height - pad));
  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(top)}px`;
}

// Wire the shared dismissal rules to the freshly-opened popup.
function armPopupDismiss(el, onClose) {
  // A non-Node target (an event dispatched straight at window) can never be
  // inside the panel — Node.contains() would throw on it, so it is ruled out first.
  const closeIf = (e) => {
    const t = e.target;
    if (!(t instanceof Node) || !el.contains(t)) onClose();
  };
  const onKey = (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();   // Escape closes the popup and NOTHING else
    onClose();
  };
  const opts = { capture: true };
  window.addEventListener('pointerdown', closeIf, opts);
  window.addEventListener('keydown', onKey, opts);
  window.addEventListener('wheel', onClose, { capture: true, passive: true });
  window.addEventListener('resize', onClose);
  ctxCleanup = () => {
    window.removeEventListener('pointerdown', closeIf, opts);
    window.removeEventListener('keydown', onKey, opts);
    window.removeEventListener('wheel', onClose, opts);
    window.removeEventListener('resize', onClose);
  };
}

/**
 * items: [{ label, disabled?, tip?, onSelect(x, y)? } | { sep: true }]
 * A disabled row stays VISIBLE and dim — the menu is a map of what exists, not
 * a shifting list. onSelect receives the menu's own anchor so a follow-up
 * popover (DUPLICATE…) opens exactly where the menu was.
 */
export function openContextMenu(x, y, items) {
  closeContextMenu();
  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  menu.setAttribute('role', 'menu');
  for (const it of items || []) {
    if (it.sep) {
      const s = document.createElement('div');
      s.className = 'ctx-sep';
      menu.appendChild(s);
      continue;
    }
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ctx-item';
    b.setAttribute('role', 'menuitem');
    b.textContent = it.label;
    if (it.disabled) {
      b.disabled = true;
      // A menu row is TEXT, so its "why is this dim?" line is a HUD tip, not a
      // native title (tooltip convention, see initTooltips).
      if (it.tip) { b.classList.add('has-tip'); b.setAttribute('data-tip', it.tip); }
    } else b.addEventListener('click', () => { closeContextMenu(); it.onSelect?.(x, y); });
    menu.appendChild(b);
  }
  document.body.appendChild(menu);
  ctxEl = menu;
  placePopup(menu, x, y);
  armPopupDismiss(menu, closeContextMenu);
  menu.querySelector('.ctx-item:not(:disabled)')?.focus();
  return menu;
}

/**
 * A small anchored number prompt — NOT a full modal (it never blocks the app or
 * takes the keyboard away from anything else). { label, value, min, max,
 * onConfirm(n) }.
 */
export function openCountPopover(x, y, opts = {}) {
  closeContextMenu();
  const min = opts.min ?? 1, max = opts.max ?? 20;
  const pop = document.createElement('div');
  pop.className = 'ctx-menu ctx-pop';

  const row = document.createElement('div');
  row.className = 'ctx-pop-row';
  const lab = document.createElement('span');
  lab.className = 'label';
  lab.textContent = opts.label || 'COUNT';

  const grp = document.createElement('span');
  grp.className = 'step-group compact';
  const minus = document.createElement('button');
  minus.type = 'button'; minus.className = 'btn flip step-btn'; minus.dataset.step = '-1';
  minus.textContent = '−'; minus.setAttribute('aria-label', 'Decrease');
  const field = document.createElement('span');
  field.className = 'field';
  const inp = document.createElement('input');
  inp.type = 'number'; inp.name = 'ctx-count';
  inp.min = String(min); inp.max = String(max); inp.step = '1';
  inp.value = String(opts.value ?? min);
  field.appendChild(inp);
  const plus = document.createElement('button');
  plus.type = 'button'; plus.className = 'btn step-btn'; plus.dataset.step = '1';
  plus.textContent = '＋'; plus.setAttribute('aria-label', 'Increase');
  grp.append(minus, field, plus);
  row.append(lab, grp);

  const acts = document.createElement('div');
  acts.className = 'ctx-pop-acts';
  const cancel = document.createElement('button');
  cancel.type = 'button'; cancel.className = 'btn tool-mini'; cancel.textContent = 'CANCEL';
  const ok = document.createElement('button');
  ok.type = 'button'; ok.className = 'btn tool-mini'; ok.textContent = 'OK';
  acts.append(cancel, ok);

  const clamp = () => {
    const n = Math.round(parseFloat(inp.value));
    return Math.max(min, Math.min(max, Number.isFinite(n) ? n : min));
  };
  const bump = (d) => { inp.value = String(Math.max(min, Math.min(max, clamp() + d))); };
  minus.addEventListener('click', () => bump(-1));
  plus.addEventListener('click', () => bump(1));
  const confirm = () => { const n = clamp(); closeContextMenu(); opts.onConfirm?.(n); };
  ok.addEventListener('click', confirm);
  cancel.addEventListener('click', () => closeContextMenu());
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); confirm(); }
  });

  pop.append(row, acts);
  document.body.appendChild(pop);
  ctxEl = pop;
  placePopup(pop, x, y);
  armPopupDismiss(pop, closeContextMenu);
  inp.focus();
  inp.select();
  return pop;
}

/**
 * PART COLOUR — an anchored swatch grid + one hex field + RESET, in the same
 * popover shell as the context menu (chamfered --card panel, Kode Mono, one
 * popup at a time, closes on pick / Escape / click-out).
 *
 * Deliberately NOT a gradient or rainbow picker: ten curated, HUD-legible hues
 * (roles.PART_SWATCHES) plus a typed #rrggbb escape hatch for anyone who knows
 * exactly what they want. The hex field validates LIVE (the field goes `bad`
 * the moment the text stops being a colour) and only applies on Enter or blur,
 * so a half-typed "#4d" never repaints the scene.
 *
 * opts = { value: '#rrggbb'|null, role, name, onPick(hex|null) }
 *   value null → the part is on its role colour, and RESET is a no-op.
 *   onPick(null) → RESET: drop the override, back to the role colour.
 */
export function openColorPopover(x, y, opts = {}) {
  closeContextMenu();
  const current = normalizeHex(opts.value);
  const roleHex = roleColorHex(opts.role);

  // Set by the Escape listener armed at the bottom: Escape means "never mind",
  // so the blur it causes must not commit the half-typed hex.
  let escaped = false;

  const pop = document.createElement('div');
  pop.className = 'ctx-menu ctx-pop ctx-color';
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', `Colour${opts.name ? ` for ${opts.name}` : ''}`);

  const head = document.createElement('div');
  head.className = 'regmark ctx-color-head';
  head.textContent = 'COLOUR';

  const grid = document.createElement('div');
  grid.className = 'ctx-swatches';
  for (const hex of PART_SWATCHES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ctx-swatch' + (current === hex ? ' on' : '');
    b.style.setProperty('--sw', hex);
    // A colour chip is an icon-only button: its NAME is the hex it applies.
    b.title = `Set ${hex}`;
    b.setAttribute('aria-label', `Set ${hex}`);
    b.addEventListener('click', () => { closeContextMenu(); opts.onPick?.(hex); });
    grid.appendChild(b);
  }

  const row = document.createElement('div');
  row.className = 'ctx-pop-row';
  const lab = document.createElement('span');
  lab.className = 'label';
  lab.textContent = 'HEX';
  const field = document.createElement('span');
  field.className = 'field ctx-hex';
  const inp = document.createElement('input');
  inp.type = 'text';
  inp.name = 'ctx-hex';
  inp.spellcheck = false;
  inp.autocomplete = 'off';
  inp.maxLength = 7;
  inp.placeholder = roleHex;
  inp.value = current || '';
  field.appendChild(inp);
  row.append(lab, field);

  const acts = document.createElement('div');
  acts.className = 'ctx-pop-acts';
  const reset = document.createElement('button');
  reset.type = 'button';
  reset.className = 'btn tool-mini has-tip';
  reset.textContent = 'RESET';
  reset.setAttribute('data-tip',
    `Drop the colour override and go back to the role colour (${roleHex}).`);
  reset.addEventListener('click', () => { closeContextMenu(); opts.onPick?.(null); });
  acts.append(reset);

  // Live validation: empty is neutral (nothing typed yet), anything that is not
  // a #rrggbb reads `bad` immediately, so a rejected value is VISIBLE before
  // Enter rather than silently ignored after it.
  const validate = () => {
    const raw = inp.value.trim();
    const ok = !raw || !!normalizeHex(raw);
    field.classList.toggle('bad', !ok);
    return ok;
  };
  const apply = () => {
    const raw = inp.value.trim();
    if (!raw) return false;                 // blank on blur = leave it alone
    const hex = normalizeHex(raw);
    if (!hex) { field.classList.add('bad'); return false; }
    closeContextMenu();
    opts.onPick?.(hex);
    return true;
  };
  inp.addEventListener('input', validate);
  inp.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    apply();
  });
  // Blur commits — EXCEPT when focus merely moved to another control inside the
  // popover (a swatch click blurs the field first; applying the typed text there
  // would beat the swatch to the punch), and except after Escape, which means
  // "never mind" and must not commit the half-typed value on its way out.
  inp.addEventListener('blur', (e) => {
    if (escaped) return;
    if (e.relatedTarget instanceof Node && pop.contains(e.relatedTarget)) return;
    if (validate()) apply();
  });

  pop.append(head, grid, row, acts);
  document.body.appendChild(pop);
  ctxEl = pop;
  placePopup(pop, x, y);
  // Registered BEFORE armPopupDismiss so this capture listener runs first — the
  // dismiss handler stops propagation on Escape, so nothing downstream sees it.
  const onEsc = (e) => { if (e.key === 'Escape') escaped = true; };
  window.addEventListener('keydown', onEsc, { capture: true });
  armPopupDismiss(pop, closeContextMenu);
  const baseCleanup = ctxCleanup;
  ctxCleanup = () => {
    window.removeEventListener('keydown', onEsc, { capture: true });
    baseCleanup?.();
  };
  grid.querySelector('.ctx-swatch.on, .ctx-swatch')?.focus();
  return pop;
}

// ── Server / worker health indicator (header conn dot) ────────────────
export function setHealth(kind, label) {
  if (!els.connDot) return;
  els.connDot.className = 'conn-dot' + (kind ? ` ${kind}` : '');
  if (els.connTxt) els.connTxt.textContent = label;
}

// ── MCP dialog (header MCP button) ────────────────────────────────────
// Read-only "how do I point an agent at this?" card, built lazily on first
// open and reused after. Everything it shows is derived from where the page is
// actually served from, so it can never drift from reality:
//   endpoint  = location.origin + '/mcp'
//   setup     = the `claude mcp add` line for that endpoint
//   docs link = read off the FEEDBACK button, which main.js's health poll
//               already points at repoUrl (hidden when the server reports none)
// Self-wiring at module load — ui.js is an ES module, so it runs after parse
// and els.mcpBtn is already resolved. There is no init call to add to main.js.
const MCP_BLURB = '20 tools: parts, primitives, booleans, zoned lattice generation, flow metrics, '
                + 'STEP export, C# scripting. Works with any MCP client that speaks streamable HTTP.';
const MCP_NOTE  = 'The server must be running (it is — you\'re looking at it). Loopback only.';

function mcpDocsUrl() {
  const fb = els.feedbackBtn;
  if (!fb || fb.hidden || !fb.getAttribute('href') || fb.getAttribute('href') === '#') return '';
  // main.js sets FEEDBACK to `<repoUrl>/issues/new`; the repo root renders the README.
  return fb.href.replace(/\/issues\/new\/?$/, '');
}

function initMcpDialog() {
  const btn = els.mcpBtn;
  if (!btn) return;
  let overlay = null, docsLink = null, lastFocus = null;

  const endpoint = `${location.origin}/mcp`;
  const addCmd = `claude mcp add anvil --transport http --url ${endpoint}`;

  function copyRow(labelHtml, value) {
    return `
      <div class="mcp-sec">
        <span class="label">${labelHtml}</span>
        <div class="mcp-cmd">
          <code>${escapeHtml(value)}</code>
          <button type="button" class="mcp-copy" data-copy="${escapeHtml(value)}" aria-label="Copy to the clipboard">COPY</button>
        </div>
      </div>`;
  }

  function build() {
    const el = document.createElement('div');
    el.className = 'hud-overlay';
    el.hidden = true;
    el.innerHTML = `
      <div class="hud-card mcp-card" role="dialog" aria-modal="true" aria-label="MCP agent access">
        <div class="hud-head">
          <span class="label">MCP <span class="slash">//</span> AGENT ACCESS</span>
          <button type="button" class="hud-close" title="Close (Esc)" aria-label="Close (Esc)">✕</button>
        </div>
        <div class="hud-body">
          <p class="mcp-lede">${escapeHtml(MCP_BLURB).replace('20 tools', '<b>20 tools</b>')}</p>
          ${copyRow('ENDPOINT', endpoint)}
          ${copyRow('CLAUDE CODE <span class="regmark">SETUP</span>', addCmd)}
          <p class="mcp-note">${escapeHtml(MCP_NOTE)}</p>
          <a class="btn mcp-docs" target="_blank" rel="noopener" hidden>FULL DOCS → README</a>
        </div>
      </div>`;

    docsLink = el.querySelector('.mcp-docs');
    el.querySelector('.hud-close').addEventListener('click', close);
    el.addEventListener('click', (e) => { if (e.target === el) close(); });
    el.addEventListener('click', (e) => {
      const c = e.target.closest('.mcp-copy');
      if (c) copy(c);
    });
    // ESC on the document, not just the overlay — a click on dead space inside
    // the card moves focus to <body> and would otherwise swallow the key.
    document.addEventListener('keydown', (e) => {
      if (!el.hidden && e.key === 'Escape') { e.preventDefault(); close(); }
    });
    // light focus trap: Tab cycles inside the card.
    el.addEventListener('keydown', (e) => {
      if (e.key !== 'Tab') return;
      const f = [...el.querySelectorAll('button, a[href], [tabindex]:not([tabindex="-1"])')]
        .filter((n) => !n.hidden && n.offsetParent !== null);
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });
    document.body.appendChild(el);
    return el;
  }

  async function copy(b) {
    const value = b.dataset.copy || '';
    try { await navigator.clipboard.writeText(value); }
    catch { /* clipboard blocked (no permission / insecure ctx) — fall through */ }
    if (b._t) clearTimeout(b._t);
    b.textContent = 'COPIED';
    b.classList.add('copied');
    b._t = setTimeout(() => { b.textContent = 'COPY'; b.classList.remove('copied'); }, 1400);
  }

  function open() {
    if (!overlay) overlay = build();
    const docs = mcpDocsUrl();
    if (docs) { docsLink.href = docs; docsLink.hidden = false; }
    else { docsLink.removeAttribute('href'); docsLink.hidden = true; }
    lastFocus = document.activeElement;
    overlay.hidden = false;
    overlay.querySelector('.hud-close')?.focus();
  }
  function close() {
    if (!overlay || overlay.hidden) return;
    overlay.hidden = true;
    lastFocus?.focus?.();
  }

  btn.addEventListener('click', (e) => { e.preventDefault(); open(); });
}
initMcpDialog();

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
// Latticed-row verbs: the source shell drawn behind the lattice, and the undo
// glyph that gives the plain part back. REVERT is the header UNDO icon at row
// scale — Lucide `undo-2`, same 24×24 / stroke-2 / round-cap conventions as
// every other row icon. (It used to be the hand-drawn 3/4-turn arc, which was
// unreadable at 16px; see the note on #undo-btn in index.html.)
const ICON_GHOST = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 20V10a7 7 0 0 1 14 0v10l-2.3-1.8L14.3 20 12 18.2 9.7 20l-2.4-1.8Z"/><path d="M9.5 10h.01M14.5 10h.01"/></svg>';
const ICON_REVERT = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5 5.5 5.5 0 0 1-5.5 5.5H11"/></svg>';
