# Roadmap: computational engineering (parked 2026-07-26)

The Forge scripting platform shipped with native beam lattices, Fillet, Area,
axis options, and seven examples that stand on the plate (regeneratively
cooled bell nozzle, two-domain TPMS counterflow heat exchanger, compliant
rover wheel, embossed card, manifold block, graded puck, smoke test). This
document parks the NEXT tier of capability so we can pick it back up later.

The full research behind this roadmap lives in
[research-leap71-computational-engineering.md](research-leap71-computational-engineering.md)
(LEAP71 repo architecture notes, the PicoGK capability audit, and the design
checklist). The LEAP71 reference repos are cloned locally under
`..\..\` (ShapeKernel, HelixHeatX, RoverWheel, QuasiCrystals, LatticeLibrary)
and vendored under the PicoGK fork's `vendor\` directory.

## Ranked next steps (from the research, in order of leverage)

1. **Sweep along a frame with a modulated profile.** ShapeKernel's core
   abstraction: an arc-length parameterized spine plus a per-point orthonormal
   triad, with the cross-section radius given by `f(phi, t)`. This one command
   unlocks ducts, volutes, blades, and organic transitions. Use double
   reflection parallel transport for the frames, not ShapeKernel's brute
   force angle search.
2. **Beam lattice structures from LEAP71_LatticeLibrary** (unit cells, conformal
   arrays, graded strut diameters) layered on the existing `Beams` primitive.
3. **Field-driven modulation.** Expose PicoGK `ScalarField` / `VectorField` so
   wall thickness, cell size, or strut diameter can vary with a field (stress
   proxy, distance from a face, imported data).
4. **Revolve about an arbitrary axis and 2D profile extrusion** (profile from
   points or an SVG path), completing the classic CAD trio next to Loft.
5. **Slicing outputs.** PicoGK `PolySlice` to SVG for slice previews and
   downstream toolpath experiments.
6. **Surface and ray queries** (closest point, ray intersection) for scripts
   that measure and self-validate their own geometry.
7. **Fillet variants** (concave radius control, blend between two bodies) and
   an `OverOffset` based cleanup pass.
8. **The interstitial vent for the heat exchanger example.** Deferred as a
   real design problem: the tell-tale port cannot route to the gyroid wall
   without crossing circuit B. Needs a thickened mid-height blocker and a
   third separation proof. Documented in `scripts-library/heat_exchanger.csx`.

## Also parked

- Simulation coupling (the curriculum's later chapters): pressure drop and
  thermal estimates against the two-domain HX, using the flow metrics
  machinery as the starting point.
- Role tinting for solid script parts (open UI question).
- A ShapeKernel-style object model for scripts (parts that build themselves
  and validate in their constructor) as a convention layer over Forge.

## How to resume

Read the research doc first. Each roadmap item above maps to a section there
with the PicoGK/math foundation, an implementation sketch, and an example
call. The examples in `scripts-library/` are the acceptance bar: a new
capability earns its place by making one of them better or enabling a new one
of the same quality.
