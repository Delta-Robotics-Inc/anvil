//
// SPDX-License-Identifier: CC0-1.0
//
// TPMSWall originally copied VERBATIM from PicoGK examples
// (examples/03_SimpleShapes/GyroidCylinder.cs, class TPMSWall lines 96-159).
//
// Extended for the "flow metrics v1" feature with:
//   * latticeType   sheet (|f| band, wall thickness) vs skeletal (single f
//                   threshold at biasMM — one connected solid, one connected air)
//   * per-axis cell size (kx,ky,kz) with gradient grad = sqrt(kx²+ky²+kz²)
//   * rotation of the pattern field about the envelope bbox center
//   * phase offset (in cell fractions) applied after rotation
//
// Only the pattern FIELD is transformed — the part geometry / world coordinates
// are never touched (the field is sampled at a transformed point).
//

using PicoGK;
using System.Numerics;

namespace Anvil.Worker
{
    /// <summary>
    /// Generic triply-periodic minimal surface wall as IImplicit.
    /// Returns approximate signed distance (mm) to the chosen TPMS solid.
    /// </summary>
    class TPMSWall : IImplicit
    {
        public enum EFn { Gyroid, SchwarzP, SchwarzD, Lidinoid, Neovius }
        public enum ELattice { Sheet, Skeletal }

        readonly float m_fKx;
        readonly float m_fKy;
        readonly float m_fKz;
        readonly float m_fGrad;      // sqrt(kx²+ky²+kz²) — reduces to k·√3 for uniform cells
        readonly float m_fThresh;    // sheet: wall/2·grad ; skeletal: bias·grad
        readonly EFn   m_eFn;
        readonly ELattice m_eLattice;

        readonly Vector3   m_vecCenter;    // rotation pivot (envelope bbox center, mm)
        readonly Matrix4x4 m_matRot;       // Rz·Ry·Rx (System.Numerics row-vector form)
        readonly bool      m_bRotate;
        readonly Vector3   m_vecPhaseMM;   // phase offset in mm = (px·ax, py·ay, pz·az)

        /// <summary>
        /// Backward-compatible uniform-cell sheet constructor (original signature).
        /// </summary>
        public TPMSWall(float fUnitCellMM, float fWallThickMM, EFn eFn)
            : this(new Vector3(fUnitCellMM, fUnitCellMM, fUnitCellMM),
                   fWallThickMM, eFn, ELattice.Sheet, 0f,
                   Vector3.Zero, Vector3.Zero, Vector3.Zero)
        { }

        /// <summary>
        /// Full constructor.
        /// </summary>
        /// <param name="vecCellMM">Per-axis unit cell size in mm (ax, ay, az).</param>
        /// <param name="fWallThickMM">Wall thickness (sheet mode only).</param>
        /// <param name="eFn">TPMS pattern.</param>
        /// <param name="eLattice">Sheet or skeletal.</param>
        /// <param name="fBiasMM">Skeletal bias (mm). 0 ≈ 50% solid; negative = less solid.</param>
        /// <param name="vecCenter">Envelope bbox center (rotation pivot, mm).</param>
        /// <param name="vecRotationDeg">Rotation of the field about the center (deg, X/Y/Z).</param>
        /// <param name="vecPhaseFrac">Phase offset in cell fractions (0..1, X/Y/Z).</param>
        public TPMSWall(
            Vector3   vecCellMM,
            float     fWallThickMM,
            EFn       eFn,
            ELattice  eLattice,
            float     fBiasMM,
            Vector3   vecCenter,
            Vector3   vecRotationDeg,
            Vector3   vecPhaseFrac)
        {
            float ax = vecCellMM.X > 0 ? vecCellMM.X : 1f;
            float ay = vecCellMM.Y > 0 ? vecCellMM.Y : 1f;
            float az = vecCellMM.Z > 0 ? vecCellMM.Z : 1f;

            m_fKx = 2f * MathF.PI / ax;
            m_fKy = 2f * MathF.PI / ay;
            m_fKz = 2f * MathF.PI / az;

            // Gradient normalization: |∇f| ≈ sqrt(kx²+ky²+kz²). For a uniform cell
            // this is k·√3, matching the original single-frequency approximation.
            m_fGrad = MathF.Sqrt(m_fKx * m_fKx + m_fKy * m_fKy + m_fKz * m_fKz);

            m_eFn      = eFn;
            m_eLattice = eLattice;

            // Sheet: solid where |f|/grad - wall/2 < 0.
            // Skeletal: solid where f/grad - bias < 0 (single connected solid network).
            m_fThresh = (eLattice == ELattice.Sheet)
                ? fWallThickMM * 0.5f * m_fGrad
                : fBiasMM * m_fGrad;

            m_vecCenter  = vecCenter;
            m_vecPhaseMM = new Vector3(vecPhaseFrac.X * ax,
                                       vecPhaseFrac.Y * ay,
                                       vecPhaseFrac.Z * az);

            m_bRotate = vecRotationDeg != Vector3.Zero;
            if (m_bRotate)
            {
                float rx = vecRotationDeg.X * MathF.PI / 180f;
                float ry = vecRotationDeg.Y * MathF.PI / 180f;
                float rz = vecRotationDeg.Z * MathF.PI / 180f;

                // System.Numerics uses row-vector transforms: Vector3.Transform(v, M) = v·M.
                // For column-convention v' = Rz·Ry·Rx·d (apply Rx, then Ry, then Rz),
                // the equivalent row-vector matrix is Mx·My·Mz (each CreateRotation* already
                // matches the column rotation for that single axis — verified by expansion).
                m_matRot = Matrix4x4.CreateRotationX(rx)
                         * Matrix4x4.CreateRotationY(ry)
                         * Matrix4x4.CreateRotationZ(rz);
            }
            else
            {
                m_matRot = Matrix4x4.Identity;
            }
        }

