# MELRA CLI

Everything in one command, with nothing installed beforehand, run from the
project the agent should work in:

```bash
cd ~/project
npx @melra/cli@alpha setup
```

That directory becomes the agent's workspace, the boundary for its file and
command operations; set `MELRA_WORKSPACE` to choose another. `setup` writes a
safe local policy, produces an MCP client configuration, and runs every
readiness check (Node, workspace, SQLite, browser, computer-use adapter,
policy, MCP clients). In a terminal it asks which detected client to set up
and offers to write MELRA into that client's own config file;
`--client <name> --write` does the same without asking which, and piped or
with `--json` it prints JSON. If the workspace would be your home directory, a
directory holding it, or a filesystem root, `setup` and `init` ask first in a
terminal and otherwise refuse with `workspace_too_broad`, unless
`MELRA_WORKSPACE` is set. It exits non-zero if a check fails and never
overwrites an existing policy.

To keep a resolved copy on the machine instead of resolving on every run:

```bash
npm install --global @melra/cli@alpha
melra setup
```

Either way the generated configuration names a command your client can actually
spawn: run through `npx` and it launches the server through `npx` at the exact
version that wrote the config, since an `npx` install leaves no `melra` on your
`PATH`.

Individual steps are still available: `melra doctor` checks readiness and writes
nothing, `melra init` writes the policy and config without checking. `melra
serve` speaks stdio, `--http` loopback HTTP with the console, and `--socket
<path>` a mode-`0600` Unix socket; `melra tasks`, `watch`, and `status` show what
MELRA is doing without a server. Run `melra help` for the full command list.

`melra conformance` checks a running endpoint rather than a build — its own
stdio server by default, or `--url` for a loopback HTTP one — and reports the
level it earned: L1 typed effects, L2 governed effects, L3 verified effects.
The report says what the level does not prove as plainly as what it does.

The CLI starts with a local policy that allows reads outright and gates every
mutation: a consequential operation requires declared evidence and an exact,
task-scoped approval before it runs: a phrase echoed back in developer mode, or
an operator's `melra approve <task-id>` in enforced mode, where the agent is
given no phrase and one it sends is refused.

Requires Node.js 22.13 or newer, or 23.4 or newer. Full documentation:
[github.com/XAGI-Lab/melra](https://github.com/XAGI-Lab/melra)
