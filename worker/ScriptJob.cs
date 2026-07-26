//
// Anvil.Worker — ScriptJob (Stage 5: LEAP71-style code-to-geometry)
//
// mode == "script": compile and run a user C# script (.csx) against the PicoGK +
// Anvil.Worker geometry APIs, INSIDE a per-job worker process. The script talks
// to the app through the ScriptGlobals object (its `this`):
//
//     Params        IReadOnlyDictionary<string,object?>  user parameters
//     VoxelSizeMM   float                                the job voxel size
//     SavePart(name, Voxels|Mesh)                         emit a result part
//     Log(msg)                                            structured progress note
//
// SavePart(Voxels) meshes the field, runs MeshClean (island removal + watertight),
// writes a binary STL to outputDir\{n}_{slug}.stl and appends a manifest entry.
// SavePart(Mesh) trusts the mesh (watertight CHECK only), writes + appends.
//
// The whole run happens inside `using var lib = new PicoGK.Library(voxelSizeMM)`
// so every `new Voxels(...)` / meshing call has a live kernel. A COMPILE failure
// throws ScriptCompilationException (Program.cs serializes the diagnostics); a
// RUNTIME exception propagates to the existing {error,stage:"script"} handler.
//
// Security: the script is arbitrary C# executed with the user's privileges in
// this process — there is NO sandbox. The server binds loopback only; see README.
//

using System.Collections.Immutable;
using System.Numerics;
using System.Text;
using System.Text.Json;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Scripting;
using Microsoft.CodeAnalysis.Scripting;
using PicoGK;

namespace Anvil.Worker
{
    /// <summary>One compiler diagnostic surfaced to the caller (1-based line/char).</summary>
    public sealed class ScriptDiagnostic
    {
        public int    line      { get; set; }
        public int    character { get; set; }
        public string severity  { get; set; } = "";
        public string message   { get; set; } = "";
    }

    /// <summary>
    /// A script that FAILED TO COMPILE. Carries every error diagnostic so the
    /// worker entry point can emit a structured {error,scriptError:[…]} line.
    /// </summary>
    public sealed class ScriptCompilationException : Exception
    {
        public IReadOnlyList<ScriptDiagnostic> Diagnostics { get; }
        public ScriptCompilationException(IReadOnlyList<ScriptDiagnostic> diagnostics)
            : base("script compilation failed") => Diagnostics = diagnostics;

        /// <summary>Map Roslyn error diagnostics (any source) to ScriptDiagnostics.</summary>
        public static ScriptCompilationException From(IEnumerable<Diagnostic> diags)
        {
            var list = new List<ScriptDiagnostic>();
            foreach (var d in diags)
            {
                if (d.Severity != DiagnosticSeverity.Error) continue;
                var pos = d.Location.GetLineSpan().StartLinePosition; // 0-based
                list.Add(new ScriptDiagnostic
                {
                    line      = pos.Line + 1,        // 1-based for humans
                    character = pos.Character + 1,
                    severity  = "error",
                    message   = d.GetMessage(),
                });
            }
            if (list.Count == 0)
                list.Add(new ScriptDiagnostic { line = 0, character = 0, severity = "error", message = "unknown compilation error" });
            return new ScriptCompilationException(list);
        }
    }

    /// <summary>One saved part in the script's output manifest (worker → server).</summary>
    public sealed class ScriptPartEntry
    {
        public string  name           { get; set; } = "";
        public string  path           { get; set; } = "";   // abs STL path in outputDir
        public float   volumeMM3      { get; set; }
        public int     triangles      { get; set; }
        public float   surfaceAreaMM2 { get; set; }
        public float[] cogMM          { get; set; } = new float[3];
        public float[] bboxMin        { get; set; } = new float[3];
        public float[] bboxMax        { get; set; } = new float[3];
        public bool    watertight     { get; set; }
    }

    /// <summary>
    /// The script's global scope (its `this`). Public members are directly in
    /// scope inside the .csx — a script just calls SavePart(...)/Log(...)/ParamF(...)
    /// and reads Params / VoxelSizeMM without qualification.
    /// </summary>
    public sealed class ScriptGlobals
    {
        private readonly string _outputDir;
        private readonly float  _voxelSizeMM;
        private readonly List<ScriptPartEntry> _parts = new();
        private int _saveIndex;
        private int _logCount;

        /// <summary>User parameters (numbers → double, strings, bools; else raw JSON text).</summary>
        public IReadOnlyDictionary<string, object?> Params { get; }

        /// <summary>The voxel size (mm) this job runs at.</summary>
        public float VoxelSizeMM => _voxelSizeMM;

        internal IReadOnlyList<ScriptPartEntry> SavedParts => _parts;
        internal int LogCount => _logCount;

