# Forge scripting

**The ANVIL Forge is a flat list of geometry commands you call from an ordinary C# script.** A script is a `.csx` file: no project, no build step, no new runtime. It compiles with Roslyn inside a per-job worker process that already holds a live [PicoGK](https://github.com/leap71/PicoGK) voxel kernel, so `Box(...)`, `Subtract(...)` and `Lattice(...)` are real voxel operations rather than a mesh-editing veneer. Because it is C#, the shape of a part can be a function: a loop, a curve, a solver, a table of test data. That is the whole point. Anything you can compute, you can build.

```csharp
Shape plate = Box(60, 4, 40);
Shape boss  = Cylinder(d: 12, h: 8, at: V(0, 6, 0));
Shape body  = SmoothUnion(plate, boss, radius: 2);
Shape holes = ArrayRadial(Cylinder(4, 20), count: 6, radius: 20);
SavePart("bracket", Subtract(body, holes));
```

## Contents

- [Running a script](#running-a-script)
- [Script globals](#script-globals)
- [Conventions](#conventions)
- [The voxel-size rule](#the-voxel-size-rule)
- [Command reference](#command-reference)
  - [Points](#points)
  - [Builders](#builders)
  - [Combinators](#combinators)
  - [Modifiers](#modifiers)
  - [Info](#info)
  - [The Shape and Bounds types](#the-shape-and-bounds-types)
- [Worked example: the rocket nozzle](#worked-example-the-rocket-nozzle)
- [Example scripts](#example-scripts)
- [Gotchas](#gotchas)
- [Security](#security)

## Running a script

There are three ways in, and all three run the same worker.

**The SCRIPTS view.** Open `SCRIPTS` in the toolbar. Pick a template from the picker (the `scripts-library` seeds plus everything you have saved), edit, and press `RUN` or `Ctrl+Enter`. Every part the script saves lands in the canvas and the objects list through the normal derived-part flow, so a whole run is one `Ctrl+Z`. `SAVE` files the buffer under a name, `UPLOAD` reads a `.csx` off disk, and `TOOLS ?` opens this page.

**The HTTP API.**

```
POST /api/scripts/run
{ "code": "<the .csx source>", "name": "my_part", "params": { "sizeMM": 40 }, "voxelSizeMM": 0.3 }
-> 202 { "jobId": "j_ab12cd34" }
```

Poll `GET /api/jobs/{jobId}` until `state` is `done`. The finished job carries `parts[]` (one entry per `SavePart`, with triangle count, volume, surface area, bbox and a watertight flag) and `log[]` (everything the script passed to `Log`). A compile failure comes back as `state: "failed"` with `errorData.scriptError[]`, one entry per Roslyn diagnostic with its line and character.

**MCP.** Agents call `run_script` with the same fields, and it polls to completion for them. `list_scripts` / `get_script` / `save_script` reach the same library the picker shows, and `get_forge_reference` returns this command reference as text.

## Script globals

These are in scope unqualified inside every script, with no `using` and no receiver.

| Global | What it does |
| --- | --- |
| `Params` | `IReadOnlyDictionary<string, object?>` of the parameters the caller passed. Numbers arrive as `double`, strings as `string`, booleans as `bool`. |
| `ParamF(key, fallback)` | Read a numeric parameter as a `float`, with a default when it is missing or not a number. |
| `ParamS(key, fallback)` | Read a string parameter, with a default. |
| `ParamB(key, fallback)` | Read a boolean parameter, with a default. |
| `VoxelSizeMM` | The `float` voxel size this job is running at. Read it to validate that a thin feature can actually resolve. |
| `SavePart(name, shape)` | Emit a result part. Meshes the field, removes floating islands, checks watertightness, writes a binary STL in mm and registers the part. Also accepts a raw PicoGK `Voxels` or a `Mesh`. |
| `Log(message)` | A structured progress note. It reaches `job.log[]`, the SCRIPTS terminal and the MCP result. |

A script that reads every input through `ParamF` and friends is a whole family of parts rather than one part:

```csharp
float sizeMM = ParamF("sizeMM", 40f);
float cellMM = ParamF("cellMM", 6f);
Log($"cube {sizeMM} mm, cell {cellMM} mm at voxel {VoxelSizeMM} mm");
SavePart("core", Lattice(Box(sizeMM, sizeMM, sizeMM), cell: cellMM));
```

Also imported automatically: `PicoGK` (`Voxels`, `Mesh`, `IImplicit`, `BBox3`), `Anvil.Worker` (`MeshUtil`, `TPMSWall`, `MeshClean`), `System`, `System.Numerics`, `System.Collections.Generic`, `System.Linq`, `System.IO`, plus static imports of `System.Math` and `Anvil.Worker.Forge`. A `Shape` converts to and from `Voxels` implicitly, so Forge commands and raw kernel calls mix freely in one script.

## Conventions

These hold for every command, without exception.

- **Units are millimetres. Angles are degrees.**
- **The up axis is +Y**, the Onshape and SolidWorks convention the viewer uses. `Cylinder`, `Cone`, `Loft`, `Torus` and `ArrayRadial` all revolve about +Y.
- **Scripts are coordinate-explicit.** Nothing is auto-dropped onto a build plate. Every builder's `at` modifier is the shape's **centre** and defaults to the world origin. To stand a 20 mm cylinder on the XZ plane, say so: `Cylinder(10, 20, at: V(0, 10, 0))`.
- **Commands never mutate their inputs.** Every one returns a new `Shape`, so an input can be reused as many times as you like.
- **Bad modifiers fail loudly.** An out-of-range value raises an `ArgumentException` naming the command and the offending number, and the worker reports it on the script error channel with the rest of the run's log. A script failure reads like a compiler error, not a stack trace.
- **Operators are shorthand.** `a + b` is `Union`, `a - b` is `Subtract`, `a & b` is `Intersect`.

## The voxel-size rule

Everything in a script runs inside one PicoGK library at the job's `voxelSizeMM`, so that single number sets the resolution of every voxel operation in the run.

- Booleans, offsets, shells and lattices are accurate to about **half a voxel**. A measured volume therefore differs from the analytic one by roughly surface area times half a voxel: a 20 mm cube at a 0.5 mm voxel measures about 8600 mm3, not 8000.
- **Any feature you care about needs several voxels across it.** A 1.2 mm lattice wall at a 0.3 mm voxel is four voxels thick, which is fine. The same wall at 0.6 mm is two, and it will look ragged.
- **Cost grows with the cube of resolution.** Halving the voxel size multiplies memory and time by roughly eight. Rough a design in at 0.4 to 0.6 mm, then drop to 0.15 to 0.2 mm for the final bake.
- Validate against it rather than guessing: `if (wallMM < 2 * VoxelSizeMM) throw new ArgumentException(...)`.

## Command reference

Every public Forge command, grouped the way you reach for them. Each entry gives the signature, one line on what it does, and a table of its modifiers: parameter, units, default and meaning. A parameter marked `required` has no default.

### Points

#### V

```csharp
Vec3 V(double x, double y, double z)
```

A point, offset or direction in millimetres. The short name is deliberate, because scripts read best as `V(10, 0, 4)`.

| Parameter | Units | Default | Meaning |
| --- | --- | --- | --- |
| `x` | mm | required | X coordinate. |
| `y` | mm | required | Y coordinate, the up axis. |
| `z` | mm | required | Z coordinate. |

A `Vec3` supports `+`, `-`, scaling by a number, a `Length` property, and converts implicitly to and from `System.Numerics.Vector3`.

#### Origin

```csharp
Vec3 Origin { get; }
```

The world origin, `V(0, 0, 0)`. It takes no modifiers. It is the default `at` of every builder and the default pivot of `ArrayRadial` and `Mirror`.

### Builders

Every builder returns a solid centred on `at`, which defaults to the world origin.

#### Box

```csharp
Shape Box(double x, double y, double z, Vec3? at = null)
```

An axis-aligned rectangular block.

| Parameter | Units | Default | Meaning |
| --- | --- | --- | --- |
| `x` | mm | required | Full extent along X. Must be greater than 0. |
| `y` | mm | required | Full extent along Y. Must be greater than 0. |
| `z` | mm | required | Full extent along Z. Must be greater than 0. |
| `at` | mm point | origin | Centre of the box. |

#### Cylinder

```csharp
Shape Cylinder(double d, double h, Vec3? at = null)
```

A circular cylinder standing along +Y.

| Parameter | Units | Default | Meaning |
| --- | --- | --- | --- |
| `d` | mm | required | Diameter. Must be greater than 0. |
| `h` | mm | required | Height along Y. Must be greater than 0. |
| `at` | mm point | origin | Centre of the cylinder. It spans `at.y` plus or minus `h/2`. |

#### Cone

```csharp
Shape Cone(double d, double h, Vec3? at = null)
```

A circular cone standing along +Y: base at `at.y - h/2`, apex at `at.y + h/2`.

| Parameter | Units | Default | Meaning |
| --- | --- | --- | --- |
| `d` | mm | required | Base diameter. Must be greater than 0. |
| `h` | mm | required | Height along Y. Must be greater than 0. |
| `at` | mm point | origin | Centre of the cone's bounding box. |

#### Sphere

```csharp
Shape Sphere(double d, Vec3? at = null)
```

A sphere.

| Parameter | Units | Default | Meaning |
| --- | --- | --- | --- |
| `d` | mm | required | Diameter. Must be greater than 0. |
| `at` | mm point | origin | Centre of the sphere. |

#### Capsule

```csharp
Shape Capsule(Vec3 a, Vec3 b, double d)
```

A sphere of diameter `d` swept along the straight line from `a` to `b`, so a rod with hemispherical ends. The workhorse for beams and struts.

| Parameter | Units | Default | Meaning |
| --- | --- | --- | --- |
| `a` | mm point | required | Start of the sweep axis. |
| `b` | mm point | required | End of the sweep axis. |
| `d` | mm | required | Diameter of the swept sphere. Must be greater than 0. |

#### Torus

```csharp
Shape Torus(double d, double ring, Vec3? at = null)
```

A torus lying in the XZ plane, so its axis of revolution is +Y: a ring you look through from above.

| Parameter | Units | Default | Meaning |
| --- | --- | --- | --- |
| `d` | mm | required | Diameter of the ring's **centre circle**. The outer diameter is `d + ring`. Must be greater than 0. |
| `ring` | mm | required | Diameter of the tube itself. Must be greater than 0. |
| `at` | mm point | origin | Centre of the torus. |

#### Loft

```csharp
Shape Loft(Func<double, double> radiusAtY, double y0, double y1)
```

A solid of revolution about +Y, built from a radius function. The rocket-nozzle, vase and trumpet-bell primitive. The profile is sampled finely enough for the job's voxel size, capped flat at both ends, and slope-corrected so steep profiles stay accurate.

| Parameter | Units | Default | Meaning |
| --- | --- | --- | --- |
| `radiusAtY` | mm from mm | required | Radius in mm at a given height y in mm, for example `y => 5 + 10 * Math.Pow(y / 40.0, 2)`. Negative returns clamp to 0. |
| `y0` | mm | required | Height where the solid starts. |
| `y1` | mm | required | Height where the solid ends. Must differ from `y0`. |

#### Pipe

```csharp
Shape Pipe(IEnumerable<Vec3> path, double d)
```

A round pipe following a polyline: the union of a capsule per segment, so corners round themselves and every joint is watertight.

| Parameter | Units | Default | Meaning |
| --- | --- | --- | --- |
| `path` | mm points | required | Two or more points along the pipe's centreline. |
| `d` | mm | required | Outside diameter. Must be greater than 0. Use `Shell` afterwards to hollow it. |

#### FromFile

```csharp
Shape FromFile(string path)
```

Load a solid from a **binary STL**, forcing millimetres. An STL carries no units and every part in ANVIL is mm.

| Parameter | Units | Default | Meaning |
| --- | --- | --- | --- |
| `path` | file path | required | Absolute path, or a bare filename resolved against the job's output folder, then `scripts-library\assets`, then `scripts-library`, then the repo root. |

**Builders in use.**

```csharp
Shape shaft  = Cylinder(d: 8, h: 40, at: V(0, 20, 0));      // stands on the XZ plane
Shape collar = Torus(d: 16, ring: 4, at: V(0, 34, 0));      // a bead near the top
Shape horn   = Loft(y => 4 + 12 * Math.Pow(y / 30.0, 2), 0, 30);
Shape strut  = Capsule(V(-20, 5, 0), V(20, 25, 0), d: 5);
```

### Combinators

Combinators fuse shapes. Inputs are never modified, so you can reuse one as many times as you like.

#### Union

```csharp
Shape Union(params Shape[] shapes)
```

Boolean union: everything that is solid in **any** input.

| Parameter | Units | Default | Meaning |
| --- | --- | --- | --- |
| `shapes` | shapes | required | Two or more shapes to fuse. One is returned unchanged. |

#### Subtract

```csharp
Shape Subtract(Shape a, params Shape[] cuts)
```

Boolean subtraction: `a` with every cutting shape removed.

| Parameter | Units | Default | Meaning |
| --- | --- | --- | --- |
| `a` | shape | required | The shape to cut into. |
| `cuts` | shapes | required | One or more shapes to remove from it. |

#### Intersect

```csharp
Shape Intersect(Shape a, Shape b)
```

Boolean intersection: only what is solid in **both** shapes.

| Parameter | Units | Default | Meaning |
| --- | --- | --- | --- |
| `a` | shape | required | First shape. |
| `b` | shape | required | Second shape. |

#### SmoothUnion

```csharp
Shape SmoothUnion(Shape a, Shape b, double radius)
```

Union with a blend: the two shapes are fused and the seam between them is filleted, so load flows through the joint instead of stopping at a sharp internal corner. It only ever **adds** material, and the original faces of both inputs survive untouched.

| Parameter | Units | Default | Meaning |
| --- | --- | --- | --- |
| `a` | shape | required | First shape. |
| `b` | shape | required | Second shape. |
| `radius` | mm | required | Blend radius. Must be greater than 0, and worth a few voxels or more, or the fillet cannot be resolved. |

**Combinators in use.**

```csharp
Shape body  = SmoothUnion(Box(60, 10, 40), Cylinder(d: 20, h: 24, at: V(0, 12, 0)), radius: 3);
Shape holes = ArrayLinear(Cylinder(d: 5, h: 30), count: 3, step: V(18, 0, 0));
Shape part  = Subtract(body, holes);                 // same as: body - holes
Shape lug   = Intersect(part, Box(30, 40, 40));      // same as: part & Box(...)
```

### Modifiers

Modifiers reshape one solid into a new one.

#### Move

```csharp
Shape Move(Shape shape, double x, double y, double z)
```

Translate a shape.

| Parameter | Units | Default | Meaning |
| --- | --- | --- | --- |
| `shape` | shape | required | Shape to move. |
| `x` | mm | required | Distance along X. |
| `y` | mm | required | Distance along Y. |
| `z` | mm | required | Distance along Z. |

#### RotateX

```csharp
Shape RotateX(Shape shape, double deg, Vec3? about = null)
```

Rotate about an axis parallel to X.

| Parameter | Units | Default | Meaning |
| --- | --- | --- | --- |
| `shape` | shape | required | Shape to rotate. |
| `deg` | degrees | required | Rotation, right-handed about +X. |
| `about` | mm point | the shape's bbox centre | Point the axis passes through. The default spins the shape in place. |

#### RotateY

```csharp
Shape RotateY(Shape shape, double deg, Vec3? about = null)
```

Rotate about an axis parallel to Y, the up axis.

| Parameter | Units | Default | Meaning |
| --- | --- | --- | --- |
| `shape` | shape | required | Shape to rotate. |
| `deg` | degrees | required | Rotation, right-handed about +Y. |
| `about` | mm point | the shape's bbox centre | Point the axis passes through. |

#### RotateZ

```csharp
Shape RotateZ(Shape shape, double deg, Vec3? about = null)
```

Rotate about an axis parallel to Z.

| Parameter | Units | Default | Meaning |
| --- | --- | --- | --- |
| `shape` | shape | required | Shape to rotate. |
| `deg` | degrees | required | Rotation, right-handed about +Z. |
| `about` | mm point | the shape's bbox centre | Point the axis passes through. |

#### Scale

```csharp
Shape Scale(Shape shape, double f, Vec3? about = null)
Shape Scale(Shape shape, double fx, double fy, double fz, Vec3? about = null)
```

Scale a shape, uniformly or per axis.

| Parameter | Units | Default | Meaning |
| --- | --- | --- | --- |
| `shape` | shape | required | Shape to scale. |
| `f` | factor | required | Uniform scale factor. 1 leaves it unchanged. Must be greater than 0. |
| `fx` / `fy` / `fz` | factor | required | Per-axis scale factors. Each must be greater than 0. |
| `about` | mm point | the shape's bbox centre | Fixed point of the scaling. The default grows the shape in place. |

#### Mirror

```csharp
Shape Mirror(Shape shape, string plane, Vec3? through = null)
```

Mirror across a world plane through a point, flipping triangle winding so the result re-voxelises as a solid rather than inside out.

| Parameter | Units | Default | Meaning |
| --- | --- | --- | --- |
| `shape` | shape | required | Shape to mirror. |
| `plane` | `"XY"` / `"YZ"` / `"XZ"` | required | `"XY"` is the z = 0 plane, `"YZ"` is x = 0, `"XZ"` is y = 0. Case-insensitive. |
| `through` | mm point | origin | A point the mirror plane passes through. |

#### Shell

```csharp
Shape Shell(Shape shape, double wall, string dir = "in")
```

Hollow a solid out into a wall of constant thickness.

| Parameter | Units | Default | Meaning |
| --- | --- | --- | --- |
| `shape` | shape | required | Solid to hollow. |
| `wall` | mm | required | Wall thickness. Must be greater than 0 and at least a couple of voxels. |
| `dir` | `"in"` / `"out"` / `"center"` | `"in"` | Where the wall sits relative to the original surface. `"in"` grows it inward and keeps the outer size, `"out"` grows it outward and keeps the inner cavity, `"center"` straddles the surface half each way. |

The result is a **closed** shell: shelling a solid whose ends are capped gives you a sealed vessel. For an open duct, loft or extrude the outer surface and subtract an over-length bore instead, as `rocket_nozzle.csx` does.

#### Offset

```csharp
Shape Offset(Shape shape, double d)
```

Grow or shrink a solid by moving every surface point along its normal. A positive distance rounds convex edges, a negative one rounds concave ones, which is how you deburr a part or add clearance to a mating face.

| Parameter | Units | Default | Meaning |
| --- | --- | --- | --- |
| `shape` | shape | required | Shape to offset. |
| `d` | mm, signed | required | Positive grows, negative shrinks. 0 is rejected. |

#### Smooth

```csharp
Shape Smooth(Shape shape, double r)
```

Round every edge of a solid, convex and concave alike, by a radius, using a triple offset. The cheap way to take the 3D-print edge off a part or blend a lattice into its skin.

| Parameter | Units | Default | Meaning |
| --- | --- | --- | --- |
| `shape` | shape | required | Shape to smooth. |
| `r` | mm | required | Rounding radius. Must be greater than 0. Features thinner than `2r` disappear. |

#### ArrayLinear

```csharp
Shape ArrayLinear(Shape shape, int count, Vec3 step)
```

Repeat a shape along a straight line and fuse the copies.

| Parameter | Units | Default | Meaning |
| --- | --- | --- | --- |
| `shape` | shape | required | Shape to repeat. Copy 0 is the shape where it already is. |
| `count` | count | required | Total number of copies including the original. Must be at least 1. |
| `step` | mm vector | required | Offset from one copy to the next. Must be non-zero when `count` is above 1. |

#### ArrayRadial

```csharp
Shape ArrayRadial(Shape shape, int count, double radius, Vec3? about = null)
```

Repeat a shape evenly around the +Y axis and fuse the copies. Each copy is first pushed out along +X by `radius`, then rotated into place, so a radius of 0 spins the copies about the axis itself.

| Parameter | Units | Default | Meaning |
| --- | --- | --- | --- |
| `shape` | shape | required | Shape to repeat. |
| `count` | count | required | Number of copies around the full 360 degrees. Must be at least 1. |
| `radius` | mm | required | Distance from the axis to each copy. May be 0. |
| `about` | mm point | origin | Point the +Y axis passes through. |

#### Lattice

```csharp
Shape Lattice(Shape shape, string pattern = "gyroid", double cell = 8, double wall = 1.2,
              string type = "sheet", double bias = 0,
              Vec3? rotDeg = null, Vec3? phase = null, Vec3? cellXYZ = null)
```

Fill a solid with a triply periodic minimal surface (TPMS) lattice, clipped exactly to the shape. This is the infill engine: a **sheet** gyroid splits the interior into two interpenetrating channels that never touch, a **skeletal** one leaves a single connected strut network.

| Parameter | Units | Default | Meaning |
| --- | --- | --- | --- |
| `shape` | shape | required | The envelope to fill. Only the lattice inside it survives. |
| `pattern` | name | `"gyroid"` | `"gyroid"`, `"schwarzP"`, `"schwarzD"`, `"lidinoid"` or `"neovius"`. Case-insensitive. |
| `cell` | mm | `8` | Unit cell size. Smaller means a finer lattice and more triangles. |
| `wall` | mm | `1.2` | Wall thickness for sheet lattices. Ignored when `type` is `"skeletal"`. |
| `type` | `"sheet"` / `"skeletal"` | `"sheet"` | A wall around the surface, or a solid strut network. |
| `bias` | mm | `0` | Skeletal solid-fraction bias. 0 is roughly 50 percent solid; negative is less solid. Ignored for `"sheet"`. |
| `rotDeg` | degrees vector | none | Rotation of the lattice **field** about the shape's bbox centre, in degrees X/Y/Z. The part itself never moves. |
| `phase` | cell fractions, 0 to 1 | none | Phase shift of the lattice field per axis. Use it to align cells with a wall. |
| `cellXYZ` | mm vector | none | Per-axis cell size, overriding `cell` where an entry is greater than 0. The way to make a stretched, directional lattice. |

#### Emboss

```csharp
Shape Emboss(Shape shape, string imagePath, string face = "+y",
             double depth = 1, string mode = "raise", double marginMM = 0)
```

Bake a grayscale depth map onto one face of a part. The image is projected along the chosen face's normal from that face of the shape's bounding box: **white is full effect, black is none**, and greys ramp smoothly between them. The map is sampled bilinearly, so the result is a smooth relief rather than a staircase. The image keeps its aspect ratio and is centred on the face. Raised material is trimmed back to within one depth of the real surface, so a map applied to a strongly curved face simply fades out where the surface drops away.

| Parameter | Units | Default | Meaning |
| --- | --- | --- | --- |
| `shape` | shape | required | The part to decorate. |
| `imagePath` | file path | required | PNG, JPG or BMP. Absolute, or a bare filename resolved against the job folder, then `scripts-library\assets`. |
| `face` | face name | `"+y"` | Which bounding-box face to project onto: `"+x"`, `"-x"`, `"+y"` (the top), `"-y"`, `"+z"` or `"-z"`. |
| `depth` | mm | `1` | Relief height at pure white. Must be greater than 0 and worth several voxels. |
| `mode` | `"raise"` / `"cut"` | `"raise"` | `"raise"` adds material outward, `"cut"` engraves inward. |
| `marginMM` | mm | `0` | Inset of the mapped region from the edges of the face. |

**Modifiers in use.**

```csharp
Shape tank    = Shell(Sphere(d: 60), wall: 2, dir: "in");         // 2 mm sealed shell
Shape deburr  = Smooth(Box(40, 12, 40), r: 1.5);                  // every edge rounded
Shape ribs    = ArrayRadial(Box(2, 20, 14), count: 8, radius: 18);
Shape core    = Lattice(Cylinder(d: 40, h: 30), cell: 6, wall: 1.0, type: "sheet");
Shape badged  = Emboss(deburr, "emboss-sample.png", face: "+y", depth: 0.8, marginMM: 4);
```

### Info

Measure a shape without saving it.

#### Volume

```csharp
double Volume(Shape shape)
```

Solid volume in cubic millimetres, measured on the voxel field, so it carries the usual half-voxel discretisation error.

| Parameter | Units | Default | Meaning |
| --- | --- | --- | --- |
| `shape` | shape | required | Shape to measure. |

#### BBox

```csharp
Bounds BBox(Shape shape)
```

The axis-aligned bounding box of a shape, in mm.

| Parameter | Units | Default | Meaning |
| --- | --- | --- | --- |
| `shape` | shape | required | Shape to measure. |

#### Center

```csharp
Vec3 Center(Shape shape)
```

The centre of a shape's bounding box, in mm. Handy as the `about` of a rotation, or the `at` of the next feature.

| Parameter | Units | Default | Meaning |
| --- | --- | --- | --- |
| `shape` | shape | required | Shape to measure. |

**Info in use.**

```csharp
Shape part = Subtract(Box(50, 20, 30), Cylinder(d: 10, h: 40));
Bounds bb  = BBox(part);
Log($"{Volume(part):0.#} mm3, {bb.Size.x} x {bb.Size.y} x {bb.Size.z} mm, top at {bb.Max.y}");
Shape cap  = Cylinder(d: 12, h: 4, at: Center(part) + V(0, bb.Size.y * 0.5, 0));
```

### The Shape and Bounds types

A `Shape` is the single value every command consumes and produces.

| Member | Meaning |
| --- | --- |
| `shape.Volume` | Same as `Volume(shape)`, in mm3. |
| `shape.Bounds` | Same as `BBox(shape)`. |
| `shape.Voxels` | The underlying PicoGK voxel field, for raw kernel calls. |
| `shape.ToMesh()` | Mesh the shape (marching cubes over the voxel field). |
| `a + b`, `a - b`, `a & b` | `Union`, `Subtract`, `Intersect`. |
| implicit conversion | A `Shape` is accepted anywhere a `Voxels` is expected, and the other way round. |

`Bounds` is what `BBox` returns.

| Member | Meaning |
| --- | --- |
| `Min` / `Max` | The corners with the smallest and largest X, Y and Z, in mm. |
| `Size` | Full extent on each axis, `Max - Min`, in mm. |
| `Center` | Midpoint of the box, in mm. |
| `MaxSize` | The largest of the three extents, in mm. |

## Worked example: the rocket nozzle

[`scripts-library/rocket_nozzle.csx`](../scripts-library/rocket_nozzle.csx) turns six engineering numbers into a printable bell nozzle in about 12 seconds at a 0.3 mm voxel. It is the clearest demonstration of why geometry is worth writing as code: the contour is not drawn, it is **derived**.

**1. Read the inputs.** Every number comes through `ParamF`, so one script is a family of nozzles.

```csharp
double throatDiaMM  = ParamF("throatDiaMM", 12f);
double exitDiaMM    = ParamF("exitDiaMM", 40f);
double chamberDiaMM = ParamF("chamberDiaMM", 30f);
double lengthMM     = ParamF("lengthMM", 60f);
double wallMM       = ParamF("wallMM", 1.6f);
double bellFraction = ParamF("bellFraction", 0.8f);
```

It then rejects impossible combinations up front (an exit smaller than the throat, a wall thinner than two voxels), so a bad call fails with a sentence rather than an empty part.

**2. Do the engineering.** The expansion area ratio sets everything downstream. The bell length is `bellFraction` of the length of a 15 degree conical nozzle with the same area ratio, which is what "80 percent bell" means, and whatever length is left over becomes the convergent section.

```csharp
double areaRatio = (rExit / rThroat) * (rExit / rThroat);
double coneLen   = (rExit - rThroat) / Math.Tan(15.0 * Math.PI / 180.0);
double bellLen   = bellFraction * coneLen;
double convLen   = lengthMM - bellLen;
```

The Rao wall angles `thetaN` (leaving the throat) and `thetaE` (arriving at the exit plane) come from a smooth fit to the published charts as a function of area ratio. That is a shaping approximation, not a method-of-characteristics contour, and the script says so in its header.

**3. Build the contour as a function.** The divergent half is a quadratic Bezier whose control point is where the two tangents cross. Because `y(t)` is monotonic, a 36-step bisection inverts it, so the Bezier can be read as a radius at a height. The convergent half is a raised cosine, which lands on the throat with zero slope and gives a rounded throat with no crease.

```csharp
double y1 = (r2 - r0 - m2 * y2 + m0 * y0) / (m0 - m2);   // tangent intersection
double r1 = r0 + m0 * (y1 - y0);

Func<double, double> innerRadius = y =>
{
    double yc = Math.Clamp(y, 0.0, lengthMM);
    return yc <= convLen ? ConvergentRadius(yc) : BellRadius(yc);
};
```

**4. Make it a wall.** `Loft` revolves the outer surface, a second `Loft` revolves the bore and runs it past both ends so the part is a tube rather than a bottle, and one `Subtract` leaves a constant `wallMM` wall.

```csharp
Shape outerSolid = Loft(y => innerRadius(y) + wallMM, 0, lengthMM);
Shape bore       = Loft(innerRadius, -overrun, lengthMM + overrun);
```

`Shell(outerSolid, wallMM)` is the wrong tool here: `Loft` caps its own ends, so shelling it would seal the throat and the exit.

**5. Add the flange.** A `Cylinder` disc plus a `Torus` bead is a flange with a rolled rim, and `SmoothUnion` fuses it to the nozzle with a fillet instead of a sharp internal corner. The bore is subtracted **after** the flange goes on, which reopens the inlet the disc had covered.

```csharp
Shape flange = Union(flangeDisc, flangeBead);
Shape body   = SmoothUnion(outerSolid, flange, radius: Math.Max(wallMM, 1.0));
body = Subtract(body, bore);
```

**6. Array in both directions.** `ArrayRadial` appears twice, once as a cutter and once as an adder. Bolt holes are one cylinder pushed out to the bolt circle and spun; the regenerative cooling tubes are one `Pipe` swept along the outer contour and spun about the axis with `radius: 0`.

```csharp
body = Subtract(body, ArrayRadial(onePin, boltHoles, radius: boltCircleR));
...
Shape oneTube = Pipe(tubePath, tubeDiaMM);
body = Union(body, ArrayRadial(oneTube, coolingTubes, radius: 0));
```

**7. Report and save.** `Volume` and `BBox` go to the log so the run is auditable, and `SavePart` meshes, cleans, watertight-checks and registers the result.

```csharp
Bounds bb = BBox(body);
Log($"nozzle: {Volume(body):0.#} mm3, bbox {bb.Size}, exit plane at y = {bb.Max.y:0.##} mm");
SavePart("rocket_nozzle", body);
```

At the defaults this produces a watertight part of about 18,200 mm3 in a 56.4 by 61.5 by 56.4 mm box, roughly 613,000 triangles. Change `exitDiaMM` to 60 and every one of those numbers follows, with no redraw.

## Example scripts

All of these ship in [`scripts-library/`](../scripts-library) and appear in the SCRIPTS template picker. Runtimes are at the default 0.3 mm voxel.

| Script | What it makes | Shows off |
| --- | --- | --- |
| [`rocket_nozzle.csx`](../scripts-library/rocket_nozzle.csx) | A parametric bell nozzle with a bolted chamber flange and regenerative cooling tubes. About 12 s. | `Loft`, `Subtract`, `Cylinder`, `Torus`, `Union`, `SmoothUnion`, `ArrayRadial` both ways, `Pipe`. |
| [`embossed_card.csx`](../scripts-library/embossed_card.csx) | A rounded card with the same depth map raised on the front and engraved on the back. About 12 s. | `Box`, `Smooth`, `Emboss` in both modes, `BBox`, `Volume`. |
| [`manifold_block.csx`](../scripts-library/manifold_block.csx) | A ported pneumatic manifold whose internal gallery is filled with a gyroid. About 6 s. | `ArrayLinear`, `Pipe`, `Union`, `Subtract`, `Intersect`, `Lattice`. |
| [`heat_exchanger_core.csx`](../scripts-library/heat_exchanger_core.csx) | A parametric gyroid heat-exchanger core. | The raw PicoGK route: `MeshUtil`, `TPMSWall`, `voxIntersectImplicit`. |
| [`graded_lattice_puck.csx`](../scripts-library/graded_lattice_puck.csx) | A puck filled with a radially graded skeletal gyroid. | Writing your own `IImplicit` when a fixed-parameter field is not enough. |
| [`forge_smoke.csx`](../scripts-library/forge_smoke.csx) | Two demo parts, plus an assertion per command. | Every Forge command checked against its analytic answer. Read it as an executable spec. |

## Gotchas

- **`Log` is the script logger, and it hides `System.Math.Log`.** Write `Math.Log(x)` in full for a natural logarithm. The same applies to any other name the globals and `System.Math` share.
- **`Smooth` trims as well as rounds.** It is a triple offset, so a 4 mm slab smoothed at 1.5 mm measures about 3.6 mm at a 0.3 mm voxel. Add the loss back into your nominal size if the finished number matters.
- **`Shell` seals capped solids.** See the note under [Shell](#shell).
- **An empty result is an error, not a silent success.** `Shell`, `Offset`, `Smooth` and `Lattice` all raise if the operation removed everything, and the message names the number that did it.
- **`at` is a centre, not a corner, and nothing lands on the plate by itself.** `Cylinder(10, 20)` straddles y = 0. Use `at: V(0, 10, 0)` to stand it up.
- **`ArrayRadial(shape, n, radius: 0)` spins copies about the world +Y axis**, not about each copy's own centre. Pass `about` to move the axis.
- **Measured volumes carry half a voxel of skin.** Compare shapes at the same voxel size before concluding that a change did something.
- **Declaring a class inside a script is legal**, and `graded_lattice_puck.csx` does exactly that to define a custom `IImplicit`. Local functions at the top level are fine too, as long as they are declared after the locals they capture.

## Security

> [!CAUTION]
> **Scripts execute arbitrary C# with your full user privileges. There is no sandbox.**

A `.csx` can read, write and delete anything your account can, open network connections, and start processes. Per-job worker processes give crash isolation and cleanup, **not** a security boundary. The server binds `127.0.0.1` only and has no authentication, and connecting an agent to `/mcp` grants that agent code execution on this machine.

Treat a script exactly like an executable someone handed you: read it before you run it. The full policy is in the [README security section](../README.md#security) and [SECURITY.md](../.github/SECURITY.md).

---

Back to the [README](../README.md), the [scripting overview](../README.md#scripting) and the [HTTP API table](../README.md#http-api).
