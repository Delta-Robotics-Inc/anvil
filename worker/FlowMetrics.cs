//
// Anvil.Worker — FlowMetrics
//
// Computes flow-oriented metrics for a built lattice, reusing the voxel fields
// already in hand (no re-voxelization). The key trick: open-area profiles along
// ALL THREE axes are accumulated in a SINGLE pass over each field's Z-slices —
// each set voxel contributes to profileX[x], profileY[y] and profileZ[z]
// simultaneously.
//
// Coordinate alignment: PicoGK voxel grids are world-anchored, so a given
// absolute voxel index (i,j,k) maps to the same world point in every Voxels
// object (Library.vecVoxelsToMm(i,j,k)). Two fields differ only in their origin
// and size (GetVoxelDimensions origin overload). We therefore accumulate into a
// COMMON absolute-index window covering both fields and index each field's slice
// pixels by absolute index = origin + localIndex.
//

using System.Numerics;
using PicoGK;

namespace Anvil.Worker
{
    /// <summary>Downsampled open-area profile along the flow axis.</summary>
    class ProfileDto
    {
        public string  axis            { get; set; } = "z";
        public float[] positionsMM     { get; set; } = Array.Empty<float>();
        public float[] openAreaMM2     { get; set; } = Array.Empty<float>();
        public float[] envelopeAreaMM2 { get; set; } = Array.Empty<float>();
    }

    /// <summary>All flow-metric outputs (merged flat into the done stats).</summary>
    class FlowMetricsResult
    {
        // Volumes
        public float airVolumeMM3;
        public float porosityPct;
        // Choke (flow axis)
        public float minOpenAreaMM2;
        public float minAtMM;
        public float chokeRatio;
        public float grossAreaMM2;
        public float flowLengthMM;
        // Surface
        public float surfaceAreaMM2;
        public float specificSurfaceInvMM;
        public float hydraulicDiameterMM;
        // Estimates
        public float permeabilityM2;
        public float deltaPKPa;
        // Meta
        public string flowAxis = "z";
        public List<string> warnings = new();
        public ProfileDto profile = new();

        // Diagnostic (emitted to stdout as a note, not part of the stats contract)
        public bool  profileAssertPass;
        public float profileIntegralMM3;
    }

    static class FlowMetrics
    {
        // Darcy / Kozeny-Carman constants
        const float MuAir = 1.81e-5f;   // dynamic viscosity of air (Pa·s)

