"""make_test_parts.py -- generate STEP test parts for the Infill App.

Writes three STEP files into the samples/ dir (or a --out dir) that exercise
both product workflows:

  positive.step        60x40x20 box with a fully-enclosed 50x30x12 rectangular
                       internal cavity (outer box MINUS a centered inner box).
                       Workflow B "positive".
  negative.step        the 50x30x12 cavity solid ALONE, modeled in the SAME
                       world coordinate frame it occupies inside positive.step
                       (centered at the global origin). Workflow B "negative".
  hollow_bracket.step  a small single-solid L-bracket (~50 mm) suitable for
                       Workflow A (gyroidize the whole solid).

The whole point of positive/negative is that they live in ONE common global
coordinate system: the inner cavity of positive.step and the standalone
negative.step occupy the exact same world coordinates. Nothing is ever
re-centered or exported centered-at-origin individually -- coordinate
preservation is a core product guarantee (CAD insert-in-place).

Run:  C:\\Python314\\python.exe make_test_parts.py [--out DIR]
Prints a JSON summary of the files written and their world bounding boxes.
"""

from __future__ import annotations

import argparse
import json
import os
import sys

from build123d import Box, Pos, export_step


# ---- Common world frame -------------------------------------------------
# build123d's Box is centered on its local origin. By building every part on
# the SAME global origin, the inner cavity of the positive and the standalone
# negative end up at identical world coordinates -- exactly what Workflow B
# needs. No part is ever recentered before export.

OUTER = (60.0, 40.0, 20.0)   # positive outer box (X, Y, Z)
CAVITY = (50.0, 30.0, 12.0)  # internal cavity / negative solid (X, Y, Z)


def build_positive():
    """60x40x20 box minus a centered, fully-enclosed 50x30x12 cavity."""
    outer = Box(*OUTER)
    inner = Box(*CAVITY)          # centered at the global origin
    return outer - inner          # a single solid with an internal void


def build_negative():
    """The cavity solid alone, in the same world frame it sits at above."""
    return Box(*CAVITY)           # centered at the global origin, same as inner


def build_hollow_bracket():
    """A single-solid L-bracket ~50 mm, for Workflow A.

    Two overlapping boxes unioned into one solid: a flat base plate and an
    upstanding wall sharing a corner. Modeled off the global origin (its own
    natural frame -- Workflow A only needs coordinate preservation, not a
    shared frame with anything else).
    """
    # Base plate: 50 (X) x 30 (Y) x 5 (Z), bottom face at z = 0.
    base = Pos(0, 0, 2.5) * Box(50.0, 30.0, 5.0)
    # Upstanding wall: 5 (X) x 30 (Y) x 45 (Z), left edges aligned with base,
    # rising from z = 0 to z = 45. Overlaps the base so the union is one solid.
    wall = Pos(-22.5, 0, 22.5) * Box(5.0, 30.0, 45.0)
    return base + wall


def _bbox(shape):
    bb = shape.bounding_box()
    return {
        "min": [bb.min.X, bb.min.Y, bb.min.Z],
        "max": [bb.max.X, bb.max.Y, bb.max.Z],
    }


def main(argv=None):
    ap = argparse.ArgumentParser(description="Generate STEP test parts.")
    ap.add_argument(
        "--out",
        default=os.path.dirname(os.path.abspath(__file__)),
        help="output directory (default: this script's directory)",
    )
    args = ap.parse_args(argv)

    out_dir = os.path.abspath(args.out)
    os.makedirs(out_dir, exist_ok=True)

    parts = {
        "positive.step": build_positive(),
        "negative.step": build_negative(),
        "hollow_bracket.step": build_hollow_bracket(),
    }

    summary = {"outDir": out_dir, "files": []}
    for name, shape in parts.items():
        path = os.path.join(out_dir, name)
        export_step(shape, path)
        n_solids = len(shape.solids())
        summary["files"].append(
            {
                "file": name,
                "path": path,
                "solids": n_solids,
                "bbox": _bbox(shape),
            }
        )

    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
