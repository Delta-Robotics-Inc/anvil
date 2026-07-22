//
// SPDX-License-Identifier: CC0-1.0
//
// TPMSWall copied VERBATIM from PicoGK examples
// (examples/03_SimpleShapes/GyroidCylinder.cs, class TPMSWall lines 96-159).
// Only the namespace is changed (PicoGKExamples -> InfillWorker).
//

using PicoGK;
using System.Numerics;

namespace InfillWorker
{
    /// <summary>
    /// Generic triply-periodic minimal surface wall as IImplicit.
    /// Returns approximate signed distance (mm) to the chosen TPMS sheet.
    /// </summary>
    class TPMSWall : IImplicit
    {
        public enum EFn { Gyroid, SchwarzP, SchwarzD, Lidinoid, Neovius }

        readonly float m_fK;
        readonly float m_fThresh;
        readonly float m_fGrad;
        readonly EFn   m_eFn;

        public TPMSWall(float fUnitCellMM, float fWallThickMM, EFn eFn)
        {
            m_fK     = 2f * MathF.PI / fUnitCellMM;
            m_eFn    = eFn;
            // approx gradient magnitude — same for all patterns since each is sum
            // of trig terms with similar spatial frequency
            m_fGrad  = m_fK * MathF.Sqrt(3f);
            m_fThresh = fWallThickMM * 0.5f * m_fGrad;
        }

        public float fSignedDistance(in Vector3 v)
        {
            float kx = m_fK * v.X;
            float ky = m_fK * v.Y;
            float kz = m_fK * v.Z;

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

            return (MathF.Abs(d) - m_fThresh) / m_fGrad;
        }
    }
}