        /// <summary>
        /// Compute all flow metrics.
        /// </summary>
        /// <param name="voxEnvelope">Envelope voxels (part in single, cavity in fuse).</param>
        /// <param name="voxLattice">TPMS-clipped lattice voxels, clipped to the UN-offset envelope.</param>
        /// <param name="voxAir">envelope − lattice (the open/air network).</param>
        /// <param name="mshLattice">Mesh of the lattice (for surface area).</param>
        /// <param name="envelopeVolumeMM3">Envelope volume (mm³), already computed.</param>
        /// <param name="airVolumeMM3">Air volume (mm³), already computed.</param>
        /// <param name="fVoxelSizeMM">Voxel edge length (mm).</param>
        /// <param name="strFlowAxis">"x" | "y" | "z".</param>
        /// <param name="strPattern">Pattern name (for warnings).</param>
        /// <param name="strLatticeType">"sheet" | "skeletal".</param>
        /// <param name="fWallThicknessMM">Wall thickness (for warnings).</param>
        /// <param name="fRefFlowLpm">Reference flow rate (L/min) for ΔP estimate.</param>
        public static FlowMetricsResult Compute(
            Voxels voxEnvelope,
            Voxels voxLattice,
            Voxels voxAir,
            Mesh   mshLattice,
            float  envelopeVolumeMM3,
            float  airVolumeMM3,
            float  fVoxelSizeMM,
            string strFlowAxis,
            string strPattern,
            string strLatticeType,
            float  fWallThicknessMM,
            float  fRefFlowLpm)
        {
            var res = new FlowMetricsResult { flowAxis = strFlowAxis };

            float fVox  = fVoxelSizeMM;
            float fArea = fVox * fVox;      // mm² per set pixel
            float fVol  = fVox * fVox * fVox;

            res.airVolumeMM3 = airVolumeMM3;
            res.porosityPct  = envelopeVolumeMM3 > 0f ? 100f * airVolumeMM3 / envelopeVolumeMM3 : 0f;

            // ---- Single-pass three-axis open-area profiles -------------------
            voxEnvelope.GetVoxelDimensions(out int exo, out int eyo, out int ezo,
                                           out int exs, out int eys, out int ezs);
            voxAir.GetVoxelDimensions(out int axo, out int ayo, out int azo,
                                      out int axs, out int ays, out int azs);

            // Common absolute-index window covering both fields (air ⊆ envelope,
            // but be defensive and union the ranges anyway).
            int xMin = Math.Min(exo, axo), xMaxEx = Math.Max(exo + exs, axo + axs);
            int yMin = Math.Min(eyo, ayo), yMaxEx = Math.Max(eyo + eys, ayo + ays);
            int zMin = Math.Min(ezo, azo), zMaxEx = Math.Max(ezo + ezs, azo + azs);
            int nX = Math.Max(0, xMaxEx - xMin);
            int nY = Math.Max(0, yMaxEx - yMin);
            int nZ = Math.Max(0, zMaxEx - zMin);

            long[] envX = new long[nX], envY = new long[nY], envZ = new long[nZ];
            long[] airX = new long[nX], airY = new long[nY], airZ = new long[nZ];

            AccumulateProfiles(voxEnvelope, exo, eyo, ezo, exs, eys, ezs,
                               xMin, yMin, zMin, envX, envY, envZ);
            AccumulateProfiles(voxAir, axo, ayo, azo, axs, ays, azs,
                               xMin, yMin, zMin, airX, airY, airZ);

            // ---- Sanity assertion: profile integral · voxel ≈ envelope volume
            long envTotal = 0;
            for (int i = 0; i < nZ; i++) envTotal += envZ[i];
            res.profileIntegralMM3 = envTotal * fVol;
            res.profileAssertPass = envelopeVolumeMM3 <= 0f ||
                MathF.Abs(res.profileIntegralMM3 - envelopeVolumeMM3) <= 0.02f * envelopeVolumeMM3;

            // ---- Select the flow-axis profile --------------------------------
            long[] envAxis; long[] airAxis; int nAxis; int axisMin; int axisComp;
            switch ((strFlowAxis ?? "z").Trim().ToLowerInvariant())
            {
                case "x": envAxis = envX; airAxis = airX; nAxis = nX; axisMin = xMin; axisComp = 0; break;
                case "y": envAxis = envY; airAxis = airY; nAxis = nY; axisMin = yMin; axisComp = 1; break;
                default:  envAxis = envZ; airAxis = airZ; nAxis = nZ; axisMin = zMin; axisComp = 2;
                          res.flowAxis = "z"; break;
            }

            // Convert to mm² areas along the flow axis.
            float[] envAreaAxis = new float[nAxis];
            float[] airAreaAxis = new float[nAxis];
            float[] posAxis     = new float[nAxis];
            for (int i = 0; i < nAxis; i++)
            {
                envAreaAxis[i] = envAxis[i] * fArea;
                airAreaAxis[i] = airAxis[i] * fArea;
                posAxis[i]     = WorldPos(axisMin + i, axisComp);
            }

            // ---- Choke metrics on the flow-axis profile ----------------------
            float grossArea = 0f;
            for (int i = 0; i < nAxis; i++) grossArea = MathF.Max(grossArea, envAreaAxis[i]);
            res.grossAreaMM2 = grossArea;

            float thresh = grossArea * 0.02f;   // ignore the fringe where the part barely intersects
            int firstValid = -1, lastValid = -1, iMin = -1;
            float minAir = float.PositiveInfinity;
            for (int i = 0; i < nAxis; i++)
            {
                if (envAreaAxis[i] <= thresh) continue;
                if (firstValid < 0) firstValid = i;
                lastValid = i;
                if (airAreaAxis[i] < minAir)
                {
                    minAir = airAreaAxis[i];
                    iMin = i;
                }
            }

            if (iMin >= 0)
            {
                res.minOpenAreaMM2 = airAreaAxis[iMin];
                res.minAtMM        = posAxis[iMin];
                res.chokeRatio     = envAreaAxis[iMin] > 0f ? airAreaAxis[iMin] / envAreaAxis[iMin] : 0f;
                res.flowLengthMM   = (lastValid - firstValid + 1) * fVox;
            }

            // ---- Surface metrics ---------------------------------------------
            res.surfaceAreaMM2       = SurfaceArea(mshLattice);
            res.specificSurfaceInvMM = envelopeVolumeMM3 > 0f ? res.surfaceAreaMM2 / envelopeVolumeMM3 : 0f;
            float eps = envelopeVolumeMM3 > 0f ? airVolumeMM3 / envelopeVolumeMM3 : 0f;  // porosity fraction
            res.hydraulicDiameterMM  = res.specificSurfaceInvMM > 0f ? 4f * eps / res.specificSurfaceInvMM : 0f;

            // ---- Estimates (order-of-magnitude) ------------------------------
            // Kozeny–Carman permeability:  k = ε³ / (5 · S0² · (1−ε)²)
            //   ε  = porosity fraction (air / envelope)
            //   S0 = specific surface per unit SOLID volume = surfaceArea / solidVolume [1/m]
            // Units: work in metres so k comes out in m².
            float solidVolMM3 = MathF.Max(0f, envelopeVolumeMM3 - airVolumeMM3);
            if (solidVolMM3 > 0f && eps > 0f && eps < 1f)
            {
                float s0PerMM = res.surfaceAreaMM2 / solidVolMM3;   // 1/mm
                float s0PerM  = s0PerMM * 1000f;                    // 1/m
                float k = (eps * eps * eps) /
                          (5f * s0PerM * s0PerM * (1f - eps) * (1f - eps)); // m²
                res.permeabilityM2 = k;

                // Darcy pressure drop:  ΔP = μ · L · v / k
                //   v = superficial velocity = Q / grossArea
                if (k > 0f && grossArea > 0f)
                {
                    float lengthM   = res.flowLengthMM * 1e-3f;          // m
                    float qM3s      = fRefFlowLpm / 60000f;              // L/min → m³/s
                    float grossM2   = grossArea * 1e-6f;                 // mm² → m²
                    float vSuper    = qM3s / grossM2;                    // m/s
                    float dpPa      = MuAir * lengthM * vSuper / k;      // Pa
                    res.deltaPKPa   = dpPa / 1000f;                      // kPa
                }
            }

            // ---- Warnings ----------------------------------------------------
            bool bSheet = !string.Equals(strLatticeType, "skeletal", StringComparison.OrdinalIgnoreCase);
            if (bSheet && fWallThicknessMM < 0.8f)
                res.warnings.Add($"wall {fWallThicknessMM:0.###} mm < 0.8 mm — FDM leak risk at pressure");
            if (bSheet && fVoxelSizeMM > fWallThicknessMM / 3f)
                res.warnings.Add($"voxel {fVoxelSizeMM:0.###} mm > wall/3 — lattice walls under-resolved");
            if (string.Equals(strPattern, "schwarzP", StringComparison.OrdinalIgnoreCase))
                res.warnings.Add("SchwarzP has flat cell ceilings — droop risk in FDM; consider rotating 45° or gyroid");
            if (bSheet)
                res.warnings.Add("sheet lattice creates two independent air networks — verify your ports reach the intended one");
            if (iMin >= 0 && res.chokeRatio < 0.1f)
                res.warnings.Add("choke ratio below 10% — severe flow restriction");

            // ---- Downsampled flow-axis profile (≤128 bins by averaging) ------
            res.profile = Downsample(res.flowAxis, posAxis, airAreaAxis, envAreaAxis, 128);

            return res;
        }

