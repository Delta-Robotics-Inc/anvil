// graded_lattice_puck.csx
// ---------------------------------------------------------------------------
// A cylindrical puck (Ø40 × 15 mm) filled with a skeletal gyroid whose density
// is GRADED radially — dense at the rim, open in the middle (a stiff-shell /
// light-core disc, the kind of functional grading additive manufacturing is
// uniquely good at).
//
// Technique: a custom IImplicit. TPMSWall is fixed-parameter, so to vary the
// lattice across space we write our own signed-distance field whose skeletal
// BIAS is a function of radius. A skeletal gyroid is solid where
//     gyroid(x,y,z) < bias
// so raising the bias toward the rim thickens the solid network there. Anvil
// voxelises any IImplicit via voxIntersectImplicit, so this "just works".
//
// Orientation: the puck STANDS ON THE PLATE, axis along +Z, z in [0, heightMM].
// The envelope is built with Cylinder(..., axis: "z") and the grading field
// measures its radius in the XY plane to match.
//
// Parameters (all optional):
//   diaMM       puck diameter                 (default 40)
//   heightMM    puck height (Z, the up axis)  (default 15)
//   cellMM      gyroid unit-cell              (default 6)
//   biasCenter  skeletal bias at the axis     (default -0.6, sparser)
//   biasRim     skeletal bias at the rim      (default  0.6, denser)
// ---------------------------------------------------------------------------

float diaMM      = ParamF("diaMM", 40f);
float heightMM   = ParamF("heightMM", 15f);
float cellMM     = ParamF("cellMM", 6f);
float biasCenter = ParamF("biasCenter", -0.6f);
float biasRim    = ParamF("biasRim", 0.6f);

Log($"graded puck: Ø{diaMM} × {heightMM}mm, cell {cellMM}mm, bias {biasCenter}→{biasRim}");

// A radially-graded skeletal gyroid as a signed-distance field. Declaring a
// class inside a script is fine — the script body follows.
class RadialGradedGyroid : IImplicit
{
    readonly float m_k;      // angular frequency 2π/cell
    readonly float m_grad;   // |∇f| normaliser ≈ k·√3
    readonly float m_bias0;  // bias at r = 0
    readonly float m_bias1;  // bias at r = rMax
    readonly float m_rMax;
    readonly Vector3 m_c;

    public RadialGradedGyroid(float cellMM, float bias0, float bias1, float rMax, Vector3 center)
    {
        m_k     = 2f * MathF.PI / cellMM;
        m_grad  = m_k * MathF.Sqrt(3f);
        m_bias0 = bias0;
        m_bias1 = bias1;
        m_rMax  = rMax > 0f ? rMax : 1f;
        m_c     = center;
    }

    public float fSignedDistance(in Vector3 v)
    {
        // The puck STANDS IN Z, so the radial coordinate is measured in the
        // XY plane — the grading has to run out to the rim, not up the axis.
        float dx = v.X - m_c.X, dy = v.Y - m_c.Y;
        float r  = MathF.Sqrt(dx * dx + dy * dy);
        float t  = Math.Clamp(r / m_rMax, 0f, 1f);
        float bias = m_bias0 + (m_bias1 - m_bias0) * t;

        float kx = m_k * v.X, ky = m_k * v.Y, kz = m_k * v.Z;
        float g  = MathF.Sin(kx) * MathF.Cos(ky)
                 + MathF.Sin(ky) * MathF.Cos(kz)
                 + MathF.Sin(kz) * MathF.Cos(kx);

        // Solid where g < bias  ⇒  signed distance (g - bias)/grad ≤ 0.
        return (g - bias) / m_grad;
    }
}

// Solid puck envelope, standing on the plate along +Z: z in [0, heightMM].
Shape puck = Cylinder(d: diaMM, h: heightMM, at: V(0, 0, heightMM * 0.5f), axis: "z");

// Clip the graded skeletal gyroid to the puck. voxIntersectImplicit walks only
// the voxels the envelope already occupies, so the field is never sampled over
// empty space.
var field = new RadialGradedGyroid(cellMM, biasCenter, biasRim, diaMM * 0.5f, Vector3.Zero);
Voxels voxGraded = ((Voxels)puck).voxIntersectImplicit(field);

Bounds bb = BBox(voxGraded);
Log($"puck: {Volume(voxGraded):0.#} mm3, bbox {bb.Size}, standing on the plate from z = {bb.Min.z:0.##} to {bb.Max.z:0.##} mm");
SavePart("graded_lattice_puck", voxGraded);
