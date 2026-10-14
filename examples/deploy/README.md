# Hardened deployment recipes

Runnable setups where the operating system, not MELRA, keeps the process boxed
in (#52). Each one is exercised in CI, and `melra doctor` run under it reports
what actually took effect on its `isolation` line.

| Recipe | Platform | What the kernel enforces | CI check |
|---|---|---|---|
| [`systemd/melra.service`](systemd/melra.service) | Linux | no capabilities, `no_new_privs`, a seccomp filter (`@system-service`), a read-only filesystem except the workspace and data directory, private `/tmp` and devices, IP and Unix sockets only | `scripts/systemd-smoke.mjs`: `doctor` must show all four restrictions, and conformance must reach L3 inside them |
| [`macos/melra.sb`](macos/melra.sb) | macOS | writes confined to the workspace, the data directory, and temp folders, for MELRA and every command it runs; `sudo`, `su`, and `login` refused | `scripts/macos-sandbox-smoke.mjs`: conformance must reach L3 inside it, a write inside the workspace must succeed, and a write to the home folder must be refused by the kernel |
| [Docker](../../docs/INSTALLATION.md#docker) | any OCI host | read-only root, `--cap-drop ALL`, `no-new-privileges`, Docker's default seccomp profile | `scripts/docker-smoke.mjs` |

The systemd unit serves on a mode-`0600` Unix socket in a runtime directory
only its user can enter, with `MELRA_MODE=enforced`. Edit the two paths in it,
`MELRA_WORKSPACE` and `MELRA_HOME`, and the `ReadWritePaths` line that matches
them.

Run the macOS profile with
`sandbox-exec -f melra.sb -D WORKSPACE="$PWD" -D MELRA_HOME="$HOME/.melra" melra serve`.
It does not cover the browser adapter: Chrome brings its own sandbox and will
not start inside another one. `melra doctor` cannot see a sandbox profile from
inside, so its `isolation` line on macOS says so rather than guessing.

Still open on #52: a Windows Job Object equivalent.
