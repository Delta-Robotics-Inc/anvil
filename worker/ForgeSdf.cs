//
// Anvil.Worker — ForgeSdf
//
// The implicit (signed-distance) building blocks behind the Forge API, plus the
// grayscale image sampler that Forge.Emboss projects onto a part.
//
// Every implicit here returns a BAND-SAFE signed distance: where an exact
// distance is not available the value is deliberately UNDER-estimated (never
// over-estimated), because PicoGK's narrow-band level-set renderer will miss the
// surface if a field claims to be further from it than it really is. The usual
// fix, applied throughout, is to divide the naive field value by the local
// gradient magnitude (a "Lipschitz normalisation").
//
// Nothing in this file is part of the scripting surface — scripts call the
// Forge.* commands in Forge.cs, which own these types.
//

using System.Numerics;
using PicoGK;

namespace Anvil.Worker
{
    /// <summary>
    /// A grayscale height map loaded from an image file, sampled bilinearly in
    /// PIXEL coordinates. White (1.0) means full effect, black (0.0) means none;
    /// alpha multiplies the value, so transparent pixels read as black.
    /// </summary>
    internal sealed class ForgeImage
    {
        private readonly float[] _g;   // row-major, _w * _h, 0..1
        private readonly int _w, _h;

        public int Width  => _w;
        public int Height => _h;

        private ForgeImage(float[] g, int w, int h) { _g = g; _w = w; _h = h; }

        /// <summary>
        /// Load any GDI+-readable raster (PNG / JPG / BMP / GIF / TIFF) and reduce
        /// it to a normalised grayscale table using Rec.709 luma, pre-multiplied
        /// by alpha. Windows-only (the app is a Windows desktop app).
        /// </summary>
        public static ForgeImage Load(string path)
        {
#pragma warning disable CA1416 // System.Drawing is Windows-only; Anvil is a Windows app
            using var bmp = new System.Drawing.Bitmap(path);
            int w = bmp.Width, h = bmp.Height;
            if (w < 2 || h < 2)
                throw new ArgumentException($"Forge.Emboss: image '{path}' is too small ({w}x{h}); need at least 2x2 pixels");

            var rect = new System.Drawing.Rectangle(0, 0, w, h);
            var data = bmp.LockBits(rect, System.Drawing.Imaging.ImageLockMode.ReadOnly,
                                    System.Drawing.Imaging.PixelFormat.Format32bppArgb);
            byte[] buf;
            int stride;
            try
            {
                stride = Math.Abs(data.Stride);
                buf = new byte[stride * h];
                System.Runtime.InteropServices.Marshal.Copy(data.Scan0, buf, 0, buf.Length);
            }
            finally
            {
                bmp.UnlockBits(data);
            }
#pragma warning restore CA1416

            float[] g = new float[w * h];
            for (int y = 0; y < h; y++)
            {
                int row = y * stride;
                int dst = y * w;
                for (int x = 0; x < w; x++)
                {
                    int i = row + x * 4;          // BGRA in memory (little-endian ARGB)
                    float b = buf[i + 0] / 255f;
                    float gr = buf[i + 1] / 255f;
                    float r = buf[i + 2] / 255f;
                    float a = buf[i + 3] / 255f;
                    g[dst + x] = (0.2126f * r + 0.7152f * gr + 0.0722f * b) * a;
                }
            }
            return new ForgeImage(g, w, h);
        }

