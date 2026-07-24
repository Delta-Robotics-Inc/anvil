//
// Anvil.Worker — entry point
//
// Usage: AnvilWorker <job.json>
//
// Reads a JobRequest from job.json, runs the gyroid pipeline, streams JSON-line
// progress on stdout, exits 0 on success. On failure, prints a single JSON error
// object on stderr and exits non-zero.
//

using System.Text.Json;
using Anvil.Worker;

// Auto-flush stdout so the server can stream progress line-by-line.
var stdout = new StreamWriter(Console.OpenStandardOutput()) { AutoFlush = true };
Console.SetOut(stdout);

if (args.Length < 1)
{
    Console.Error.WriteLine(JsonSerializer.Serialize(new { error = "usage: AnvilWorker <job.json>", stage = "args" }));
    return 2;
}

string jobPath = args[0];
JobRequest job;
try
{
    string json = File.ReadAllText(jobPath);
    job = JsonSerializer.Deserialize<JobRequest>(json, JobRequest.JsonOptions)
          ?? throw new Exception("job.json deserialized to null");
}
catch (Exception ex)
{
    Console.Error.WriteLine(JsonSerializer.Serialize(new { error = $"failed to read job.json: {ex.Message}", stage = "parse" }));
    return 3;
}

try
{
    GyroidJob.Run(job);
    Console.Out.Flush();
    return 0;
}
catch (ScriptCompilationException sce)
{
    // A script that failed to COMPILE: emit the structured diagnostics so the
    // server/agent can point at the offending line(s). stage stays "script".
    Console.Out.Flush();
    Console.Error.WriteLine(JsonSerializer.Serialize(new
    {
        error = "script compilation failed",
        stage = "script",
        scriptError = sce.Diagnostics,
    }));
    return 1;
}
catch (Exception ex)
{
    Console.Out.Flush();
    Console.Error.WriteLine(JsonSerializer.Serialize(new { error = ex.Message, stage = Progress.CurrentStage }));
    return 1;
}
