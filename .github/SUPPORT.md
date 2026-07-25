# Getting help

ANVIL is maintained by a small team at Delta Robotics alongside other work.
Using the right channel gets you a faster answer and keeps the issue tracker
usable.

## Where to go

| You want to ... | Go here |
| --- | --- |
| Report a bug, crash, or wrong geometry | [Open a bug report](https://github.com/Delta-Robotics-Inc/anvil/issues/new?template=1-bug.yml) |
| Request a feature, pattern, or metric | [Open a feature request](https://github.com/Delta-Robotics-Inc/anvil/issues/new?template=2-feature.yml) |
| Ask "how do I ...", tune parameters, or sanity-check an approach | [Discussions](https://github.com/Delta-Robotics-Inc/anvil/discussions) |
| Chat with the maintainers and other users in real time | [Delta Robotics Discord](https://discord.gg/W69MdWMrhH) |
| Show a part you made with it | [Discussions](https://github.com/Delta-Robotics-Inc/anvil/discussions) or the Discord - genuinely, we like seeing these |
| Report a security vulnerability | [Security policy](SECURITY.md) - **never** a public issue |
| Contribute code or docs | [CONTRIBUTING.md](CONTRIBUTING.md) |

## Before you ask

Most first-run problems are covered already:

- **[Troubleshooting in the README](../README.md#troubleshooting)** - build
  failures, the sibling PicoGK checkout, the Python sidecar, resolution-guard
  rejections, and slow or huge STEP exports.
- **[Requirements](../README.md#requirements)** - the exact .NET, Python and
  PicoGK versions ANVIL expects.
- Search [existing issues](https://github.com/Delta-Robotics-Inc/anvil/issues?q=is%3Aissue)
  and [discussions](https://github.com/Delta-Robotics-Inc/anvil/discussions).

If you hit a build error, please confirm first that a plain
`dotnet build Anvil.sln` succeeds with PicoGK checked out as a sibling
directory. That single check resolves most setup reports.

## Agent, MCP and scripting questions are welcome

Driving ANVIL from Claude Code, Claude Desktop or your own agent is a supported,
first-class workflow, and so is the C# scripting surface. Questions about MCP
tool behaviour, script APIs (`SavePart`, `TPMSWall`, custom `IImplicit`
fields) and agent-driven CAD pipelines belong in Discussions and we are happy to
get them. Please read the [scripting security
notes](SECURITY.md#the-scripting-endpoint-executes-arbitrary-code-by-design)
first - the endpoint runs arbitrary code with your privileges by design.

## Response expectations

This is not a commercial support channel. We aim to acknowledge issues and pull
requests **within a few days**, and we will always tell you when something is
out of scope rather than leaving it open forever. Security reports get
priority. If an issue goes quiet, a polite bump is fine.