        public ScriptGlobals(string outputDir, float voxelSizeMM, IReadOnlyDictionary<string, object?> prms)
        {
            _outputDir   = outputDir;
            _voxelSizeMM = voxelSizeMM;
            Params       = prms;
            Directory.CreateDirectory(_outputDir);
        }

        /// <summary>Read a numeric parameter (any JSON number) with a fallback.</summary>
        public float ParamF(string key, float fallback)
            => Params.TryGetValue(key, out var v) && v is not null && TryToFloat(v, out float f) ? f : fallback;

        /// <summary>Read a string parameter with a fallback.</summary>
        public string ParamS(string key, string fallback)
            => Params.TryGetValue(key, out var v) && v is string s ? s : fallback;

        /// <summary>Read a boolean parameter with a fallback.</summary>
        public bool ParamB(string key, bool fallback)
            => Params.TryGetValue(key, out var v) && v is bool b ? b : fallback;

        /// <summary>
        /// Save a voxel field as a result part: mesh it, run MeshClean (remove
        /// floating islands + directed-edge watertight check), write the STL, and
        /// append a manifest entry.
        /// </summary>
        public void SavePart(string name, Voxels vox)
        {
            Mesh msh = new Mesh(vox);
            Mesh cleaned = MeshClean.Clean(msh, _voxelSizeMM, new MeshCleanOptions(), out MeshCleanResult r);
            Save(name, cleaned, r.watertight);
        }

        /// <summary>
        /// Save a Forge <see cref="Shape"/> as a result part — identical to the
        /// Voxels overload (mesh, clean, watertight check, write, append).
        /// </summary>
        public void SavePart(string name, Shape shape)
        {
            if (shape is null) throw new ArgumentException($"SavePart('{name}'): shape is null");
            SavePart(name, shape.Voxels);
        }

        /// <summary>
        /// Save an already-built mesh as a result part: watertight CHECK only (no
        /// island removal — the caller owns the mesh topology), write, append.
        /// </summary>
        public void SavePart(string name, Mesh msh)
        {
            MeshClean.CheckWatertight(msh, 1e-4, out bool watertight, out _);
            Save(name, msh, watertight);
        }

        /// <summary>Emit a structured progress note the server collects into log[].</summary>
        public void Log(string message)
        {
            _logCount++;
            Progress.Note(new { log = message ?? "" });
        }

        // ---- internals ----------------------------------------------------

        private void Save(string name, Mesh msh, bool watertight)
        {
            string safeName = string.IsNullOrWhiteSpace(name) ? $"part{_saveIndex}" : name.Trim();
            string slug = Slug(safeName);
            string file = $"{_saveIndex}_{slug}.stl";
            _saveIndex++;
            string path = Path.Combine(_outputDir, file);
            msh.SaveToStlFile(path, Mesh.EStlUnit.MM); // FORCE MM

            MeshUtil.MeshMassProps(msh, out float vol, out float area, out Vector3 cog);
            BBox3 bb = msh.oBoundingBox();
            _parts.Add(new ScriptPartEntry
            {
                name           = safeName,
                path           = path,
                volumeMM3      = vol,
                triangles      = msh.nTriangleCount(),
                surfaceAreaMM2 = area,
                cogMM          = new[] { cog.X, cog.Y, cog.Z },
                bboxMin        = new[] { bb.vecMin.X, bb.vecMin.Y, bb.vecMin.Z },
                bboxMax        = new[] { bb.vecMax.X, bb.vecMax.Y, bb.vecMax.Z },
                watertight     = watertight,
            });
        }

        private static bool TryToFloat(object v, out float f)
        {
            switch (v)
            {
                case double d: f = (float)d; return true;
                case float ff: f = ff; return true;
                case long l:   f = l; return true;
                case int i:    f = i; return true;
                case string s when float.TryParse(s, System.Globalization.NumberStyles.Float,
                                                   System.Globalization.CultureInfo.InvariantCulture, out var ps):
                    f = ps; return true;
                default: f = 0f; return false;
            }
        }

        private static string Slug(string name)
        {
            var sb = new StringBuilder(name.Length);
            foreach (char c in name.ToLowerInvariant())
            {
                if (char.IsLetterOrDigit(c)) sb.Append(c);
                else if (sb.Length > 0 && sb[^1] != '_') sb.Append('_');
            }
            string s = sb.ToString().Trim('_');
            return string.IsNullOrEmpty(s) ? "part" : s;
        }
    }

