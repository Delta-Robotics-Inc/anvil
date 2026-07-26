//
// scripts.js — the SCRIPTS view: a first-class code editor in the left panel.
//
// The old header popover (a read-only list with a RUN button per row) is gone.
// SCRIPTS is a toolbar view on the same one-view host contract as every tool:
// #tb-scripts toggles it, ui.setLeftView('scripts') puts it on screen, ESC ✕
// hands the panel back to LATTICE.
//
// What it owns:
//   · TEMPLATE picker  — GET /api/scripts (library seeds + user saves). Picking
//                        one loads its source; a dirty editor asks first.
//   · EDITOR           — a plain <textarea> plus a line-number gutter kept in
//                        step by scroll + input. Deliberately NO Monaco /
//                        CodeMirror: no CDN, no bundle, and Ctrl+Z inside the
//                        box stays the browser's own text undo (main.js's
//                        isTypingTarget guard already keeps it off the app
//                        history stack, and every edit this module makes goes
//                        through execCommand('insertText') so the native undo
//                        stack survives).
//   · RUN              — POST /api/scripts/run through main.runScriptFlow, which
//                        polls the job and lands every emitted part through the
//                        normal derived-part flow. Compile failures come back as
//                        structured {line, character, message} diagnostics and
//                        render as a clickable error list.
//   · SAVE / UPLOAD    — POST /api/scripts, and a .csx file input. Both prompt
//                        inline in HUD chrome; no browser prompt()/confirm().
//
// Accent budget: RUN is this view's CONFIRM. It carries the single solid
// --primary fill while the view is open and the editor is non-empty, and swaps
// to the .generating pulse while a run is in flight (which CSS already lets
// outrank every other fill). main.updateAccents drives it through setRunFilled.
//
//   ctx = {
//     runScript(code, name, onProgress, onJob) -> Promise<part[]>
//     toast(msg, kind, ms)
//     onStateChange()      (→ main.updateAccents)
//   }
//
import * as api from './api.js';
import * as ui from './ui.js';

// ── module state ──────────────────────────────────────────────────────
let ctx = null;
let el = null;             // cached element map, built on init
let baseline = '';         // the source as loaded/saved — dirty compares to this
let curName = 'untitled';  // what a run/save is called
let curId = null;          // the descriptor id the editor was loaded from
let catalog = [];          // last GET /api/scripts result
let running = null;        // { jobId } while a run is in flight
let ask = null;            // pending "discard?" continuation
let lineCount = 0;         // last painted gutter length

const INDENT = '  ';       // Tab inserts two spaces

// ── init ──────────────────────────────────────────────────────────────
export function initScriptsView(controller) {
  ctx = controller;
  const id = (s) => document.getElementById(s);
  el = {
    view: id('view-scripts'),
    close: id('scripts-close'),
    template: id('sx-template'),
    ask: id('sx-ask'), askMsg: id('sx-ask-msg'), askNo: id('sx-ask-no'), askYes: id('sx-ask-yes'),
    editor: id('sx-editor'), gutter: id('sx-gutter'), code: id('sx-code'),
    fileName: id('sx-file-name'), dirty: id('sx-dirty'), count: id('sx-count'),
    errors: id('sx-errors'),
    run: id('sx-run'), save: id('sx-save'), upload: id('sx-upload'), docs: id('sx-docs'),
    saveRow: id('sx-save-row'), name: id('sx-name'),
    saveOk: id('sx-save-ok'), saveCancel: id('sx-save-cancel'),
    note: id('sx-note'),
    progress: id('sx-progress'), progStage: id('sx-prog-stage'), cancel: id('sx-cancel'),
    file: id('sx-file'),
  };
  if (!el.view || !el.code) return;

  el.close.addEventListener('click', close);
  el.run.addEventListener('click', run);
  el.cancel.addEventListener('click', cancelRun);
  el.save.addEventListener('click', openSaveRow);
  el.saveCancel.addEventListener('click', closeSaveRow);
  el.saveOk.addEventListener('click', commitSave);
  el.name.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commitSave(); }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeSaveRow(); }
  });
  el.upload.addEventListener('click', () => el.file.click());
  el.file.addEventListener('change', onFilePicked);
  el.template.addEventListener('change', onTemplatePicked);
  el.askNo.addEventListener('click', () => resolveAsk(false));
  el.askYes.addEventListener('click', () => resolveAsk(true));

  // Editor wiring. `input` repaints the gutter + dirty dot; `scroll` keeps the
  // gutter locked to the text; Tab indents; Ctrl+Enter runs.
  el.code.addEventListener('input', onEdit);
  el.code.addEventListener('scroll', syncScroll);
  el.code.addEventListener('keydown', onEditorKey);

  // Ctrl+Enter anywhere inside the view runs, not only from the textarea.
  el.view.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); run(); }
  });
  // ESC closes the view (main.js's Escape ladder defers to isOpen()).
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !isOpen() || running) return;
    if (!el.saveRow.hidden) return;   // the save prompt owns Escape first
    e.stopPropagation();
    close();
  });

  paint();
}

