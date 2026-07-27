# LEAP 71 / PicoGK research → ANVIL Forge

Research for the ANVIL example rebuild. All five LEAP 71 repos cloned to `C:\Users\Kev\Desktop\Repos\` and read at source level; the local PicoGK fork (`C:\Users\Kev\Desktop\Repos\PicoGK`) read including the C++ runtime; the `picogk.org` curriculum walked (24 chapters).

---

## 0. Executive summary  -  the five things that matter

1. **The single most important architectural idea in ShapeKernel is the `Frames` + `Modulation` pair.** A shape is a *spine* (a polyline plus a per-point orthonormal frame) crossed with a *profile* whose radius is a function `f(phi, lengthRatio)`. Every BaseShape is `vecGetSurfacePoint(u, v, w)` over that space, meshed as quad strips. ANVIL has no equivalent  -  `Forge.Loft` is a 1-D radius-of-revolution only, and `Forge.Pipe` is a constant-radius polyline. This is Forge addition #2.
2. **ANVIL never touches `PicoGK.Lattice` / `RenderLattice`, and this is a hard blocker, not a nicety.** I read the C++ (`PicoGK/vendor/PicoGKRuntime/Source/PicoGKVdbVoxels.h`): `RenderImplicit` is a **dense single-threaded triple loop over the whole bbox with a managed P/Invoke callback per voxel**, while `RenderLattice` loops **per beam over that beam's own tight bbox in native code**. For the spiral-cooled nozzle this is a ~1000× difference: `Forge.Pipe` on 22 helices is hours, `Lattice.AddBeam` is seconds. Forge addition #1.
3. **The proven two-fluid recipe is "model the fluid volume, then derive the metal."** `LEAP71_HelixHeatX/src/HelixHeatX/HelixHeatX.cs:152-196` builds both fluid voids, pushes them apart by a wall thickness with `voxOffset`, then `voxOuterVolume - voxInnerVolume`. The curriculum states it as a rule (ch. 13/14): *"model the fluid volume, not the pipe"*, and subtract function **last** so later additions can never break it. Both new examples should be built this way.
4. **ANVIL can already do more than its examples show.** A script may declare its own `IImplicit` (see `scripts-library/graded_lattice_puck.csx:33`) and render it with `voxIntersectImplicit`. That alone unlocks the third example (spiral-rib compliant wheel) with **zero** API additions. The current examples under-sell the tool badly.
5. **Meshing, not field math, is the runtime ceiling.** A gyroid HX core at 0.3 mm makes 3-5 M triangles; `SavePart` → `new Mesh(vox)` → `MeshClean.Clean` → STL dominates every budget below. Every spec here states a triangle estimate and a recommended voxel size.

---

## 1. LEAP71_ShapeKernel  -  architecture map

Repo: `C:\Users\Kev\Desktop\Repos\LEAP71_ShapeKernel`

### 1.1 The four-layer stack (from `README.md`)

PicoGK (voxel kernel) → **ShapeKernel** (BaseShapes = the "atoms") → application layer (Computational Engineering Models) → the part. The README is explicit that a single heat exchanger is *"hundreds of such simple shapes … logically and spatially combined by Boolean() and Offset() operations."* That is the mental model ANVIL scripts should adopt: many small parameterised primitives, combined, not one clever primitive.

### 1.2 `LocalFrame`  -  `ShapeKernel/Frames/LocalFrame.cs`

A position plus a right-handed triad (`m_vecLocalX/Y/Z`), with `oTranslate`, `oRotate(dPhi, axis)` and static `oGetInvertFrame`. Local **Z is the sweep direction**; local X is the profile's "0°" reference. `vecGetLocalY = cross(localZ, localX)` (line 254). Implicit conversion to/from PicoGK 2's `Frame3d` (line 260)  -  i.e. LEAP 71 has since upstreamed this concept into PicoGK proper as `PicoGK.Shapes.Frame3d`.

### 1.3 `Frames`  -  `ShapeKernel/Frames/Frames.cs`  -  **the rail**

A *list* of frames sampled along a spine. Four constructors:

| Constructor | Use |
|---|---|
| `Frames(length, constFrame)` | straight extrusion of a fixed frame |
| `Frames(points, constFrame)` | sweep along a spline, orientation locked |
| `Frames(points, vecTargetX)` | tangent-following `localZ`, `localX` pulled toward a fixed world direction |
| `Frames(points, EFrameType)` | `CYLINDRICAL` / `SPHERICAL` / `Z` / `MIN_ROTATION` |

Mechanics worth stealing:
- `aGetTangentDirections()` (line 251)  -  central-difference tangents, with the first/last duplicated so the ends stay continuous.
- `SplineOperations.aGetReparametrizedSpline(points, spacing)`  -  **arc-length reparameterisation** before anything else. Everything downstream indexes by `fLengthRatio ∈ [0,1]` and interpolates (`vecGetSpineAlongLength`, `vecGetLocalXAlongLength`, …).
- `EFrameType.MIN_ROTATION` (line 185) is a rotation-minimising frame implemented by carrying `m_vecLastLocalX` forward. **Note the implementation is brute force**: `vecAlignWithTargetX` (line 208) sweeps 18,000 candidate angles in 0.01° steps per sample. Do not copy this  -  use double-reflection parallel transport (see §6.2).
- After building, `Frames` NURBS-smooths the points *and* the three axis lists (lines 136-139), which is what gives their sweeps C² continuity.

### 1.4 Modulations  -  `ShapeKernel/Modulations/`

- `LineModulation(1D).cs`  -  `f(ratio) → float`. Three sources: a constant, a `RatioFunc` delegate, or a **discrete point list with linear interpolation** (`oPointsDummyFunc`, line 151  -  binary search + lerp, with automatic clamping to `[0,1]`). Operator overloads `*`, `+`, `-` compose modulations lazily via the nested `ModulationAddition` / `ModulationMultiplication` helper classes (lines 209-285)  -  i.e. `2f * modA + modB` is itself a `LineModulation`.
- `SurfaceModulation(2D).cs`  -  `f(phi, lengthRatio) → float`. Sources: constant, `RatioFunc(phi, lengthRatio)`, **a promoted `LineModulation`** (choose which axis it applies to via `ELine.FIRST/SECOND`), or **an image** with a `MappingFunc(gray) → float` (line 95, sampled at line 136).
- `Distribution` / `GenericContour` (line 288, 305)  -  a modulation bundled with a physical length, so a normalised profile can be re-used at any scale.

This is the whole "parametric" story: **geometry parameters are functions, not numbers, and functions compose.**

### 1.5 BaseShapes  -  `ShapeKernel/BaseShapes/`

`BaseShape.cs` defines four interfaces:

```csharp
ISurfaceBaseShape : Vector3 vecGetSurfacePoint(float r1, float r2, float r3)
ISpineBaseShape   : Vector3 vecGetSpinePoint(float r1)
IMeshBaseShape    : Mesh    mshConstruct()
ILatticeBaseShape : Lattice latConstruct()
```

plus `SetTransformation(fnVertexTransformation)`  -  **a point-wise deformation applied to every generated vertex** (`m_fnTrafo(vecPt)` at `BasePipe.cs:317`). This is the conformal-design-space mechanism, used to enormous effect by RoverWheel.

`BasePipe.cs` is the canonical implementation and the one to port:

```csharp
public virtual Vector3 vecGetSurfacePoint(float fLengthRatio, float fPhiRatio, float fRadiusRatio)
{
    Vector3 vecSpinePos = m_aFrames.vecGetSpineAlongLength(fLengthRatio);
    Vector3 vecLocalX   = m_aFrames.vecGetLocalXAlongLength(fLengthRatio);
    Vector3 vecLocalY   = m_aFrames.vecGetLocalYAlongLength(fLengthRatio);
    float fPhi          = 2f*MathF.PI * fPhiRatio;
    float fOuterRadius  = m_oOuterRadiusModulation.fGetModulation(fPhi, fLengthRatio);
    float fInnerRadius  = m_oInnerRadiusModulation.fGetModulation(fPhi, fLengthRatio);
    float fRadius       = fRadiusRatio * (fOuterRadius - fInnerRadius) + fInnerRadius;
    Vector3 vecPt       = vecSpinePos + fRadius*MathF.Cos(fPhi)*vecLocalX
                                      + fRadius*MathF.Sin(fPhi)*vecLocalY;
    return m_fnTrafo(vecPt);
}
```

`mshConstruct()` then emits four quad-strip surfaces  -  top, bottom, inner mantle, outer mantle (lines 137-275)  -  with an explicit `bFlip` winding argument per surface. Resolution is three independent step counts (`SetLengthSteps` default **500**, `SetPolarSteps` 360, `SetRadialSteps` 5).

**A modulated, swept, hollow pipe is therefore: a spine → `Frames` → two `SurfaceModulation`s → one mesh → one `new Voxels(mesh)`.** No booleans, no implicit sampling, no per-voxel callbacks. That is why ShapeKernel is fast and why ANVIL's Loft/Subtract approach is not.

Others: `BaseBox`, `BaseCylinder`, `BaseCone`, `BaseSphere`, `BaseLens` (a bi-convex disc  -  the rover wheel envelope), `BaseRing`, `BasePipeSegment` (an angular sector of a pipe), `BaseRevolve` (`LineModulation` inner/outer radii about a spine, Z-axis only), `BaseLogoBox`, plus `LatticePipe` / `LatticeManifold` which implement `ILatticeBaseShape` and emit beams instead of a mesh.

### 1.6 Utilities worth porting wholesale

| File | Contents |
|---|---|
| `Utilities/VecOperations.cs` | `vecGetCylPoint(r, phi, z)`, `vecGetSphPoint`, `fGetRadius/fGetPhi/fGetTheta`, `vecRotateAroundAxis`, `vecGetOrthogonalDir`, `vecCylindricalInterpolation`, `vecSphericalInterpolation`, frame↔world conversions |
| `Utilities/SplineOperations.cs` | `aGetReparametrizedSpline` (by count **and** by spacing), `aGetNURBSpline`, `aGetSnappedSpline(points, voxTarget)`  -  **snaps a polyline onto a voxel surface**, exactly what "lay a cooling channel on the bell" needs |
| `Utilities/PolygonalShapes.cs` | `fGetPolygonRadius(phi, nSides)`  -  an n-gon as a radius modulation |
| `Utilities/SuperShapes.cs` | `fGetSuperShapeRadius(phi, m, n1, n2, n3)`  -  the superformula, as a radius modulation |
| `Utilities/UsefulFormulas.cs` | `fTransFixed` / `fTransSmooth` (smooth blends between two values), `aGetFibonacciCirlePoints`, `aGetFibonacciSpherePoints`, Gaussian/linear RNG |
| `Utilities/ImplicitUtility.cs` | `ImplicitGyroid`, `ImplicitSphere`, `ImplicitGenus`, `ImplicitSuperEllipsoid` |
| `Functions/ShLatticeFunctions.cs` | `latFromLine(points, beam)`, `latFromEdges`, `latFromGrid`, `latFromBeam(p1,p2,b1,b2,rounded)`  -  the thin, obvious wrapper over `PicoGK.Lattice` that Forge is missing |
| `Functions/ShVoxelFunctions.cs` | `vecGetClosestSurfacePoint(vox, pt)`, `vecGetProjectedSurfacePoint(vox, pt, dir)`  -  thin wrappers over PicoGK's unused ray/closest-point queries |

---

## 2. LEAP71_HelixHeatX  -  how two-fluid separation is actually built

Repo: `C:\Users\Kev\Desktop\Repos\LEAP71_HelixHeatX`. 100 × 100 × 100 mm interior, printed and tested. README calls it deliberately simple  -  *"most of the functions needed are contained in just one class"*.

### 2.1 The construction sequence (`src/HelixHeatX/HelixHeatX.cs:114-216`)

```
1  turning fins (hot) + turning fins (cool)            → voxAllCornerFins
2  straight fins (hot) + straight fins (cool)          → voxAllStraightFins
3  outer structural ribs                               → voxStructure
4  GetHelicalVoid(out void, out splitters, HOT)
5  GetHelicalVoid(out void, out splitters, COOL)
6  voxHotFluidVoid  -= voxCoolFluidVoid.voxOffset(wall)     ← THE SEPARATION
   voxCoolFluidVoid -= voxHotFluidVoid.voxOffset(wall)        (sequential, so it is guaranteed)