    static class ScriptJob
    {
        public static void Run(JobRequest job)
        {
            if (string.IsNullOrEmpty(job.scriptPath)) throw new ArgumentException("script mode requires scriptPath");
            if (string.IsNullOrEmpty(job.outputDir))  throw new ArgumentException("script mode requires outputDir");
            if (!File.Exists(job.scriptPath))          throw new ArgumentException($"script not found: {job.scriptPath}");

            float voxel = job.voxelSizeMM > 0f ? job.voxelSizeMM : 0.3f;
            string code = File.ReadAllText(job.scriptPath);

            Progress.Report("compile", 0.1);

            // References by ASSEMBLY (never path strings): PicoGK, the worker itself
            // (Forge/MeshUtil/TPMSWall/MeshClean), and System.Numerics. Imports pull
            // the common namespaces plus two STATIC imports — System.Math and
            // Anvil.Worker.Forge — so a script writes Sqrt(2) and Box(10,10,10)
            // bare, with no qualification.
            var options = ScriptOptions.Default
                .WithReferences(
                    typeof(PicoGK.Library).Assembly,
                    typeof(Anvil.Worker.MeshUtil).Assembly,
                    typeof(System.Numerics.Vector3).Assembly)
                .WithImports(
                    "PicoGK", "Anvil.Worker",
                    "System", "System.Numerics", "System.Collections.Generic",
                    "System.Linq", "System.IO",
                    "System.Math", "Anvil.Worker.Forge");

            Script<object> script = CSharpScript.Create<object>(code, options, typeof(ScriptGlobals));

            // Compile FIRST so a compile error never even boots the PicoGK kernel.
            ImmutableArray<Diagnostic> diags = script.Compile();
            if (diags.Any(d => d.Severity == DiagnosticSeverity.Error))
                throw ScriptCompilationException.From(diags);

            var globals = new ScriptGlobals(job.outputDir!, voxel, BuildParams(job.scriptParams));

            // Bind the Forge command layer to THIS job: its voxel size, and the
            // folders a bare filename (Forge.FromFile / Forge.Emboss) resolves
            // against — the job's own output folder first, then the bundled
            // scripts-library assets, then the library and repo root.
            Forge.Configure(voxel, AssetSearchDirs(job.outputDir!));

            Progress.Report("script", 0.3);
            using (var lib = new PicoGK.Library(voxel)) // headless, per-job voxel size
            {
                try
                {
                    script.RunAsync(globals).GetAwaiter().GetResult();
                }
                catch (CompilationErrorException cee)
                {
                    // Defensive: RunAsync recompiled and found errors (should not
                    // happen — we compiled above — but map it structurally anyway).
                    throw ScriptCompilationException.From(cee.Diagnostics);
                }
            } // Library disposed → native run-once guard released

            Progress.Report("saving", 0.95);
            DoneStats(globals);
        }

        /// <summary>
        /// Ordered folders a bare asset filename resolves against, most specific
        /// first: the job's own output folder, the bundled scripts-library assets,
        /// the scripts-library itself, the repo root, then the process CWD. The
        /// repo root is found by walking up from the worker executable looking for
        /// Anvil.sln (dev tree) or a scripts-library folder (deployed tree).
        /// </summary>
        private static IEnumerable<string> AssetSearchDirs(string outputDir)
        {
            var dirs = new List<string> { outputDir };

            string? root = null;
            var dir = new DirectoryInfo(AppContext.BaseDirectory);
            for (int i = 0; i < 8 && dir is not null; i++, dir = dir.Parent)
            {
                if (File.Exists(Path.Combine(dir.FullName, "Anvil.sln")) ||
                    Directory.Exists(Path.Combine(dir.FullName, "scripts-library")))
                {
                    root = dir.FullName;
                    break;
                }
            }

            if (root is not null)
            {
                dirs.Add(Path.Combine(root, "scripts-library", "assets"));
                dirs.Add(Path.Combine(root, "scripts-library"));
                dirs.Add(root);
            }
            dirs.Add(Directory.GetCurrentDirectory());
            return dirs;
        }

        /// <summary>Emit the script done-line: {parts:[…manifest], logCount}.</summary>
        private static void DoneStats(ScriptGlobals g)
        {
            Progress.CurrentStage = "done";
            var stats = new { parts = g.SavedParts, logCount = g.LogCount };
            Console.WriteLine(JsonSerializer.Serialize(new { stage = "done", stats }));
            Console.Out.Flush();
        }

        /// <summary>Unwrap JSON params to plain CLR values for ScriptGlobals.Params.</summary>
        private static IReadOnlyDictionary<string, object?> BuildParams(
            Dictionary<string, JsonElement>? sp)
        {
            var d = new Dictionary<string, object?>(StringComparer.Ordinal);
            if (sp is not null)
                foreach (var kv in sp)
                    d[kv.Key] = Unwrap(kv.Value);
            return d;
        }

        private static object? Unwrap(JsonElement e) => e.ValueKind switch
        {
            JsonValueKind.Number => e.GetDouble(),
            JsonValueKind.String => e.GetString(),
            JsonValueKind.True   => true,
            JsonValueKind.False  => false,
            JsonValueKind.Null   => null,
            _ => e.GetRawText(),   // arrays/objects: raw JSON text
        };
    }
}