// ── open / close (the toolbar toggle contract) ────────────────────────
export function isOpen() { return ui.getLeftView() === 'scripts'; }

export function open() {
  // A tool (or LATTICE) may have taken the panel while a prompt row was up —
  // reopening always starts from a clean header.
  hideAsk();
  closeSaveRow();
  ui.setLeftView('scripts');
  // A run started here may still be in flight after the panel was handed to
  // another view — reopening picks the running chrome back up.
  el.run.classList.toggle('generating', !!running);
  loadCatalog();
  syncRun();
  ctx?.onStateChange();
  // Focus the editor so Ctrl+Enter and Tab land where the user expects.
  requestAnimationFrame(() => el.code?.focus({ preventScroll: true }));
}

export function close() {
  if (!isOpen()) return;
  hideAsk();
  closeSaveRow();
  // A job may outlive the view. Drop the .generating pulse on the way out: the
  // run carries on (and CANCEL is one click away on reopen), but a pulsing
  // button inside a hidden view would keep suppressing whichever fill the
  // accent machine hands to the view that took over.
  el.run.classList.remove('generating');
  ui.setLeftView('lattice');
  ctx?.onStateChange();
}

/** The accent machine asks this: RUN holds the fill when there is code to run
 *  and no job is in flight (a running job paints its own .generating fill). */
export function canRun() { return !running && !!el?.code?.value.trim(); }

/** main.updateAccents hands the single solid --primary fill here. */
export function setRunFilled(filled) {
  el?.run?.classList.toggle('solid', !!filled && !running);
}

/** The FULL DOCS link, built from the health poll's repoUrl. '' hides it. */
export function setDocsUrl(url) {
  if (!el?.docs) return;
  // No native title here: the link already carries a HUD data-tip, and the two
  // must never sit on one element (tooltip convention, ui.initTooltips). The
  // raw URL was never a useful tooltip anyway.
  if (url) { el.docs.href = url; el.docs.hidden = false; }
  else { el.docs.removeAttribute('href'); el.docs.hidden = true; }
}

// ── template catalog ──────────────────────────────────────────────────
async function loadCatalog(selectId) {
  try { catalog = await api.listScripts(); }
  catch (err) {
    catalog = [];
    setNote(`Could not list scripts: ${err.message}`, 'err');
  }
  const sel = el.template;
  sel.innerHTML = '';
  const blank = document.createElement('option');
  blank.value = '';
  blank.textContent = catalog.length ? 'TEMPLATE…' : 'NO SCRIPTS FOUND';
  sel.appendChild(blank);
  for (const source of ['library', 'user']) {
    const rows = catalog.filter((s) => s.source === source);
    if (!rows.length) continue;
    const og = document.createElement('optgroup');
    og.label = source === 'library' ? 'LIBRARY' : 'SAVED';
    for (const s of rows) {
      const o = document.createElement('option');
      o.value = s.id;
      o.textContent = s.name;
      og.appendChild(o);
    }
    sel.appendChild(og);
  }
  sel.value = selectId ?? (catalog.some((s) => s.id === curId) ? curId : '');
}

function onTemplatePicked() {
  const id = el.template.value;
  if (!id) return;
  const desc = catalog.find((s) => s.id === id);
  confirmOverwrite(`Load ${desc?.name || id}? Unsaved edits are lost.`, (go) => {
    if (!go) { el.template.value = curId && catalog.some((s) => s.id === curId) ? curId : ''; return; }
    loadTemplate(id);
  });
}

async function loadTemplate(id) {
  setNote('Loading…', '');
  let c;
  try { c = await api.getScript(id); }
  catch (err) { setNote(`Load failed: ${err.message}`, 'err'); return; }
  setSource(c.code || '', c.name || id, c.id || id);
  setNote(`${c.source === 'user' ? 'saved' : 'library'} · ${c.name}`, '');
  clearErrors();
}

