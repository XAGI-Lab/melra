# Hardened deployment recipes

Runnable setups where the operating system, not MELRA, keeps the process boxed
in (#52). Each one is exercised in CI. `melra doctor` run under the first three
reports what actually took effect on its `isolation` line; the container pair
also boxes the agent, and `melra probe` checks it from the agent's side.

| Recipe | Platform | What the kernel enforces | CI check |
|---|---|---|---|
| [`systemd/melra.service`](systemd/melra.service) | Linux | no capabilities, `no_new_privs`, a seccomp filter (`@system-service`), a read-only filesystem except the workspace and data directory, private `/tmp` and devices, IP and Unix sockets only | `scripts/systemd-smoke.mjs`: `doctor` must show all four restrictions, and conformance must reach L3 inside them |
| [`macos/melra.sb`](macos/melra.sb) | macOS | writes confined to the workspace, the data directory, and temp folders, for MELRA and every command it runs; `sudo`, `su`, and `login` refused | `scripts/macos-sandbox-smoke.mjs`: conformance must reach L3 inside it, a write inside the workspace must succeed, and a write to the home folder must be refused by the kernel |
| [Docker](../../docs/INSTALLATION.md#docker) | any OCI host | read-only root, `--cap-drop ALL`, `no-new-privileges`, Docker's default seccomp profile | `scripts/docker-smoke.mjs` |
| [`compose/compose.yaml`](compose/compose.yaml) | Docker Engine 28.0 or later | MELRA and the agent in separate containers: the agent gets the workspace read-only, no MELRA data, no network route out or address on the host, and MELRA's mode-`0600` socket; both get a read-only root, no capabilities, `no-new-privileges`, and process and memory caps | `scripts/compose-smoke.mjs`: from inside the agent's container, `melra probe` must find a workspace write, MELRA's data, a connection out and one to the host refused (both aimed at the runner), and a file write through the socket, approved from MELRA's side, must reach `verified_success` with a receipt |

The systemd unit serves on a mode-`0600` Unix socket in a runtime directory
only its user can enter, with `MELRA_MODE=enforced`. Edit the two paths in it,
`MELRA_WORKSPACE` and `MELRA_HOME`, and the `ReadWritePaths` line that matches
them.

Run the macOS profile with
`sandbox-exec -f melra.sb -D WORKSPACE="$PWD" -D MELRA_HOME="$HOME/.melra" melra serve`.
It does not cover the browser adapter: Chrome brings its own sandbox and will
not start inside another one. `melra doctor` cannot see a sandbox profile from
inside, so its `isolation` line on macOS says so rather than guessing.

**On Windows**, run MELRA inside one of the recipes above: Docker Desktop with
the Docker recipe, or WSL2 with the systemd unit (WSL2 runs systemd when
`systemd=true` is set under `[boot]` in `/etc/wsl.conf`). There is no native
Windows recipe. A Job Object limits processes and memory, not file access, so
it would not confine writes the way the recipes above do; that needs a
low-privilege account with NTFS ACLs, or an AppContainer, and a CI check that
a write outside the workspace is refused. `melra doctor` on native Windows
says so on its `isolation` line.
