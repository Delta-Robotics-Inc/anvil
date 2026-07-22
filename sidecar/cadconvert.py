r"""cadconvert.py -- STEP <-> STL sidecar for the Infill App.

Run with:  C:\Python314\python.exe cadconvert.py <subcommand> ...

Subcommands
    step2stl  IN.step OUT.stl [--lin-tol 0.1] [--ang-tol 0.3]
    stl2step  IN.stl  OUT.step [--max-tris 500000]
    checkstep IN.step

Output contract
    Success -> exit 0, a SINGLE result JSON object on stdout.
    Failure -> non-zero exit, a SINGLE error JSON object on stderr:
               {"error": "...", "detail": "..."}

IMPORTANT for the consuming server: OCCT (STEP reader/writer, meshers) can emit
progress/warning chatter on the native stdout stream. To keep stdout parseable
we redirect the native stdout file descriptor to devnull for the whole duration
of processing and restore it only to print the final result line. As a belt-and-
braces guarantee, the result JSON is always the LAST line written to stdout, so
the server should parse the LAST non-empty line of stdout as JSON.

Coordinate preservation: no command ever translates, recenters, or rescales
geometry. import_step / export_stl / the faceted-BRep path all operate in the
source world frame -- this is a core product guarantee (CAD insert-in-place).

Dependencies: build123d, cadquery-ocp (OCP), and the stdlib only.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time

from build123d import import_step, export_stl

from OCP.RWStl import RWStl
from OCP.BRepBuilderAPI import (
    BRepBuilderAPI_MakeShapeOnMesh,
    BRepBuilderAPI_Sewing,
    BRepBuilderAPI_MakeSolid,
    BRepBuilderAPI_MakePolygon,
    BRepBuilderAPI_MakeFace,
)
from OCP.ShapeFix import ShapeFix_Solid
from OCP.STEPControl import STEPControl_Writer, STEPControl_StepModelType
from OCP.IFSelect import IFSelect_ReturnStatus
from OCP.BRepCheck import BRepCheck_Analyzer
from OCP.TopExp import TopExp_Explorer
from OCP.TopAbs import TopAbs_ShapeEnum
from OCP.TopoDS import TopoDS


# Policy thresholds (see plan). Warn on dense meshes; refuse on very dense ones.
WARN_TRIS = 150_000
DEFAULT_MAX_TRIS = 500_000


class SidecarError(Exception):
    """A clean, reportable failure -> JSON error object on stderr."""


# ---------------------------------------------------------------------------
# Native-stdout silencer: redirect fd 1 -> devnull during OCCT work so its
# C++ chatter never corrupts the JSON we print afterwards.
# ---------------------------------------------------------------------------
class _NativeStdoutSilencer:
    def __init__(self):
        self._saved_fd = None
        self._devnull_fd = None

    def start(self):
        if self._saved_fd is not None:
            return
        sys.stdout.flush()
        self._saved_fd = os.dup(1)
        self._devnull_fd = os.open(os.devnull, os.O_WRONLY)
        os.dup2(self._devnull_fd, 1)

    def stop(self):
        # Idempotent: safe to call more than once.
        if self._saved_fd is None:
            return
        sys.stdout.flush()
        os.dup2(self._saved_fd, 1)
        os.close(self._devnull_fd)
        os.close(self._saved_fd)
        self._saved_fd = None
        self._devnull_fd = None


# ---------------------------------------------------------------------------
# Small topology helpers
# ---------------------------------------------------------------------------
def _explore(shape, enum):
    """Yield every sub-shape of the given TopAbs enum within `shape`."""
    exp = TopExp_Explorer(shape, enum)
    while exp.More():
        yield exp.Current()
        exp.Next()


def _count(shape, enum):
    return sum(1 for _ in _explore(shape, enum))


def _require_file(path, label):
    if not os.path.isfile(path):
        raise SidecarError(f"{label} not found: {path}")


# ---------------------------------------------------------------------------
# step2stl
# ---------------------------------------------------------------------------
def cmd_step2stl(in_step, out_stl, lin_tol, ang_tol):
    _require_file(in_step, "input STEP")

    shape = import_step(in_step)  # build123d Compound; world frame preserved

    # Binary STL is mandatory -- PicoGK throws on ASCII STL.
    ok = export_stl(
        shape,
        out_stl,
        tolerance=lin_tol,
        angular_tolerance=ang_tol,
        ascii_format=False,
    )
    if not ok or not os.path.isfile(out_stl):
        raise SidecarError(f"export_stl failed to write {out_stl}")

    # Triangle count: read the written STL back (RWStl welds coincident nodes,
    # NbTriangles is the true facet count).
    tri = RWStl.ReadFile_s(out_stl)
    if tri is None:
        raise SidecarError("wrote STL but could not read it back to count triangles")
    n_tris = int(tri.NbTriangles())

    # Analytic bbox from the source shape (authoritative world coordinates).
    bb = shape.bounding_box()
    return {
        "triangles": n_tris,
        "bbox": {
            "min": [bb.min.X, bb.min.Y, bb.min.Z],
            "max": [bb.max.X, bb.max.Y, bb.max.Z],
        },
    }


# ---------------------------------------------------------------------------
# stl2step (faceted-BRep conversion)
# ---------------------------------------------------------------------------
def _faces_shape_via_makeshapeonmesh(tri):
    """Primary path: BRepBuilderAPI_MakeShapeOnMesh.

    In OCP 7.9 this returns a COMPOUND of loose per-triangle planar faces (not
    a sewn shell), so the caller must still sew the result. Returns the faces
    compound, or None if the builder is unavailable / did not complete.
    """
    try:
        mk = BRepBuilderAPI_MakeShapeOnMesh(tri)
        mk.Build()
        if not mk.IsDone():
            return None
        shp = mk.Shape()
    except Exception:
        return None
    if _count(shp, TopAbs_ShapeEnum.TopAbs_FACE) == 0:
        return None
    return shp


def _faces_via_manual(tri):
    """Fallback path: build one planar face per triangle by hand."""
    faces = []
    n = int(tri.NbTriangles())
    for i in range(1, n + 1):
        a, b, c = tri.Triangle(i).Get()
        pa, pb, pc = tri.Node(a), tri.Node(b), tri.Node(c)
        poly = BRepBuilderAPI_MakePolygon(pa, pb, pc, True)  # closed wire
        if not poly.IsDone():
            continue
        mf = BRepBuilderAPI_MakeFace(poly.Wire(), True)  # planar face
        if not mf.IsDone():
            continue
        faces.append(mf.Face())
    if not faces:
        return None
    return faces


def _sew(faces, tol):
    """Sew a faces-compound (Load) or a list of faces (Add) into a shell."""
    sew = BRepBuilderAPI_Sewing(tol)
    if isinstance(faces, list):
        for f in faces:
            sew.Add(f)
    else:
        sew.Load(faces)
    sew.Perform()
    return sew.SewedShape()


def _solid_from_sewed(sewed):
    """Build + repair a solid from a sewed result. Returns (solid, n_shells)."""
    if sewed.ShapeType() == TopAbs_ShapeEnum.TopAbs_SHELL:
        shells = [sewed]
    else:
        shells = list(_explore(sewed, TopAbs_ShapeEnum.TopAbs_SHELL))
    if not shells:
        return None, 0

    mk = BRepBuilderAPI_MakeSolid()
    for s in shells:
        mk.Add(TopoDS.Shell_s(s))
    mk.Build()
    if not mk.IsDone():
        return None, len(shells)
    solid = mk.Solid()

    fix = ShapeFix_Solid()
    fix.Init(solid)
    fix.Perform()
    fixed = fix.Solid()
    return (fixed if fixed is not None else solid), len(shells)


def cmd_stl2step(in_stl, out_step, max_tris):
    _require_file(in_stl, "input STL")
    t0 = time.perf_counter()

    tri = RWStl.ReadFile_s(in_stl)
    if tri is None:
        raise SidecarError(f"could not read STL (empty or not a valid STL): {in_stl}")
    n_tris = int(tri.NbTriangles())
    if n_tris == 0:
        raise SidecarError("STL contains no triangles")
    if n_tris > max_tris:
        raise SidecarError(
            f"refusing: {n_tris} triangles exceeds --max-tris {max_tris}. "
            f"Decimate/coarse-remesh the mesh before STEP conversion."
        )

    warning = None
    if n_tris > WARN_TRIS:
        warning = (
            f"dense mesh: {n_tris} triangles (> {WARN_TRIS}); "
            f"STEP conversion will be slow and the file large"
        )

    # Sewing tolerance: RWStl already welds coincident nodes, so a tight
    # tolerance sews exactly. Retry looser if the first pass yields no shell.
    faces_primary = _faces_shape_via_makeshapeonmesh(tri)

    solid = None
    n_shells = 0
    for tol in (1e-6, 1e-4, 1e-3):
        if faces_primary is not None:
            solid, n_shells = _solid_from_sewed(_sew(faces_primary, tol))
            if solid is not None:
                break
        # Fallback: hand-built faces (also used if MakeShapeOnMesh was absent).
        manual = _faces_via_manual(tri)
        if manual is not None:
            solid, n_shells = _solid_from_sewed(_sew(manual, tol))
            if solid is not None:
                break
    if solid is None:
        raise SidecarError(
            "mesh did not sew into a closed shell; cannot build a solid "
            "(is the mesh watertight?)"
        )

    writer = STEPControl_Writer()
    status = writer.Transfer(solid, STEPControl_StepModelType.STEPControl_AsIs)
    if status != IFSelect_ReturnStatus.IFSelect_RetDone:
        raise SidecarError(f"STEP transfer failed (status {status})")
    status = writer.Write(out_step)
    if status != IFSelect_ReturnStatus.IFSelect_RetDone:
        raise SidecarError(f"STEP write failed (status {status})")

    return {
        "triangles": n_tris,
        "warning": warning,
        "seconds": round(time.perf_counter() - t0, 3),
    }


# ---------------------------------------------------------------------------
# checkstep
# ---------------------------------------------------------------------------
def cmd_checkstep(in_step):
    _require_file(in_step, "input STEP")
    shape = import_step(in_step)
    wrapped = shape.wrapped
    valid = bool(BRepCheck_Analyzer(wrapped).IsValid())
    return {
        "valid": valid,
        "solids": _count(wrapped, TopAbs_ShapeEnum.TopAbs_SOLID),
        "shells": _count(wrapped, TopAbs_ShapeEnum.TopAbs_SHELL),
    }


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def _build_parser():
    p = argparse.ArgumentParser(
        prog="cadconvert.py", description="STEP<->STL sidecar for the Infill App."
    )
    sub = p.add_subparsers(dest="cmd", required=True)

    a = sub.add_parser("step2stl", help="STEP -> binary STL")
    a.add_argument("in_step")
    a.add_argument("out_stl")
    a.add_argument("--lin-tol", type=float, default=0.1, help="linear deflection")
    a.add_argument("--ang-tol", type=float, default=0.3, help="angular deflection")

    b = sub.add_parser("stl2step", help="STL -> faceted-BRep STEP")
    b.add_argument("in_stl")
    b.add_argument("out_step")
    b.add_argument("--max-tris", type=int, default=DEFAULT_MAX_TRIS)

    c = sub.add_parser("checkstep", help="validate a STEP file")
    c.add_argument("in_step")

    return p


def main(argv=None):
    # Parse BEFORE silencing stdout so --help / usage errors reach the console.
    args = _build_parser().parse_args(argv)

    silencer = _NativeStdoutSilencer()
    silencer.start()
    try:
        if args.cmd == "step2stl":
            result = cmd_step2stl(args.in_step, args.out_stl, args.lin_tol, args.ang_tol)
        elif args.cmd == "stl2step":
            result = cmd_stl2step(args.in_stl, args.out_step, args.max_tris)
        elif args.cmd == "checkstep":
            result = cmd_checkstep(args.in_step)
        else:  # pragma: no cover -- argparse enforces choices
            raise SidecarError(f"unknown subcommand: {args.cmd}")
    except SidecarError as e:
        silencer.stop()
        sys.stderr.write(json.dumps({"error": "SidecarError", "detail": str(e)}) + "\n")
        sys.stderr.flush()
        return 1
    except Exception as e:  # noqa: BLE001 -- surface any failure as JSON
        silencer.stop()
        sys.stderr.write(
            json.dumps({"error": type(e).__name__, "detail": str(e)}) + "\n"
        )
        sys.stderr.flush()
        return 1

    silencer.stop()
    # Result JSON is always the LAST line on stdout (see module docstring).
    sys.stdout.write(json.dumps(result) + "\n")
    sys.stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
