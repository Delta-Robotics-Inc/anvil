//
// roles.js — single source of truth for role → accent colour.
//
// Shared by the sidebar part rows (ui.js, as CSS hex) and the 3D ghost meshes
// (viewer.js, as a numeric hex). Keep these in sync with the sidebar accents in
// style.css (--role-*): "part" is the HUD --primary orange (ghost parts read
// orange, never blue); positive stays --green, negative stays --primary orange.
//
export const ROLE_COLORS = {
  part:     '#ff5c00',  // --primary  oklch(0.6837 0.2120 40.5923)
  positive: '#47c86e',  // --green    oklch(0.74 0.17 150)
  negative: '#ff5c00',  // --primary  oklch(0.6837 0.2120 40.5923)
};

/** CSS hex string for a role (falls back to Part orange). */
export const roleColorHex = (role) => ROLE_COLORS[role] || ROLE_COLORS.part;

/** Numeric 0xRRGGBB for three.js material.color (falls back to Part orange). */
export const roleColorInt = (role) => parseInt(roleColorHex(role).slice(1), 16);