7  voxInnerVolume = hot + cool
   voxOuterVolume = voxInnerVolume.voxOffset(0.9)            ← the skin derives from the fluid
8  flange (+ Fillet(5) + Smoothen(0.5)), IO supports, centre piece
9  voxOuterVolume.ProjectZSlice(4, -4)                       ← printability: sweep the silhouette down
   voxOuterVolume -= voxGetPrintWeb()
10 voxResult = voxOuterVolume - voxInnerVolume               ← METAL = skin minus fluid
   voxResult += voxFins + voxSplitters
   voxResult &= m_voxBounding                                ← clip to the design envelope
11 voxResult += voxGetIOThreads(); voxResult -= voxGetIOCuts()
12 Sh.ExportVoxelsToSTLFile(...)
```

**Steps 6, 7 and 10 are the entire recipe and they transfer verbatim to Forge:**

```csharp
fluidA = Subtract(fluidA, Offset(fluidB, wallMM));
fluidB = Subtract(fluidB, Offset(fluidA, wallMM));
Shape metal = Subtract(Offset(Union(fluidA, fluidB), skinMM), Union(fluidA, fluidB));
```

Because the metal is *defined* as the complement of the fluid inside an offset skin, it is automatically watertight, automatically encloses both circuits, and cannot leak. Note `Fillet(5)` + `Smoothen(0.5)` used as a finishing pass on the flange only, not the whole part.

### 2.2 The helical void (`src/HelixHeatX/HelicalVoids.cs`)

Not a swept mesh  -  a **beam lattice**:

```csharp
uint nSamples = (uint)(fTotalLength / 0.005f);      // 20,000 samples over 100 mm
for (int i = 0; i < nSamples; i++) {
    float fPhi = fPhiStart + fSlope*(fZ - fStartZ);
    Vector3 vecPt1 = vecGetCylPoint(fInnerRadius, fPhi, fZ);
    Vector3 vecPt2 = vecGetCylPoint(fOuterRadius, fPhi, fZ);
    latVoid.AddBeam(vecPt1, fBeam, vecPt2, fBeam);      // radial rung
    latVoid.AddBeam(vecPt1, fBeam, vecPt1 + 3*UnitZ, 0.2f);  // tapered riser
    latVoid.AddBeam(vecPt2, fBeam, vecPt2 + 3*UnitZ, 0.2f);
}
Voxels voxHelicalVoid = new Voxels(latVoid);          // ~60,000 beams, ONE render
```

Two starts, phase-offset by π (`fPhiStart = MathF.PI` for HOT, `0` for COOL), so the two helices interleave without touching. `nTurns` is derived so plate + inter-plate thickness tile the length exactly. **The tapered-radius beams (`fBeam` → `0.2f`) are free**  -  `AddBeam` takes a radius per end.

**And those two extra risers are the printability trick, not decoration.** `AddBeam(vecPt1, fBeam, vecPt1 + 3f*UnitZ, 0.2f)` grows a 3 mm cone upward from every void cross-section, turning a round channel into a **teardrop** whose roof is self-supporting. This is the same round↔teardrop morphing LEAP 71 describes for manifold pipes and Hyperganic for aerospike channels (§5.2 tell #7), and in `Lattice` terms it costs one extra `AddBeam` per sample. Copy it verbatim into the nozzle spec (§8.1).

That 60,000-beam single render is the load-bearing perf fact. See §6.2.

---

## 3. LEAP71_RoverWheel  -  how a complex part is structured from parameters

Repo: `C:\Users\Kev\Desktop\Repos\LEAP71_RoverWheel`

### 3.1 Class structure

```
abstract RoverWheel                  ← static key dimensions + the coordinate transform
  ├ Wheel_01 … Wheel_04, RandomWheel ← concrete designs = a recipe of layers + elements
  ├ WheelLayer                       ← a struct: {startLengthRatio, endLengthRatio}
  ├ WheelTread + ITreadPattern       ← TreadPattern_01/02/03 are swappable strategies
  └ WheelElements                    ← abstract; SpiralStruts / TubeStruts / RectHoles
                                        / RosettaStruts / EgyptianStruts
