//
// tools.js — Wave-1 "Objects & Ops" contextual tool panel.
//
// Renders a HyDesign-style contextual panel into the #sec-tool tile at the top
// of the left panel: a live selection header + params + CONFIRM + inline
// progress. Each tool declares how it renders, validates, and builds its
// /api/ops (or transform bake) request. main.js owns app state + the viewer and
// passes a small `ctx` controller; this module never touches app state directly.
//
// Wave-7: NO tool has a part dropdown. What an op runs on is what is selected in
// the canvas or the objects list, in pick order.
//
//   ctx = {
//     selection()        -> [id]                  (ordered by pick; EVERY op binds to it)
//     primaryId()        -> id | null             (last picked = the bound part)
//     partName(id)       -> string
//     partColor(id)      -> '#rrggbb' | null      (effective colour, for the bind dot)
//     rowId(id)          -> id                    (a unit id → the ROW that owns it)
//     unitId(id)         -> id                    (a row id → the mesh an op must read)
//     selectionBox()     -> { center, size } | null (combined world bbox)
//     unionCenter()      -> {x,y,z} | null        (visible-union bbox centre)
//     voxelDefault()     -> number                (current TPMS voxel size)
//     getPartTrs(id)     -> trs | null            (a part's non-destructive TRS)
//     partBbox(id)       -> { min:[3], max:[3] } | null
//     setPartTransform(id, trs)                   (live preview + persist)
//     clearPartTransform(id)                      (APPLY bake → reset source TRS)
//     runOp(body, onProgress) -> Promise<part|null>
//     consumeSources(ids, resultId, kind)         (BOOL/SMOOTH: sources REMOVED)
//     armOpenFaces(id) -> bool                    (SHELL: arm the flat-face quads)
//     cancelOpenFaces() / clearOpenFaces()        (disarm / drop the picked set)
//     isOpenFacesArmed() -> bool
//     openFaceIds() -> [quadId]                   (the picked faces, stable ids)
//     faceQuadData(quadId) -> openFace | null     (world-frame oriented rectangle)
//     onStateChange()                             (→ main.updateAccents)
//     toast(msg, kind, ms)
//   }
//
import * as ui from './ui.js';

// ── module state ──────────────────────────────────────────────────────
let ctx = null;
let cur = null;   // { id, read, valid, running } for the open tool, or null
let fieldSeq = 0; // names the dynamically-built inputs (a11y: id/name present)

const els = () => ui.els;

// ── small DOM builders (all reuse the existing HUD chamfer classes) ────
function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
}

function labelEl(html, tip) {
  const l = el('span', 'label', html);
  if (tip) { l.classList.add('has-tip'); l.setAttribute('data-tip', tip); }
  return l;
}

function paramBlock(labelHtml, controlEl, { wide = true, tip } = {}) {
  const wrap = el('div', 'param' + (wide ? ' param-wide' : ''));
  wrap.append(labelEl(labelHtml, tip), controlEl);
  return wrap;
}

function segControl(options, value, onChange) {
  const seg = el('div', 'seg' + (options.length >= 4 ? ' seg-4' : ''));
  seg.setAttribute('role', 'group');
  for (const opt of options) {
    const b = el('button', 'seg-btn' + (opt.val === value ? ' active' : ''));
    b.type = 'button'; b.dataset.val = opt.val;
    b.setAttribute('aria-pressed', opt.val === value ? 'true' : 'false');
    b.textContent = opt.label;
    b.addEventListener('click', () => {
      for (const x of seg.querySelectorAll('.seg-btn')) {
        const on = x === b;
        x.classList.toggle('active', on);
        x.setAttribute('aria-pressed', on ? 'true' : 'false');
      }
      onChange(opt.val);
    });
    seg.appendChild(b);
  }
  const get = () => (seg.querySelector('.seg-btn.active')?.dataset.val ?? options[0]?.val);
  return { el: seg, get };
}

// Single chamfered −/＋ stepper around a numeric field. Returns { el, inp }.
function stepper({ value, min, max, step }, { compact } = {}) {
  const grp = el('span', 'step-group' + (compact ? ' compact' : ''));
  const minus = el('button', 'btn flip step-btn'); minus.type = 'button';
  minus.dataset.step = '-1'; minus.textContent = '−'; minus.setAttribute('aria-label', 'Decrease');
  const field = el('span', 'field');
  const inp = el('input'); inp.type = 'number'; inp.name = `tool-num-${++fieldSeq}`; inp.value = String(value);
  if (min != null) inp.min = String(min);
  if (max != null) inp.max = String(max);
  inp.step = String(step);
  field.appendChild(inp);
  const plus = el('button', 'btn step-btn'); plus.type = 'button';
  plus.dataset.step = '1'; plus.textContent = '＋'; plus.setAttribute('aria-label', 'Increase');
  grp.append(minus, field, plus);
  return { el: grp, inp };
}

// X/Y/Z triplet of compact steppers. Returns { el, inp:{x,y,z} }.
function tripletStepper(labelHtml, unit, vals, step, tip) {
  const sub = el('div', 'subparam');
  sub.appendChild(labelEl(`${labelHtml} <em>${unit}</em>`, tip));
  const trip = el('div', 'triplet');
  const inp = {};
  for (const ax of ['x', 'y', 'z']) {
    const cell = el('div', 'axis-cell');
    cell.appendChild(el('span', 'axis-lab', ax.toUpperCase()));
    const s = stepper({ value: vals[ax], step }, { compact: true });
    inp[ax] = s.inp;
    cell.appendChild(s.el);
    trip.appendChild(cell);
  }
  sub.append(trip);
  return { el: sub, inp };
}

