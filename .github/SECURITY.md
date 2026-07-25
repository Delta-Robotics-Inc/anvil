# Security Policy

## Supported versions

ANVIL is pre-1.0 and ships from `main`. Only the latest commit on `main`
receives fixes; there are no maintained release branches or backports.

| Version | Supported |
| --- | --- |
| Latest commit on `main` | Yes |
| Any earlier commit or tag | No - please update before reporting |

## Reporting a vulnerability

Please do **not** open a public issue for a vulnerability.

1. Preferred: use GitHub [private vulnerability reporting](https://github.com/Delta-Robotics-Inc/anvil/security/advisories/new).
   It drafts a private advisory and credits you automatically.
2. Or email **mark@deltaroboticsinc.com** with "ANVIL security" in the subject.

Please include the version or commit, your OS, reproduction steps, and the
impact you believe it has. A proof of concept helps a lot.

**Response expectations.** ANVIL is maintained by a small team alongside other
work. Expect an acknowledgement within a few days. We will tell you what we
found, agree a fix window with you, and credit you in the advisory unless you
would rather stay anonymous. Please give us a reasonable chance to ship a fix
before disclosing publicly.

## Design notes: what is intentionally not a vulnerability

Read this before reporting. ANVIL is a **local, single-user desktop tool** whose
whole purpose is to run geometry code on your machine. Several behaviours look
alarming out of context but are deliberate, documented design.

### The server is loopback-only and unauthenticated

`AnvilServer` binds **`http://127.0.0.1:5238` only** and has **no
authentication, no authorization and no CSRF protection**. That is the security
model: the trust boundary is your machine's loopback interface, and everything
inside it is treated as you.

Consequences you must respect:

- **Do not bind it to a public interface**, port-forward it, expose it through a
  reverse proxy, or publish it over a tunnel such as ngrok or Cloudflare Tunnel.
- **Anyone who can reach port 5238 can run arbitrary code as your user.** On a
  shared or multi-user machine, treat the port as equivalent to a shell.
- Reports that amount to "the API has no authentication" or "the endpoint
  accepts unauthenticated requests" are working as designed and will be closed.

### The scripting endpoint executes arbitrary code by design

`POST /api/scripts/run`, the **SCRIPTS** panel, and the `run_script` MCP tool
compile and execute **user-supplied C#** in a worker process. This is the
headline feature, not an oversight.

- **There is no sandbox.** A script runs with your full user privileges. It can
  read, write and delete any file you can, open network connections, and start
  processes.
- Per-job worker processes exist for **crash isolation and cleanup**, not as a
  security boundary. Do not treat process separation as containment.
- **Treat a `.csx` exactly like an executable someone handed you.** Read it
  before you run it. Do not run scripts from untrusted sources.
- `add_part_from_file` and the export tools read and write **arbitrary absolute
  paths** on your filesystem, by design.

### Connecting an agent to `/mcp` grants code execution

The MCP server at `/mcp` is stateless HTTP with **no authentication**. Any MCP
client that can reach it can drive every tool, including `run_script`.
Connecting an agent to ANVIL means **that agent can run code on this machine.**
Only connect agents you trust, and be aware that prompt injection reaching such
an agent inherits that capability.

### What we *do* want to hear about

- Path traversal that escapes `DataDir` through the parts, scripts or export
  endpoints (script saving is meant to reject traversal - a bypass is a bug).
- A way for a **remote** origin to reach the API, for example a DNS-rebinding or
  CORS weakness that lets a web page in your browser drive the local server.
- Memory-safety or crash bugs in mesh or STL parsing that are reachable from an
  uploaded file, especially anything exploitable beyond a denial of service.
- Resource-exhaustion paths that bypass the voxel resolution guard.
- Vulnerable third-party dependencies we ship or reference.
- Anything that leaks a secret, credential or file outside the data directory.

## Hardening notes for operators

- Keep ANVIL on a workstation you control. It is not a service.
- Do not run it as Administrator. Nothing in ANVIL needs elevation.
- Keep `DataDir` (default `data/`) on a local disk, not a network share.
- Uploaded and derived parts are stored unencrypted on disk. If your geometry is
  sensitive, use full-disk encryption and clear `data/` when you are done.
- Review any script from the internet before running it, exactly as you would a
  downloaded `.exe`.