// ── editor ────────────────────────────────────────────────────────────
/** Replace the whole buffer and reset the dirty baseline. */
function setSource(code, name, id) {
  el.code.value = code;
  baseline = code;
  curName = name || 'untitled';
  curId = id || null;
  el.code.scrollTop = 0;
  el.code.scrollLeft = 0;
  paint();
  syncRun();
  ctx?.onStateChange();
}

function onEdit() {
  paint();
  syncRun();
  ctx?.onStateChange();
}

/** Gutter + dirty dot + line count + filename. Cheap enough for every keystroke:
 *  the gutter is only rebuilt when the LINE COUNT actually changes. */
function paint() {
  const n = el.code.value.split('\n').length;
  if (n !== lineCount) {
    lineCount = n;
    let s = '';
    for (let i = 1; i <= n; i++) s += `${i}\n`;
    el.gutter.textContent = s;
    el.gutter.style.setProperty('--sx-digits', String(Math.max(2, String(n).length)));
    el.count.textContent = `${n} line${n === 1 ? '' : 's'}`;
  }
  const dirty = el.code.value !== baseline;
  el.dirty.hidden = !dirty;
  el.fileName.textContent = curName;
  syncScroll();
}

function syncScroll() {
  el.gutter.scrollTop = el.code.scrollTop;
}

function onEditorKey(e) {
  if (e.key === 'Tab' && !e.ctrlKey && !e.metaKey && !e.altKey) {
    // Indent INSIDE the box only — Tab everywhere else stays focus navigation.
    e.preventDefault();
    insertText(INDENT);
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); run(); }
}

/** Insert text at the caret WITHOUT clobbering the native undo stack (a direct
 *  `.value =` write wipes it, which would break Ctrl+Z inside the editor). */
function insertText(text) {
  const ta = el.code;
  let ok = false;
  try { ok = document.execCommand('insertText', false, text); }
  catch { ok = false; }
  if (!ok) {
    const s = ta.selectionStart, e = ta.selectionEnd;
    ta.setRangeText(text, s, e, 'end');
  }
  onEdit();
}

/** Put the caret on a 1-based line/character and scroll it into view. */
function focusAt(line, character) {
  const ta = el.code;
  const lines = ta.value.split('\n');
  const n = Math.max(1, Math.min(lines.length, line || 1));
  let pos = 0;
  for (let i = 0; i < n - 1; i++) pos += lines[i].length + 1;
  const col = Math.max(0, Math.min((character || 1) - 1, lines[n - 1].length));
  ta.focus();
  ta.setSelectionRange(pos + col, pos + col);
  const lh = parseFloat(getComputedStyle(ta).lineHeight) || 18;
  ta.scrollTop = Math.max(0, (n - 1) * lh - ta.clientHeight / 2);
  syncScroll();
}

// ── inline prompts (no browser confirm()/prompt()) ────────────────────
function confirmOverwrite(message, then) {
  if (el.code.value === baseline) { then(true); return; }
  el.askMsg.textContent = message;
  el.ask.hidden = false;
  ask = then;
}
function resolveAsk(go) {
  const then = ask;
  hideAsk();
  then?.(go);
}
function hideAsk() { ask = null; if (el?.ask) el.ask.hidden = true; }

function openSaveRow() {
  el.saveRow.hidden = false;
  el.name.value = curId?.startsWith('user:') ? curName : (curName === 'untitled' ? '' : `${curName}_edit`);
  el.name.focus();
  el.name.select();
}
function closeSaveRow() { if (el?.saveRow) el.saveRow.hidden = true; }

async function commitSave() {
  const name = el.name.value.trim();
  const code = el.code.value;
  if (!name) { setNote('A name is required to save', 'err'); el.name.focus(); return; }
  if (!code.trim()) { setNote('Nothing to save: the editor is empty', 'err'); return; }
  el.saveOk.disabled = true;
  let d;
  try { d = await api.saveScript(name, code); }
  catch (err) {
    el.saveOk.disabled = false;
    setNote(`Save failed: ${err.message}`, 'err');
    ctx.toast(`Save failed: ${err.message}`, 'error', 9000);
    return;
  }
  el.saveOk.disabled = false;
  closeSaveRow();
  baseline = code;
  curName = d.name || name;
  curId = d.id || null;
  paint();
  await loadCatalog(curId);
  setNote(`saved · ${curName}`, 'ok');
  ctx.toast(`Saved script "${curName}"`, 'success', 3500);
}