```

`Wheel_01.voxConstruct()` (`RoverWheel/Wheels/Wheel_01.cs:91-124`) is literally a **recipe table**:

```csharp
WheelLayer sLayer_01 = new WheelLayer(this, 0.05f, 0.20f);   // radial band, as a ratio
...
WheelElements oElements_01 = new SpiralStruts (sLayer_01, 16, 2.5f);   // (layer, symmetry, wall)
WheelElements oElements_02 = new RectHoles    (sLayer_02, 20, 4);
WheelElements oElements_03 = new TubeStruts   (sLayer_03, 36, 2);
WheelElements oElements_04 = new TubeStruts   (sLayer_04, 72, 1);
WheelElements oElements_05 = new RosettaStruts(sLayer_05, 60, 2);
voxWheel = voxGetLayer(0f, 0.05f) + struts01 + … + struts05 + voxTread;
```

**Design language to steal for the third ANVIL example: concentric radial bands, each with its own symmetry count and wall thickness, each a different element type.** Symmetry rises and thickness falls as you move outward  -  that single rule is what makes it read as engineered rather than decorative.

### 3.2 The conformal trick (`RoverWheel/RoverWheel.cs:99-112`, `WheelElements/SpiralStruts.cs`)

Everything is authored in a **simple cylindrical design space** and then bent into the curved wheel by a point-wise transform:

```csharp
oLayer.SetTransformation(vecGetWheelLayerTrafo);   // BaseShape applies it per vertex
...
public static Vector3 vecGetWheelLayerTrafo(Vector3 vecPt) {
    float fRadius = fGetRadius(vecPt); float fPhi = fGetPhi(vecPt);
    float fHeightRatio = vecPt.Z / m_fRefWidth;
    float fLengthRatio = (fRadius - m_fHubRadius) / (m_fOuterRadius - m_fHubRadius);
    Vector3 vecNewPt = vecGetInnerPt(fHeightRatio, fLengthRatio);   // bilinear blend of 4 rails
    return vecRotateAroundZ(vecNewPt, fPhi);
}
```

And in `SpiralStruts.voxConstruct()` the sequence is:

```csharp
aVoxelList.Add(new Voxels(Sh.latFromLine(aPoints, 0.5f*m_fWallThickness)));  // NURBS spiral → beams
Voxels oVoxels = Voxels.voxCombineAll(aVoxelList);
oVoxels.ProjectZSlice(aZList[0], aZList[^1]);                     // ← extrude the rod into a WALL
Mesh oMesh = new Mesh(oVoxels);
Voxels voxStruts = new Voxels(MeshUtility.mshApplyTransformation(oMesh, vecGetWheelLayerTrafo));
```

Two PicoGK capabilities ANVIL does not expose show up here and both are high value:
- **`ProjectZSlice(z0, z1)`** turns a thin planar lattice into a full-width wall for free (silhouette sweep).
- **point-wise mesh deformation** (`mshApplyTransformation`)  -  arbitrary warping of a finished solid. Forge only has rigid `Matrix4x4`.

Also note `m_nSymmetry = Math.Max(m_nSymmetry, (uint)(2π·rMid / range))`  -  the symmetry count is **auto-raised so the elements stay roughly square in the band**. That is the kind of derived parameter that makes generated parts look designed.

---

## 4. LEAP71_LatticeLibrary and LEAP71_QuasiCrystals

### 4.1 LatticeLibrary  -  two halves

**Beam half** (`LatticeLibrary/`): `ICellArray` (`RegularCellArray`, `ConformalCellArray`) × `IUnitCell` (`CuboidCell`) × `ILatticeType` (`BodyCentreLattice`, `OctahedronLattice`, `RandomSplineLattice`) × `IBeamThickness` (`ConstantBeamThickness`, `CellBasedBeamThickness`, `GlobalFuncBeamThickness`, `BoundaryBeamThickness`). `ConformalCellArray` takes a `BaseBox` / `BaseLens` / `BasePipeSegment` and subdivides its **parametric** space into 8-corner cells (`ConformalCellArray.cs:44-80`), so the lattice conforms to a curved envelope instead of being clipped by it. Everything ends as `Lattice.AddBeam` calls.

`BoundaryBeamThickness` / `GlobalFuncBeamThickness` are the field-driven-thickness idea: beam radius is `f(position)`, which is how you'd drive a lattice from an FEA stress field.

**Implicit half** (`ImplicitLibrary/`): `RawTPMSPatterns.cs` + presets, and two pieces that matter directly:

- **`SplittingLogic.cs`**  -  six `ISplittingLogic` implementations that convert a raw TPMS value `f` into different solids. This is exactly the two-fluid TPMS separation, in closed form:

  | Logic | Returns | Meaning |
  |---|---|---|
  | `FullWallLogic` | `abs(f) - w/2` | the sheet (the separating wall) |
  | `FullVoidLogic` | `-(abs(f) - w/2)` | everything except the sheet |
  | `PositiveHalfWallLogic` | `max(f, abs(f) - w/2)` | the sheet **plus** the `f>0` side |
  | `NegativeHalfWallLogic` | `max(-f, abs(f) - w/2)` | the sheet plus the `f<0` side |
  | `PositiveVoidLogic` | `-(max(0, f) - w/2)` | the `f>0` **channel** only |
  | `NegativeVoidLogic` | `-(max(0,-f) - w/2)` | the `f<0` **channel** only |

  `PositiveVoidLogic` and `NegativeVoidLogic` are the two never-touching fluid domains, guaranteed separated by `w`. See `ImplicitSplitVoidGyroid.cs` / `ImplicitSplitWallGyroid.cs` for the concrete gyroid instantiations.

- **`CoordinateTrafo.cs`**  -  `ICoordinateTrafo` with `ScaleTrafo` (per-axis cell size), `FunctionalScaleTrafo` (cell size as a function of position  -  **graded lattices**), `RadialTrafo` (evaluate the pattern in cylindrical coordinates with an optional twist `dPhiPerZ`  -  **a gyroid that wraps a cylinder**), and `CombinedTrafo`. ANVIL's `TPMSWall` supports rigid rotation + phase + per-axis cell, but **not** a functional (graded) or a cylindrical transform.

### 4.2 QuasiCrystals

`QuasiCrystal/QuasiCrystal.cs` implements **inflation-based aperiodic tiling**: start from `IcosehedralFace`s, repeatedly inflate each face into sub-tiles (`QuasiTileInflation.aGetInflatedFace`), dedupe by rounded centre (`aGetDeduplicatedSubTiles`), `nGenerations` deep. `QuasiTile_01..04` are the four prototiles; `RhombicTile` / `RobinsonTriangle` do the 2-D Penrose case. Output is a set of tiles whose edges become beams.

Engineering rationale from the README: no translational symmetry → no distinct resonance; they applied a multi-layer Penrose pattern to a hypersonic airframe panel. Visually striking, but it is a *pattern generator*, not a part  -  as a third ANVIL example it would read as art. **Not recommended** (see §8.3 for the pick and §8.4 for the runner-up).

---

## 5. Web context  -  what LEAP 71 and Hyperganic actually ship, and why it reads as engineering

Sources: `leap71.com/gallery/` (images CC BY-SA 4.0), `leap71.com/downloads/` (free print-ready STLs, 0.5-2.2 GB each  -  you can load their actual geometry as reference), `leap71.com/tech/`, `/rp/`, `/noyron/`, `hyperganic.com/solutions/` and `/press-and-stories/`.

### 5.1 The part catalogue

| Class | Distinguishing geometry |
|---|---|
| **Bell thrust chambers** (TKL-5 5 kN CuCrZr; TKL-200 200 kN AlSi10Mg, >1.3 m) | Coaxial-swirl injector head; **helical cooling channels wrapping the whole jacket with variable cross-section, walls as thin as 0.8 mm**; film-cooling holes; **chamber wall thickness varied along the axis** to trade conductivity against pressure containment; the whole motor is **2 parts**. |
| **Aerospikes** (AKL-5, 210 mm, 6.9 kg CuCrZr; XRA-2E5, 1 m, 120 kg IN718) | Toroidal chamber wrapped around a central spike; **dual-circuit regen  -  LOX cools the spike from inside, fuel cools the outer shroud**; very shallow unsupported overhang at the throat with the cooling channels forced to route along it; ring of distributed plasma igniters fused in; monolithic, post-machining = thread cutting only. |
| **Injector heads** (XRB-2E6, **Ø600 mm**) | Dense face array of coaxial swirl elements; **swirler and pipe cross-section scale with mixture ratio**; **a third fluid volume  -  a nitrogen purge layer  -  sandwiched between fuel and oxidiser so a wall crack cannot mix them.** |
| **Liquid-liquid heat exchangers** (**Ø200 × 300 mm** reference) | Central inlet pipe at the bottom → **splits into many small pipes** → central outlet at top; coolant enters an **upper volute**, descends around the pipes, exits a **lower volute**; **a centreline spiral holds the small pipes in place and lengthens the coolant path**; the small pipes themselves carry a swirl; **hexagonal volutes auto-generate their own thin support struts**. Modules named: volutes, internal piping, outer walls, flanges, cooling ribs. |
| **Hypersonic precooler** (1.5 m) | "Fractal folding algorithm to maximise surface area without compromising aerodynamic flow"; intertwined air / LH2 domains. |
| **Manifolds** | Published algorithm: bounding box → 10-25 random inlet/outlet pairs → straight connections → **differential-growth repulsion to a target gap** → **each pipe grows its own support struts, landing on nearby pipes when within a radius** → **each pipe morphs round↔teardrop with local overhang angle** → offset + smoothen − inner volumes. 25 manifolds in 10 minutes. |
| **Impellers / turbopumps, electric motors (bi-metal Cu+steel stators), Tesla valves, Penrose hypersonic panels** | See §4.2 for the Penrose panel; note its interior is aperiodic but **the edge frames are deliberately re-gridded to a repetitive screw spacing**. |
| **Hyperganic** | Fractal-branching HX with **phyllotaxis-placed branch inlets and constant total cross-sectional area at every branching generation** (14× the surface area of a plain tube); AC condenser with graded lamellae **plus a purpose-built internal channel for compressed-air depowdering**; stress-graded lattice bracket (58.9 g → 24.1 g, beams 0.9-10 mm, ≤220 MPa); aerospike whose **channel cross-sections morph round↔rhombic with local build angle**, zero supports. |

### 5.2 The eleven tells  -  what separates a real part from a demo blob

Every one of these is cheap to add and each is worth more than another primitive:

1. **Named subsystems, visible.** Their copy always enumerates: *chamber, cooling features, manifolds, injector, ignition, structure*. A blob has one feature; a part has 6-10 you can point at.
2. **Legible fluid topology.** A viewer must be able to trace inlet → distribution → working section → collection → outlet. If they cannot answer "where does it go in and out", it is a blob.
3. **Many-into-few manifolding.** The 1→many→1 branching signature is the single most recognisable computational-engineering visual. Hyperganic's rule  -  **hold total cross-sectional area constant across each branching generation**  -  is what makes branching look computed rather than drawn.
4. **Period-regular interfaces bounding organic interiors.** Flanges, bolt circles, port bosses, always. The Penrose panel is the lesson: aperiodic inside, **regular screw spacing on the frame**. This is the strongest available "this is hardware" signal.
5. **Wall thickness that varies for a stated reason.** 0.8 mm channel walls; chamber wall graded along the axis; lattice beams 0.9-10 mm under a stress cap. Varying-with-a-reason beats uniform offset.
6. **Supports that are structural.** Their words: *"the supports become an integral part of the design as they not only ensure printability but are also intended to take some of the loads."* Struts land on neighbouring pipes, not the plate.
7. **Print-orientation literacy in the section shape.** The most transferable trick in the corpus: **circular cross-sections morph continuously into teardrop (or rhombic) as the local overhang gets shallow.** ShapeKernel makes this a first-class primitive  -  `LatticeManifold` takes an explicit overhang angle. HelixHeatX does it with tapered riser beams (§2.2).
8. **Standing, single-axis, monolithic.** 210 mm / 1 m / 1.3 m / 1.5 m, all upright, one piece, "no sealing or assembly required". Nothing floats or spans horizontally.
9. **Smooth C² contours from spline-driven frames**  -  the §1.3/§1.5 machinery, which is why their pipes flow rather than segment.
10. **Arrays that repeat *with a gradient*.** Injector elements individually tuned to their distance from the wall; fins graded to airflow. Identical repetition reads as texture; graded repetition reads as engineering.
11. **Post-processing realism.** Depowdering access channels, CNC clamping rings that exist only as fixturing, thread bosses. The hardest thing to fake and the most convincing.

Plus one presentation rule: **they always show a family, not a hero shot**  -  three aerospikes at 5 / 20 / 200 kN "sharing the same Noyron DNA". A parameter sweep implies a model behind the object. Every ANVIL example should ship with a table of 3 named variants.

### 5.3 Numbers worth using as anchors

Chamber pressure **50 bar** (20 kN methalox) to **100 bar** (TKL-200) · minimum cooling-channel wall **0.8 mm** · chamber gas 3000 °C bell / 3500 °C aerospike, outer surface target <250 °C · HX envelope **Ø200 × 300 mm** · injector head Ø600 mm at 2 MN · aerospike 210 mm / 6.9 kg in CuCrZr, 1 m / 120 kg in IN718 · layer height 60 µm in AlSi10Mg *chosen specifically to control cooling-channel wall roughness*, adaptive 60-90 µm in CuCrZr · materials **CuCrZr** (≤20 kN), **AlSi10Mg** (lightweight large), **IN718** (large/high-temp), Ti (corrosive fluids) · manifold generator 10-25 port pairs · Hyperganic lattice beams 0.9-10 mm at ≤220 MPa.

### 5.4 Stack, confirmed

PicoGK (Apache 2.0; C++ `PicoGKRuntime` over **OpenVDB** + GLFW viewer, C# API) → **ShapeKernel** → **Noyron**, a proprietary "Large Computational Engineering Model" (Josefine Lissner) that is deterministic and first-principles: propellant types + target thrust + chamber pressure in, manufacturable geometry out, ~30 min per full engine iteration, <3 weeks spec-to-hot-fire. Hyperganic Core is the closed ancestor; **HyDesign** is its browser no-code layer and is the closest thing to a competitor for ANVIL  -  TPMS infills with Cartesian/cylindrical/spherical periodicity, gyroid↔Schwarz-P blending, **bitmap-driven lattice thickness modulation**, shell/offset/emboss/skin, and a beta meshless linear-elastic solver.

*(Two corrections to avoid repeating: the Astrolab/Venturi lunar rover wheel is Venturi Space's, not Hyperganic's; and there is no Hyperganic MRI/RF coil or cranial implant in any source.)*

---

## 6. ANVIL gap analysis

Files read: `anvil/worker/{Forge.cs, ForgeSdf.cs, TPMSWall.cs, GyroidJob.cs, OpJob.cs, SdfJob.cs, ScriptJob.cs, MeshUtil.cs, MeshClean.cs, FlowMetrics.cs}`, `anvil/docs/scripting.md`, `anvil/scripts-library/*.csx`. PicoGK surface from `PicoGK/src/*.cs` and `PicoGK/vendor/PicoGKRuntime/Source/*.h`.

### 6.1 PicoGK public surface: used vs unused

**Used by ANVIL today**

`Library(voxelSizeMM)` · `new Voxels()` / `Voxels(Voxels)` / `Voxels(Mesh)` / `Voxels(IImplicit, BBox3)` · `voxDuplicate` · `BoolAdd`/`BoolSubtract`/`BoolIntersect` and `voxBoolAdd`/`voxBoolSubtract`/`voxBoolIntersect` · `Offset` / `voxOffset` · `voxTripleOffset` · `voxFillet` · `IntersectImplicit` / `voxIntersectImplicit` · `CalculateProperties` · `GetVoxelDimensions` · `GetVoxelSlice` + `ESliceMode.BlackWhite` (FlowMetrics.cs:316, SdfJob.cs:258 only  -  **not reachable from a script**) · `new Mesh(Voxels)` · `Mesh.mshFromStlFile` / `SaveToStlFile` + `EStlUnit` · `mshCreateTransformed(Matrix4x4)` · `oBoundingBox` · `nAddTriangle` / `nTriangleCount` / `nVertexCount` / `vecVertexAt` · `BBox3` · `IImplicit`.

**Never referenced anywhere in the worker** (verified by grep, count = 0):

| API | Why it matters |
|---|---|
| **`PicoGK.Lattice`, `AddBeam`, `AddSphere`, `new Voxels(Lattice)`, `RenderLattice`** | **THE gap.** Batch beam/strut geometry with per-end radii, rendered per-beam in native code. Everything LEAP 71 does with struts, spirals, pipes, drill bits and "painting" goes through this. |
| `ProjectZSlice` / `voxProjectZSlice` | Directional silhouette sweep  -  extrude a slice through a range, build a solid base under floating geometry, guarantee draft/removability. RoverWheel and HelixHeatX both use it. No CSG equivalent. |
| `OverOffset` / `voxOverOffset` | Morphological open/close with two different distances  -  **deletes every feature below a size threshold** while preserving larger ones. Curriculum ch. 12 uses it for de-featuring. |
| `voxDoubleOffset` | Offset out then in by *different* amounts. |
| `voxShell(f)` and `voxShell(neg, pos)` | Native shell; Forge re-implements this with two offsets and a subtract. |
| `Smoothen` / `voxSmoothen` | Level-set smoothing, distinct from `voxTripleOffset`. |
| `Gaussian(mm)`, `Median(mm)`, `Mean(mm)` | Field filters  -  noise removal / organic softening. |
| `Trim(BBox3)` | Cheap clip to a box without building a box solid + boolean. |
| `voxCombine`, `voxCombineAll`, `BoolAddAll`, `BoolSubtractAll`, `voxBoolAddAll` | **N-ary booleans in one native call.** Forge's `Union(params Shape[])` does an N-1 managed loop instead. |
| `Voxels.voxSphere(centre, r)` | Free sphere without a mesh round trip. |
| `IBoundedImplicit` | An implicit that carries its own `oBounds`, so `new Voxels(impl)` needs no box. Forge computes boxes by hand in every builder. |
| `vecSurfaceNormal`, `bClosestPointOnSurface`, `vecClosestPointOnSurface`, `bRayCastToSurface`, `vecRayCastToSurface` | **Surface queries.** These are how you snap a channel path onto a lofted bell, or place a boss normal to a curved face. ShapeKernel wraps them as `Sh.vecGetClosestSurfacePoint` / `vecGetProjectedSurfacePoint` and `SplineOperations.aGetSnappedSpline`. |
| `ScalarField` (incl. `Voxels(ScalarField)`, `SetValue/bGetValue`, `TraverseActive`, `ITraverseScalarField`, `fSignedDistance`  -  **`ScalarField` implements `IImplicit`**) | A sparse, sampled scalar field you can write into and then render or use as a modulation source. The natural home for an FEA/CFD result driving thickness. |
| `VectorField` (+ `ITraverseVectorField`) | Sparse vector field  -  flow directions, principal stress directions. |
| `PolySlice`, `PolyContour`, `PolySliceStack`, `PolySlice.oFromSdf`, `SaveToSvgFile`, `AsSvgPath` | 2-D contour extraction and **SVG export**  -  cross-sections, drawings, laser-cut flats. |
| `nSliceCount`, `vecZSliceOrigin`, `GetInterpolatedVoxelSlice` | Slice stack access (partially used internally, not exposed). |
| `voxFromVdbFile` / `SaveToVdbFile` | **OpenVDB round trip**  -  the only lossless way to persist a voxel field between jobs. Everything currently round-trips through STL. |
| `PicoGK.Image`, `ImageGrayScale`, `TgaIo` | PicoGK's own image type (Forge rolls its own `ForgeImage` via System.Drawing). `SurfaceModulation(Image, MappingFunc)` needs it. |
| `PolyLine`, `Viewer`, `Animation`, `Easing`, `Csv`, `FieldMetadata`, `bIsEqual` | Preview/telemetry/persistence surface. |
| `Mesh.mshCreateMirrored`, `AddQuad`, `AddVertices`, `Append` | Direct mesh authorship  -  the mechanism behind every ShapeKernel BaseShape. Forge never builds a mesh from parameters except via `MeshUtil.Create*`. |

**Also missing at the Forge level even though the plumbing exists:**
- `Forge.Fillet(shape, r)`  -  `voxFillet` is used *inside* `SmoothUnion` but is not a command. There is no concave-only fillet available to a script (`Smooth` = `voxTripleOffset` rounds convex edges too and eats thin ribs).
- `Forge.Area(shape)`  -  `MeshUtil.MeshMassProps` already computes surface area for the manifest; scripts can only get `Volume`. Heat-exchanger and lattice scripts cannot report their headline number.
- `Forge.SmoothSubtract` / `SmoothIntersect`  -  only `SmoothUnion` exists.
- Anything from `FlowMetrics.cs` (porosity, hydraulic diameter, choke area, permeability, Δp). It is wired to `GyroidJob` only.
- **Multi-part output is supported** (`SavePart` is index-keyed) but no example uses it. The HX spec below does.

### 6.2 The performance finding  -  read this before writing the nozzle

From `PicoGK/vendor/PicoGKRuntime/Source/PicoGKVdbVoxels.h`:

```cpp
// line 256  -  RenderImplicit
for (x = min.X - iAdd; x <= max.X + iAdd; x++)
for (y = ...) for (z = ...) {
    float fValue = std::min(oVoxelSize.fToVoxels((*pfn)(&vecSample)), oAccess.getValue(xyz));
    SetSdValue(...);
}
```
→ **dense, single-threaded, over the entire bbox, with one managed callback (`pfn`) per voxel.**

```cpp
// line 239  -  RenderLattice
for (auto roBeam : oLattice.oBeams())
    DoRenderLattice(&oAccess, fBackground(), *roBeam, fVoxelSizeMM);
// DoRenderLattice (line 634) loops over roBeam->oBBox() ONLY, in native code.
```
→ **per-beam, over that beam's own tight bbox, entirely in C++.**

Concretely for the v2 nozzle (22 helical channels, ~230 beams each, exit Ø90):

| Route | Work | Wall clock |
|---|---|---|
| `Forge.Pipe` (`SdPolyPipe`, one implicit, min over N segments per voxel) | 54 M voxels × 230 segments × 22 renders ≈ **2.7 × 10¹¹** managed calls | hours  -  infeasible |
| `Forge.Pipe` chunked into 20 short arcs per helix | 440 renders × ~0.35 M voxels × 21 segments ≈ 3 × 10⁹ + 440 booleans | 3-6 min  -  painful but possible |
| `Lattice.AddBeam` × 5060 + one `new Voxels(lat)` | 5060 beams × ~13.8 k voxels ≈ **7 × 10⁷** native ops | **~5-8 s** |

Secondary consequences of the same code:
- `Forge`'s `Pad()` (`Forge.cs:840`) grows every render box by `max(4·voxel, 0.5)` on all six faces. For a large `Loft` that is a few percent; for many small implicits it is not free. Prefer `IBoundedImplicit` and tight boxes.
- `SdPolyPipe.fSignedDistance` (`ForgeSdf.cs:254`) is an **unaccelerated linear scan over every segment**. It is fine for ≤ ~20 points and quadratically bad beyond that. This should be documented in `scripting.md` as a hard limit, and `Pipe` should internally switch to `Lattice` above a segment threshold.
- Everything is single-threaded. Budget accordingly; there is no "it'll use all cores".

### 6.3 Verdict: is ANVIL capable of computational/algorithmic engineering?

**Yes, and more than its examples suggest  -  but with three real ceilings.**

Already there: parameters in / part out; arbitrary C# in a script including user-defined classes; user-defined `IImplicit` fields rendered with `voxIntersectImplicit`; robust unlimited booleans; SDF offsets, shells, triple-offset and fillet-union; TPMS with per-axis cell, rotation and phase; multi-part output; a real error channel. That covers curriculum chapters 8-12 and 19 outright.

The three ceilings:
1. **No batch beam primitive.** Anything strut-, spiral-, or pipe-network-shaped hits the `RenderImplicit` wall. This blocks a whole class of LEAP-71-style parts.
2. **No swept/modulated profile.** `Loft(r(y))` is a surface of revolution; there is no way to sweep a varying profile along a curve, which is the primitive ShapeKernel is *built around*. Everything non-axisymmetric has to be faked with booleans.
3. **No surface queries and no field I/O.** You cannot ask "where is the surface" (`vecClosestPointOnSurface`, `vecRayCastToSurface`), cannot persist a field (`SaveToVdbFile`), and cannot drive geometry from sampled data (`ScalarField`). That is the difference between a scripting toy and a CEM platform.

One more, softer: **there is no place for engineering intent to live.** The curriculum's central rule (ch. 10) is *"whenever you are tempted to encapsulate a process in a class, you are probably doing something wrong"*  -  name the noun, validate in the constructor, build in the constructor. A `.csx` that runs top-to-bottom encourages the opposite. Worth considering a convention (or a `scripts-library/` template) where a script declares one `sealed class Nozzle { public Nozzle(...) { validate; build; } public Shape Part { get; } }` and ends with three lines. All three specs below are written that way.

---

## 7. Ranked Forge additions

Ranked by (unlocked capability) / (implementation cost). #1 and #2 are prerequisites for the specs in §7; #6 is a 3-line change also needed by §8.3.

### #1  -  `Beams` : batch beam/strut lattice  ★ required by §8.1 and §8.3

- **What.** Build a solid from an arbitrary set of round-capped, per-end-tapered beams and spheres in one render.
- **Foundation.** `PicoGK.Lattice.AddBeam(a, rA, b, rB, roundCap)` / `AddSphere`, then `new Voxels(lat)` → `RenderLattice`. Native, per-beam tight bbox (§6.2).
- **Implementation sketch.** ~40 lines in `Forge.cs`. No new SDF. Mirror `ShapeKernel/Functions/ShLatticeFunctions.cs`:
  ```csharp
  public static Shape Beams(IEnumerable<Vec3> path, double d, double? dEnd = null)   // chained polyline, optional taper
  public static Shape Beams(IEnumerable<(Vec3 a, Vec3 b, double dA, double dB)> beams)
  public static Shape Spheres(IEnumerable<Vec3> pts, double d)
  // body: var lat = new PicoGK.Lattice(); foreach(...) lat.AddBeam(a, (float)dA*0.5f, b, (float)dB*0.5f, true);
  //       return new Shape(new Voxels(lat));
  ```
  Also: make `Forge.Pipe` delegate to `Beams` when `path.Count > 16`, keeping `SdPolyPipe` only for short runs (it gives an exact field for a handful of segments). Document the switch.
- **Example.** `Shape channels = Beams(helixPts, d: 3.0);`  -  5000 beams, one render, seconds.

### #2  -  `Sweep` : profile swept along a frame-carrying spine  ★ required by §8.3 (and the general unlock)

- **What.** The ShapeKernel `BasePipe` concept: sweep a closed 2-D profile along a 3-D spine, with the profile radius modulated by `(phi, t)` and inner/outer radii for a hollow sweep. This is *the* missing primitive.
- **Foundation.** Arc-length reparameterised spine + a rotation-minimising frame; emit quad strips; `new Voxels(mesh)`. Pure mesh construction  -  **no per-voxel callbacks at all**, so it is fast at any complexity. Port `BasePipe.vecGetSurfacePoint` (§1.5) verbatim; port `Frames` but **replace the 18,000-step angle search** at `Frames.cs:215` with double-reflection parallel transport:
  ```
  given frame (t_i, x_i) at p_i and tangent t_{i+1}:
    v1 = p_{i+1} - p_i;  c1 = v1·v1
    tL = t_i - (2/c1)(v1·t_i) v1 ;  xL = x_i - (2/c1)(v1·x_i) v1
    v2 = t_{i+1} - tL  ;  c2 = v2·v2
    t_{i+1} = tL - (2/c2)(v2·tL) ;  x_{i+1} = xL - (2/c2)(v2·xL)
  ```
  O(1) per sample, exactly minimal twist.
- **Implementation sketch.** New file `worker/ForgeSweep.cs`: `Frames` (spine + RMF + `oGetLocalFrame(t)`), then a mesh builder that walks `(t, phi)` emitting the outer mantle, inner mantle and two caps with explicit winding (copy `BasePipe.AddOuterMantle` etc.). Steps: `lengthSteps = clamp(arcLen / (0.5·voxel), 64, 4096)`, `polarSteps = MeshUtil.Segments(2·rMax, voxel)`.
  ```csharp
  Shape Sweep(IEnumerable<Vec3> spine,
              Func<double,double,double> radiusOuter,          // (t, phiRad) -> mm
              Func<double,double,double>? radiusInner = null,  // null = solid
              Vec3? upHint = null, bool capStart = true, bool capEnd = true)
  ```
- **Example.** `Shape duct = Sweep(spine, (t, phi) => 12 + 3*Cos(4*phi) - 4*t, (t, phi) => 9);`
- **Falls out for free once this exists:** `Revolve(profile, axis)` (spine = a circle), `Loft` with a `(y, phi)` radius, extrusion (spine = a straight line), n-gon and superformula profiles (`PolygonalShapes`, `SuperShapes` from §1.6).

### #3  -  `Warp` : point-wise deformation of a finished solid

- **What.** Apply `Func<Vec3,Vec3>` to every vertex of a solid  -  the conformal-design-space trick (RoverWheel §3.2, `BaseShape.SetTransformation`).
- **Foundation.** `new Mesh(vox)` → rebuild vertex-by-vertex → `new Voxels(mesh)`. `MeshUtil.MirrorWindingFixed` (`MeshUtil.cs:101`) is already a per-triangle rebuild; copy its structure.
- **Implementation sketch.** ~30 lines. Must **detect winding inversion** (a warp with negative Jacobian flips normals  -  check the sign of one transformed triangle's normal against its original and flip globally if needed) and **warn when the mesh is too coarse for the warp** (report max edge length after warping vs. voxel size).
- **Example.** `Shape bent = Warp(flatPanel, p => Cyl(p.x, p.y, p.z, radius: 80));`

### #4  -  surface queries + path snapping

- **What.** `Vec3 ClosestPoint(shape, p)`, `Vec3 Normal(shape, surfacePt)`, `Vec3 RayHit(shape, from, dir)`, and the composite `IEnumerable<Vec3> SnapToSurface(shape, path, offsetMM)`.
- **Foundation.** `Voxels.vecClosestPointOnSurface`, `vecSurfaceNormal`, `vecRayCastToSurface` (all present, all unused). `SnapToSurface` mirrors `SplineOperations.aGetSnappedSpline`.
- **Implementation sketch.** ~25 lines of direct pass-through plus a loop. The `bXxx` overloads return success flags  -  surface them as `null` returns rather than throwing.
- **Example.** `var onBell = SnapToSurface(bellOuter, roughHelix, offsetMM: 1.2 + chDia/2);`  -  this is the *correct* way to build §8.1's channels if the contour ever stops being analytic.

### #5  -  `Lattice` upgrades: graded, cylindrical, and split-domain

- **What.** Three additions to `Forge.Lattice` / `TPMSWall`:
  (a) `cellFn: Func<Vec3,double>` and `wallFn: Func<Vec3,double>`  -  graded lattices (`FunctionalScaleTrafo`);
  (b) `space: "cartesian" | "cylindrical"` with `twistDegPerMM`  -  a gyroid that wraps an axis (`RadialTrafo`);
  (c) `side: "wall" | "plus" | "minus" | "plusWall" | "minusWall"`  -  the six `ISplittingLogic` modes (§4.1), so the two never-touching TPMS fluid domains come out of **one** call each instead of three booleans.
- **Foundation.** `TPMSWall.fSignedDistance` (`worker/TPMSWall.cs:122`) already transforms the sample point; extend the transform and the final thresholding. `SplittingLogic.cs` gives the exact formulas.
- **Implementation sketch.** ~60 lines inside `TPMSWall` plus enum plumbing in `Forge.Lattice`. Caution: graded cells break the `|∇f| ≈ sqrt(kx²+ky²+kz²)` normalisation  -  clamp the gradient estimate or sample it by finite differences, or the narrow band will miss the surface.
- **Example.** `Shape hotSide = Lattice(core, cell: 10, wall: 1.2, side: "plus");`

### #6  -  the cheap wins: `Fillet`, `Area`, `Trim`, `OverOffset`, `ProjectUp`, N-ary booleans  ★ `Fillet` required by §8.3

Each is 3-10 lines of pass-through. Together they close most of the everyday gap.

```csharp
Shape Fillet(Shape s, double r)              // voxFillet  -  concave-only, does NOT thin ribs (unlike Smooth)
double Area(Shape s)                          // MeshUtil.MeshMassProps  -  already computed for the manifest
Shape Trim(Shape s, Vec3 min, Vec3 max)       // Voxels.Trim(BBox3)  -  clip without building a box + boolean
Shape OverOffset(Shape s, double d1, double d2) // deletes features below a size threshold
Shape ProjectUp(Shape s, double y0, double y1)  // RotateX(-90)→ProjectZSlice→RotateX(90); or ask upstream for ProjectYSlice
Shape Union(IEnumerable<Shape>)               // route to voxBoolAddAll  -  one native call, not N-1 managed ones
Shape SmoothSubtract(Shape a, Shape b, double r)
```
`Fillet` is the important one: `Forge.Smooth` is `voxTripleOffset`, which rounds convex edges too and **destroys any feature thinner than 2r**  -  unusable as a finishing pass on a ribbed part.

### #7  -  `ScalarField` bridge (field-driven design)

- **What.** `Field` as a first-class script type: `Field FieldFrom(shape)`, `Field FieldFrom(Func<Vec3,double>, bbox, spacingMM)`, `Field.Sample(p)`, `Shape ToShape(Field)`, `Field Load/Save(path)`, plus letting `Lattice(..., wallFn: field.Sample)` and `Sweep(..., radius: field.Sample)` take a field.
- **Foundation.** `PicoGK.ScalarField`  -  note it **implements `IImplicit`**, so `new Voxels(field)` and `voxIntersectImplicit(field)` already work. `SetValue` / `bGetValue` / `TraverseActive` / `ITraverseScalarField`.
- **Why.** This is the door to importing an FEA/CFD result and letting it drive thickness  -  the thing that separates "generative" from "computational engineering". Also the only sane way to cache an expensive field between runs.
- **Example.** `Field stress = Field.LoadCsv("vm.csv"); SavePart("bracket", Lattice(env, wallFn: p => Lerp(0.6, 2.4, stress.Sample(p)/sMax)));`

### #8  -  `SliceSvg` / VDB round-trip

- **What.** `SaveSlices(shape, path, everyMM)` → SVG stack via `PolySlice.oFromSdf` + `SaveToSvgFile`; `SaveField(shape, path)` / `LoadField(path)` via `SaveToVdbFile` / `voxFromVdbFile`.
- **Why.** Slices give free 2-D drawings, gasket/laser flats, and a visual QA channel that is not a 5 M-triangle STL. VDB is the only lossless field persistence  -  and it would let a long HX run be checkpointed and re-finished at a different resolution.

---

## 8. The three example specs

**Global rules for all three (state these in every header comment):**

- **Up axis.** Forge authors geometry with **+Y up** (`docs/scripting.md:79`). The app's viewer up-axis chip is a *display* setting only (`README.md:218`). "Standing on the plate" therefore means **the part spans `y ∈ [0, H]` with `y = 0` on the plate**, and every script must place it there explicitly  -  nothing is auto-dropped (`docs/scripting.md:80`).
- **Structure.** One `sealed class` per part; validate every parameter in the constructor and throw; build in the constructor; expose `Shape Part { get; }`. The script body is: read params → `new Thing(...)` → `Log(...)` → `SavePart(...)`. (Curriculum ch. 10; see §6.3.)
- **Report real numbers.** Every script ends by logging volume, bbox, mass at a stated density, and  -  where meaningful  -  a *proof* (see the HX separation assertions).
- **Guard the voxel size.** `if (thinnestFeature < 3 * VoxelSizeMM) throw`  -  three voxels, not two, for anything load-bearing or leak-critical.
- **Guard the triangle count.** Estimate `Area / (0.5 · voxel²)` before saving and `Log` a warning above ~4 M. Meshing is the runtime ceiling (§0.5).
- **Ship a variant table.** Each script's header comment ends with three named parameter sets (e.g. nozzle: `bench-2kN`, `demo-5kN`, `display-half-scale`)  -  LEAP 71 never shows a hero shot without a family (§5.2).
- **Hit the tells.** Before calling a spec done, check it against §5.2: named subsystems visible; fluid path traceable in and out; period-regular bolted interface next to the organic interior; wall thickness that varies for a stated reason; self-supporting section shapes; standing monolithic orientation; graded rather than identical arrays.

---

### 8.1 `rocket_nozzle.csx` v2  -  regeneratively-cooled bell with helical channels

**Requires Forge addition #1 (`Beams`).** A fallback path with today's Forge is given at the end; it is 5-8× slower and the spec should ship with `Beams`.

#### Orientation and why

`y = 0` is the **exit plane, on the plate**; the injector flange is at the top. Radius therefore *decreases* monotonically from the exit to the throat, so the outer wall leans **inward** the whole way up  -  self-supporting, no supports, no bridging. The convergent section above the throat flares back out at ≈30° from vertical, still inside the 45° rule. The coolant inlet manifold sits at the exit end (bottom) and the outlet at the throat/flange end (top), which is also the physically correct regen circuit direction (coolant enters cold at the exit, flows counter to the exhaust, exits hot into the injector).

#### Contour `r(y)`

Let `yT = bellLen` (throat height) and `yTop = bellLen + convLen` (flange face).

```
rT = throatDia/2, rE = exitDia/2, rC = chamberDia/2
areaRatio = (rE/rT)^2
coneLen   = (rE - rT) / tan(15°)
bellLen   = bellFraction * coneLen
bellCorr  = (0.8 / bellFraction)^0.35
thetaN    = clamp((17.0 + 2.6*ln(areaRatio)) * bellCorr, 12, 35)   // wall angle AT the throat
thetaE    = clamp((18.0 - 2.5*ln(areaRatio)) * bellCorr,  3, 22)   // wall angle AT the exit
if (thetaN <= thetaE + 1) thetaN = thetaE + 1
```

Bell, parametrised by **axial distance above the throat measured downward**, `x = yT - y ∈ [0, bellLen]`. Quadratic Bézier `P0 = (0, rT)` with slope `m0 = tan(thetaN)`, `P2 = (bellLen, rE)` with slope `m2 = tan(thetaE)`, control point at the tangent intersection:

```
x1 = (rE - rT - m2*bellLen) / (m0 - m2)        // clamp to (0, bellLen)
R1 = rT + m0*x1                                 // clamp to (rT, rE)
x(t) = (1-t)^2*0   + 2(1-t)t*x1 + t^2*bellLen
R(t) = (1-t)^2*rT  + 2(1-t)t*R1 + t^2*rE
```
`x(t)` is monotone because `0 < x1 < bellLen`, so invert by 36-step bisection (identical to the existing script's `BellRadius`).

Convergent, `y ∈ [yT, yTop]`, `u = (y - yT)/convLen`  -  raised cosine, zero slope at both ends (no crease at the throat, square to the flange):

```
r = rT + (rC - rT) * 0.5 * (1 - cos(pi*u))
```

Full contour:
```csharp
double R(double y) => y <= yT ? Bell(yT - y) : Conv(y);
```

#### Channel parametrisation  -  this is the engineering content

**Wall thickness is graded along the axis**, thickest at the throat where the heat flux and the pressure both peak, thinning toward the exit  -  LEAP 71 states this explicitly for TKL-200 ("chamber wall thickness varied along the axis to improve conductivity while holding structural integrity"), and their published minimum is 0.8 mm:

```
double wall(double y) {
    double t = Clamp((R(y) - rT) / (rE - rT), 0, 1);      // 0 at the throat, 1 at the exit plane
    return wallThroatMM + (wallExitMM - wallThroatMM) * t;
}
```
Grading on *radius* rather than on `y` is deliberate: it makes the convergent section  -  which climbs back out to `rC`  -  pick up an intermediate thickness (≈1.18 mm at the defaults) automatically, and it keeps the rule true for any contour.

Channel centrelines lie on the surface offset outward from the hot-gas wall:
`rho(y) = R(y) + wall(y) + 0.5*chDia(y)`

Let `alpha(y)` be the **helix angle from the meridian** (0 = straight up the bell, 90° = a circumferential ring). The perpendicular pitch between adjacent channel centrelines is `p = 2*pi*rho*cos(alpha) / N`. Holding `p` constant gives near-complete, constant-land coverage:

```
cosAlpha(y) = clamp( pitchMM * N / (2*pi*rho(y)),  cos(helixMaxDeg),  1 )
alpha(y)    = acos(cosAlpha(y))
chDia(y)    = clamp( 2*pi*rho(y)*cosAlpha(y)/N - landMM,  chMinMM, chMaxMM )
```

Reading of this: at the **throat** `rho` is smallest so `cosAlpha → 1`  -  the channels run nearly straight, tightly packed, maximum heat flux where the engine needs it. Moving down the bell `rho` grows, `alpha` grows to keep the pitch constant, so the channels **wrap harder and harder**; once `alpha` saturates at `helixMaxDeg` the pitch opens up and the channels spread out toward the exit  -  which is exactly how real regen circuits are graded (dense at the throat, sparse or absent at low area ratio). Total wrap at the defaults is ≈205°, a clearly visible spiral that is not a rat's nest.

Resolve the `rho ↔ chDia` circularity with one fixed-point pass: compute `rho0` with `chNom = (chMin+chMax)/2`, evaluate `alpha`/`chDia` from `rho0`, then recompute `rho`. The residual is far below a voxel.

**Path generator  -  march by arc length, not by y:**

```
GeneratePath(phi0):
    pts = [];  rads = []
    y = yInlet;  phi = phi0
    while y < yOutlet:
        a  = alpha(y);  rr = rho(y);  dch = chDia(y)
        pts.add(  V( rr*cos(phi), y, rr*sin(phi) )  );  rads.add( dch*0.5 )
        y   += stepMM * cos(a)                  // axial advance
        phi += stepMM * sin(a) / rr             // circumferential advance (exact on the surface)
    # close on the outlet ring
    pts.add( V( rho(yOutlet)*cos(phi), yOutlet, rho(yOutlet)*sin(phi) ) ); rads.add( chDia(yOutlet)*0.5 )
    return pts, rads

allBeams = []
for k in 0 .. N-1:
    pts, rads = GeneratePath(2*pi*k/N)
    for i in 0 .. len(pts)-2:
        allBeams.add( (pts[i], pts[i+1], 2*rads[i], 2*rads[i+1]) )   // per-end diameter = free taper
    if teardropMM > 0:                                                # self-supporting roof (§2.2)
        for i in 0 .. len(pts)-1:
            outward = normalize( V(pts[i].x, 0, pts[i].z) )           # radially OUT, i.e. the local downskin normal
            allBeams.add( (pts[i], pts[i] + teardropMM*outward, 2*rads[i], 0.4) )
channelVoid = Beams(allBeams)
```

`stepMM = 1.0` gives ≈230 beams per channel, ≈5060 total; the teardrop risers add ≈5060 more.

**Why the riser points radially outward, not up.** The channel's unsupported roof is its *outer* face  -  the part is built bottom-up and the outer surface of the bell leans inward, so the overhang the printer sees on each channel is on the outboard side. A tapered cone of length `teardropMM` growing radially out of every cross-section turns the round bore into a teardrop with a self-supporting apex. This is `HelixHeatX/HelicalVoids.cs:91-92` applied to a cone instead of a cylinder, and it is the difference between a channel that prints and a channel that slumps.

#### Build order

```csharp
// 1. gas-side surfaces
Shape bore     = Loft(R, -over, yTop + over);                     // over = 2*wallThroatMM + 1
Shape hotWall  = Loft(y => R(y) + wall(y), 0, yTop);              // graded wall

// 2. coolant circuit as a VOID (curriculum ch.13: model the fluid, derive the metal)
Shape channels = Beams(allBeams);
Shape ringIn   = Torus(d: 2*rho(yInlet),  ring: manifoldRingMM, at: V(0, yInlet,  0));
Shape ringOut  = Torus(d: 2*rho(yOutlet), ring: manifoldRingMM, at: V(0, yOutlet, 0));
Shape portIn   = RotateZ(Cylinder(portDiaMM, portLen), 90, about: V(0, yInlet, 0));   // radial, +X
portIn         = Move(portIn, rho(yInlet) + portLen*0.5 - manifoldRingMM*0.5, 0, 0);
Shape portOut  = /* same at yOutlet, rotated 180° about Y */;
Shape coolant  = Union(channels, ringIn, ringOut, portIn, portOut);

