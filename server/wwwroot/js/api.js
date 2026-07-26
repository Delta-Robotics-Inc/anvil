//
// api.js — thin client for the Infill App /api surface (same origin, no CORS).
//
// Field names mirror the server DTOs (server/Jobs/JobModels.cs):
//   Part      : { id, name, sourceFormat, stlUrl, triangles, bbox:{min,max} }
//   JobStatus : { id, state, stage, progress, stats, step, warning, error }
//     state   : queued | running | done | failed | cancelled
//     step    : { state: none|running|done|failed, triangles, warning, error }
//

const BASE = '/api';

/** Pull the most useful human message out of an error response body. */
async function errorFrom(res) {
  let msg = `${res.status} ${res.statusText}`;
  try {
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('json')) {
      const body = await res.json();
      msg = body.error || body.detail || body.title || msg;
    } else {
      const text = await res.text();
      if (text) msg = text.slice(0, 300);
    }
  } catch { /* keep status line */ }
  const err = new Error(msg);
  err.status = res.status;
  return err;
}

/** Server / worker health. Returns { ok, workerExists, workerPath, python }. */
export async function health() {
  const res = await fetch(`${BASE}/health`);
  if (!res.ok) throw await errorFrom(res);
  return res.json();
}

/** Upload one .stl/.step/.stp file → Part record. Throws Error(message) on 4xx/5xx. */
export async function uploadPart(file) {
  const fd = new FormData();
  fd.append('file', file, file.name);
  const res = await fetch(`${BASE}/parts`, { method: 'POST', body: fd });
  if (!res.ok) throw await errorFrom(res);
  return res.json();
}

export async function deletePart(id) {
  const res = await fetch(`${BASE}/parts/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!res.ok && res.status !== 404) throw await errorFrom(res);
}

/** Create a generation job. Returns { jobId, warning }. Throws on the 400 resolution guard. */
export async function createJob(body) {
  const res = await fetch(`${BASE}/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await errorFrom(res);
  return res.json();
}

/** Poll a job. Returns the JobStatus DTO. */
export async function getJob(id) {
  const res = await fetch(`${BASE}/jobs/${encodeURIComponent(id)}`);
  if (!res.ok) throw await errorFrom(res);
  return res.json();
}

export async function cancelJob(id) {
  const res = await fetch(`${BASE}/jobs/${encodeURIComponent(id)}/cancel`, { method: 'POST' });
  if (!res.ok && res.status !== 404) throw await errorFrom(res);
}

// ── Wave-1 tool ops (POST /api/ops) ────────────────────────────────────
// Runs a tool op that produces a NEW derived part. Response shape depends on op:
//   duplicate → 200 with the PartInfo object DIRECTLY (id, derived, mass props…)
//   all others → 202 { jobId, partId, warning } — poll GET /jobs/{id} for .part
// Returns the parsed body verbatim; the caller branches on `.jobId` vs `.id`.
export async function runOp(body) {
  const res = await fetch(`${BASE}/ops`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await errorFrom(res);
  return res.json();
}

/** List every registered part (uploads + derived). Returns PartInfo[]. */
export async function listParts() {
  const res = await fetch(`${BASE}/parts`);
  if (!res.ok) throw await errorFrom(res);
  return res.json();
}

/** Kick off the faceted-STEP export (async; watch JobStatus.step for progress). */
export async function startStepExport(id, targetTriangles) {
  const res = await fetch(`${BASE}/jobs/${encodeURIComponent(id)}/step`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(targetTriangles ? { targetTriangles } : {}),
  });
  if (!res.ok) throw await errorFrom(res);
  return res.json().catch(() => ({}));
}

// ── Wave-3 unified export (POST /api/export) ───────────────────────────
// One call covers every combination: 1..N sources (parts and/or the generate
// result) × stl|step × separate-zip|combined. Always async — 202 {exportId},
// then poll getExport(id) until state === 'done' and pull exportFileUrl(id).
// Body: { sources:[{partId}|{jobId}], format, combined, name, transforms, targetTriangles }
export async function startExport(body) {
  const res = await fetch(`${BASE}/export`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await errorFrom(res);
  return res.json();
}
/** Poll an export. { id, state, note, error, fileName, format, combined, sources, triangles, warning } */
export async function getExport(id) {
  const res = await fetch(`${BASE}/export/${encodeURIComponent(id)}`);
  if (!res.ok) throw await errorFrom(res);
  return res.json();
}

// ── Part distance field (live preview clip) ────────────────────────────
// The GPU preview clips the TPMS field to the part's ACTUAL shape by sampling a
// baked signed-distance volume. The field is PART-LOCAL (untransformed mesh
// coords), so moving the part with the gizmo re-uses the same bake — the shader
// applies the part's TRS through an inverse matrix instead.
//
//   POST /api/parts/{id}/sdf        → 200 { ready:true }  (cached)
//                                   → 202 { jobId }       (poll getJob)
//   GET  /api/parts/{id}/sdf.json   → { nx, ny, nz, originMM:{x,y,z}, cellMM,
//                                       bandMM, encoding:'r8',
//                                       sign:'negative-inside', url }
//   GET  /api/parts/{id}/sdf.bin    → Uint8, x-fastest,
//                                     clamp(d/bandMM,-1,1)*127+128  (<128 inside)
//
// Both throw on any non-2xx, INCLUDING 404 — the preview treats that as "not
// served yet" and stays in bbox-clip fallback.
export async function requestPartSdf(id, resolution) {
  const res = await fetch(`${BASE}/parts/${encodeURIComponent(id)}/sdf`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(resolution ? { resolution } : {}),
  });
  if (!res.ok) throw await errorFrom(res);
  const body = await res.json().catch(() => ({}));
  return { ready: !!body.ready, jobId: body.jobId || null };
}

export async function getPartSdfMeta(id) {
  const res = await fetch(`${BASE}/parts/${encodeURIComponent(id)}/sdf.json`);
  if (!res.ok) throw await errorFrom(res);
  return res.json();
}

export const partSdfBinUrl = (id) => `${BASE}/parts/${encodeURIComponent(id)}/sdf.bin`;

// ── Stage-5 scripting (POST /api/scripts/run, GET /api/scripts) ────────
/** List library + user scripts. Returns [{id,name,source,savedUtc}]. */
export async function listScripts() {
  const res = await fetch(`${BASE}/scripts`);
  if (!res.ok) throw await errorFrom(res);
  return res.json();
}
/** Fetch one script's source by id. Returns { id, name, code, source }. */
export async function getScript(id) {
  const res = await fetch(`${BASE}/scripts/${encodeURIComponent(id)}`);
  if (!res.ok) throw await errorFrom(res);
  return res.json();
}
/** Run a script (compile + execute in a worker). Returns { jobId }. */
export async function runScript(body) {
  const res = await fetch(`${BASE}/scripts/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await errorFrom(res);
  return res.json();
}

// ── URL helpers (used directly by <a>/download links and the STL loader) ──
export const partMeshUrl = (id) => `${BASE}/parts/${encodeURIComponent(id)}/mesh.stl`;
export const previewUrl  = (id, download = false) =>
  `${BASE}/jobs/${encodeURIComponent(id)}/preview.stl${download ? '?download=1' : ''}`;
export const resultStepUrl = (id, download = false) =>
  `${BASE}/jobs/${encodeURIComponent(id)}/result.step${download ? '?download=1' : ''}`;
// The server sets the download filename (Content-Disposition) from the name the
// user typed — the anchor needs no `download` attribute value of its own.
export const exportFileUrl = (id) => `${BASE}/export/${encodeURIComponent(id)}/file`;
