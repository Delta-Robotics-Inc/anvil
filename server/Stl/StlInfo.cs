//
// StlInfo — binary-STL triangle count + bounding box, with ASCII detection.
//
// The Infill App only ever deals in BINARY STL (PicoGK cannot read ASCII STL,
// and every STL the worker/sidecar produces is binary). This tiny reader is
// used on part upload to (a) reject ASCII STLs with a clear error and (b)
// compute {triangles, bbox} without pulling in PicoGK.
//
// Binary STL layout: 80-byte header, uint32 little-endian triangle count, then
// one 50-byte record per triangle: 12 bytes normal (3 float32) + 36 bytes
// vertices (9 float32) + 2 bytes attribute count. Coordinates are read exactly
// as stored — never recentered — so bboxes are comparable across import/export.
//
using System.Text;

namespace InfillServer.Stl;

public enum StlKind { Binary, Ascii, Invalid }

public sealed record StlBbox(double[] Min, double[] Max);

public sealed record StlResult(int Triangles, StlBbox Bbox);

public static class StlInfo
{
    /// <summary>
    /// Classify an STL file as Binary, Ascii, or Invalid using the header:
    /// a file whose length exactly equals 84 + count*50 is binary; otherwise a
    /// "solid" text prefix marks it ASCII; anything else is Invalid.
    /// </summary>
    public static StlKind Detect(string path)
    {
        var fi = new FileInfo(path);
        if (!fi.Exists) return StlKind.Invalid;
        long len = fi.Length;

        if (len >= 84)
        {
            using var fs = File.OpenRead(path);
            Span<byte> hdr = stackalloc byte[84];
            if (ReadFully(fs, hdr) == 84)
            {
                uint count = BitConverter.ToUInt32(hdr.Slice(80, 4));
                long expected = 84L + (long)count * 50L;
                if (expected == len)
                    return StlKind.Binary;
            }
        }

        // Not a valid binary length. Sniff for an ASCII "solid" prefix.
        using (var fs = File.OpenRead(path))
        {
            int n = (int)Math.Min(6L, len);
            Span<byte> prefix = stackalloc byte[6];
            prefix = prefix.Slice(0, n);
            ReadFully(fs, prefix);
            string s = Encoding.ASCII.GetString(prefix).TrimStart();
            if (s.StartsWith("solid", StringComparison.OrdinalIgnoreCase))
                return StlKind.Ascii;
        }

        return StlKind.Invalid;
    }

    /// <summary>
    /// Read a binary STL and return its triangle count and world-frame bbox.
    /// Throws InvalidDataException if the file is not a well-formed binary STL.
    /// </summary>
    public static StlResult ReadBinary(string path)
    {
        byte[] bytes = File.ReadAllBytes(path);
        if (bytes.Length < 84)
            throw new InvalidDataException($"file too small to be a binary STL: {path}");

        uint count = BitConverter.ToUInt32(bytes, 80);
        long expected = 84L + (long)count * 50L;
        if (expected != bytes.Length)
            throw new InvalidDataException(
                $"not a binary STL (length {bytes.Length} != 84 + {count}*50 = {expected}): {path}");

        if (count == 0)
            return new StlResult(0, new StlBbox(new[] { 0.0, 0, 0 }, new[] { 0.0, 0, 0 }));

        double minX = double.MaxValue, minY = double.MaxValue, minZ = double.MaxValue;
        double maxX = double.MinValue, maxY = double.MinValue, maxZ = double.MinValue;

        var span = bytes.AsSpan();
        int off = 84;
        for (uint i = 0; i < count; i++)
        {
            // Skip the 12-byte face normal; read the three vertices.
            int v = off + 12;
            for (int k = 0; k < 3; k++)
            {
                float x = BitConverter.ToSingle(span.Slice(v, 4));
                float y = BitConverter.ToSingle(span.Slice(v + 4, 4));
                float z = BitConverter.ToSingle(span.Slice(v + 8, 4));
                v += 12;
                if (x < minX) minX = x; if (x > maxX) maxX = x;
                if (y < minY) minY = y; if (y > maxY) maxY = y;
                if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
            }
            off += 50; // 50-byte record stride
        }

        return new StlResult((int)count,
            new StlBbox(new[] { minX, minY, minZ }, new[] { maxX, maxY, maxZ }));
    }

    private static int ReadFully(Stream s, Span<byte> buf)
    {
        int total = 0;
        while (total < buf.Length)
        {
            int r = s.Read(buf.Slice(total));
            if (r <= 0) break;
            total += r;
        }
        return total;
    }
}
