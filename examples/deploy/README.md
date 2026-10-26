# Hardened deployment recipes

Runnable setups where the operating system, not MELRA, keeps the process boxed
in (#52). Each one is exercised in CI. `melra doctor` run under the first three
reports what actually took effect on its `isolation` line; the container pair
also boxes the agent, and `melra probe` checks it from the agent's side.

Enforced mode also runs every command MELRA starts in an OS sandbox of its
own, and refuses to start where none works: bubblewrap under the systemd
unit, a second account in the container pair, Seatbelt on a Mac outside
`melra.sb`. `melra doctor`'s `sandbox` line says which, or why none works and
how to fix it ([per-command sandbox](../../docs/INSTALLATION.md#per-command-sandbox)).

| Recipe | Platform | What the kernel enforces | CI check |
|---|---|---|---|
| [`systemd/melra.service`](systemd/melra.service) | Linux | no capabilities, `no_new_privs`, a seccomp filter (`@system-service` and the mount calls), a read-only filesystem except the workspace and data directory, private `/tmp` and devices, IP, Unix and netlink sockets only, and only the namespaces bubblewrap makes for each command | `scripts/systemd-smoke.mjs`: `doctor` must show all four restrictions, conformance must reach L3 inside them, and in enforced mode MELRA must either run commands in bubblewrap and reach L3 there, or refuse to start and say why |
| [`macos/melra.sb`](macos/melra.sb) | macOS, developer mode | writes confined to the workspace, the data directory, and temp folders, for MELRA and every command it runs; `sudo`, `su`, and `login` refused | `scripts/macos-sandbox-smoke.mjs`: conformance must reach L3 inside it, a write inside the workspace must succeed, a write to the home folder must be refused by the kernel, and enforced mode must say it would refuse to start inside it |
| [Docker](../../docs/INSTALLATION.md#docker) | any OCI host | read-only root, `--cap-drop ALL`, `no-new-privileges`, Docker's default seccomp profile | `scripts/docker-smoke.mjs` |
| [`compose/compose.yaml`](compose/compose.yaml) | Docker Engine 28.0 or later | MELRA and the agent in separate containers: the agent gets the workspace read-only, no MELRA data, no network route out or address on the host, and MELRA's mode-`0600` socket; both get a read-only root, `no-new-privileges`, and process and memory caps, and no capabilities but MELRA's `CAP_SETUID` and `CAP_SETGID`, which it uses only to run each command as an account that cannot enter its data | `scripts/compose-smoke.mjs`: from inside the agent's container, `melra probe` must find a workspace write, MELRA's data, a connection out and one to the host refused (both aimed at the runner), a file write through the socket, approved from MELRA's side, must reach `verified_success` with a receipt, and so must a command MELRA runs, which must find MELRA's data closed to it and edit what MELRA wrote, and MELRA's write into a directory the command made |

The systemd unit serves on a mode-`0600` Unix socket in a runtime directory
only its user can enter, with `MELRA_MODE=enforced`. Edit the two paths in it,
`MELRA_WORKSPACE` and `MELRA_HOME`, and the `ReadWritePaths` line that matches
them. Install bubblewrap first; on Ubuntu 24.04 also let unprivileged programs
make user namespaces, which `melra doctor` names the setting for. Without
them the unit refuses to start, and says why.

In the container pair MELRA runs as root with `CAP_SETUID` and `CAP_SETGID`
alone, keeps its data and policy file in the image's root-only
`/var/lib/melra` and `/etc/melra`, and runs each command as `node` (1000), the
account [`compose/policy.json`](compose/policy.json) names. Root without the
other capabilities reads and writes by file modes alone, so MELRA runs in
group 1000 and makes what it creates group-writable, as the commands do, and
the workspace must be writable by root and by 1000; the agent runs as root
with no capabilities too, because only MELRA's account may open its socket.

Run the macOS profile with
`sandbox-exec -f melra.sb -D WORKSPACE="$PWD" -D MELRA_HOME="$HOME/.melra" melra serve`,
in developer mode: macOS applies no profile inside another, so enforced mode,
which runs each command under a profile of its own, refuses to start inside
it.
It does not cover the browser adapter: Chrome brings its own sandbox and will
not start inside another one. `melra doctor` cannot see a sandbox profile from
inside, so its `isolation` line on macOS says so rather than guessing.

**On Windows**, run MELRA inside one of the recipes above: for enforced mode,
WSL2 with bubblewrap and the systemd unit (WSL2 runs systemd when
`systemd=true` is set under `[boot]` in `/etc/wsl.conf`), or the container pair
in [compose](compose/) under Docker Desktop. There is no native
Windows recipe. A Job Object limits processes and memory, not file access, so
it would not confine writes the way the recipes above do; that needs a
low-privilege account with NTFS ACLs, or an AppContainer, and a CI check that
a write outside the workspace is refused. `melra doctor` on native Windows
says so on its `isolation` line.