        /// <summary>
        /// Accumulate per-axis set-voxel counts for one field into the shared
        /// absolute-index bins, in a single pass over the field's Z-slices.
        /// </summary>
        static void AccumulateProfiles(
            Voxels vox,
            int xo, int yo, int zo, int xs, int ys, int zs,
            int xMin, int yMin, int zMin,
            long[] profX, long[] profY, long[] profZ)
        {
            if (xs <= 0 || ys <= 0 || zs <= 0) return;

            var img = new ImageGrayScale(xs, ys);
            float[] px = img.m_afValues;   // row-major (x + y·width)

            // IMPORTANT PicoGK polarity: in ESliceMode.BlackWhite, INSIDE/solid voxels
            // (SDF ≤ 0) are written as 0.0 and OUTSIDE voxels as 1.0
            // (PicoGK_Voxels.cs GetVoxelSlice). So a SOLID/set voxel is value < 0.5.
            for (int z = 0; z < zs; z++)
            {
                vox.GetVoxelSlice(z, ref img, Voxels.ESliceMode.BlackWhite);

                int absZ = zo + z - zMin;
                long sliceCount = 0;
                int i = 0;
                for (int y = 0; y < ys; y++)
                {
                    int absY = yo + y - yMin;
                    long rowCount = 0;
                    for (int x = 0; x < xs; x++, i++)
                    {
                        if (px[i] < 0.5f)   // solid / inside
                        {
                            profX[xo + x - xMin]++;
                            rowCount++;
                        }
                    }
                    if (rowCount != 0) profY[absY] += rowCount;
                    sliceCount += rowCount;
                }
                if (sliceCount != 0) profZ[absZ] += sliceCount;
            }
        }

