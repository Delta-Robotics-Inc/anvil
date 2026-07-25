//
// tools.js — Wave-1 "Objects & Ops" contextual tool panel.
//
// Renders a HyDesign-style contextual panel into the #sec-tool tile at the top
// of the left panel: pickers + params + CONFIRM + inline progress. Each tool
// declares how it renders, validates, and builds its /api/ops (or transform
// bake) request. main.js owns app state + the viewer and passes a small `ctx`
// controller; this module never touches app state directly.
//
//   ctx = {
//     listParts()        -> [{ id, name, role }]  (current parts, for pickers)
//     unionCenter()      -> {x,y,z} | null        (visible-union bbox centre)
//     voxelDefault()     -> number                (current TPMS voxel size)
//     getPartTrs(id)     -> trs | null            (a part's non-destructive TRS)
//     partBbox(id)       -> { min:[3], max:[3] } | null
//     setPartTransform(id, trs)                   (live preview + persist)
//     clearPartTransform(id)                      (APPLY bake → reset source TRS)
//     runOp(body, onProgress) -> Promise<part|null>
//     consumeSources(ids, resultId, kind)         (BOOL/SMOOTH: sources → USED)
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

// A HUD-styled part picker (reuses the .field base-select). `onChange` fires
// with the chosen part id. Returns { el, get }.
function pickerControl(value, onChange) {
  const field = el('span', 'field');
  const sel = el('select');
  sel.name = `tool-pick-${++fieldSeq}`;
  const parts = ctx.listParts();
  if (!parts.length) {
    const o = el('option'); o.value = ''; o.textContent = '— no parts —'; o.disabled = true; o.selected = true;
    sel.appendChild(o); sel.disabled = true;
  } else {
    let chosen = parts.some((p) => p.id === value) ? value : parts[0].id;
    for (const p of parts) {
      const o = el('option'); o.value = p.id; o.textContent = p.name;
      if (p.id === chosen) o.selected = true;
      sel.appendChild(o);
    }
  }
  sel.addEventListener('change', () => onChange(sel.value));
  field.appendChild(sel);
  return { el: field, get: () => sel.value };
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
function inputRef(id) {
  const t = trsNonIdentity(ctx.getPartTrs(id));
  return t ? { partId: id, transform: t } : { partId: id };
}

// ══ TOOLS registry ════════════════════════════════════════════════════
// Each tool: title/jp (heading), confirm (button label), render(host)→read,
// validate(vals)→{ok,note,noteKind}, build(vals)→request body (null = no-op),
// afterConfirm(vals, part)? (post-success hook, e.g. transform reset).
const TOOLS = {
  // ── PRIMITIVE ────────────────────────────────────────────────────────
  primitive: {
    title: 'PRIMITIVE', jp: '基本', confirm: 'CREATE',
    render(host) {
      const c = ctx.unionCenter() || { x: 0, y: 0, z: 0 };
      let kind = 'box';       // box | cyl | sph | cone
      let shapeRead = null;   // () -> sizeMM { x, y, z }
      let inited = false;     // openTool's body-wide initSteppers wires the FIRST build
      let zDirty = false;     // the user edited Z himself → stop auto-sitting on the plate

      const seg = segControl(
        [{ val: 'box', label: 'BOX' }, { val: 'cyl', label: 'CYL' },
         { val: 'sph', label: 'SPH' }, { val: 'cone', label: 'CONE' }],
        'box', (val) => { kind = val; rebuild(); syncZ(); onChange(); });

      // Shape-specific fields live in their own flex column so the panel's
      // vertical rhythm is preserved when they are swapped on kind change.
      const shapeHost = el('div');
      shapeHost.style.display = 'flex';
      shapeHost.style.flexDirection = 'column';
      shapeHost.style.gap = '12px';

      // Everything is printed: Z0 is the plate. X/Y still default to the visible-
      // union bbox centre, but Z defaults to HALF the primitive's height so the
      // new part rests ON the bed (bbox min Z = 0) instead of straddling it.
      const cen = tripletStepper('Center', 'mm',
        { x: round(c.x), y: round(c.y), z: 0 }, 1,
        'Placement of the primitive centre. X/Y default to the visible-union bbox centre; '
        + 'Z defaults to half the height so the part sits ON the plate (Z0 = print bed). '
        + 'Type your own Z and it stops tracking the size.');
      cen.inp.z.addEventListener('input', () => { zDirty = true; });
      const vox = stepper({ value: round(ctx.voxelDefault()), min: 0.05, step: 0.05 });

      host.append(
        paramBlock('Shape', seg.el, { tip: 'Box, cylinder, sphere or cone.' }),
        shapeHost, cen.el,
        paramBlock('Resolution <em>voxel mm</em>', vox.el,
          { tip: 'Voxel size the curved shapes (cylinder, sphere, cone) are faceted at — finer = smoother. Box is exact.' }),
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
              { tip: 'Round cross-section (X = Y). Use BOX for a custom rectangular footprint.' }),
            paramBlock('Height <em>mm</em>', hgt.el,
              { tip: 'Cylinder height along Z, centred on the centre point.' }),
          );
          shapeRead = () => { const d = num(dia.inp, 20); return { x: d, y: d, z: num(hgt.inp, 40) }; };
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
              { tip: 'Round base (X = Y). Base sits at centre − height/2, apex at centre + height/2.' }),
            paramBlock('Height <em>mm</em>', hgt.el,
              { tip: 'Cone height along Z, centred on the centre point.' }),
          );
          shapeRead = () => { const d = num(dia.inp, 20); return { x: d, y: d, z: num(hgt.inp, 40) }; };
        }
        // Every size/height/diameter edit re-seats the part on the plate (until
        // the user takes Z over). The steppers dispatch a bubbling `input`, so
        // both typing and −/＋ land here.
        for (const inp of shapeHost.querySelectorAll('input[type="number"]'))
          inp.addEventListener('input', () => { syncZ(); onChange(); });
        if (inited) ui.initSteppers(shapeHost);
      }

      // Z default = half the primitive's height → bbox min Z lands on 0.
      function syncZ() {
        if (zDirty || !shapeRead) return;
        cen.inp.z.value = String(round(shapeRead().z / 2));   // assignment fires no event
      }

      rebuild();
      inited = true;
      syncZ();

      return () => ({
        kind, size: shapeRead(), center: xyz(cen.inp), voxel: num(vox.inp, 0.3),
      });
    },
    validate(v) {
      if (v.size.x <= 0 || v.size.y <= 0 || v.size.z <= 0)
        return { ok: false, note: 'Size must be > 0 on all axes', noteKind: 'err' };
      if (v.voxel <= 0) return { ok: false, note: 'Resolution must be > 0', noteKind: 'err' };
      const onPlate = Math.abs(v.center.z - v.size.z / 2) < 1e-6;
      return { ok: true, note: `${v.kind.toUpperCase()} · ${onPlate ? 'sits on the plate (Z0)' : `centre Z ${round(v.center.z)} mm`}` };
    },
    build(v) {
      const kindMap = { box: 'box', cyl: 'cylinder', sph: 'sphere', cone: 'cone' };
      return {
        op: 'primitive', voxelSizeMM: v.voxel,
        primitive: { kind: kindMap[v.kind], sizeMM: v.size, centerMM: v.center, sides: 0 },
      };
    },
  },

  // ── BOOLEAN (union · difference · intersect · smooth) ────────────────
  // ONE combining tool. The first three submit `op:"boolean"`; SMOOTH is the old
  // MERGE tool folded in — a filleted union, `op:"merge"` + filletMM. Whichever
  // mode runs, the two sources are CONSUMED by the result (main.consumeSources):
  // they stay listed for undo but leave the viewport and the mode logic, so the
  // combined part is immediately a valid single base for GENERATE.
  boolean: {
    title: 'BOOLEAN', jp: '論理', confirm: 'CONFIRM', usesParts: true,
    render(host) {
      const parts = ctx.listParts();
      const a = parts[0]?.id, b = parts[1]?.id ?? parts[0]?.id;
      const main = pickerControl(a, () => onChange());
      const sec = pickerControl(b, () => onChange());
      const seg = segControl(
        [{ val: 'union', label: 'UNION' }, { val: 'difference', label: 'DIFFERENCE' },
         { val: 'intersection', label: 'INTERSECT' }, { val: 'smooth', label: 'SMOOTH' }],
        'union', () => onChange());
      const hint = el('span', 'regmark tool-hint');
      const blend = stepper({ value: 1, min: 0, step: 0.1 });
      const vox = stepper({ value: round(ctx.voxelDefault()), min: 0.05, step: 0.05 });
      host.append(
        paramBlock('Main', main.el, { tip: 'Primary part — consumed by the result.' }),
        paramBlock('Secondary', sec.el, { tip: 'Second part — consumed by the result.' }),
        paramBlock('Operation', seg.el,
          { tip: 'Union (A+B), difference (A−B), intersect (A∩B), or smooth — a filleted union that blends the seam.' }),
      );
      const segWrap = host.lastChild; segWrap.appendChild(hint);
      const blendBlock = paramBlock('Blend radius <em>mm</em>', blend.el,
        { tip: 'SMOOTH only — fillet radius applied to the union, rounding the seam where the two parts meet.' });
      host.append(blendBlock, paramBlock('Resolution <em>voxel mm</em>', vox.el,
        { tip: 'Voxel size for this operation.' }));
      blend.inp.addEventListener('input', () => onChange());
      const read = () => ({ main: main.get(), secondary: sec.get(), kind: seg.get(),
        blend: num(blend.inp, 1), voxel: num(vox.inp, 0.3) });
      function updateHint() {
        const v = read();
        // The blend radius belongs to SMOOTH alone — hidden in the other modes.
        blendBlock.classList.toggle('param-off', v.kind !== 'smooth');
        hint.textContent =
          v.kind === 'difference'   ? 'MAIN − SECONDARY' :
          v.kind === 'intersection' ? 'MAIN ∩ SECONDARY' :
          v.kind === 'smooth'       ? `filleted union — blends the seam by ${round(v.blend)} mm` :
                                      'MAIN + SECONDARY';
      }
      updateHint();
      cur._hint = updateHint;
      return read;
    },
    validate(v) {
      if (!v.main || !v.secondary) return { ok: false, note: 'Pick two parts', noteKind: 'err' };
      if (v.main === v.secondary) return { ok: false, note: 'Main and Secondary must differ', noteKind: 'err' };
      if (v.kind === 'smooth' && v.blend < 0)
        return { ok: false, note: 'Blend radius must be ≥ 0', noteKind: 'err' };
      return { ok: true, note: 'both sources are consumed — delete the result to restore them' };
    },
    build(v) {
      const inputs = [inputRef(v.main), inputRef(v.secondary)];
      return v.kind === 'smooth'
        ? { op: 'merge',   voxelSizeMM: v.voxel, filletMM: v.blend, inputs }
        : { op: 'boolean', voxelSizeMM: v.voxel, booleanKind: v.kind, inputs };
    },
    afterConfirm(v, part) {
      ctx.consumeSources([v.main, v.secondary], part.id, v.kind === 'smooth' ? 'SMOOTH' : 'BOOL');
    },
  },

  // ── SHELL ────────────────────────────────────────────────────────────
  shell: {
    title: 'SHELL', jp: '殻', confirm: 'CONFIRM', usesParts: true,
    render(host) {
      const part = pickerControl(ctx.listParts()[0]?.id, () => onChange());
      const seg = segControl(
        [{ val: 'inside', label: 'INSIDE' }, { val: 'outside', label: 'OUTSIDE' },
         { val: 'centered', label: 'CENTERED' }],
        'inside', () => onChange());
      const th = stepper({ value: 2, min: 0, step: 0.1 });
      const vox = stepper({ value: round(ctx.voxelDefault()), min: 0.05, step: 0.05 });
      const hint = el('span', 'regmark tool-hint');
      host.append(
        paramBlock('Part', part.el, { tip: 'Source part.' }),
        paramBlock('Direction', seg.el, { tip: 'Grow the wall inward, outward, or centred on the surface.' }),
        paramBlock('Thickness <em>mm</em>', th.el, { tip: 'Wall thickness of the shell.' }),
      );
      host.lastChild.appendChild(hint);
      host.append(paramBlock('Resolution <em>voxel mm</em>', vox.el, { tip: 'Voxel size for this operation.' }));
      cur._hint = () => {
        const min = 1.5 * num(vox.inp, 0.3);
        hint.classList.toggle('warn', num(th.inp) <= min);
        hint.textContent = `min wall ${(min).toFixed(2)} mm (1.5 × voxel)`;
      };
      cur._hint();
      return () => ({ part: part.get(), dir: seg.get(), thickness: num(th.inp, 2), voxel: num(vox.inp, 0.3) });
    },
    validate(v) {
      if (!v.part) return { ok: false, note: 'Pick a part', noteKind: 'err' };
      const min = 1.5 * v.voxel;
      if (v.thickness <= min) return { ok: false, note: `Thickness must exceed ${min.toFixed(2)} mm`, noteKind: 'warn' };
      return { ok: true, note: '' };
    },
    build(v) {
      return { op: 'shell', voxelSizeMM: v.voxel, shellDirection: v.dir,
        shellThicknessMM: v.thickness, inputs: [inputRef(v.part)] };
    },
  },

  // ── OFFSET ───────────────────────────────────────────────────────────
  offset: {
    title: 'OFFSET', jp: '膨張', confirm: 'CONFIRM', usesParts: true,
    render(host) {
      const part = pickerControl(ctx.listParts()[0]?.id, () => onChange());
      const dist = stepper({ value: 1, step: 0.1 });
      const vox = stepper({ value: round(ctx.voxelDefault()), min: 0.05, step: 0.05 });
      const hint = el('span', 'regmark tool-hint');
      host.append(
        paramBlock('Part', part.el, { tip: 'Source part.' }),
        paramBlock('Distance <em>signed mm</em>', dist.el,
          { tip: 'Grow (+) or shrink (−) the part surface. Small offsets erode fine detail.' }),
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
      return () => ({ part: part.get(), dist: num(dist.inp, 0), voxel: num(vox.inp, 0.3) });
    },
    validate(v) {
      if (!v.part) return { ok: false, note: 'Pick a part', noteKind: 'err' };
      const min = 1.5 * v.voxel;
      if (Math.abs(v.dist) <= min) return { ok: false, note: `|distance| must exceed ${min.toFixed(2)} mm`, noteKind: 'warn' };
      return { ok: true, note: '' };
    },
    build(v) {
      return { op: 'offset', voxelSizeMM: v.voxel, offsetDistMM: v.dist, inputs: [inputRef(v.part)] };
    },
  },

  // ── TRANSFORM (live preview; APPLY bakes) ────────────────────────────
  transform: {
    title: 'TRANSFORM', jp: '変換', confirm: 'APPLY', usesParts: true, live: true,
    render(host) {
      const parts = ctx.listParts();
      const startId = parts[0]?.id;
      const cur0 = ctx.getPartTrs(startId) || {};
      const t0 = cur0.translateMM || { x: 0, y: 0, z: 0 };
      const r0 = cur0.rotateDeg   || { x: 0, y: 0, z: 0 };
      const s0 = cur0.scale       || { x: 1, y: 1, z: 1 };
      const part = pickerControl(startId, (id) => { prefill(id); onLive(); });
      const tr = tripletStepper('Translate', 'mm', { x: t0.x, y: t0.y, z: t0.z }, 1,
        'Moves the part. Non-destructive — travels with the part into GENERATE.');
      const rot = tripletStepper('Rotate', 'deg', { x: r0.x, y: r0.y, z: r0.z }, 15,
        'Rotates the part about its origin (X then Y then Z).');
      const scl = tripletStepper('Scale', '×', { x: s0.x, y: s0.y, z: s0.z }, 0.05,
        'Per-axis scale factor (1 = original). Applied before rotation; travels with the part.');
      for (const ax of ['x', 'y', 'z']) { scl.inp[ax].min = '0.01'; }
      const center = el('button', 'btn tool-mini'); center.type = 'button'; center.textContent = 'CENTER';
      center.setAttribute('data-tip', 'Preset: translate the part bbox centre to the origin.');
      const actions = el('div', 'tool-actions'); actions.appendChild(center);
      host.append(paramBlock('Part', part.el, { tip: 'Source part.' }), tr.el, rot.el, scl.el,
        paramBlock('Preset', actions, { tip: 'One-tap placement presets.' }));

      const readScale = () => { const s = xyz(scl.inp); return { x: s.x || 1, y: s.y || 1, z: s.z || 1 }; };
      function readTrs() {
        return { translateMM: xyz(tr.inp), rotateDeg: xyz(rot.inp), scale: readScale() };
      }
      function prefill(id) {
        const t = ctx.getPartTrs(id) || {};
        const tt = t.translateMM || { x: 0, y: 0, z: 0 }, rr = t.rotateDeg || { x: 0, y: 0, z: 0 };
        const ss = t.scale || { x: 1, y: 1, z: 1 };
        tr.inp.x.value = tt.x; tr.inp.y.value = tt.y; tr.inp.z.value = tt.z;
        rot.inp.x.value = rr.x; rot.inp.y.value = rr.y; rot.inp.z.value = rr.z;
        scl.inp.x.value = ss.x ?? 1; scl.inp.y.value = ss.y ?? 1; scl.inp.z.value = ss.z ?? 1;
      }
      function onLive() {
        const id = part.get();
        if (id) ctx.setPartTransform(id, readTrs());
        onChange();   // refresh validity/accent
      }
      // live-preview on every translate/rotate/scale edit
      for (const g of [tr.inp, rot.inp, scl.inp]) for (const ax of ['x', 'y', 'z'])
        g[ax].addEventListener('input', onLive);
      center.addEventListener('click', () => {
        const id = part.get(); const bb = ctx.partBbox(id);
        if (!bb) return;
        tr.inp.x.value = round(-(bb.min[0] + bb.max[0]) / 2);
        tr.inp.y.value = round(-(bb.min[1] + bb.max[1]) / 2);
        tr.inp.z.value = round(-(bb.min[2] + bb.max[2]) / 2);
        onLive();
      });
      cur._live = onLive;
      return () => ({ part: part.get(), trs: readTrs() });
    },
    validate(v) {
      if (!v.part) return { ok: false, note: 'Pick a part', noteKind: 'err' };
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
    title: 'MIRROR', jp: '鏡像', confirm: 'CONFIRM', usesParts: true,
    render(host) {
      const part = pickerControl(ctx.listParts()[0]?.id, () => onChange());
      const seg = segControl(
        [{ val: 'xy', label: 'XY' }, { val: 'yz', label: 'YZ' }, { val: 'xz', label: 'XZ' }],
        'yz', () => onChange());
      const off = stepper({ value: 0, step: 1 });
      host.append(
        paramBlock('Part', part.el, { tip: 'Source part.' }),
        paramBlock('Plane', seg.el, { tip: 'Reflection plane (winding-corrected).' }),
        paramBlock('Plane offset <em>mm</em>', off.el,
          { tip: 'Distance of the mirror plane from the origin along its normal.' }),
      );
      return () => ({ part: part.get(), plane: seg.get(), offset: num(off.inp, 0) });
    },
    validate(v) {
      if (!v.part) return { ok: false, note: 'Pick a part', noteKind: 'err' };
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
  duplicate: {
    title: 'DUPLICATE', jp: '複製', confirm: 'DUPLICATE', usesParts: true,
    render(host) {
      const part = pickerControl(ctx.listParts()[0]?.id, () => onChange());
      host.append(paramBlock('Part', part.el, { tip: 'Part to copy (independent, instant).' }));
      return () => ({ part: part.get() });
    },
    validate(v) {
      if (!v.part) return { ok: false, note: 'Pick a part', noteKind: 'err' };
      return { ok: true, note: 'instant independent copy' };
    },
    build(v) { return { op: 'duplicate', inputs: [{ partId: v.part }] }; },
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

export function openTool(id) {
  const t = TOOLS[id];
  if (!t) return;
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
  els().secTool.classList.remove('hidden');
  // reflect toolbar active state
  syncToolbarActive(id);
  revalidate();
}

export function close() {
  if (!cur) return;
  cur = null;
  els().secTool.classList.add('hidden');
  syncToolbarActive(null);
  ui.setToolConfirmFilled(false);
  ctx.onStateChange();
}

export function toggle(id) { (cur && cur.id === id) ? close() : openTool(id); }
export function isOpen() { return !!cur; }
export function isValid() { return !!(cur && cur.valid); }

// re-render an open picker-tool after the parts set changes (preserve selections
// where the ids still exist; primitive/transform-in-flight are left untouched).
export function onPartsChanged() {
  if (cur && TOOLS[cur.id]?.usesParts && !cur.running) openTool(cur.id);
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
    // picker tools re-render (fresh part now selectable); transform re-prefills
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