async function onFilePicked() {
  const f = el.file.files?.[0];
  el.file.value = '';
  if (!f) return;
  let text;
  try { text = await f.text(); }
  catch (err) { setNote(`Could not read ${f.name}: ${err.message}`, 'err'); return; }
  confirmOverwrite(`Load ${f.name}? Unsaved edits are lost.`, (go) => {
    if (!go) return;
    setSource(text, f.name.replace(/\.[^.]+$/, ''), null);
    el.template.value = '';
    clearErrors();
    setNote(`uploaded · ${f.name}`, '');
  });
}

// ── run ───────────────────────────────────────────────────────────────
async function run() {
  if (running) return;
  const code = el.code.value;
  if (!code.trim()) { setNote('Nothing to run: the editor is empty', 'err'); return; }
  hideAsk();
  closeSaveRow();
  clearErrors();
  setNote('', '');   // the previous run's verdict is not this run's

  running = { jobId: null };
  setRunning(true, 'Queued…');
  syncRun();
  ctx.onStateChange();

  let parts = null;
  try {
    parts = await ctx.runScript(code, curName,
      (stage) => setStage(stage),
      (jobId) => { if (running) running.jobId = jobId; });
  } catch (err) {
    running = null;
    setRunning(false);
    const diags = err.diagnostics || [];
    if (diags.length) {
      renderErrors(diags);
      setNote(`${diags.length} compile error${diags.length === 1 ? '' : 's'}, click one to jump there`, 'err');
    } else {
      setNote(err.message, 'err');
    }
    ctx.toast(`${curName} failed: ${err.message}`, 'error', 9000);
    syncRun();
    ctx.onStateChange();
    return;
  }

  running = null;
  setRunning(false);
  const n = parts.length;
  setNote(n ? `${n} part${n === 1 ? '' : 's'} created` : 'ran clean, but the script saved no parts', n ? 'ok' : '');
  if (n && n <= 4) for (const p of parts) ctx.toast(`SCRIPT → ${p.name}`, 'success', 3500);
  else if (n) ctx.toast(`${curName}: ${n} parts created`, 'success', 3500);
  else ctx.toast(`${curName} ran, but saved no parts`, 'warn');
  syncRun();
  ctx.onStateChange();
}

async function cancelRun() {
  const jobId = running?.jobId;
  if (!jobId) return;
  el.cancel.disabled = true;
  try { await api.cancelJob(jobId); } catch { /* the poll reports the outcome */ }
  setStage('Cancelling…');
}

function setRunning(on, stage) {
  el.progress.classList.toggle('hidden', !on);
  el.run.disabled = on || !el.code.value.trim();
  el.run.classList.toggle('generating', on && isOpen());
  if (on) { el.run.classList.remove('solid'); el.run.textContent = 'RUNNING'; }
  else { el.run.textContent = 'RUN'; }
  el.cancel.disabled = false;
  el.template.disabled = on;
  el.save.disabled = on;
  el.upload.disabled = on;
  if (on) setStage(stage);
}
function setStage(stage) { el.progStage.textContent = stage || 'Working…'; }

/** RUN is gated on there being code (the accent fill itself comes from
 *  main.updateAccents, which asks canRun()). */
function syncRun() { if (el?.run) el.run.disabled = !!running || !el.code.value.trim(); }

function setNote(text, kind) {
  el.note.textContent = text || '';
  el.note.className = 'tool-note' + (kind ? ` ${kind}` : '');
}

// ── compile errors (neutral advisory rows, click = jump) ──────────────
function clearErrors() {
  el.errors.innerHTML = '';
  el.errors.hidden = true;
}
function renderErrors(diags) {
  el.errors.innerHTML = '';
  for (const d of diags) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'sx-err';
    const where = document.createElement('span');
    where.className = 'sx-err-at regmark';
    where.textContent = d.line > 0 ? `L${d.line}:${d.character || 1}` : '—';
    const msg = document.createElement('span');
    msg.className = 'sx-err-msg';
    msg.textContent = d.message;
    row.append(where, msg);
    // A text row, not an icon button, so the affordance is a HUD tip. The
    // message is already the row's visible text, so a line-less diagnostic
    // (no jump target) gets no tip at all rather than a tip that repeats it.
    if (d.line > 0) {
      row.classList.add('has-tip');
      row.setAttribute('data-tip', `Click to put the caret on line ${d.line} in the editor.`);
    }
    row.addEventListener('click', () => { if (d.line > 0) focusAt(d.line, d.character); });
    el.errors.appendChild(row);
  }
  el.errors.hidden = false;
}
