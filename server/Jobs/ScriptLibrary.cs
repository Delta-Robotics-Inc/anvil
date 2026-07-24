//
// ScriptLibrary — the merged .csx catalog behind /api/scripts and the MCP
// list_scripts / get_script / save_script tools.
//
// Two sources, merged newest-first:
//   * "library"  scripts-library\*.csx   (versioned seeds in the repo, read-only)
//   * "user"     {DataDir}\scripts\*.csx  (saved via POST /api/scripts / save_script)
//
// Ids are "{source}:{stem}" (e.g. "library:heat_exchanger_core"). Saving a
// script slugifies the name to a filename and REFUSES anything that would escape
// the user scripts dir (path traversal). The user dir is gitignored.
//
using System.Text;
using Anvil.Server.Api;

namespace Anvil.Server.Jobs;

public sealed record ScriptDescriptor(string id, string name, string source, string? savedUtc);
public sealed record ScriptContent(string id, string name, string code, string source);

public sealed class ScriptLibrary
{
    private readonly string _libraryDir;   // repoRoot\scripts-library
    private readonly string _userDir;      // dataDir\scripts

    public ScriptLibrary(AppPaths paths)
    {
        _libraryDir = Path.Combine(paths.RepoRoot, "scripts-library");
        _userDir = Path.Combine(paths.DataDir, "scripts");
    }

    public string UserDir => _userDir;

    /// <summary>All scripts (library + user), newest-first by last-write.</summary>
    public IReadOnlyList<ScriptDescriptor> List()
    {
        var list = new List<(ScriptDescriptor d, DateTime t)>();
        Collect(_libraryDir, "library", list);
        Collect(_userDir, "user", list);
        return list.OrderByDescending(x => x.t).Select(x => x.d).ToList();
    }

    /// <summary>Resolve a script by id ("{source}:{stem}") and return its code.</summary>
    public ScriptContent? Get(string id)
    {
        if (string.IsNullOrWhiteSpace(id)) return null;
        string source, stem;
        int colon = id.IndexOf(':');
        if (colon > 0)
        {
            source = id[..colon];
            stem = id[(colon + 1)..];
        }
        else
        {
            // Bare stem: search library first, then user.
            source = "library";
            stem = id;
            if (ResolveFile(_libraryDir, stem) is null && ResolveFile(_userDir, stem) is not null)
                source = "user";
        }

        string dir = source == "user" ? _userDir : _libraryDir;
        string? file = ResolveFile(dir, stem);
        if (file is null) return null;

        string code = File.ReadAllText(file);
        string name = Path.GetFileNameWithoutExtension(file);
        return new ScriptContent($"{source}:{name}", name, code, source);
    }

    /// <summary>
    /// Save a user script. The name is slugified to a filename; the result MUST
    /// stay inside the user scripts dir (else ArgumentException). Returns the
    /// saved descriptor.
    /// </summary>
    public ScriptDescriptor Save(string name, string code)
    {
        if (string.IsNullOrWhiteSpace(name)) throw new ArgumentException("script name is required");
        if (string.IsNullOrWhiteSpace(code)) throw new ArgumentException("script code is required");

        string slug = Slug(name);
        if (slug.Length == 0) throw new ArgumentException("script name has no usable characters");

        Directory.CreateDirectory(_userDir);
        string file = Path.Combine(_userDir, slug + ".csx");

        // Path-traversal guard: the resolved file must live directly in _userDir.
        string fullUser = Path.GetFullPath(_userDir);
        string fullFile = Path.GetFullPath(file);
        if (!fullFile.StartsWith(fullUser + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase) ||
            !string.Equals(Path.GetDirectoryName(fullFile), fullUser.TrimEnd(Path.DirectorySeparatorChar), StringComparison.OrdinalIgnoreCase))
            throw new ArgumentException("invalid script name (path traversal rejected)");

        File.WriteAllText(fullFile, code);
        return new ScriptDescriptor($"user:{slug}", slug, "user",
            File.GetLastWriteTimeUtc(fullFile).ToString("o"));
    }

    // ---- helpers -----------------------------------------------------------

    private static void Collect(string dir, string source, List<(ScriptDescriptor, DateTime)> into)
    {
        if (!Directory.Exists(dir)) return;
        foreach (string path in Directory.EnumerateFiles(dir, "*.csx"))
        {
            string stem = Path.GetFileNameWithoutExtension(path);
            DateTime t = File.GetLastWriteTimeUtc(path);
            into.Add((new ScriptDescriptor($"{source}:{stem}", stem, source, t.ToString("o")), t));
        }
    }

    /// <summary>Find "{stem}.csx" in dir, guarding against traversal in the stem.</summary>
    private static string? ResolveFile(string dir, string stem)
    {
        if (string.IsNullOrWhiteSpace(stem)) return null;
        // Reject any separators / traversal — a stem is a bare filename.
        if (stem.IndexOfAny(new[] { '/', '\\', ':' }) >= 0 || stem.Contains("..")) return null;
        string file = Path.Combine(dir, stem + ".csx");
        return File.Exists(file) ? file : null;
    }

    private static string Slug(string name)
    {
        var sb = new StringBuilder(name.Length);
        foreach (char c in name.ToLowerInvariant())
        {
            if (char.IsLetterOrDigit(c)) sb.Append(c);
            else if (sb.Length > 0 && sb[^1] != '_') sb.Append('_');
        }
        return sb.ToString().Trim('_');
    }
}
