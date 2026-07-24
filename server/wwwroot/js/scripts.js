//
// scripts.js — minimal SCRIPTS panel (Stage 5).
//
// A header button opens an overlay that lists GET /api/scripts (versioned
// library seeds + user-saved). Each row has a RUN button that hands the script
// id back to main.js's runScript(), which posts /api/scripts/run, polls the job,
// and lands the resulting part(s) through the normal derived-part flow.
//
// Deliberately tiny: no in-app editor this wave (a read-only code peek only).
//
import * as api from './api.js';

export function initScripts({ runScript, toast }) {
  const btn = document.getElementById('scripts-btn');
  if (!btn) return;
  let overlay = null;

  function buildOverlay() {
    const el = document.createElement('div');
    el.className = 'scripts-overlay';
    el.hidden = true;
    el.innerHTML = `
      <div class="scripts-panel" role="dialog" aria-label="Scripts">
        <div class="scripts-head">
          <span class="label">SCRIPTS <span style="color:var(--primary)">//</span> CODE-TO-GEOMETRY</span>
          <button type="button" class="scripts-close" aria-label="Close">✕</button>
        </div>
        <div class="scripts-list"></div>
        <div class="scripts-foot label">Scripts run arbitrary C# in a worker · loopback only · no sandbox.</div>
      </div>`;
    el.querySelector('.scripts-close').addEventListener('click', close);
    el.addEventListener('click', (e) => { if (e.target === el) close(); });
    document.addEventListener('keydown', (e) => { if (!el.hidden && e.key === 'Escape') close(); });
    document.body.appendChild(el);
    return el;
  }

  async function load() {
    const list = overlay.querySelector('.scripts-list');
    list.innerHTML = '<div class="label" style="opacity:.6;padding:10px">loading…</div>';
    let scripts;
    try { scripts = await api.listScripts(); }
    catch (e) { list.innerHTML = `<div class="label" style="padding:10px">failed: ${escapeHtml(e.message)}</div>`; return; }
    if (!scripts.length) { list.innerHTML = '<div class="label" style="opacity:.6;padding:10px">no scripts found</div>'; return; }
    list.innerHTML = '';
    for (const s of scripts) {
      const row = document.createElement('div');
      row.className = 'scripts-row';
      row.innerHTML = `
        <span class="scripts-name">${escapeHtml(s.name)}</span>
        <span class="scripts-src label">${escapeHtml(s.source)}</span>
        <button type="button" class="scripts-peek" title="View source">CODE</button>
        <button type="button" class="scripts-run">RUN</button>`;
      const runBtn = row.querySelector('.scripts-run');
      const peekBtn = row.querySelector('.scripts-peek');
      runBtn.addEventListener('click', async () => {
        const prev = runBtn.textContent;
        runBtn.disabled = true; peekBtn.disabled = true; runBtn.textContent = '…';
        try {
          const parts = await runScript(s.id, s.name, (stage) => { runBtn.textContent = (stage || '…').slice(0, 10); });
          toast?.(`${s.name}: ${parts.length} part(s) created`, 'ok');
          close();
        } catch (e) {
          toast?.(`${s.name} failed: ${e.message}`, 'err', 9000);
        } finally {
          runBtn.disabled = false; peekBtn.disabled = false; runBtn.textContent = prev;
        }
      });
      peekBtn.addEventListener('click', () => togglePeek(row, s.id));
      list.appendChild(row);
    }
  }

  async function togglePeek(row, id) {
    const existing = row.nextElementSibling;
    if (existing && existing.classList.contains('scripts-code')) { existing.remove(); return; }
    let code = '';
    try { code = (await api.getScript(id)).code; }
    catch (e) { code = `// failed to load: ${e.message}`; }
    const pre = document.createElement('pre');
    pre.className = 'scripts-code';
    pre.textContent = code;
    row.after(pre);
  }

  function open() {
    if (!overlay) overlay = buildOverlay();
    overlay.hidden = false;
    load();
  }
  function close() { if (overlay) overlay.hidden = true; }

  btn.hidden = false;
  btn.addEventListener('click', (e) => { e.preventDefault(); open(); });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