        public float fSignedDistance(in Vector3 v)
        {
            // Transform the SAMPLE POINT into lattice space:
            //   v'  = Rz·Ry·Rx·(v − c) + c      (rotation about envelope center)
            //   v'' = v' + phase                (phase offset in mm)
            Vector3 p = v;
            if (m_bRotate)
                p = Vector3.Transform(v - m_vecCenter, m_matRot) + m_vecCenter;
            p += m_vecPhaseMM;

            float kx = m_fKx * p.X;
            float ky = m_fKy * p.Y;
            float kz = m_fKz * p.Z;

            float d = m_eFn switch
            {
                EFn.Gyroid =>
                      MathF.Sin(kx) * MathF.Cos(ky)
                    + MathF.Sin(ky) * MathF.Cos(kz)
                    + MathF.Sin(kz) * MathF.Cos(kx),

                EFn.SchwarzP =>
                      MathF.Cos(kx) + MathF.Cos(ky) + MathF.Cos(kz),

                EFn.SchwarzD =>
                      MathF.Sin(kx) * MathF.Sin(ky) * MathF.Sin(kz)
                    + MathF.Sin(kx) * MathF.Cos(ky) * MathF.Cos(kz)
                    + MathF.Cos(kx) * MathF.Sin(ky) * MathF.Cos(kz)
                    + MathF.Cos(kx) * MathF.Cos(ky) * MathF.Sin(kz),

                EFn.Lidinoid =>
                      0.5f * (MathF.Sin(2*kx) * MathF.Cos(ky) * MathF.Sin(kz)
                            + MathF.Sin(2*ky) * MathF.Cos(kz) * MathF.Sin(kx)
                            + MathF.Sin(2*kz) * MathF.Cos(kx) * MathF.Sin(ky))
                    - 0.5f * (MathF.Cos(2*kx) * MathF.Cos(2*ky)
                            + MathF.Cos(2*ky) * MathF.Cos(2*kz)
                            + MathF.Cos(2*kz) * MathF.Cos(2*kx))
                    + 0.15f,

                EFn.Neovius =>
                      3f * (MathF.Cos(kx) + MathF.Cos(ky) + MathF.Cos(kz))
                    + 4f * (MathF.Cos(kx) * MathF.Cos(ky) * MathF.Cos(kz)),

                _ => 0f,
            };

            // Sheet uses the absolute value (two-sided band around the surface);
            // skeletal uses the signed value directly (one-sided solid network).
            float raw = (m_eLattice == ELattice.Sheet) ? MathF.Abs(d) : d;
            return (raw - m_fThresh) / m_fGrad;
        }
    }
}