// ── Wave-7 · the SELECTION is the picker ──────────────────────────────
// No op carries a part dropdown any more. Every tool that needs a part BINDS to
// the app selection the way XFORM always has: the panel opens on a live readout
// of what it is pointed at, and tools.onSelectionChanged repaints it in place,
// so picking in the canvas or the objects list while the tool is open rebinds it
// instantly. Pick order carries meaning — BOOLEAN's A is the first part picked.
const EMPTY_ONE = 'Select a part in the canvas or the objects list';
const EMPTY_TWO = 'Select two parts in the canvas or the objects list';

// One bound-object row: the part's colour dot, its role key (PART / A / B) and
// its name. `set(id)` repaints it; `set(null)` takes it off screen.
function bindRow(key) {
  const row = el('div', 'xf-bind tool-bind');
  const dot = el('i', 'tool-bind-dot'); dot.setAttribute('aria-hidden', 'true');
  const k = el('span', 'tool-bind-k regmark', key);
  const name = el('span', 'tool-bind-n');
  row.append(dot, k, name);
  return {
    el: row,
    set(id) {
      row.hidden = !id;
      if (!id) return;
      const nm = ctx.partName(id) || '—';
      row.style.setProperty('--role-color', ctx.partColor(id) || 'var(--dim)');
      name.textContent = nm;
      row.title = `${key}: ${nm}`;   // truncation reveal only, never an explanation
    },
  };
}

// The two bind headers. Both return a read accessor and install `cur._sync`, so
// a selection change repaints the header without re-rendering the parameters
// (a field being typed in keeps its value and its caret).

/** `PART: <name>` — bound to the PRIMARY (last picked) part. → () => id|null */
function bindPrimary(host) {
  const row = bindRow('PART');
  const empty = el('div', 'xf-bind empty', EMPTY_ONE);
  const note = el('span', 'regmark tool-bind-note');
  host.append(row.el, empty, note);
  const bound = () => (ctx.selection().length ? ctx.primaryId() : null);
  const sync = () => {
    const n = ctx.selection().length;
    const id = bound();
    row.set(id);
    empty.hidden = !!id;
    note.hidden = n < 2;
    note.textContent = n > 1 ? `using the primary of ${n} selected` : '';
  };
  cur._sync = sync;
  sync();
  return bound;
}

/** `A: <name>` / `B: <name>` + ⇄ SWAP — bound to the first two parts picked.
 *  → () => [aId, bId] (either may be undefined). */
function bindPair(host) {
  const rowA = bindRow('A'), rowB = bindRow('B');
  const swapWrap = el('div', 'tool-actions tool-swap');
  const swap = el('button', 'btn tool-mini');
  swap.type = 'button'; swap.textContent = '⇄ SWAP';
  swap.classList.add('has-tip');   // text button → HUD tip (see ui.initTooltips)
  swap.setAttribute('data-tip', 'Exchange A and B. Order matters: A − B is not B − A.');
  swapWrap.appendChild(swap);
  const empty = el('div', 'xf-bind empty', EMPTY_TWO);
  const note = el('span', 'regmark tool-bind-note');
  host.append(rowA.el, rowB.el, swapWrap, empty, note);

  let flip = false, key = '';
  // Two parts or nothing: one part is not a boolean, so it reads as the empty
  // state rather than as a half-filled form.
  const pair = () => {
    const s = ctx.selection().slice(0, 2);
    if (s.length < 2) return [];
    return flip ? [s[1], s[0]] : s;
  };
  const sync = () => {
    const n = ctx.selection().length;
    // A fresh pair drops the flip: A is the first part picked until asked otherwise.
    const k = ctx.selection().slice(0, 2).join('|');
    if (k !== key) { key = k; flip = false; }
    const [a, b] = pair();
    rowA.set(a); rowB.set(b);
    swapWrap.hidden = n < 2;
    empty.hidden = n >= 2;
    note.hidden = n <= 2;
    note.textContent = n > 2 ? `using the first 2 of ${n} selected` : '';
  };
  swap.addEventListener('click', () => { flip = !flip; sync(); onChange(); });
  cur._sync = sync;
  sync();
  return pair;
}

// ── request helpers ───────────────────────────────────────────────────
const num = (inp, dflt = 0) => { const n = parseFloat(inp?.value); return Number.isFinite(n) ? n : dflt; };
const xyz = (t) => ({ x: num(t.x), y: num(t.y), z: num(t.z) });