// 3. the closeout jacket forms itself
Shape jacket   = closeoutMode == "tubes"
               ? Offset(coolant, closeoutMM)                       // visible spiral tubes
               : Loft(y => R(y) + wall(y) + chDia(y) + teardropMM + closeoutMM, 0, yTop);  // smooth skin
//    with land 1.2 and closeout 0.9, adjacent skins overlap (2*0.9 > 1.2) so the jacket is continuous

// 4. flange + bosses
Shape flange   = Cylinder(flangeODMM, flangeTMM, at: V(0, yTop - flangeTMM*0.5, 0));
Shape bossIn   = /* cylinder around portIn, dia portDia + 2*bossWall */;
Shape bossOut  = /* ditto */;

// 5. combine, then subtract the function LAST
Shape body = SmoothUnion(Union(hotWall, jacket, bossIn, bossOut), flange, radius: 2.0);
body       = Subtract(body, bore, coolant);
if (boltCount > 0)
    body   = Subtract(body, ArrayRadial(Cylinder(boltDiaMM, flangeTMM*4, at: V(0, yTop - flangeTMM*0.5, 0)),
                                        boltCount, radius: flangeODMM*0.5 - boltDiaMM - 3));
```

#### Parameter table

| Parameter | Default | Unit | Meaning |
|---|---|---|---|
| `throatDiaMM` | 24 | mm | throat diameter |
| `exitDiaMM` | 90 | mm | exit-plane diameter (area ratio 14.1) |
| `chamberDiaMM` | 54 | mm | chamber / injector-face diameter |
| `convLenMM` | 34 | mm | convergent length, throat → flange face |
| `bellFraction` | 0.8 | - | bell length / 15° cone length |
| `wallThroatMM` | 1.4 | mm | hot-gas wall at the throat (thickest  -  peak flux and pressure) |
| `wallExitMM` | 0.9 | mm | hot-gas wall at the exit plane (LEAP 71's published floor is 0.8 mm) |
| `teardropMM` | 1.6 | mm | radial teardrop extension on each channel  -  the self-supporting roof; 0 = plain round |
| `channelStarts` | 22 | - | number of helical starts |
| `pitchMM` | 4.2 | mm | target perpendicular pitch between centrelines |
| `landMM` | 1.2 | mm | metal land between adjacent channels |
| `chMinMM` / `chMaxMM` | 2.4 / 5.0 | mm | channel diameter clamps |
| `helixMaxDeg` | 60 | ° | maximum helix angle from the meridian |
| `closeoutMM` | 0.9 | mm | jacket thickness over the channels |
| `closeout` | `"tubes"` | - | `"tubes"` (visible spiral) or `"smooth"` |
| `manifoldRingMM` | 9 | mm | tube diameter of the inlet/outlet manifold torus |
| `portDiaMM` | 8 | mm | coolant port bore |
| `flangeODMM` / `flangeTMM` | 78 / 6 | mm | injector flange |
| `boltCount` / `boltDiaMM` | 8 / 5.5 | - / mm | flange bolt pattern |
| `stepMM` | 1.0 | mm | channel path arc-length step |

**Derived at the defaults:** `coneLen` 123.2, `bellLen` 98.5, `yTop` 132.5 mm tall; `thetaN` 23.9°, `thetaE` 11.4°; Bézier `x1` 54.4, `R1` 36.1; max OD ≈ 107 mm (over the inlet manifold); channel wrap ≈ 205°; ≈10 100 beams (5060 spine + 5040 teardrop risers).

**Validation to throw on:** `exitDia > throatDia`; `chamberDia > throatDia`; `bellFraction ∈ [0.5, 1.2]`; `min(wallThroatMM, wallExitMM) ≥ 3·VoxelSizeMM`; `chMinMM ≥ 4·VoxelSizeMM`; `landMM ≥ 3·VoxelSizeMM`; `2·closeoutMM > landMM` when `closeout == "tubes"` (else the jacket has gaps); `pitchMM·channelStarts ≤ 2π·rho(yT)` (else the throat is over-subscribed); `teardropMM ≤ chMaxMM` (a longer riser breaks through the closeout).

**Variant table for the header comment:** `bench-2kN` (throat 16 / exit 58 / chamber 36, 16 starts) · `demo-5kN` (the defaults above) · `display-half` (all diameters ×0.5, voxel 0.2, `closeout: "tubes"`  -  the photogenic one).

#### Runtime budget (0.3 mm voxel, single-threaded)

| Step | Cost |
|---|---|
| `Loft` × 2 (bbox ≈ 105 × 140 × 105 → ~54 M + ~33 M voxel callbacks) | 6-8 s |
| `Beams` (≈10 100 beams, native, per-beam bbox) | 8-12 s |
| `Offset(coolant, 0.9)` (`"tubes"` mode) | 4-7 s |
| 2 tori + flange + bosses + bolt ring | 3-5 s |
| ~9 booleans on 50-100 M-voxel narrow bands | 8-14 s |
| `SavePart`: mesh + `MeshClean` + STL (~1.6 M triangles) | 8-15 s |
| **Total** | **≈ 35-55 s** ✔ under the 60 s budget |

0.4 mm for iteration (≈15-20 s); 0.2 mm for the final bake (≈4-6 min, ~3.6 M triangles).

**Fallback without `Beams`:** split each helix into 20 arcs of ~12 points and call `Pipe` per arc (440 calls, each over a small bbox), accumulating into one field before the final union. ≈3-6 min at 0.3 mm; drop the default voxel to 0.4 and `channelStarts` to 14. Ship this only if #1 slips.

---

### 8.2 `heat_exchanger.csx` v2  -  two-domain TPMS counterflow core, printable metal + fluid volumes

Buildable with **today's Forge**. `Area()` (#6) would let it report its headline number; addition #5(c) would replace three booleans with two calls.

#### Topology  -  how the two circuits are guaranteed never to meet, and how each gets its own header

The gyroid splits the core into two interpenetrating domains separated by a sheet of thickness `wallMM`. Both domains run the full height, so the headers cannot simply be "one at each end". The trick is to **seal each domain against a different boundary of the core**:

- **Domain A (axial):** sealed against the cylindrical side wall by subtracting a solid annular band of thickness `skinMM`. A can therefore only enter and leave through the **top and bottom faces** → simple coaxial trumpet plenums with an axial port at each end.
- **Domain B (radial):** sealed against the top and bottom faces by subtracting two solid slabs of thickness `skinMM`. B can therefore only enter and leave through the **cylindrical side** → an annular jacket around the core, **blocked by a solid ring at mid-height** so B must travel *through the core* from the lower jacket to the upper jacket instead of short-circuiting up the annulus.

Result: A flows top → bottom axially, B flows bottom → top through the core interior. Genuine counterflow, four ports, two independent circuits, one printable piece. Every seal is a boolean against a primitive  -  no clever geometry.

#### Build order (exact Forge calls)

```csharp
// 0. envelope
Shape core = Cylinder(coreDiaMM, coreHMM, at: V(0, coreHMM*0.5, 0));

