# MELRA Python SDK

Async Python client for MELRA task, evidence, and durable workflow interfaces.
Requires Python 3.11 or newer (CI covers 3.11 through 3.14), and the wheel ships
`py.typed`, so mypy and pyright use its annotations.

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
