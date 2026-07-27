//
// Anvil.Worker — VoxelSlice
//
// The ONE place that states PicoGK's slice-buffer convention, so the two
// readers (SdfJob.ReadOccupancy and FlowMetrics.SweepSlices) cannot drift apart
// or re-learn it independently.
//
// Voxels.GetVoxelSlice(z, ref ImageGrayScale img, ...) fills img.m_afValues,
// which ImageGrayScale indexes as `x + y * nWidth` (PicoGK_Image.cs). Two
// separate facts live in that buffer, and only the first was ever written down:
//
//   POLARITY — in ESliceMode.BlackWhite a SOLID voxel (SDF <= 0) is written as
//   0.0 and an outside voxel as 1.0. "Solid" is therefore value < 0.5.
//
//   ROW ORDER — the buffer is an IMAGE, and an image's row 0 is its TOP row.
//   Top means the HIGHEST voxel-Y in the field's window, so row r holds
//   voxel-Y index (ys - 1 - r) and NOT r. Indexing rows by voxel-Y directly
//   mirrors the whole field in Y.
//
// That second fact is invisible to any symmetric test fixture — a box, a
// cylinder, a sphere and the X-symmetric manifold cavity all read identically
// mirrored, and a Monte-Carlo volume/occupancy check cannot see it either
// because a mirror preserves volume exactly. It is caught by an ASYMMETRIC
// fixture only (see the "sdf chirality" block in scripts/test_api.ps1, which
// bakes a tetrahedron whose centroid sits at 1/4 of every extent).
//
namespace Anvil.Worker
{
    /// <summary>PicoGK voxel-slice buffer conventions (see the file header).</summary>
    static class VoxelSlice
    {
        /// <summary>
        /// Image ROW holding voxel-Y index <paramref name="j"/> of a field window
        /// <paramref name="ys"/> rows tall — PicoGK slice rows run top-down, so
        /// this is the Y flip that keeps a slice read in voxel space.
        /// Self-inverse: Row(Row(j, ys), ys) == j.
        /// </summary>
        public static int Row(int j, int ys) => ys - 1 - j;
    }
}