// 1. the separating wall, and the two domains  (3 renders, 3 booleans)
Shape wall    = Lattice(core, "gyroid", cell: cellMM, wall: wallMM, type: "sheet");
Shape negSide = Lattice(core, "gyroid", cell: cellMM, type: "skeletal", bias: 0);   // solid where f < 0
Shape domB0   = Subtract(negSide, wall);            // f < -w/2
Shape domA0   = Subtract(core, negSide, wall);      // f > +w/2
//  ASSERT: Volume(Intersect(domA0, domB0)) == 0

// 2. seal each domain against a different boundary
Shape sideBand = Subtract(core, Cylinder(coreDiaMM - 2*skinMM, coreHMM + 2, at: V(0, coreHMM*0.5, 0)));
Shape endSlabs = Union(Box(coreDiaMM+4, skinMM, coreDiaMM+4, at: V(0, skinMM*0.5, 0)),
                       Box(coreDiaMM+4, skinMM, coreDiaMM+4, at: V(0, coreHMM - skinMM*0.5, 0)));
Shape domA = Subtract(domA0, sideBand);   // axial only
Shape domB = Subtract(domB0, endSlabs);   // radial only

// 3. A's headers: two trumpet plenums, axial ports
double rPlenum = coreDiaMM*0.5 - skinMM;
Shape headA_lo = Loft(y => Lerp(rPlenum, portDiaMM*0.5, -y/headerHMM), -headerHMM, 0);
Shape headA_hi = Move(Mirror(headA_lo, "XZ"), 0, coreHMM, 0);
Shape portA_lo = Cylinder(portDiaMM, portLenMM*2, at: V(0, -headerHMM, 0));
Shape portA_hi = Cylinder(portDiaMM, portLenMM*2, at: V(0, coreHMM + headerHMM, 0));

