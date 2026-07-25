# What

<!-- What does this change do? One or two sentences. -->

# Why

<!-- The problem it solves. Link the issue: "Fixes #123" / "Part of #123". -->

# How it was tested

<!--
Geometry code fails in ways a compiler cannot catch. Say what you actually ran,
with numbers where you have them (triangle counts, volumes, porosity, timings).
Screenshots of before/after are very welcome for anything visual.
-->

## Checklist

- [ ] `dotnet build Anvil.sln` is clean (no new warnings).
- [ ] `scripts\test_ops.ps1` passes (worker CLI: primitives, booleans, shell, offset, transform, mirror, zoned generate).
- [ ] `scripts\test_api.ps1` passes (HTTP surface: parts, ops, jobs, export, lattice part registration).
- [ ] `scripts\test_scripts.ps1` passes (Roslyn scripting and the MCP JSON-RPC smoke test).
- [ ] I exercised the change in the browser at `http://127.0.0.1:5238` and the console is clean.
- [ ] Geometry changes preserve the coordinate guarantee: nothing is recentered, and results still land in the source world frame.
- [ ] Docs updated (README, CONTRIBUTING, or in-code comments) if behaviour or setup changed.
- [ ] `CHANGELOG.md` has an entry under `[Unreleased]` if this is user-visible.
- [ ] New assertions added to the relevant test harness for new behaviour.
- [ ] Commits are signed off for the DCO (`git commit -s`). See [CONTRIBUTING](CONTRIBUTING.md#developer-certificate-of-origin).

## Notes for the reviewer

<!-- Trade-offs, things you are unsure about, follow-up work you deliberately left out. -->
