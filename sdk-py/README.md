# MELRA Python SDK

Async Python client for MELRA task, evidence, and durable workflow interfaces.
Requires Python 3.11 or newer (CI covers 3.11 through 3.14), and the wheel ships
`py.typed`, so mypy and pyright use its annotations.

## Install

> [!CAUTION]
> This SDK is not published on PyPI, so `pip install melra` does not install
> it. A `melra` package that appears there is not this project's.

Each [GitHub release](https://github.com/XAGI-Lab/melra/releases) attaches the
wheel, named with the Python spelling of the version (`0.3.0a12` for
`0.3.0-alpha.12`). It is covered by the release's `SHA256SUMS` and its signed
provenance attestation. Download the wheel and `SHA256SUMS` into one
directory, then check the wheel before installing it by path; each step runs
only if the one before it passed:

```bash
sha256sum --check --ignore-missing SHA256SUMS &&
  gh attestation verify melra-0.3.0a12-py3-none-any.whl --repo XAGI-Lab/melra &&
  pip install ./melra-0.3.0a12-py3-none-any.whl
```

From a checkout of the repository, or for a release without a wheel attached,
install from source: `pip install ./sdk-py`.

`MelraClient()` starts `melra serve` from your `PATH`, which
`npm install -g @melra/cli@alpha` puts there. For an install that leaves no
`melra` on the `PATH` ([npx, the release tarball, a checkout, the single
executable](../docs/INSTALLATION.md#install)), name the launcher yourself, for
example `MelraClient(command="npx", args=["-y", "@melra/cli@alpha", "serve"])`.
`connect_http` and `connect_socket` start nothing, so they need no CLI on this
machine.

## Use

```python
from melra import MelraClient

async with MelraClient(workspace="/path/to/project") as melra:
    capabilities = await melra.capabilities()
```

That spawns `melra serve` over stdio. The server gets this process's
environment except `MELRA_UNHINGED` and `MELRA_SOCKET`, so a credential a
policy reads from the environment, `MELRA_BROWSER*`, `LANG` and `CI` reach it.
`workspace` and `data_directory` set `MELRA_WORKSPACE` and `MELRA_HOME`, and
`environment` goes on top of all of it, so pass either of the two left out
there to mean it. The TypeScript SDK's `connect()` passes the same.

To use a server that is already running, connect to it instead; every method is
the same:

```python
# melra serve --http — the MCP URL and token it prints at startup
async with MelraClient.connect_http("http://127.0.0.1:7457/mcp", token=token) as melra:
    ...

# melra serve --socket <path> — not available on Windows
async with MelraClient.connect_socket("/run/user/1000/melra.sock", token=token) as melra:
    ...
```

`token` is required and never read from the environment for you: a library that
picks up a credential on its own and sends it to whatever URL it was handed is
how tokens leak, so pass `os.environ["MELRA_HTTP_TOKEN"]` yourself if that is
where it lives. A wrong token raises `PermissionError`.
The token can drive the machine, so `connect_http` refuses plain `http://` to
anything but a loopback host; reach a remote server over `https://`, or pass
`allow_insecure_http=True` on a network you trust.

## Methods

`capabilities`, `plan`, `execute`, `status`, `cancel`, `receipt` and `judge`
call the task tools; `plan_workflow`, `advance_workflow`, `workflow_status`,
`cancel_workflow` and `control_workflow` call the workflow tools. `call_tool`
reaches any tool by name.

A task whose `requiredEvidence` asks a `semantic` question stops at
`waiting_user` until someone outside MELRA answers it. Answer it as a principal
other than the one that planned it:

```python
waiting = await melra.status(task_id)
judged = await melra.judge(
    task_id,
    waiting["judgements"][0]["judgementId"],
    "yes",  # or "no", "cannot_tell"
    identity={"principal": {"kind": "agent", "id": "grader"}},
    rationale="The summary covers every section.",  # optional; MELRA never reads it
)
```

A judge declaring the task's own principal or one of the non-human links it
acts for, or whose `onBehalfOf` names that principal, is refused with
`semantic_judge_is_actor`. In enforced mode a verdict sent this way is refused,
and an operator answers with `melra judge`.