        /// <summary>
        /// Bilinear sample in pixel units, where (0,0) is the TOP-LEFT corner of
        /// the top-left pixel and (Width, Height) is the bottom-right corner of
        /// the image. Coordinates outside the image return 0 (no effect), so the
        /// map simply stops at its own border; inside, edge pixels clamp.
        /// </summary>
        public float Sample(float px, float py)
        {
            if (px < 0f || py < 0f || px > _w || py > _h) return 0f;

            float fx = px - 0.5f, fy = py - 0.5f;   // to pixel-CENTRE space
            int x0 = (int)MathF.Floor(fx), y0 = (int)MathF.Floor(fy);
            float tx = fx - x0, ty = fy - y0;
            int x1 = x0 + 1, y1 = y0 + 1;

            x0 = Math.Clamp(x0, 0, _w - 1); x1 = Math.Clamp(x1, 0, _w - 1);
            y0 = Math.Clamp(y0, 0, _h - 1); y1 = Math.Clamp(y1, 0, _h - 1);

            float a = _g[y0 * _w + x0], b = _g[y0 * _w + x1];
            float c = _g[y1 * _w + x0], d = _g[y1 * _w + x1];
            float top = a + (b - a) * tx;
            float bot = c + (d - c) * tx;
            return top + (bot - top) * ty;
        }
    }

    /// <summary>
    /// Line-swept sphere (capsule): the set of points within radius r of the
    /// segment A-B. Exact signed distance everywhere.
    /// </summary>
    internal sealed class SdCapsule : IImplicit
    {
        private readonly Vector3 _a, _ba;
        private readonly float _len2, _r;

        public SdCapsule(Vector3 a, Vector3 b, float radius)
        {
            _a = a; _ba = b - a; _len2 = Vector3.Dot(_ba, _ba); _r = radius;
        }

        public float fSignedDistance(in Vector3 p)
        {
            Vector3 pa = p - _a;
            float h = _len2 > 1e-12f ? Math.Clamp(Vector3.Dot(pa, _ba) / _len2, 0f, 1f) : 0f;
            return (pa - _ba * h).Length() - _r;
        }
    }

    /// <summary>
    /// Torus whose ring lies in the XZ plane (axis of revolution = +Y), centred
    /// on <c>C</c>. <c>R</c> is the centre-circle radius, <c>r</c> the tube
    /// radius. Exact signed distance everywhere.
    /// </summary>
    internal sealed class SdTorus : IImplicit
    {
        private readonly Vector3 _c;
        private readonly float _bigR, _tubeR;

        public SdTorus(Vector3 center, float bigR, float tubeR)
        {
            _c = center; _bigR = bigR; _tubeR = tubeR;
        }

        public float fSignedDistance(in Vector3 p)
        {
            Vector3 q = p - _c;
            float k = MathF.Sqrt(q.X * q.X + q.Z * q.Z) - _bigR;
            return MathF.Sqrt(k * k + q.Y * q.Y) - _tubeR;
        }
    }

    /// <summary>
    /// Solid of revolution about the +Y axis: radius(y) over y in [y0, y1], with
    /// flat caps at both ends. The radius function is PRE-SAMPLED into a table at
    /// construction time, so (a) the user's delegate is never called from the
    /// renderer's threads and (b) the local slope dR/dy is known and used to
    /// Lipschitz-normalise the radial term, keeping the field band-safe even for
    /// steep profiles (rocket nozzles, vases, trumpet bells).
    /// </summary>
    internal sealed class SdLoft : IImplicit
    {
        private readonly float[] _r;       // radius at each table node (mm, >= 0)
        private readonly float[] _slope;   // dR/dy at each table node
        private readonly float _y0, _y1, _step, _invStep;
        private readonly int _n;

        /// <summary>Largest radius over the sampled profile (mm) — used to size the render box.</summary>
        public float MaxRadius { get; }

