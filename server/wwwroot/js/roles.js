//
// roles.js — single source of truth for role → accent colour + role grouping.
//
// Shared by the sidebar part rows (ui.js, as CSS hex) and the 3D ghost meshes
// (viewer.js, as a numeric hex). Keep these in sync with the sidebar accents in
// style.css (--role-*).
//
//   BASE roles decide the generate mode (single | fuse):
//     part      = --primary orange  (gyroidize the whole part)
//     positive  = --green           (fuse: solid body)
//     negative  = --primary orange  (fuse: cavity to lattice)
//
//   ZONE roles are Autodesk-GD-style region markers layered on a base part
//   (Wave-1 zoned lattice): blue = lattice-only, green = keep-solid, red = void.
//
export const ROLE_COLORS = {
  part:           '#ff5c00',  // --primary  oklch(0.6837 0.2120 40.5923)
  positive:       '#47c86e',  // --green     oklch(0.74 0.17 150)
  negative:       '#ff5c00',  // --primary
  'zone-lattice': '#4da3ff',  // blue  — lattice-only region
  'zone-keep':    '#47c86e',  // green — stay-solid region
  'zone-void':    '#ff4747',  // red   — never-enter region
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