// 4. B's jacket: annulus, blocked at mid-height, radial ports at 18% and 82%
Shape jacketVoid = Subtract(Cylinder(coreDiaMM + 2*jacketGapMM, coreHMM, at: V(0, coreHMM*0.5, 0)),
                            Cylinder(coreDiaMM, coreHMM + 2,     at: V(0, coreHMM*0.5, 0)),
                            Box(coreDiaMM*3, 2*skinMM, coreDiaMM*3, at: V(0, coreHMM*0.5, 0)));
Shape portB_lo = /* RotateZ(Cylinder(portDiaMM, portLenMM*2), 90) moved to +X at y = 0.18*coreHMM */;
Shape portB_hi = /* same at y = 0.82*coreHMM, rotated 180° about Y */;

// 5. the two fluid volumes
Shape fluidA = Union(domA, headA_lo, headA_hi, portA_lo, portA_hi);
Shape fluidB = Union(domB, jacketVoid, portB_lo, portB_hi);

// 6. PROVE the separation  -  this is the part that makes it read as engineering
if (Volume(Intersect(fluidA, fluidB)) > 0)                       throw new ArgumentException("circuits touch");
if (Volume(Intersect(Offset(fluidA, 0.4*wallMM), fluidB)) > 0)   throw new ArgumentException("wall thinner than 0.8*wallMM somewhere");
Log($"separation proven: min metal between circuits >= {0.8*wallMM:0.00} mm");