        public SdLoft(Func<double, double> radiusAtY, double y0, double y1, int samples)
        {
            _n = Math.Max(4, samples);
            _y0 = (float)y0; _y1 = (float)y1;
            _step = (_y1 - _y0) / (_n - 1);
            _invStep = _step > 0f ? 1f / _step : 0f;

            _r = new float[_n];
            float max = 0f;
            for (int i = 0; i < _n; i++)
            {
                double y = y0 + (y1 - y0) * i / (double)(_n - 1);
                double v = radiusAtY(y);
                if (double.IsNaN(v) || double.IsInfinity(v))
                    throw new ArgumentException(
                        $"Forge.Loft: radiusAtY({y:0.###}) returned {v} — the radius function must return a finite number");
                float rr = (float)Math.Max(0.0, v);
                _r[i] = rr;
                if (rr > max) max = rr;
            }
            MaxRadius = max;

            // Central differences for the slope (one-sided at the ends).
            _slope = new float[_n];
            for (int i = 0; i < _n; i++)
            {
                int lo = Math.Max(0, i - 1), hi = Math.Min(_n - 1, i + 1);
                float dy = (hi - lo) * _step;
                _slope[i] = dy > 1e-9f ? (_r[hi] - _r[lo]) / dy : 0f;
            }
        }

        public float fSignedDistance(in Vector3 p)
        {
            float yc = Math.Clamp(p.Y, _y0, _y1);
            float u = (yc - _y0) * _invStep;
            int i = (int)u;
            if (i < 0) i = 0;
            if (i > _n - 2) i = _n - 2;
            float t = u - i;

            float r = _r[i] + (_r[i + 1] - _r[i]) * t;
            float s = _slope[i] + (_slope[i + 1] - _slope[i]) * t;

            float rad = MathF.Sqrt(p.X * p.X + p.Z * p.Z);
            float dRad = (rad - r) / MathF.Sqrt(1f + s * s);   // band-safe radial term
            float dAxial = MathF.Max(_y0 - p.Y, p.Y - _y1);    // exact slab distance

            return MathF.Max(dRad, dAxial);
        }
    }

    /// <summary>
    /// Union of capsules along a polyline, evaluated as ONE implicit (min over
    /// every segment) so a whole pipe run costs a single voxel render instead of
    /// N boolean unions. Exact signed distance outside; the usual min-union
    /// under-estimate near interior joints, which is band-safe.
    /// </summary>
    internal sealed class SdPolyPipe : IImplicit
    {
        private readonly Vector3[] _a, _ba;
        private readonly float[] _len2;
        private readonly float _r;

        public SdPolyPipe(IReadOnlyList<Vector3> pts, float radius)
        {
            int segs = pts.Count - 1;
            _a = new Vector3[segs];
            _ba = new Vector3[segs];
            _len2 = new float[segs];
            for (int i = 0; i < segs; i++)
            {
                _a[i] = pts[i];
                _ba[i] = pts[i + 1] - pts[i];
                _len2[i] = Vector3.Dot(_ba[i], _ba[i]);
            }
            _r = radius;
        }

        public float fSignedDistance(in Vector3 p)
        {
            float best = float.MaxValue;
            for (int i = 0; i < _a.Length; i++)
            {
                Vector3 pa = p - _a[i];
                float h = _len2[i] > 1e-12f ? Math.Clamp(Vector3.Dot(pa, _ba[i]) / _len2[i], 0f, 1f) : 0f;
                float d = (pa - _ba[i] * h).Length();
                if (d < best) best = d;
            }
            return best - _r;
        }
    }

    /// <summary>
    /// The Forge.Emboss height-map slab: a face-aligned volume bounded on one side
    /// by the depth map and on the other by a flat plane.
    ///
    /// The face's OUTWARD normal defines a signed axial coordinate t (t = 0 at the
    /// bounding-box face plane, positive outward). The two remaining axes give the
    /// in-plane coordinates (u, v) that address the image. The slab is
    ///     { p : -floorMM &lt;= t &lt;= depth * gray(u, v) }
    /// for a RAISE, or
    ///     { p : -depth * gray(u, v) &lt;= t &lt;= ceilMM }
    /// for a CUT (the ceiling sits harmlessly outside the part, so black pixels
    /// remove nothing).
    ///
    /// The height term is divided by sqrt(1 + |grad h|^2) so steep image gradients
    /// cannot make the field over-estimate its distance to the surface.
    /// </summary>
    internal sealed class SdEmbossSlab : IImplicit
    {
        private readonly ForgeImage _img;
        private readonly int _axN, _axU, _axV;
        private readonly float _sgN, _sgU, _sgV;
        private readonly float _planeC;      // face plane coordinate along the normal axis (signed space)
        private readonly float _uStart;      // signed-u coordinate of the image's left edge (mm)
        private readonly float _vTop;        // signed-v coordinate of the image's TOP edge (mm)
        private readonly float _mmPerPx, _invMmPerPx;
        private readonly float _depth;
        private readonly float _floor;       // how far the slab reaches BELOW t=0 (raise)
        private readonly float _ceil;        // how far the slab reaches ABOVE t=0 (cut)
        private readonly bool _cut;
        private readonly float _uMid, _uHalf, _vMid, _vHalf;   // mapped image rectangle

