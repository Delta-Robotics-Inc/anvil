//
// StlTransform — streaming binary-STL transform baking + concatenation.
//
// The unified export pipeline (POST /api/export) must hand the user a file whose
// coordinates match WHAT THEY SEE IN THE VIEWPORT. Parts carry a non-destructive
// TRS in the browser; nothing on disk moves. So on export we BAKE that TRS into a
// throwaway copy of the mesh:
//
//   * BuildMatrix mirrors worker\MeshUtil.BuildMatrix EXACTLY — the ONE canonical
//     composition scale → rotX → rotY → rotZ → translate, in System.Numerics
//     row-vector form (Vector3.Transform(v, M) = v·M). Any drift here would put
//     the exported mesh somewhere the viewport never showed it.
//   * Every vertex is transformed, the per-facet normal is RECOMPUTED from the
//     transformed triangle, and the winding is FLIPPED when the determinant of
//     the 3×3 linear part is negative (a mirroring/negative scale otherwise turns
//     the solid inside-out — same reasoning as MeshUtil.MirrorWindingFixed).
//   * Read→write is streamed record-by-record (50-byte stride), so a multi-
//     million-triangle result never lands in memory twice.
//
// Coordinates are NEVER recentred: the canonical matrix is the ONLY transform
// applied. An identity (or absent) transform is a byte-for-byte file copy.
//
using System.Buffers.Binary;
using System.Numerics;
using System.Text;
using Anvil.Server.Jobs;

namespace Anvil.Server.Stl;

public static class StlTransform
{
    private const int Rec = 50;          // binary-STL per-triangle record stride
    private const float TrsEps = 1e-6f;  // matches main.js nonIdentityTrs

    /// <summary>
    /// The ONE canonical composition (mirrors worker MeshUtil.BuildMatrix):
    /// M = Scale · RotX · RotY · RotZ · Translate, row-vector form. Rotation in
    /// DEGREES, translation in mm. Returns identity for a null transform.
    /// </summary>
    public static Matrix4x4 BuildMatrix(TransformDto? t)
    {
        if (t is null) return Matrix4x4.Identity;

        Vector3 s = Vector3.One;
        if (t.scale is Vec3Dto sc)
        {
            s = new Vector3(sc.x != 0 ? (float)sc.x : 1f,
                            sc.y != 0 ? (float)sc.y : 1f,
                            sc.z != 0 ? (float)sc.z : 1f);
        }

        Vector3 r = t.rotateDeg is Vec3Dto rd
            ? new Vector3((float)rd.x, (float)rd.y, (float)rd.z) : Vector3.Zero;
        Vector3 tr = t.translateMM is Vec3Dto td
            ? new Vector3((float)td.x, (float)td.y, (float)td.z) : Vector3.Zero;

        float rx = r.X * MathF.PI / 180f;
        float ry = r.Y * MathF.PI / 180f;
        float rz = r.Z * MathF.PI / 180f;

        return Matrix4x4.CreateScale(s)
             * Matrix4x4.CreateRotationX(rx)
             * Matrix4x4.CreateRotationY(ry)
             * Matrix4x4.CreateRotationZ(rz)
             * Matrix4x4.CreateTranslation(tr);
    }

    /// <summary>True when the transform is absent or effectively the identity.</summary>
    public static bool IsIdentity(TransformDto? t)
    {
        if (t is null) return true;
        var tr = t.translateMM; var rd = t.rotateDeg; var sc = t.scale;
        if (tr is not null && (Math.Abs(tr.x) > TrsEps || Math.Abs(tr.y) > TrsEps || Math.Abs(tr.z) > TrsEps)) return false;
        if (rd is not null && (Math.Abs(rd.x) > TrsEps || Math.Abs(rd.y) > TrsEps || Math.Abs(rd.z) > TrsEps)) return false;
        if (sc is not null && (Math.Abs(sc.x - 1) > TrsEps || Math.Abs(sc.y - 1) > TrsEps || Math.Abs(sc.z - 1) > TrsEps)) return false;
        return true;
    }

    /// <summary>
    /// Copy <paramref name="inPath"/> to <paramref name="outPath"/> with the
    /// canonical TRS baked into every vertex (normals recomputed, winding flipped
    /// when det &lt; 0). An identity transform is a straight file copy. Returns the
    /// triangle count written.
    /// </summary>
    public static int Bake(string inPath, string outPath, TransformDto? t)
    {
        if (IsIdentity(t))
        {
            Directory.CreateDirectory(Path.GetDirectoryName(outPath)!);
            File.Copy(inPath, outPath, overwrite: true);
            return ReadTriangleCount(inPath);
        }
        return Bake(inPath, outPath, BuildMatrix(t));
    }