// 7. the metal
Shape envelope = Union(core,
                       Cylinder(coreDiaMM + 2*jacketGapMM + 2*skinMM, coreHMM, at: V(0, coreHMM*0.5, 0)),
                       Offset(headA_lo, skinMM), Offset(headA_hi, skinMM),
                       bossA_lo, bossA_hi, bossB_lo, bossB_hi,
                       flangeRing_lo, flangeRing_hi);
Shape metal = Subtract(envelope, fluidA, fluidB);

// 8. output
SavePart("hx_core", metal);
if (emitFluids) { SavePart("hx_fluid_A", fluidA); SavePart("hx_fluid_B", fluidB); }
```

Why step 7 works: inside the core, `core = domA ∪ domB ∪ wall` exactly, so `core − fluidA − fluidB` leaves the gyroid sheet plus the two sealing bands  -  the metal is one connected, watertight piece with the sheet bonded to the outer shell through `sideBand` and to the end faces through `endSlabs`. The sealing bands also cap the razor-thin slivers where the gyroid sheet is clipped by the cylinder, which is otherwise the #1 source of non-manifold junk in TPMS parts.

#### Parameter table

| Parameter | Default | Unit | Meaning |
|---|---|---|---|
| `coreDiaMM` | 60 | mm | gyroid core diameter |
| `coreHMM` | 80 | mm | gyroid core height |
| `cellMM` | 10 | mm | gyroid unit cell |
| `wallMM` | 1.2 | mm | separating sheet thickness = the pressure wall between circuits |
| `skinMM` | 1.5 | mm | outer shell and sealing bands |
| `jacketGapMM` | 5 | mm | annular gap for circuit B |
| `headerHMM` | 20 | mm | height of each A plenum |
| `portDiaMM` | 12 | mm | all four port bores |
| `portLenMM` | 10 | mm | port stick-out |
| `flangeODMM` / `flangeTMM` | 88 / 4 | mm | base mounting flange |
| `emitFluids` | `true` | - | also save the two fluid volumes as separate parts |
| `ventGapMM` | 0 | mm | optional interstitial tell-tale gap inside the separating wall (see below); 0 = off |

**Optional feature worth adding  -  the interstitial tell-tale.** LEAP 71's injector heads carry **a third fluid volume, a nitrogen purge layer, sandwiched between the fuel and oxidiser volumes so a printed-wall crack cannot put them in contact** (§5.1). The same idea is one line here: render a *second, thinner* sheet lattice at the same phase and subtract it from the metal  - 

```csharp
if (ventGapMM > 0) {
    Shape vent = Lattice(core, "gyroid", cell: cellMM, wall: ventGapMM, type: "sheet");
    vent = Intersect(vent, Subtract(core, sideBand, endSlabs));   // keep it off the seals
    metal = Subtract(metal, Union(vent, ventPortBore));            // one extra radial port, mid-height
}
```
 -  giving a continuous, drainable interstitial void inside the separating wall, vented to atmosphere through its own port. A leak in either circuit now shows up at the vent port instead of contaminating the other fluid. Requires `wallMM ≥ 3·ventGapMM + 6·VoxelSizeMM`; at the defaults `ventGapMM = 0.35` works. Off by default because it doubles the wall-thickness requirement, but it is the single most "this person has built hardware" feature available in this part.

**Envelope at the defaults:** Ø73 mm × 120 mm tall (Ø88 over the base flange), ~1.7 kg in 316L if fully dense  -  a real bench-scale HX.

**Validation to throw on:** `wallMM ≥ 3·VoxelSizeMM`; `cellMM ≥ 6·wallMM` (below that the domains pinch off); `skinMM ≥ wallMM` (so the sealing bands always fully close a gyroid gap); `jacketGapMM ≥ 3·skinMM`; `coreDiaMM ≥ 4·cellMM` and `coreHMM ≥ 5·cellMM`; when `ventGapMM > 0`, `wallMM ≥ 3·ventGapMM + 6·VoxelSizeMM`.

**Variant table for the header comment:** `bench` (the defaults, Ø73 × 120) · `coarse` (`cellMM 14, wallMM 1.6`, voxel 0.5  -  the 40-second iteration variant) · `reference` (Ø200 × 300 mm  -  LEAP 71's published HeatX envelope; `coreDiaMM 170, coreHMM 220, cellMM 16`, voxel 0.5, ≈8 min, ~4 M triangles). Showing the same script produce a bench part and a 200 mm reference part is the whole "families, not hero shots" argument (§5.2) in one table.

#### Runtime budget

Gyroid wetted area ≈ `2 × 3.09/cell × V`. At the defaults `V = π·30²·80 = 226 200 mm³` → **≈140 000 mm²**, which is the dominant cost driver.

| Step | 0.35 mm | 0.5 mm (iterate) |
|---|---|---|
| 2 × `Lattice` render over the core bbox (~15 M / ~5 M callbacks) | 3-4 s | 1-2 s |
| ~20 booleans + 4 offsets on 15-30 M-voxel bands | 25-40 s | 8-14 s |
| Envelope lofts/cylinders/bosses | 4-6 s | 2 s |
| `SavePart` × 3  -  mesh + `MeshClean` + STL (**≈2.3 M / 1.1 M triangles each**) | 60-110 s | 20-35 s |
| **Total** | **≈100-160 s** | **≈35-55 s** |

**Recommend `voxelSizeMM = 0.35` as this script's stated default**, 0.5 while tuning, 0.25 for a print-ready bake (≈4.5 M triangles, 5-8 min). Set `emitFluids = false` to cut roughly a third.

#### One honest caveat to put in the header comment

Lin Kayser (PicoGK's author) is publicly sceptical of TPMS heat exchangers  -  *"gyroids … usually create dead ends, and their very curvy nature creates high pressure drops"* (curriculum ch. 19). The design above answers the *dead-end* half directly: both domains are open, headered, and proven separated, and neither is a blind pocket. It does not answer the *pressure-drop* half  -  say so in the comment and point at `cellMM` as the knob. Being explicit about the criticism is itself a mark of engineering seriousness, and it is a nice hook for the docs.

---

### 8.3 `compliant_wheel.csx`  -  Ø180 mm airless rover wheel (the third example)

**Pick rationale.** The other two examples are both fluid/thermal and both revolve about an axis. This one is structural, obviously mechanical at a glance, and exercises a completely different toolkit: **a user-written `IImplicit` pattern field**, concentric graded bands, radial arrays and a real bolt interface. It needs only addition #6 (`Fillet`)  -  the rest is today's Forge  -  and it is the example that proves an ANVIL script can invent its own geometry rather than assembling primitives. It is also directly printable in TPU and instantly legible as a *part*.

Design language lifted from `LEAP71_RoverWheel/RoverWheel/Wheels/Wheel_01.cs` (§3.1): concentric bands, symmetry count rising outward, wall thickness falling outward, counter-handed neighbours.

#### Orientation

Axle along **+Y**, wheel lying flat on the plate, `y ∈ [0, widthMM]`. Every rib is a vertical wall → self-supporting, no supports, and the ribs are loaded in their strong direction.

#### The spiral-rib field (declared inside the script)

Ribs are the level sets of a logarithmic-spiral family `phi + b·ln(r) ≡ 2πk/n`. One `IImplicit`, one render, all `n` ribs of a band, with thickness graded across the band:

```csharp
class SpiralRibs : IImplicit
{
    readonly float m_n, m_b, m_r0, m_r1, m_t0, m_t1, m_phi0;
    public SpiralRibs(int n, float b, float r0, float r1, float t0, float t1, float phi0)
    { m_n=n; m_b=b; m_r0=r0; m_r1=r1; m_t0=t0; m_t1=t1; m_phi0=phi0; }

