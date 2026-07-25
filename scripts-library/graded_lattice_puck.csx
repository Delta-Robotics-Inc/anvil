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
// Parameters (all optional):
//   diaMM       puck diameter               (default 40)
//   heightMM    puck height (Y, the up axis)  (default 15)
//   cellMM      gyroid unit-cell            (default 6)
//   biasCenter  skeletal bias at the axis   (default -0.6, sparser)
//   biasRim     skeletal bias at the rim    (default  0.6, denser)
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
        // The puck STANDS IN Y, so the radial coordinate is measured in the
        // XZ plane — the grading has to run out to the rim, not up the axis.
        float dx = v.X - m_c.X, dz = v.Z - m_c.Z;
        float r  = MathF.Sqrt(dx * dx + dz * dz);
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

// Solid puck envelope (elliptical cylinder with equal diameters, standing in Y).
int seg = MeshUtil.Segments(diaMM, VoxelSizeMM);
Mesh mshPuck = MeshUtil.CreateCylinder(diaMM, diaMM, heightMM, Vector3.Zero, seg);
Voxels voxPuck = new Voxels(mshPuck);

// Clip the graded skeletal gyroid to the puck.
var field = new RadialGradedGyroid(cellMM, biasCenter, biasRim, diaMM * 0.5f, Vector3.Zero);
Voxels voxGraded = voxPuck.voxIntersectImplicit(field);

SavePart("graded_lattice_puck", voxGraded);
