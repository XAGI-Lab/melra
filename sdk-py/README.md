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

That spawns `melra serve` over stdio. To use a server that is already running,
connect to it instead; every method is the same:

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