const TRS_EPS = 1e-6;
function trsNonIdentity(trs) {
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
// One op input: { partId } plus the part's current non-identity TRS (folded in
// server-side into the mesh load, so voxel/mesh ops see the transformed part).
// A picked ROW resolves to the mesh it currently IS: for a latticed part that is
// the lattice, not the source shell it was generated from.
function inputRef(id) {
  const uid = ctx.unitId ? ctx.unitId(id) : id;
  const t = trsNonIdentity(ctx.getPartTrs(uid));
  return t ? { partId: uid, transform: t } : { partId: uid };
}

// Primitive kinds with a distinguished height axis: the worker authors them
// along +Y, so under a non-+Y MODEL UP they need a convention rotation to stand
// display-up. A box or a sphere has no such axis and never gets one.
const STANDING = new Set(['cyl', 'cone']);

// ══ TOOLS registry ════════════════════════════════════════════════════
// Each tool: title/jp (heading), confirm (button label), render(host)→read,
// validate(vals)→{ok,note,noteKind}, build(vals)→request body (null = no-op),
// afterConfirm(vals, part)? (post-success hook, e.g. transform reset).
const TOOLS = {
  // ── PRIMITIVE ────────────────────────────────────────────────────────
  primitive: {
    title: 'PRIMITIVE', jp: '基本', confirm: 'CREATE',
    render(host) {
      let kind = 'box';       // box | cyl | sph | cone
      let shapeRead = null;   // () -> sizeMM { x, y, z }
      let inited = false;     // openTool's body-wide initSteppers wires the FIRST build
      let centerDirty = false;   // the user took the centre over → stop auto-placing

      // Where this shape has to be AUTHORED (and with what convention pose) so
      // it stands display-up on the plate. See viewer.primitiveSpawn.
      const spawn = () => ctx.primitiveSpawn(shapeRead ? shapeRead().y : 0, STANDING.has(kind));

      const seg = segControl(
        [{ val: 'box', label: 'BOX' }, { val: 'cyl', label: 'CYL' },
         { val: 'sph', label: 'SPH' }, { val: 'cone', label: 'CONE' }],
        'box', (val) => { kind = val; rebuild(); syncCenter(); onChange(); });

      // Shape-specific fields live in their own flex column so the panel's
      // vertical rhythm is preserved when they are swapped on kind change.
      const shapeHost = el('div');
      shapeHost.style.display = 'flex';
      shapeHost.style.flexDirection = 'column';
      shapeHost.style.gap = '12px';

      // The centre is in FILE coordinates — what the worker receives. It defaults
      // to wherever the part has to be authored so it lands centred on the scene
      // and RESTING ON THE PLATE in display terms. Under a non-+Y MODEL UP that
      // is not the same point as where it draws: the convention rotation carries
      // it there and this centre is its pre-image (viewer.primitiveSpawn).
      const cen = tripletStepper('Center', 'mm', { x: 0, y: 0, z: 0 }, 1,
        'Placement of the primitive centre, in file coordinates. Defaults so the new part '
        + 'sits centred on the visible scene and rests on the plate under the current MODEL '
        + 'UP. Type your own numbers and it stops tracking the size.');
      for (const ax of ['x', 'y', 'z'])
        cen.inp[ax].addEventListener('input', () => { centerDirty = true; });
      const vox = stepper({ value: round(ctx.voxelDefault()), min: 0.05, step: 0.05 });

      host.append(
        paramBlock('Shape', seg.el, { tip: 'Box, cylinder, sphere or cone.' }),
        shapeHost, cen.el,
        paramBlock('Resolution <em>voxel mm</em>', vox.el,
          { tip: 'Voxel size the curved shapes (cylinder, sphere, cone) are faceted at. Finer is smoother and heavier; a box is exact at any setting.' }),
      );

      // Rebuild the shape-specific fields for the current kind. On the initial
      // build openTool's body-wide initSteppers wires them; later kind changes
      // wire the fresh steppers here (avoids double-binding the first set).
      function rebuild() {
        shapeHost.innerHTML = '';
        if (kind === 'box') {
          const size = tripletStepper('Size', 'mm', { x: 60, y: 40, z: 20 }, 0.5,
            'Full X/Y/Z dimensions of the box.');
          shapeHost.append(size.el);
          shapeRead = () => xyz(size.inp);
        } else if (kind === 'cyl') {
          const dia = stepper({ value: 20, min: 0.1, step: 0.5 });
          const hgt = stepper({ value: 40, min: 0.1, step: 0.5 });
          shapeHost.append(
            paramBlock('Diameter <em>mm</em>', dia.el,
              { tip: 'Round cross-section (X = Z). Use BOX for a custom rectangular footprint.' }),
            paramBlock('Height <em>mm</em>', hgt.el,
              { tip: 'Cylinder height. It is authored along Y and stood up along the display '
                + 'up axis, centred on the centre point.' }),
          );
          shapeRead = () => { const d = num(dia.inp, 20); return { x: d, y: num(hgt.inp, 40), z: d }; };
        } else if (kind === 'sph') {
          const dia = stepper({ value: 24, min: 0.1, step: 0.5 });
          shapeHost.append(
            paramBlock('Diameter <em>mm</em>', dia.el,
              { tip: 'Sphere diameter (equal on all axes).' }),
          );
          shapeRead = () => { const d = num(dia.inp, 24); return { x: d, y: d, z: d }; };
        } else { // cone
          const dia = stepper({ value: 20, min: 0.1, step: 0.5 });
          const hgt = stepper({ value: 40, min: 0.1, step: 0.5 });
          shapeHost.append(
            paramBlock('Base diameter <em>mm</em>', dia.el,
              { tip: 'Round base (X = Z). Base sits at centre − height/2, apex at centre + height/2.' }),
            paramBlock('Height <em>mm</em>', hgt.el,
              { tip: 'Cone height. It is authored along Y and stood up along the display up '
                + 'axis, so the apex points display-up out of the plate.' }),
          );
          shapeRead = () => { const d = num(dia.inp, 20); return { x: d, y: num(hgt.inp, 40), z: d }; };
        }
        // Every size/height/diameter edit re-seats the part on the plate (until
        // the user takes the centre over). The steppers dispatch a bubbling
        // `input`, so both typing and −/＋ land here.
        for (const inp of shapeHost.querySelectorAll('input[type="number"]'))
          inp.addEventListener('input', () => { syncCenter(); onChange(); });
        if (inited) ui.initSteppers(shapeHost);
      }

      // Centre default: the authored point that draws centred on the scene and
      // resting on the plate. All three components move — a convention rotation
      // permutes the axes — so the whole triplet is rewritten.
      function syncCenter() {
        if (centerDirty || !shapeRead) return;
        const c = spawn().centerMM;
        cen.inp.x.value = String(round(c.x));   // assignment fires no event
        cen.inp.y.value = String(round(c.y));
        cen.inp.z.value = String(round(c.z));
      }

      rebuild();
      inited = true;
      syncCenter();

      return () => ({
        kind, size: shapeRead(), center: xyz(cen.inp), voxel: num(vox.inp, 0.3),
      });
    },
    validate(v) {
      if (v.size.x <= 0 || v.size.y <= 0 || v.size.z <= 0)
        return { ok: false, note: 'Size must be > 0 on all axes', noteKind: 'err' };
      if (v.voxel <= 0) return { ok: false, note: 'Resolution must be > 0', noteKind: 'err' };
      const want = ctx.primitiveSpawn(v.size.y, STANDING.has(v.kind)).centerMM;
      const onPlate = ['x', 'y', 'z'].every((k) => Math.abs(v.center[k] - want[k]) < 1e-3);
      const at = `centre ${round(v.center.x)}, ${round(v.center.y)}, ${round(v.center.z)} mm`;
      return { ok: true, note: `${v.kind.toUpperCase()} · ${onPlate ? 'sits on the plate' : at}` };
    },
    build(v) {
      const kindMap = { box: 'box', cyl: 'cylinder', sph: 'sphere', cone: 'cone' };
      return {
        op: 'primitive', voxelSizeMM: v.voxel,
        primitive: { kind: kindMap[v.kind], sizeMM: v.size, centerMM: v.center, sides: 0 },
      };
    },
    // The worker builds cylinders and cones along +Y. Under any other MODEL UP
    // they arrive lying down, so the tool attaches the convention rotation that
    // stands them up: a normal, visible, clearable TRS that export bakes. That
    // is acceptable HERE and only here — a primitive is born in ANVIL, so there
    // is no external CAD frame to preserve.
    afterConfirm(v, part) {
      if (!part) return;
      const { trs } = ctx.primitiveSpawn(v.size.y, STANDING.has(v.kind));
      if (trs) ctx.setPartTransform(part.id, trs, { label: 'Stand up (display)', once: true });
    },
  },

  // ── BOOLEAN (union · difference · intersect · smooth) ────────────────
  // ONE combining tool. The first three submit `op:"boolean"`; SMOOTH is the old
  // MERGE tool folded in — a filleted union, `op:"merge"` + filletMM. Whichever
  // mode runs, the result CONSUMES its two inputs (main.consumeSources): the
  // source rows are REMOVED, so two parts in leaves exactly one part out and the
  // combined part is immediately a valid single base for GENERATE. Nothing is
  // lost — the whole op is one history command, so a single undo brings both
  // sources back and takes the result away.
  boolean: {
    title: 'BOOLEAN', jp: '論理', confirm: 'CONFIRM',
    render(host) {
      // A and B come off the SELECTION in pick order — first picked is A. ⇄ SWAP
      // exchanges them, because A − B is the one thing here that is not symmetric.
      const pair = bindPair(host);
      const seg = segControl(
        [{ val: 'union', label: 'UNION' }, { val: 'difference', label: 'DIFFERENCE' },
         { val: 'intersection', label: 'INTERSECT' }, { val: 'smooth', label: 'SMOOTH' }],
        'union', () => onChange());
      const hint = el('span', 'regmark tool-hint');
      const blend = stepper({ value: 1, min: 0, step: 0.1 });
      const vox = stepper({ value: round(ctx.voxelDefault()), min: 0.05, step: 0.05 });
      host.append(
        paramBlock('Operation', seg.el,
          { tip: 'Union (A+B), difference (A−B), intersect (A∩B), or smooth, a filleted union that blends the seam. '
            + 'Runs on your selection: A is the first part you picked, B the second.' }),
      );
      const segWrap = host.lastChild; segWrap.appendChild(hint);
      const blendBlock = paramBlock('Blend radius <em>mm</em>', blend.el,
        { tip: 'SMOOTH only: the fillet radius applied to the union, rounding the seam where the two parts meet.' });
      host.append(blendBlock, paramBlock('Resolution <em>voxel mm</em>', vox.el,
        { tip: 'Voxel size for this operation.' }));
      blend.inp.addEventListener('input', () => onChange());
      const read = () => {
        const [a, b] = pair();
        return { main: a || null, secondary: b || null, count: ctx.selection().length,
          kind: seg.get(), blend: num(blend.inp, 1), voxel: num(vox.inp, 0.3) };
      };
      function updateHint() {
        const v = read();
        // The blend radius belongs to SMOOTH alone — hidden in the other modes.
        blendBlock.classList.toggle('param-off', v.kind !== 'smooth');
        hint.textContent =
          v.kind === 'difference'   ? 'A − B' :
          v.kind === 'intersection' ? 'A ∩ B' :
          v.kind === 'smooth'       ? `filleted union — blends the seam by ${round(v.blend)} mm` :
                                      'A + B';
      }
      updateHint();
      cur._hint = updateHint;
      return read;
    },
    validate(v) {
      if (!v.main || !v.secondary) return { ok: false, note: EMPTY_TWO, noteKind: '' };
      if (v.kind === 'smooth' && v.blend < 0)
        return { ok: false, note: 'Blend radius must be ≥ 0', noteKind: 'err' };
      return { ok: true, note: 'consumes its inputs - undo restores them' };
    },
    build(v) {
      const inputs = [inputRef(v.main), inputRef(v.secondary)];
      return v.kind === 'smooth'
        ? { op: 'merge',   voxelSizeMM: v.voxel, filletMM: v.blend, inputs }
        : { op: 'boolean', voxelSizeMM: v.voxel, booleanKind: v.kind, inputs };
    },
    // The selection speaks in UNIT ids (a latticed row is its lattice mesh);
    // consuming works on ROWS, and takes the whole unit with it.
    afterConfirm(v, part) {
      ctx.consumeSources([ctx.rowId(v.main), ctx.rowId(v.secondary)], part.id,
        v.kind === 'smooth' ? 'SMOOTH' : 'BOOL');
    },
  },

  // ── SHELL ────────────────────────────────────────────────────────────
  // Thickness + direction hollow the part; OPEN FACES decides which walls are
  // left OUT, the way Fusion's Shell removes the faces you pick. PICK arms the
  // viewer's flat-face quads as a multi-select — clicking one toggles it green
  // ("open = air", the same language a Negative cavity uses), clicking again
  // closes it. The set lives in the VIEWER, which owns the face geometry; the
  // tool only reads its count and, at build time, its world-frame rectangles.
  shell: {
    title: 'SHELL', jp: '殻', confirm: 'CONFIRM',
    render(host) {
      const part = bindPrimary(host);
      const seg = segControl(
        [{ val: 'inside', label: 'INSIDE' }, { val: 'outside', label: 'OUTSIDE' },
         { val: 'centered', label: 'CENTERED' }],
        'inside', () => onChange());
      const th = stepper({ value: 2, min: 0, step: 0.1 });
      const vox = stepper({ value: round(ctx.voxelDefault()), min: 0.05, step: 0.05 });
      const hint = el('span', 'regmark tool-hint');
      host.append(
        paramBlock('Direction', seg.el, { tip: 'Grow the wall inward, outward, or centred on the surface.' }),
      );

      // ── OPEN FACES ──
      const pick = el('button', 'btn tool-mini has-tip');
      pick.type = 'button'; pick.textContent = 'PICK';
      pick.setAttribute('data-tip',
        'Arm face picking, then click the highlighted faces on the part. A green face is left '
        + 'OPEN: no wall there, so the hollow interior breaks out. Click it again to close it. '
        + 'Flat faces only, curved surfaces are not detected.');
      const count = el('span', 'regmark tool-hint');
      const pickRow = el('div', 'tool-actions tool-pick');
      pickRow.append(pick, count);
      host.append(paramBlock('Open faces', pickRow,
        { tip: 'Faces to leave out of the shell. None picked gives a fully closed hollow part.' }));

      host.append(paramBlock('Thickness <em>mm</em>', th.el, { tip: 'Wall thickness of the shell.' }));
      host.lastChild.appendChild(hint);
      host.append(paramBlock('Resolution <em>voxel mm</em>', vox.el, { tip: 'Voxel size for this operation.' }));
      cur._hint = () => {
        const min = 1.5 * num(vox.inp, 0.3);
        hint.classList.toggle('warn', num(th.inp) <= min);
        hint.textContent = `min wall ${(min).toFixed(2)} mm (1.5 × voxel)`;
      };
      cur._hint();

      // The open set belongs to ONE part. Rebinding to another drops it, so the
      // op can never carry faces that were picked on a different body.
      let boundFor = part();
      const openSync = () => {
        const id = part();
        if (id !== boundFor) { boundFor = id; ctx.clearOpenFaces(); }
        const armed = ctx.isOpenFacesArmed();
        const n = ctx.openFaceIds().length;
        pick.disabled = !id;
        pick.classList.toggle('active', armed);
        pick.setAttribute('aria-pressed', armed ? 'true' : 'false');
        count.textContent = n
          ? `${n} open`
          : (armed ? 'click a flat face' : 'none - fully closed');
      };
      pick.addEventListener('click', () => {
        if (ctx.isOpenFacesArmed()) ctx.cancelOpenFaces();
        else if (!ctx.armOpenFaces(part())) return;
        openSync();
        onChange();
      });
      // bindPrimary installed the header repaint — chain the open-face row onto it
      // so a selection change repaints both without re-rendering the parameters.
      const bindSync = cur._sync;
      cur._sync = (live) => { bindSync?.(live); openSync(); };
      cur._openSync = openSync;
      openSync();

      return () => ({ part: part(), dir: seg.get(), thickness: num(th.inp, 2),
        voxel: num(vox.inp, 0.3), openIds: ctx.openFaceIds() });
    },
    validate(v) {
      if (!v.part) return { ok: false, note: EMPTY_ONE, noteKind: '' };
      const min = 1.5 * v.voxel;
      if (v.thickness <= min) return { ok: false, note: `Thickness must exceed ${min.toFixed(2)} mm`, noteKind: 'warn' };
      const n = v.openIds.length;
      return { ok: true, note: n ? `${n} face${n > 1 ? 's' : ''} left open` : '' };
    },
    build(v) {
      const body = { op: 'shell', voxelSizeMM: v.voxel, shellDirection: v.dir,
        shellThicknessMM: v.thickness, inputs: [inputRef(v.part)] };
      // World-frame rectangles read at BUILD time, so they reflect the part's
      // current TRS — the same transform the request folds into inputs[0], which
      // is the frame the worker sees once it bakes it.
      const faces = v.openIds.map((id) => ctx.faceQuadData(id)).filter(Boolean);
      if (faces.length) body.openFaces = faces;   // omitted entirely = closed shell
      return body;
    },
    afterConfirm() { resetOpenFaces(); },
  },

  // ── OFFSET ───────────────────────────────────────────────────────────
  offset: {
    title: 'OFFSET', jp: '膨張', confirm: 'CONFIRM',
    render(host) {
      const part = bindPrimary(host);
      const dist = stepper({ value: 1, step: 0.1 });
      const vox = stepper({ value: round(ctx.voxelDefault()), min: 0.05, step: 0.05 });
      const hint = el('span', 'regmark tool-hint');
      host.append(
        paramBlock('Distance <em>signed mm</em>', dist.el,
          { tip: 'Grow (+) or shrink (−) the part surface by this distance. Shrinking erodes fine detail first.' }),
      );
      host.lastChild.appendChild(hint);
      host.append(paramBlock('Resolution <em>voxel mm</em>', vox.el, { tip: 'Voxel size for this operation.' }));
      cur._hint = () => {
        const d = Math.abs(num(dist.inp)), warn = 2 * num(vox.inp, 0.3);
        hint.classList.toggle('warn', d > 0 && d < warn);
        hint.textContent = d > 0 && d < warn
          ? `⚠ |d| < 2 × voxel (${warn.toFixed(2)} mm) — may lose detail`
          : `signed offset · min |d| ${(1.5 * num(vox.inp, 0.3)).toFixed(2)} mm`;
      };
      cur._hint();
      return () => ({ part: part(), dist: num(dist.inp, 0), voxel: num(vox.inp, 0.3) });
    },
    validate(v) {
      if (!v.part) return { ok: false, note: EMPTY_ONE, noteKind: '' };
      const min = 1.5 * v.voxel;
      if (Math.abs(v.dist) <= min) return { ok: false, note: `|distance| must exceed ${min.toFixed(2)} mm`, noteKind: 'warn' };
      return { ok: true, note: '' };
    },
    build(v) {
      return { op: 'offset', voxelSizeMM: v.voxel, offsetDistMM: v.dist, inputs: [inputRef(v.part)] };
    },
  },

  // ── TRANSFORM · XFORM (live selection readout; APPLY bakes) ──────────
  // Wave-6: the part dropdown is GONE. The tool binds to whatever is selected in
  // the canvas or the objects list — that IS the picker, and it is the same one
  // the gizmo uses, so the panel can never disagree with the viewport. Numbers
  // flow both ways: typing commits through setPartTransform (undoable), and a
  // gizmo/plate drag ticks the fields live through onTransformLive.
  transform: {
    title: 'TRANSFORM', jp: '変換', confirm: 'APPLY', live: true,
    render(host) {
      // Bound-part line: the name, the multi-selection note, or the empty note.
      const bind = el('div', 'xf-bind');
      const fields = el('div', 'xf-fields');
      const tr = tripletStepper('Position', 'mm', { x: 0, y: 0, z: 0 }, 1,
        'World position of the selected part. Non-destructive: it travels with the part into GENERATE.');
      const rot = tripletStepper('Rotation', 'deg', { x: 0, y: 0, z: 0 }, 15,
        'Rotation about the part origin (X then Y then Z).');
      const scl = tripletStepper('Scale', '×', { x: 1, y: 1, z: 1 }, 0.05,
        'Per-axis scale factor (1 = original). Applied before rotation; travels with the part.');
      for (const ax of ['x', 'y', 'z']) { scl.inp[ax].min = '0.01'; }
      const center = el('button', 'btn tool-mini has-tip'); center.type = 'button'; center.textContent = 'CENTER';
      center.setAttribute('data-tip', 'Preset: translate the part bbox centre to the origin.');
      const clear = el('button', 'btn tool-mini has-tip'); clear.type = 'button'; clear.textContent = 'CLEAR';
      clear.setAttribute('data-tip',
        'Reset this part to identity: no translate, no rotate, scale 1. An import never '
        + 'carries a transform, so this only ever removes ones you or a tool applied.');
      const actions = el('div', 'tool-actions'); actions.append(center, clear);
      fields.append(tr.el, rot.el, scl.el,
        paramBlock('Preset', actions, { tip: 'One-tap placement presets.' }));

      // Read-only world regmarks — where the selection actually SITS and how big
      // it is, combined bbox for a multi-selection. Live through every drag.
      const readout = el('div', 'xf-readout');
      const mk = (name) => {
        const row = el('div', 'xf-row');
        row.appendChild(el('span', 'xf-k regmark', name));
        const v = {};
        for (const ax of ['x', 'y', 'z']) {
          const cell = el('span', 'xf-v num');
          cell.textContent = '—';
          v[ax] = cell;
          row.appendChild(cell);
        }
        readout.appendChild(row);
        return v;
      };
      const head = el('div', 'xf-row xf-head');
      head.appendChild(el('span', 'xf-k regmark', 'WORLD'));
      for (const ax of ['X', 'Y', 'Z']) head.appendChild(el('span', 'xf-ax regmark', ax));
      readout.appendChild(head);
      const cenOut = mk('BBOX CENTER');
      const sizeOut = mk('SIZE');

      host.append(bind, fields, readout);

      const readScale = () => { const s = xyz(scl.inp); return { x: s.x || 1, y: s.y || 1, z: s.z || 1 }; };
      const readTrs = () => ({ translateMM: xyz(tr.inp), rotateDeg: xyz(rot.inp), scale: readScale() });
      const boundId = () => ctx.primaryId();

      // Write a value WITHOUT stealing the caret: the field the user is typing
      // in is left alone (this runs on every live drag frame and every commit).
      const put = (inp, val) => {
        if (document.activeElement === inp) return;
        const s = String(round(val));
        if (inp.value !== s) inp.value = s;
      };
      // `liveTrs` is the in-flight pose of the bound part straight off a gizmo /
      // plate drag: app state only takes the TRS on COMMIT, so mid-drag the
      // fields have to read the drag's own numbers or they would sit still while
      // the part visibly moves.
      function sync(liveTrs) {
        const sel = ctx.selection();
        const id = boundId();
        const n = sel.length;
        fields.hidden = n !== 1;
        readout.hidden = n === 0;
        if (n === 0) {
          bind.className = 'xf-bind empty';
          bind.textContent = EMPTY_ONE;
        } else if (n > 1) {
          bind.className = 'xf-bind multi';
          bind.textContent = `${n} parts selected - gizmo moves the group; numeric entry needs a single part`;
        } else {
          bind.className = 'xf-bind';
          bind.textContent = ctx.partName(id);
          const t = liveTrs || ctx.getPartTrs(id) || {};
          const tt = t.translateMM || { x: 0, y: 0, z: 0 }, rr = t.rotateDeg || { x: 0, y: 0, z: 0 };
          const ss = t.scale || { x: 1, y: 1, z: 1 };
          for (const ax of ['x', 'y', 'z']) {
            put(tr.inp[ax], tt[ax] || 0);
            put(rot.inp[ax], rr[ax] || 0);
            put(scl.inp[ax], ss[ax] ?? 1);
          }
        }
        const box = n ? ctx.selectionBox() : null;
        for (const ax of ['x', 'y', 'z']) {
          cenOut[ax].textContent = box ? round(box.center[ax]).toFixed(2) : '—';
          sizeOut[ax].textContent = box ? round(box.size[ax]).toFixed(2) : '—';
        }
      }
      function onLive() {
        const id = boundId();
        if (id && ctx.selection().length === 1) ctx.setPartTransform(id, readTrs());
        sync();
        onChange();   // refresh validity/accent
      }
      // live-preview on every position/rotation/scale edit
      for (const g of [tr.inp, rot.inp, scl.inp]) for (const ax of ['x', 'y', 'z'])
        g[ax].addEventListener('input', onLive);
      center.addEventListener('click', () => {
        const id = boundId(); const bb = id ? ctx.partBbox(id) : null;
        if (!bb) return;
        tr.inp.x.value = round(-(bb.min[0] + bb.max[0]) / 2);
        tr.inp.y.value = round(-(bb.min[1] + bb.max[1]) / 2);
        tr.inp.z.value = round(-(bb.min[2] + bb.max[2]) / 2);
        onLive();
      });
      // CLEAR — drop the part's whole TRS (identity). Goes through
      // clearPartTransform so it is ONE undo entry.
      clear.addEventListener('click', () => {
        const id = boundId();
        if (!id) return;
        ctx.clearPartTransform(id);
        sync();
        onChange();
      });
      cur._live = onLive;
      cur._sync = sync;
      sync();
      return () => ({ part: ctx.selection().length === 1 ? boundId() : null, count: ctx.selection().length, trs: readTrs() });
    },
    validate(v) {
      if (!v.count) return { ok: false, note: EMPTY_ONE, noteKind: '' };
      if (v.count > 1) return { ok: false, note: 'APPLY bakes one part at a time', noteKind: '' };
      if (!trsNonIdentity(v.trs)) return { ok: false, note: 'Move, rotate or scale, then APPLY to bake', noteKind: '' };
      return { ok: true, note: 'APPLY bakes a new part; source returns to origin' };
    },
    build(v) {
      return { op: 'transform', bake: true, voxelSizeMM: ctx.voxelDefault(),
        inputs: [{ partId: v.part, transform: v.trs }] };
    },
    afterConfirm(v) { ctx.clearPartTransform(v.part); },
  },

  // ── MIRROR ───────────────────────────────────────────────────────────
  mirror: {
    title: 'MIRROR', jp: '鏡像', confirm: 'CONFIRM',
    render(host) {
      const part = bindPrimary(host);
      const seg = segControl(
        [{ val: 'xy', label: 'XY' }, { val: 'yz', label: 'YZ' }, { val: 'xz', label: 'XZ' }],
        'yz', () => onChange());
      const off = stepper({ value: 0, step: 1 });
      host.append(
        paramBlock('Plane', seg.el, { tip: 'Reflection plane (winding-corrected). Runs on the selected part.' }),
        paramBlock('Plane offset <em>mm</em>', off.el,
          { tip: 'Distance of the mirror plane from the origin along its normal.' }),
      );
      return () => ({ part: part(), plane: seg.get(), offset: num(off.inp, 0) });
    },
    validate(v) {
      if (!v.part) return { ok: false, note: EMPTY_ONE, noteKind: '' };
      return { ok: true, note: `mirror across ${v.plane.toUpperCase()}` };
    },
    build(v) {
      const N = { xy: { x: 0, y: 0, z: 1 }, yz: { x: 1, y: 0, z: 0 }, xz: { x: 0, y: 1, z: 0 } }[v.plane];
      const P = { x: N.x * v.offset, y: N.y * v.offset, z: N.z * v.offset };
      return { op: 'mirror', voxelSizeMM: ctx.voxelDefault(),
        mirror: { planePoint: P, planeNormal: N }, inputs: [inputRef(v.part)] };
    },
  },

  // ── DUPLICATE (instant, synchronous) ─────────────────────────────────
  // ONE copy of the selected part, in place. N copies of a whole selection stay
  // with the right-click DUPLICATE… popover, which owns the count and the
  // offset-per-copy walk (and wraps the batch in one history transaction).
  duplicate: {
    title: 'DUPLICATE', jp: '複製', confirm: 'DUPLICATE',
    render(host) {
      const part = bindPrimary(host);
      return () => ({ part: part() });
    },
    validate(v) {
      if (!v.part) return { ok: false, note: EMPTY_ONE, noteKind: '' };
      return { ok: true, note: 'instant independent copy - right-click for N copies' };
    },
    build(v) { return { op: 'duplicate', inputs: [{ partId: ctx.unitId ? ctx.unitId(v.part) : v.part }] }; },
  },
};

// ── panel lifecycle ───────────────────────────────────────────────────
function setNote(text, kind) {
  const n = els().toolNote; if (!n) return;
  n.textContent = text || '';
  n.className = 'tool-note' + (kind ? ` ${kind}` : '');
}
function setProgStage(stage) {
  const s = els().toolProgStage; if (s) s.textContent = stage || 'Working…';
}
function setRunning(on, stage) {
  cur.running = on;
  els().toolProgress?.classList.toggle('hidden', !on);
  if (on) setProgStage(stage);
}

// Any control change: update dynamic hints + re-validate + refresh accent.
function onChange() {
  if (!cur) return;
  cur._hint?.();
  revalidate();
}

function revalidate() {
  if (!cur) return;
  const t = TOOLS[cur.id];
  const v = t.validate(cur.read(), ctx);
  cur.valid = v.ok;
  const btn = els().toolConfirm;
  if (btn) btn.disabled = !v.ok;          // gated CONFIRM (stays enabled while running)
  setNote(v.note, v.noteKind);
  ctx.onStateChange();                     // main.updateAccents (single-fill machine)
}

/** Drop the SHELL open-face pick AND its set. Any tool boundary resets it: the
 *  set is a parameter of one open SHELL panel, never leftover app state. */
function resetOpenFaces() {
  ctx?.cancelOpenFaces?.();
  ctx?.clearOpenFaces?.();
}

export function openTool(id) {
  const t = TOOLS[id];
  if (!t) return;
  resetOpenFaces();               // a fresh panel starts with nothing picked
  cur = { id, read: null, valid: false, running: false };
  const body = els().toolBody;
  body.innerHTML = '';
  els().toolTitle.textContent = t.title;
  els().toolTitleJp.textContent = t.jp || '';
  const btn = els().toolConfirm;
  btn.textContent = t.confirm || 'CONFIRM';
  els().toolProgress.classList.add('hidden');
  cur.read = t.render(body, ctx);
  ui.initSteppers(body);         // wire the freshly-built −/＋ steppers
  // The tool TAKES OVER the left panel: one tool per sidebar, full height, and
  // no GENERATE anywhere while it is open (the LATTICE view owns that).
  ui.setLeftView('tool');
  // reflect toolbar active state
  syncToolbarActive(id);
  revalidate();
}

export function close() {
  if (!cur) return;
  resetOpenFaces();
  cur = null;
  ui.setLeftView('lattice');   // back to the home view (LATTICE + GENERATE)
  syncToolbarActive(null);
  ui.setToolConfirmFilled(false);
  ctx.onStateChange();
}

export function toggle(id) { (cur && cur.id === id) ? close() : openTool(id); }
export function isOpen() { return !!cur; }
export function isValid() { return !!(cur && cur.valid); }

// The parts set changed. Nothing to re-render any more — no tool holds a list of
// parts — but a bound part may have just left the scene, so the header repaints
// (main.js drops departed parts from the selection first).
export function onPartsChanged() { syncBound(); }

// ── Wave-6/7 · selection binding ──────────────────────────────────────
// No tool has a part picker: they all BIND to the app's selection. main.js calls
// these whenever the selection or a part's TRS changes, and the tool repaints in
// place — no re-render, so a field being typed in keeps its value and its caret.
function syncBound() {
  if (!cur) return;
  cur._sync?.();
  revalidate();
}
/** The selection changed (or a TRS committed) — rebind and repaint. */
export function onSelectionChanged() { syncBound(); }
/** The viewer's OPEN FACES set (or its armed state) moved — repaint the row.
 *  Fired by a quad click and by anything that takes the face quads away. */
export function onOpenFacesChanged() {
  if (!cur) return;
  cur._openSync?.();
  revalidate();
}
/** Mid-drag TRS frames, straight off the gizmo/plate drag. The bound part's
 *  in-flight pose is handed to the tool so its fields tick with the drag. */
export function onTransformLive(entries) {
  if (!cur || !cur._sync || !entries?.length) return;
  const id = ctx.primaryId?.();
  const hit = id ? entries.find((e) => e.id === id) : null;
  cur._sync(hit ? hit.trs : null);
}

function syncToolbarActive(id) {
  const map = {
    primitive: 'tbPrim', boolean: 'tbBool', shell: 'tbShell',
    offset: 'tbOffset', transform: 'tbXform', mirror: 'tbMirror', duplicate: 'tbDupe',
  };
  for (const [tool, key] of Object.entries(map)) {
    const b = els()[key];
    if (b) b.classList.toggle('active', tool === id);
  }
}

async function confirmTool() {
  if (!cur || cur.running) return;
  const t = TOOLS[cur.id];
  const vals = cur.read();
  const v = t.validate(vals, ctx);
  if (!v.ok) return;
  const body = t.build(vals, ctx);
  if (!body) return;

  setRunning(true, 'Queued…');
  revalidate();
  ctx.onStateChange();
  let part = null;
  try {
    part = await ctx.runOp(body, (stage) => setProgStage(stage));
  } catch (err) {
    setRunning(false);
    setNote(err.message, 'err');
    ctx.toast(`${t.title} failed: ${err.message}`, 'error', 9000);
    revalidate();
    return;
  }
  setRunning(false);
  if (part) {
    t.afterConfirm?.(vals, part);
    ctx.toast(`${t.title} → ${part.name}`, 'success', 3500);
    // the parts set moved under the tool — repaint what it is bound to
    onPartsChanged();
  }
  revalidate();
}

// ── init ──────────────────────────────────────────────────────────────
export function initTools(controller) {
  ctx = controller;
  els().toolConfirm?.addEventListener('click', confirmTool);
  els().toolCancel?.addEventListener('click', close);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && cur && !cur.running) { e.stopPropagation(); close(); }
  });
}

// ── helpers ───────────────────────────────────────────────────────────
function round(n) { return Number.isFinite(n) ? Math.round(n * 1000) / 1000 : 0; }