        /// <summary>World-space coordinate (mm) of an absolute voxel index along one axis.</summary>
        static float WorldPos(int idx, int axisComp)
        {
            Vector3 v = axisComp switch
            {
                0 => Library.vecVoxelsToMm(idx, 0, 0),
                1 => Library.vecVoxelsToMm(0, idx, 0),
                _ => Library.vecVoxelsToMm(0, 0, idx),
            };
            return axisComp switch { 0 => v.X, 1 => v.Y, _ => v.Z };
        }

        /// <summary>Sum of triangle areas of a mesh (mm²).</summary>
        static float SurfaceArea(Mesh msh)
        {
            if (msh is null) return 0f;
            double area = 0.0;
            int n = msh.nTriangleCount();
            for (int i = 0; i < n; i++)
            {
                msh.GetTriangle(i, out Vector3 a, out Vector3 b, out Vector3 c);
                Vector3 cross = Vector3.Cross(b - a, c - a);
                area += 0.5 * cross.Length();
            }
            return (float)area;
        }

        /// <summary>Downsample the flow-axis profile to ≤ nMaxBins by averaging.</summary>
        static ProfileDto Downsample(
            string axis, float[] pos, float[] air, float[] env, int nMaxBins)
        {
            int n = pos.Length;
            var dto = new ProfileDto { axis = axis };
            if (n == 0) return dto;

            if (n <= nMaxBins)
            {
                dto.positionsMM     = (float[])pos.Clone();
                dto.openAreaMM2     = (float[])air.Clone();
                dto.envelopeAreaMM2 = (float[])env.Clone();
                return dto;
            }

            var outPos = new float[nMaxBins];
            var outAir = new float[nMaxBins];
            var outEnv = new float[nMaxBins];
            for (int b = 0; b < nMaxBins; b++)
            {
                int lo = (int)((long)b * n / nMaxBins);
                int hi = (int)((long)(b + 1) * n / nMaxBins);
                if (hi <= lo) hi = lo + 1;
                if (hi > n) hi = n;
                double sp = 0, sa = 0, se = 0;
                for (int i = lo; i < hi; i++) { sp += pos[i]; sa += air[i]; se += env[i]; }
                int cnt = hi - lo;
                outPos[b] = (float)(sp / cnt);
                outAir[b] = (float)(sa / cnt);
                outEnv[b] = (float)(se / cnt);
            }
            dto.positionsMM     = outPos;
            dto.openAreaMM2     = outAir;
            dto.envelopeAreaMM2 = outEnv;
            return dto;
        }
    }
}
