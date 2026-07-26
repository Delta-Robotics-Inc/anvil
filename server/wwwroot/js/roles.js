//
// roles.js — single source of truth for role → accent colour + role grouping.
//
// Shared by the sidebar part rows (ui.js, as CSS hex) and the 3D ghost meshes
// (viewer.js, as a numeric hex). Keep these in sync with the sidebar accents in
// style.css (--role-*).
//
//   BASE roles decide the generate mode (single | fuse):
//     part      = --primary orange  (gyroidize the whole part)
//     positive  = --primary orange  (fuse: solid body — reads as "the part")
//     negative  = --green           (fuse: cavity to lattice — the green interior,
//                                    per Kev's preferred look; drawn AFTER the
//                                    positive so it stays visible inside it)
//
//   ZONE roles are Autodesk-GD-style region markers layered on a base part
//   (Wave-1 zoned lattice): blue = lattice-only, green = keep-solid,
//   white = void. (No red/amber anywhere in ANVIL — see style.css :root.)
//
export const ROLE_COLORS = {
  part:           '#ff5c00',  // --primary  oklch(0.6837 0.2120 40.5923)
  positive:       '#ff5c00',  // --primary — the body
  negative:       '#47c86e',  // --green   — the cavity interior
  'zone-lattice': '#4da3ff',  // blue  — lattice-only region
  'zone-keep':    '#47c86e',  // green — stay-solid region
  'zone-void':    '#e8e8e8',  // white — never-enter region (void = empty)
};

// Short labels for the per-row role select (grouped BASE / ZONES).
export const ROLE_LABELS = {
  part: 'Part', positive: 'Positive', negative: 'Negative',
  'zone-lattice': 'Zone · Lattice', 'zone-keep': 'Zone · Keep', 'zone-void': 'Zone · Void',
};

// Ordered role membership per group — drives the role-select optgroups and the
// base-vs-zone split in main.computeMode().
export const ROLE_GROUPS = {
  base: ['part', 'positive', 'negative'],
  zone: ['zone-lattice', 'zone-keep', 'zone-void'],
};

export const isBaseRole = (role) => ROLE_GROUPS.base.includes(role);
export const isZoneRole = (role) => ROLE_GROUPS.zone.includes(role);

/** CSS hex string for a role (falls back to Part orange). */
export const roleColorHex = (role) => ROLE_COLORS[role] || ROLE_COLORS.part;

/** Numeric 0xRRGGBB for three.js material.color (falls back to Part orange). */
export const roleColorInt = (role) => parseInt(roleColorHex(role).slice(1), 16);

/** Human label for a role (falls back to the raw key). */
export const roleLabel = (role) => ROLE_LABELS[role] || role;

// ── Per-part colour override (session state, no persistence) ──────────
// A part may carry its OWN colour, which wins over its role colour everywhere
// the role colour is used: the ghost mesh tint, the solid lattice tint, the row
// accent bar / selection rim, the row's colour dot and the export row dot. It
// SURVIVES a role change (only RESET clears it) — a user who coloured a part to
// tell it apart in a crowded scene does not want that undone by re-roling.
//
// TEN curated swatches, no gradient/rainbow picker anywhere: an eyedropper of
// arbitrary hues on a dark HUD produces mud, and the point of the feature is
// telling parts apart at a glance. The first four ARE the existing role palette
// (orange/green/blue/white already carry meaning), the rest are HUD-friendly
// mid-lightness hues chosen to stay distinct on --bg and against each other.
// Nothing red-adjacent: red is reserved (ANVIL house rule, view-cube triad aside).
export const PART_SWATCHES = Object.freeze([
  '#ff5c00',  // orange  — --primary / Part
  '#47c86e',  // green   — Negative / Keep
  '#4da3ff',  // blue    — Zone · Lattice
  '#5bc8e8',  // cyan    — gizmo Z
  '#b07cf7',  // violet
  '#f2c14e',  // gold
  '#e8e8e8',  // white   — Zone · Void
  '#9a9a9a',  // gray
  '#7ce7c0',  // mint
  '#e77cc0',  // pink
]);

/** #rrggbb, lower-cased, or null if `v` is not one. The single validator — the
 *  hex field, the undo command and the effective-colour resolver all use it. */
export function normalizeHex(v) {
  const s = String(v == null ? '' : v).trim();
  return /^#[0-9a-fA-F]{6}$/.test(s) ? s.toLowerCase() : null;
}

/** The colour a part actually draws in: its own override, else its role's. */
export const effectiveColorHex = (colorHex, role) => normalizeHex(colorHex) || roleColorHex(role);