        public SdEmbossSlab(
            ForgeImage img,
            int axN, float sgN, float planeC,
            int axU, float sgU, float uStart,
            int axV, float sgV, float vTop,
            float mmPerPx, float depth, float floorMM, float ceilMM, bool cut)
        {
            _img = img;
            _axN = axN; _sgN = sgN; _planeC = planeC;
            _axU = axU; _sgU = sgU; _uStart = uStart;
            _axV = axV; _sgV = sgV; _vTop = vTop;
            _mmPerPx = mmPerPx; _invMmPerPx = 1f / mmPerPx;
            _depth = depth; _floor = floorMM; _ceil = ceilMM; _cut = cut;

            // The slab is hard-bounded to the mapped image rectangle, so nothing
            // the emboss builds can spill past the region the picture covers (the
            // voxel renderer is free to grow its own working box, and without this
            // the flat "no relief here" floor would skirt the whole part).
            float imgW = img.Width * mmPerPx, imgH = img.Height * mmPerPx;
            _uHalf = imgW * 0.5f; _uMid = uStart + _uHalf;
            _vHalf = imgH * 0.5f; _vMid = vTop - _vHalf;
        }

        private static float Comp(in Vector3 v, int axis)
            => axis == 0 ? v.X : (axis == 1 ? v.Y : v.Z);

        public float fSignedDistance(in Vector3 p)
        {
            float t = _sgN * (Comp(p, _axN) - _planeC);
            float cu = _sgU * Comp(p, _axU);
            float cv = _sgV * Comp(p, _axV);

            float px = (cu - _uStart) * _invMmPerPx;
            float py = (_vTop - cv) * _invMmPerPx;   // image row 0 is the TOP edge

            float h = _depth * _img.Sample(px, py);

            // Local gradient of the height field (mm of height per mm of travel),
            // by central differences half a pixel either side.
            float gu = _depth * (_img.Sample(px + 0.5f, py) - _img.Sample(px - 0.5f, py)) * _invMmPerPx;
            float gv = _depth * (_img.Sample(px, py - 0.5f) - _img.Sample(px, py + 0.5f)) * _invMmPerPx;
            float norm = MathF.Sqrt(1f + gu * gu + gv * gv);

            // Exact in-plane distance to the mapped rectangle's edge.
            float du = MathF.Abs(cu - _uMid) - _uHalf;
            float dv = MathF.Abs(cv - _vMid) - _vHalf;
            float mu = MathF.Max(du, 0f), mv = MathF.Max(dv, 0f);
            float dSide = MathF.Sqrt(mu * mu + mv * mv) + MathF.Min(MathF.Max(du, dv), 0f);

            if (_cut)
            {
                float dLower = (-h - t) / norm;   // t >= -h   (the engraved floor)
                float dUpper = t - _ceil;         // t <= ceil (a flat lid outside the part)
                return MathF.Max(MathF.Max(dLower, dUpper), dSide);
            }
            else
            {
                float dTop = (t - h) / norm;      // t <= h    (the raised surface)
                float dBottom = -_floor - t;      // t >= -floor (sunk into the part)
                return MathF.Max(MathF.Max(dTop, dBottom), dSide);
            }
        }
    }
}
