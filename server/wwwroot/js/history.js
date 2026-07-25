//
// history.js — Wave-4 UNDO / REDO command stack.
//
// A command is a plain object the caller builds with closures over whatever data
// it needs to move the app between two states:
//
//   { label, undo(), redo(), dispose?() }
//
//   undo/redo  — may be async (a part restore refetches its mesh); the stack
//                awaits them and blocks re-entrancy while one is in flight.
//   dispose()  — "this command is gone forever". Called when the entry is evicted
//                from either stack (depth cap / redo discarded by a new push) and
//                on clear(). The DELETE / CREATE commands use it to fire the
//                server-side part delete they deferred, so a part you might still
//                undo back into existence keeps its file on disk until the moment
//                undo can no longer reach it.
//
// Grouping: begin(label) … end(token) folds every push in between into ONE
// composite command. Used where a single user action mutates several things
// (BOOL creates a result AND consumes its sources; an upload creates a part AND
// flips the auto-roles) — one Ctrl+Z must take all of it back.
//
// Re-entrancy: push() is a no-op while an undo/redo runs, so a mutation performed
// BY undo/redo never records a command of its own.
//

const MAX_DEPTH = 50;

let undoStack = [];
let redoStack = [];
let busy = false;            // an undo/redo is in flight
let group = null;            // { token, label, cmds, depth } while a transaction is open
let tokenSeq = 0;
const listeners = new Set();

/** Best-effort error sink — main.js points this at ui.toast. Never console. */
let onError = null;
export function setErrorHandler(fn) { onError = fn; }

// ── state ─────────────────────────────────────────────────────────────
export function canUndo() { return !busy && undoStack.length > 0; }
export function canRedo() { return !busy && redoStack.length > 0; }
export function isBusy() { return busy; }
export function depth()  { return undoStack.length; }

/** The command Ctrl+Z would run next — for callers that COALESCE into it
 *  (the TRANSFORM panel folds a whole editing run into one entry). Returns the
 *  live object; mutate its captured state, then call touch(). Never returns a
 *  command from inside an open transaction it does not own. */
export function peekUndo() {
  if (busy) return null;
  if (group) return group.cmds.length ? group.cmds[group.cmds.length - 1] : null;
  return undoStack.length ? undoStack[undoStack.length - 1] : null;
}
/** A coalesced mutation still counts as a new action: drop the redo branch. */
export function touch() {
  if (busy) return;
  if (redoStack.length) { for (const c of redoStack) disposeCmd(c); redoStack = []; }
  emit();
}

function stateSnapshot() {
  return {
    canUndo: canUndo(),
    canRedo: canRedo(),
    undoLabel: undoStack.length ? (undoStack[undoStack.length - 1].label || '') : '',
    redoLabel: redoStack.length ? (redoStack[redoStack.length - 1].label || '') : '',
    depth: undoStack.length,
    redoDepth: redoStack.length,
    busy,
  };
}
function emit() {
  const s = stateSnapshot();
  for (const cb of listeners) { try { cb(s); } catch { /* a bad listener never breaks the stack */ } }
}
/** Subscribe to stack changes. Fires immediately with the current state. */
export function onChange(cb) {
  listeners.add(cb);
  try { cb(stateSnapshot()); } catch { /* ignore */ }
  return () => listeners.delete(cb);
}

function disposeCmd(cmd) { try { cmd?.dispose?.(); } catch { /* best effort */ } }

// ── grouping ──────────────────────────────────────────────────────────
/** Open a transaction. Returns a token to hand back to end(). Nesting joins. */
export function begin(label) {
  if (group) { group.depth++; return group.token; }
  group = { token: ++tokenSeq, label: label || '', cmds: [], depth: 1 };
  return group.token;
}
/** Close a transaction; pushes ONE command for everything collected. */
export function end(token) {
  if (!group || group.token !== token) return;
  if (--group.depth > 0) return;
  const g = group;
  group = null;
  if (g.cmds.length === 0) return;
  commit(g.cmds.length === 1 ? g.cmds[0] : composite(g.label, g.cmds));
}
function composite(label, cmds) {
  return {
    label: label || cmds[0].label || '',
    async undo() { for (let i = cmds.length - 1; i >= 0; i--) await cmds[i].undo(); },
    async redo() { for (const c of cmds) await c.redo(); },
    dispose() { for (const c of cmds) disposeCmd(c); },
  };
}

// ── push / undo / redo ────────────────────────────────────────────────
/** Record a command. No-op while undo/redo is running (re-entrancy guard). */
export function push(cmd) {
  if (busy || !cmd || typeof cmd.undo !== 'function' || typeof cmd.redo !== 'function') return;
  if (group) { group.cmds.push(cmd); return; }
  commit(cmd);
}

function commit(cmd) {
  // Any new action invalidates the redo branch — those commands can never be
  // reached again, so they release their deferred server work now.
  for (const c of redoStack) disposeCmd(c);
  redoStack = [];
  undoStack.push(cmd);
  while (undoStack.length > MAX_DEPTH) disposeCmd(undoStack.shift());
  emit();
}

export async function undo() {
  if (busy || undoStack.length === 0) return false;
  const cmd = undoStack.pop();
  busy = true;
  emit();
  let ok = true;
  try { await cmd.undo(); }
  catch (err) { ok = false; onError?.(`Undo failed: ${err?.message || err}`); }
  if (ok) redoStack.push(cmd); else undoStack.push(cmd);
  busy = false;
  emit();
  return ok;
}

export async function redo() {
  if (busy || redoStack.length === 0) return false;
  const cmd = redoStack.pop();
  busy = true;
  emit();
  let ok = true;
  try { await cmd.redo(); }
  catch (err) { ok = false; onError?.(`Redo failed: ${err?.message || err}`); }
  if (ok) undoStack.push(cmd); else redoStack.push(cmd);
  busy = false;
  emit();
  return ok;
}

/** Drop the whole history, disposing every entry (flushes deferred server work). */
export function clear() {
  const all = undoStack.concat(redoStack);
  undoStack = [];
  redoStack = [];
  group = null;
  for (const c of all) disposeCmd(c);
  emit();
}