    public float fSignedDistance(in Vector3 v)
    {
        float r = MathF.Sqrt(v.X*v.X + v.Z*v.Z);
        if (r < 1e-3f) return 1e3f;                       // the axis is never inside a rib
        float theta = MathF.Atan2(v.Z, v.X) + m_b*MathF.Log(r) - m_phi0;
        float g     = m_n * theta / (2f*MathF.PI);
        float frac  = g - MathF.Round(g);                 // signed, in [-0.5, 0.5]

        // |grad theta| = sqrt(1+b^2)/r  ->  perpendicular distance to the nearest rib mid-surface
        float dPerp = MathF.Abs(frac) * (2f*MathF.PI/m_n) * r / MathF.Sqrt(1f + m_b*m_b);

        float u = Math.Clamp((r - m_r0) / (m_r1 - m_r0), 0f, 1f);
        float t = m_t0 + (m_t1 - m_t0) * u;
        return 0.95f * (dPerp - 0.5f*t);                  // 0.95 keeps the field band-safe (under-estimate)
    }
}
```

`b = 0` gives straight radial spokes; `b > 0` and `b < 0` give opposite handedness. Adjacent bands with opposite `b` cross each other and form a **shear-stiff diamond network** at the band interfaces  -  that is what makes it look and behave engineered rather than like a pinwheel.

#### Build order

```csharp
Shape Band(double r0, double r1, int n, double b, double t0, double t1, double phase)
{
    Shape env = Subtract(Cylinder(2*r1, widthMM, at: V(0, widthMM*0.5, 0)),
                         Cylinder(2*r0, widthMM + 2, at: V(0, widthMM*0.5, 0)));
    return new Shape(((Voxels)env).voxIntersectImplicit(
                      new SpiralRibs(n, (float)b, (float)r0, (float)r1, (float)t0, (float)t1, (float)phase)));
}

Shape hub  = Subtract(Cylinder(hubOdMM, widthMM, at: V(0, widthMM*0.5, 0)),
                      Cylinder(axleBoreMM, widthMM + 2, at: V(0, widthMM*0.5, 0)),
                      ArrayRadial(Cylinder(boltDiaMM, widthMM + 2, at: V(0, widthMM*0.5, 0)),
                                  boltCount, radius: boltCircleMM*0.5));

Shape b1 = Band(hubOdMM*0.5, r1MM, n1, +bSpiral,  t1aMM, t1bMM, 0);
Shape b2 = Band(r1MM,        r2MM, n2, -bSpiral*1.5, t2aMM, t2bMM, 0);
Shape b3 = Band(r2MM,        r3MM, n3, +bSpiral*2.5, t3aMM, t3bMM, 0);

Shape rim = Subtract(Cylinder(odMM, widthMM, at: V(0, widthMM*0.5, 0)),
                     Cylinder(odMM - 2*rimTMM, widthMM + 2, at: V(0, widthMM*0.5, 0)));

// chevron tread lug: a V-shaped Pipe (3 points, so SdPolyPipe is cheap), arrayed
var vee   = new List<Vec3> { V(0, lugWMM*0.5, -lugSpanMM*0.5), V(lugHMM, 0, 0), V(0, lugWMM*0.5, lugSpanMM*0.5) };
Shape lug = Move(Pipe(vee, d: lugDMM), odMM*0.5 - lugDMM*0.25, widthMM*0.5, 0);
Shape tread = ArrayRadial(lug, treadLugs, radius: 0);

Shape wheel = Union(hub, b1, b2, b3, rim, tread);
wheel = Fillet(wheel, filletMM);        // ADDITION #6  -  concave only. Do NOT use Smooth() here:
                                         // Smooth = voxTripleOffset and would erase the 1.5 mm ribs.
SavePart("compliant_wheel", wheel);
```

#### Parameter table

| Parameter | Default | Unit | Meaning |
|---|---|---|---|
| `odMM` | 180 | mm | outside diameter over the rim (tread adds `lugHMM`) |
| `widthMM` | 45 | mm | wheel width along the axle (+Y) |
| `hubOdMM` | 46 | mm | hub outside diameter |
| `axleBoreMM` | 25 | mm | axle bore |
| `boltCount` / `boltDiaMM` / `boltCircleMM` | 6 / 4.4 / 35 | - / mm / mm | hub bolt pattern |
| `r1MM` / `r2MM` / `r3MM` | 52 / 74 / 86 | mm | band outer radii |
| `n1` / `n2` / `n3` | 12 / 24 / 48 | - | rib counts per band (rising outward) |
| `t1aMM,t1bMM` / `t2aMM,t2bMM` / `t3aMM,t3bMM` | 3.4,2.6 / 2.4,1.9 / 1.8,1.5 | mm | rib thickness, inner → outer of each band |
| `bSpiral` | 0.55 | - | spiral tightness of band 1; bands 2 and 3 use `-1.5×` and `+2.5×` |
| `rimTMM` | 3.0 | mm | rim band thickness |
| `treadLugs` / `lugDMM` / `lugHMM` / `lugSpanMM` / `lugWMM` | 30 / 6 / 3.5 / 26 / 9 | - / mm | chevron tread |
| `filletMM` | 0.9 | mm | global concave fillet |

**Validation to throw on:** `min(t3bMM) ≥ 4·VoxelSizeMM`; `2·filletMM < min rib thickness`; `r1 < r2 < r3 < odMM/2 - rimTMM`; `boltCircleMM/2 + boltDiaMM/2 < hubOdMM/2` and `> axleBoreMM/2`; each band's rib pitch at its inner radius `2π·r0/n > 2·t0` (else the ribs merge into a solid disc  -  log the computed solid fraction so this is visible).

**Derived at the defaults:** solid fraction ≈ 11-14 %, volume ≈ 150 000 mm³ ≈ **180 g in TPU 95A**; band-1 rib pitch at r=23 is 12.0 mm against a 3.4 mm rib → 28 % fill, correctly the most compliant band.

**Variant table for the header comment:** `rover-180` (the defaults) · `soft` (`t*` × 0.7, `n1 8`  -  a visibly squishier wheel, same script) · `caster-90` (all radii × 0.5, `widthMM 24`, `treadLugs 18`  -  proves the model scales).

#### Runtime budget (0.3 mm voxel)

| Step | Cost |
|---|---|
| 3 × `voxIntersectImplicit` over the wheel bbox (~66 M callbacks each, `atan2`+`log` ≈ 60 ns) | 10-14 s |
| hub + rim + bolt ring | 4-6 s |
| tread: 1 small `Pipe` + `ArrayRadial(30)` into its own thin ring field | 5-8 s |
| ~8 booleans | 6-10 s |
| `Fillet` on the full field | 4-7 s |
| `SavePart`: mesh + clean + STL (~3.3 M triangles) | 20-35 s |
| **Total** | **≈50-80 s** |

Recommend a stated default of 0.35 mm (≈35-50 s, 2.4 M triangles); 0.5 mm while tuning; 0.25 mm for the print (≈4-6 min).

**Cheap upgrade if you want more wow for one extra render:** add two thin side discs (`sidewallTMM = 1.0`) over band 1 only, cut with the same `SpiralRibs` field at a different phase  -  you get a visibly "designed" closed inner rotor with open outer compliance, which is exactly the RoverWheel look.

### 8.4 Runner-up third example (if the wheel is rejected)

**Truncated aerospike / plug nozzle.** `Loft` a plug contour, `Loft` a cowl, `Beams` a helical coolant circuit on the plug, and array N combustion-chamber pods around the base  -  visually the single most recognisable LEAP 71 image. It is genuinely spectacular but it reuses ~80 % of the nozzle-v2 machinery (contour function + helical `Beams` + manifold rings), so as a *third* example it teaches almost nothing new. Keep it as a fourth.

**Not recommended: quasicrystal.** `LEAP71_QuasiCrystals` is an inflation tiling generator (§4.2). Porting it is a week of `QuasiTileInflation` maths for an output that reads as sculpture rather than a part, and it exercises no PicoGK capability the wheel does not.

---

## 9. Recommended sequencing for the builder

1. **Land Forge addition #1 (`Beams`) and #6 (`Fillet`, `Area`).** ~80 lines total, no new SDF maths, unblocks two of the three examples and fixes the `Pipe` scaling cliff.
2. **Rebuild `heat_exchanger.csx` first**  -  it needs no additions, it is the strongest "this is real engineering" artefact, and its separation assertions are a genuinely novel thing to show.
3. **Rebuild `rocket_nozzle.csx`** on top of `Beams`.
4. **Add `compliant_wheel.csx`**  -  it also serves as the worked example for "write your own field", which is the deepest thing ANVIL can already do and is currently documented nowhere but a 60-line puck.
5. **Then Forge addition #2 (`Sweep`).** It is the biggest single capability jump but also the biggest build (a `Frames` port with a rotation-minimising frame plus a quad-strip mesher). Do it once the examples have proven the rest of the pipeline.
6. **Update `docs/scripting.md`** with: the `Pipe` segment-count limit and the `Beams` alternative; the "meshing dominates" runtime rule with the `Area/(0.5·voxel²)` triangle estimate; and a "write your own `IImplicit`" section built from the wheel example.
