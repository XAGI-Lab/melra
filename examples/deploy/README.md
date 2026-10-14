# Hardened deployment recipes

Runnable setups where the operating system, not MELRA, keeps the process boxed
in (#52). Each one is exercised in CI, and `melra doctor` run under it reports
what actually took effect on its `isolation` line.

| Recipe | Platform | What the kernel enforces | CI check |
|---|---|---|---|
| [`systemd/melra.service`](systemd/melra.service) | Linux | no capabilities, `no_new_privs`, a seccomp filter (`@system-service`), a read-only filesystem except the workspace and data directory, private `/tmp` and devices, IP and Unix sockets only | `scripts/systemd-smoke.mjs`: `doctor` must show all four restrictions, and conformance must reach L3 inside them |
| [Docker](../../docs/INSTALLATION.md#docker) | any OCI host | read-only root, `--cap-drop ALL`, `no-new-privileges`, Docker's default seccomp profile | `scripts/docker-smoke.mjs` |

The systemd unit serves on a mode-`0600` Unix socket in a runtime directory
only its user can enter, with `MELRA_MODE=enforced`. Edit the two paths in it,
`MELRA_WORKSPACE` and `MELRA_HOME`, and the `ReadWritePaths` line that matches
them.

Still open on #52: Windows Job Object and macOS sandbox-profile equivalents.
