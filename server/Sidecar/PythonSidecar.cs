//
// PythonSidecar — wraps sidecar/cadconvert.py (STEP<->STL, checkstep).
//
// Contract (from the sidecar's own docstring): parse the LAST non-empty line
// of stdout as JSON on success; on failure the process exits non-zero and
// writes a single {"error","detail"} JSON object to stderr. This wrapper
// surfaces that as SidecarException so callers can report a clean message.
//
using System.Diagnostics;
using System.Text;
using System.Text.Json;

namespace Anvil.Server.Sidecar;

public sealed class SidecarException : Exception
{
    public string? Detail { get; }
    public SidecarException(string message, string? detail = null) : base(message) => Detail = detail;
}

public sealed record Step2StlResult(int Triangles, double[] BboxMin, double[] BboxMax);
public sealed record Stl2StepResult(int Triangles, string? Warning, double Seconds);
public sealed record CheckStepResult(bool Valid, int Solids, int Shells);

public sealed class PythonSidecar
{
    private readonly string _python;      // e.g. C:\Python314\python.exe
    private readonly string _scriptPath;  // abs path to cadconvert.py
    private readonly ILogger<PythonSidecar> _log;

    public PythonSidecar(string pythonPath, string scriptPath, ILogger<PythonSidecar> log)
    {
        _python = pythonPath;
        _scriptPath = scriptPath;
        _log = log;
    }

    public string PythonPath => _python;
    public string ScriptPath => _scriptPath;
    public bool ScriptExists => File.Exists(_scriptPath);

    public async Task<Step2StlResult> Step2StlAsync(
        string inStep, string outStl, double linTol = 0.1, double angTol = 0.3,
        TimeSpan? timeout = null, CancellationToken ct = default)
    {
        var json = await RunAsync(
            new[] { "step2stl", inStep, outStl, "--lin-tol", Num(linTol), "--ang-tol", Num(angTol) },
            timeout ?? TimeSpan.FromMinutes(5), ct);

        int tris = json.GetProperty("triangles").GetInt32();
        var bb = json.GetProperty("bbox");
        double[] min = ToArr(bb.GetProperty("min"));
        double[] max = ToArr(bb.GetProperty("max"));
        return new Step2StlResult(tris, min, max);
    }

    public async Task<Stl2StepResult> Stl2StepAsync(
        string inStl, string outStep, int maxTris = 500_000,
        TimeSpan? timeout = null, CancellationToken ct = default)
    {
        var json = await RunAsync(
            new[] { "stl2step", inStl, outStep, "--max-tris", maxTris.ToString() },
            timeout ?? TimeSpan.FromMinutes(10), ct);

        int tris = json.GetProperty("triangles").GetInt32();
        string? warning = json.TryGetProperty("warning", out var w) && w.ValueKind == JsonValueKind.String
            ? w.GetString() : null;
        double seconds = json.TryGetProperty("seconds", out var s) ? s.GetDouble() : 0;
        return new Stl2StepResult(tris, warning, seconds);
    }

    public async Task<CheckStepResult> CheckStepAsync(
        string inStep, TimeSpan? timeout = null, CancellationToken ct = default)
    {
        var json = await RunAsync(
            new[] { "checkstep", inStep },
            timeout ?? TimeSpan.FromMinutes(5), ct);

        return new CheckStepResult(
            json.GetProperty("valid").GetBoolean(),
            json.GetProperty("solids").GetInt32(),
            json.GetProperty("shells").GetInt32());
    }

    // --- core process runner ------------------------------------------------
    private async Task<JsonElement> RunAsync(string[] args, TimeSpan timeout, CancellationToken ct)
    {
        if (!File.Exists(_python))
            throw new SidecarException($"python interpreter not found: {_python}");
        if (!ScriptExists)
            throw new SidecarException($"sidecar script not found: {_scriptPath}");

        var psi = new ProcessStartInfo
        {
            FileName = _python,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        psi.ArgumentList.Add(_scriptPath);
        foreach (var a in args) psi.ArgumentList.Add(a);

        using var proc = new Process { StartInfo = psi };
        var stdout = new StringBuilder();
        var stderr = new StringBuilder();
        proc.OutputDataReceived += (_, e) => { if (e.Data != null) stdout.AppendLine(e.Data); };
        proc.ErrorDataReceived += (_, e) => { if (e.Data != null) stderr.AppendLine(e.Data); };

        _log.LogInformation("sidecar: {Python} {Script} {Args}", _python, Path.GetFileName(_scriptPath), string.Join(' ', args));

        if (!proc.Start())
            throw new SidecarException("failed to start python sidecar process");
        proc.BeginOutputReadLine();
        proc.BeginErrorReadLine();

        using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeoutCts.CancelAfter(timeout);
        try
        {
            await proc.WaitForExitAsync(timeoutCts.Token);
        }
        catch (OperationCanceledException)
        {
            TryKill(proc);
            throw new SidecarException($"sidecar timed out after {timeout.TotalSeconds:0}s");
        }

        if (proc.ExitCode != 0)
        {
            // stderr should be {"error","detail"} JSON — surface the detail.
            string err = stderr.ToString().Trim();
            string message = $"sidecar exited {proc.ExitCode}";
            string? detail = err;
            try
            {
                string last = LastNonEmptyLine(err);
                using var doc = JsonDocument.Parse(last);
                var root = doc.RootElement;
                string? e = root.TryGetProperty("error", out var ep) ? ep.GetString() : null;
                string? d = root.TryGetProperty("detail", out var dp) ? dp.GetString() : null;
                if (!string.IsNullOrEmpty(d)) { detail = d; message = e is null ? d! : $"{e}: {d}"; }
                else if (!string.IsNullOrEmpty(e)) { message = e!; detail = e; }
            }
            catch { /* non-JSON stderr — keep raw */ }
            throw new SidecarException(message, detail);
        }

        string outText = stdout.ToString().Trim();
        string lastLine = LastNonEmptyLine(outText);
        if (string.IsNullOrEmpty(lastLine))
            throw new SidecarException("sidecar produced no output to parse");
        try
        {
            using var doc = JsonDocument.Parse(lastLine);
            // Clone so the JsonElement outlives the JsonDocument's disposal.
            return doc.RootElement.Clone();
        }
        catch (JsonException je)
        {
            throw new SidecarException($"could not parse sidecar output as JSON: {je.Message}", lastLine);
        }
    }

    private static void TryKill(Process p)
    {
        try { if (!p.HasExited) p.Kill(entireProcessTree: true); } catch { }
    }

    private static string LastNonEmptyLine(string s)
    {
        var lines = s.Split('\n');
        for (int i = lines.Length - 1; i >= 0; i--)
        {
            string t = lines[i].Trim();
            if (t.Length > 0) return t;
        }
        return "";
    }

    private static double[] ToArr(JsonElement e)
    {
        var list = new List<double>(3);
        foreach (var v in e.EnumerateArray()) list.Add(v.GetDouble());
        return list.ToArray();
    }

    private static string Num(double d) => d.ToString(System.Globalization.CultureInfo.InvariantCulture);
}