    /// <summary>Bake an explicit matrix (see the TransformDto overload).</summary>
    public static int Bake(string inPath, string outPath, Matrix4x4 m)
    {
        bool flip = Det3(m) < 0;

        Directory.CreateDirectory(Path.GetDirectoryName(outPath)!);
        using var fin = new FileStream(inPath, FileMode.Open, FileAccess.Read, FileShare.Read, 1 << 16);
        using var fout = new FileStream(outPath, FileMode.Create, FileAccess.Write, FileShare.None, 1 << 16);

        var head = new byte[84];
        ReadExact(fin, head, 84, inPath);
        uint count = BinaryPrimitives.ReadUInt32LittleEndian(head.AsSpan(80, 4));

        fout.Write(Header(count), 0, 84);

        var rec = new byte[Rec];
        var outRec = new byte[Rec];
        for (uint i = 0; i < count; i++)
        {
            ReadExact(fin, rec, Rec, inPath);

            Vector3 a = Vector3.Transform(ReadVec(rec, 12), m);
            Vector3 b = Vector3.Transform(ReadVec(rec, 24), m);
            Vector3 c = Vector3.Transform(ReadVec(rec, 36), m);
            if (flip) (b, c) = (c, b);   // negative determinant → restore outward normals

            Vector3 n = Vector3.Cross(b - a, c - a);
            float len = n.Length();
            n = len > 1e-20f ? n / len : Vector3.Zero;

            WriteVec(outRec, 0, n);
            WriteVec(outRec, 12, a);
            WriteVec(outRec, 24, b);
            WriteVec(outRec, 36, c);
            outRec[48] = rec[48]; outRec[49] = rec[49];   // attribute byte count, verbatim
            fout.Write(outRec, 0, Rec);
        }

        return (int)count;
    }

    /// <summary>
    /// Concatenate several binary STLs into one (header + summed triangle count +
    /// every record, verbatim). Used for the "COMBINED · one file" export — no
    /// vertex welding, just one mesh file carrying every solid. Returns the total.
    /// </summary>
    public static int Concat(IReadOnlyList<string> inPaths, string outPath)
    {
        long total = 0;
        foreach (var p in inPaths) total += ReadTriangleCount(p);
        if (total > uint.MaxValue) throw new InvalidDataException("combined STL exceeds the binary-STL triangle limit");

        Directory.CreateDirectory(Path.GetDirectoryName(outPath)!);
        using var fout = new FileStream(outPath, FileMode.Create, FileAccess.Write, FileShare.None, 1 << 16);
        fout.Write(Header((uint)total), 0, 84);

        var buf = new byte[Rec * 512];
        foreach (var p in inPaths)
        {
            using var fin = new FileStream(p, FileMode.Open, FileAccess.Read, FileShare.Read, 1 << 16);
            var head = new byte[84];
            ReadExact(fin, head, 84, p);
            uint count = BinaryPrimitives.ReadUInt32LittleEndian(head.AsSpan(80, 4));
            long bytes = (long)count * Rec;
            while (bytes > 0)
            {
                int want = (int)Math.Min(bytes, buf.Length);
                ReadExact(fin, buf, want, p);
                fout.Write(buf, 0, want);
                bytes -= want;
            }
        }
        return (int)total;
    }

    /// <summary>Triangle count from the binary-STL header (validates the length).</summary>
    public static int ReadTriangleCount(string path)
    {
        using var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
        var head = new byte[84];
        ReadExact(fs, head, 84, path);
        uint count = BinaryPrimitives.ReadUInt32LittleEndian(head.AsSpan(80, 4));
        long expected = 84L + (long)count * Rec;
        if (fs.Length != expected)
            throw new InvalidDataException(
                $"not a binary STL (length {fs.Length} != 84 + {count}*50 = {expected}): {path}");
        return (int)count;
    }

    // ---- internals ---------------------------------------------------------

    /// <summary>Determinant of the 3×3 linear part (negative ⇒ handedness flip).</summary>
    private static float Det3(Matrix4x4 m) =>
        m.M11 * (m.M22 * m.M33 - m.M23 * m.M32)
      - m.M12 * (m.M21 * m.M33 - m.M23 * m.M31)
      + m.M13 * (m.M21 * m.M32 - m.M22 * m.M31);

    /// <summary>80-byte ASCII header (never starts with "solid") + triangle count.</summary>
    private static byte[] Header(uint count)
    {
        var head = new byte[84];
        var tag = Encoding.ASCII.GetBytes("ANVIL binary STL export // 金床");
        Array.Copy(tag, head, Math.Min(tag.Length, 80));
        BinaryPrimitives.WriteUInt32LittleEndian(head.AsSpan(80, 4), count);
        return head;
    }

    private static Vector3 ReadVec(byte[] b, int off) => new(
        BitConverter.ToSingle(b, off),
        BitConverter.ToSingle(b, off + 4),
        BitConverter.ToSingle(b, off + 8));

    private static void WriteVec(byte[] b, int off, Vector3 v)
    {
        BinaryPrimitives.WriteSingleLittleEndian(b.AsSpan(off, 4), v.X);
        BinaryPrimitives.WriteSingleLittleEndian(b.AsSpan(off + 4, 4), v.Y);
        BinaryPrimitives.WriteSingleLittleEndian(b.AsSpan(off + 8, 4), v.Z);
    }

    private static void ReadExact(Stream s, byte[] buf, int count, string path)
    {
        int total = 0;
        while (total < count)
        {
            int r = s.Read(buf, total, count - total);
            if (r <= 0) throw new InvalidDataException($"truncated binary STL: {path}");
            total += r;
        }
    }
}
