// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import type { Writable } from "node:stream";
import { HOME_SECRETS } from "@melra/protocol";

/** What one command may do beyond reading files and writing the workspace and temp. */
export interface SandboxAllowance {
  /**
   * Reach IP hosts, loopback included, and DNS: a command policy gives the
   * `network` trait. Seatbelt opens no other socket even then, so no Unix one
   * (an SSH agent's, a daemon's); bubblewrap hides none on the filesystem.
   */
  network: boolean;
  /**
   * Create a symbolic link. Seatbelt also refuses renaming one; bubblewrap's
   * seccomp filter cannot see a file's type, so it refuses only creating one.
   */
  symlinks: boolean;
}

/**
 * Where a command may write and what it may not touch, each as the kernel
 * resolves it: Seatbelt matches `/private/var`, never `/var`.
 */
export interface SandboxPaths {
  workspace: string;
  /** The temp folders, writable like the workspace. */
  temp: string[];
  /** Neither readable nor writable, inside the workspace too: MELRA's own files and the secrets. */
  denied: string[];
}

/** The denied paths as bwrap takes them: only ones that exist, since it mounts over each. */
export interface BwrapPaths extends Omit<SandboxPaths, "denied"> {
  deniedDirectories: string[];
  deniedFiles: string[];
}

/** A path as an SBPL string: `\` and `"` escaped, so no path ends it early. */
function sbplString(path: string): string {
  return `"${path.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/** Written through by programs that print to their own output by name. */
const DEVICES =
  '(literal "/dev/null") (literal "/dev/zero") (literal "/dev/stdout") (literal "/dev/stderr") ' +
  '(literal "/dev/tty") (regex #"^/dev/fd/[0-9]+$")';

/**
 * The Seatbelt profile one command runs under, for `/usr/bin/sandbox-exec
 * -p`. Denied by default: allowed by default, `open` hands work to
 * LaunchServices, whose apps are no child of the command. A later rule wins
 * over an earlier one, so the denials come last and hold inside the
 * workspace too. setuid programs (sudo, ps) do not start under it. POSIX
 * semaphores and shared memory are open, for Python's multiprocessing.
 */
export function seatbeltProfile(paths: SandboxPaths, allowance: SandboxAllowance): string {
  const subpaths = (list: readonly string[]) => list.map((path) => `(subpath ${sbplString(path)})`).join(" ");
  return [
    "(version 1)",
    "(deny default)",
    "(allow process-exec process-fork)",
    "(allow signal (target same-sandbox))",
    "(allow sysctl-read)",
    "(allow ipc-posix-sem ipc-posix-shm*)",
    "(allow file-read*)",
    // The per-user temp folder's path, and user and group names.
    '(allow mach-lookup (global-name "com.apple.bsd.dirhelper") (global-name "com.apple.system.opendirectoryd.libinfo"))',
    `(allow file-write* ${subpaths([paths.workspace, ...paths.temp])} ${DEVICES})`,
    // IP and the DNS resolver's socket only, never `network*`, which opens
    // every Unix socket too.
    ...(allowance.network
      ? [
          '(allow network-outbound (remote ip) (literal "/private/var/run/mDNSResponder"))',
          "(allow network-inbound network-bind (local ip))",
        ]
      : []),
    ...(paths.denied.length === 0 ? [] : [`(deny file-read* file-write* ${subpaths(paths.denied)})`]),
    ...(allowance.symlinks ? [] : ["(deny file-write-create (vnode-type SYMLINK))"]),
  ].join("\n");
}

/**
 * The bubblewrap argv one command runs under, before `bwrap` itself. The
 * root read-only, the workspace and temp writable, MELRA's files hidden; a
 * PID namespace, so what the command leaves running dies with it and MELRA's
 * own process is not there to read; `--die-with-parent`, so a crashed MELRA
 * leaves nothing behind; and, unless the `network` trait applies, an empty
 * network namespace with a loopback of its own, so neither the host's network
 * nor its loopback. Unix sockets on the filesystem stay reachable. Without
 * symbolic links, descriptor 3 carries `symlinkFilter`.
 */
export function bwrapArgv(
  paths: BwrapPaths,
  allowance: SandboxAllowance,
  cwd: string,
  command: readonly string[],
): string[] {
  return [
    "--ro-bind", "/", "/",
    "--dev", "/dev",
    "--proc", "/proc",
    ...[...paths.temp, paths.workspace].flatMap((path) => ["--bind", path, path]),
    ...paths.deniedDirectories.flatMap((path) => ["--tmpfs", path]),
    ...paths.deniedFiles.flatMap((path) => ["--ro-bind", "/dev/null", path]),
    "--unshare-pid",
    "--die-with-parent",
    "--new-session",
    ...(allowance.network ? [] : ["--unshare-net"]),
    ...(allowance.symlinks ? [] : ["--seccomp", "3"]),
    "--chdir", cwd,
    "--",
    ...command,
  ];
}

/** SECCOMP_RET_ALLOW, and SECCOMP_RET_ERRNO with EPERM. */
const SECCOMP_ALLOW = 0x7fff0000;
const SECCOMP_EPERM = 0x00050001;

/**
 * Per architecture: its AUDIT_ARCH value, and symlink(2), symlinkat(2) and
 * io_uring_setup(2), whose rings make a link with no call of their own.
 */
const SYMLINK_CALLS: Record<string, { audit: number; calls: number[] }> = {
  x64: { audit: 0xc000003e, calls: [88, 266, 425] },
  arm64: { audit: 0xc00000b7, calls: [36, 425] },
};

/**
 * A classic BPF program for `bwrap --seccomp`: the calls above fail with
 * EPERM, and so does every call made in another architecture's convention
 * (32-bit, or x32), whose numbers differ. Undefined for an architecture
 * whose numbers are not listed.
 */
export function symlinkFilter(arch: string = process.arch): Buffer | undefined {
  const known = SYMLINK_CALLS[arch];
  if (known === undefined) return undefined;
  const checks = [
    // x32 calls are the x86_64 numbers with bit 30 set.
    ...(arch === "x64" ? [[0x35 /* jge */, 0x40000000]] : []),
    ...known.calls.map((call) => [0x15 /* jeq */, call]),
  ] as Array<[number, number]>;
  const deny = 4 + checks.length;
  const program: Array<[number, number, number, number]> = [
    [0x20, 0, 0, 4], // load the architecture
    [0x15, 0, deny - 2, known.audit],
    [0x20, 0, 0, 0], // load the call number
    ...checks.map(([code, value], index): [number, number, number, number] => [code, checks.length - index, 0, value]),
    [0x06, 0, 0, SECCOMP_ALLOW],
    [0x06, 0, 0, SECCOMP_EPERM],
  ];
  const buffer = Buffer.alloc(program.length * 8);
  program.forEach(([code, jt, jf, k], index) => {
    buffer.writeUInt16LE(code, index * 8);
    buffer.writeUInt8(jt, index * 8 + 2);
    buffer.writeUInt8(jf, index * 8 + 3);
    buffer.writeUInt32LE(k, index * 8 + 4);
  });
  return buffer;
}

/** One command's spawn, as its sandbox changes it. */
export interface ConfinedSpawn {
  file: string;
  args: string[];
  uid?: number;
  gid?: number;
  /** A seccomp program `bwrap` reads from descriptor 3. */
  seccomp?: Buffer;
}

export interface CommandSandbox {
  /** Which backend: `seatbelt`, `bubblewrap` or `uid`. Named on receipts. */
  readonly backend: string;
  /**
   * The spawn for one command. `file` is looked up on `path` first, so a
   * program that is not there is refused as spawn would refuse it, not
   * reported as the wrapper's exit status.
   */
  confine(
    command: { file: string; args: string[]; cwd: string; path?: string | undefined },
    allowance: SandboxAllowance,
  ): Promise<ConfinedSpawn>;
  /** Signals a process group MELRA may not signal itself: one running as another account. */
  signal?(group: number, signal: NodeJS.Signals): void;
}

export interface SandboxOptions {
  workspace: string;
  /** MELRA's own files and the secret files, as configured. */
  denied: string[];
  /** The `HOME_SECRETS` entries the policy file allows back. */
  readable?: readonly string[];
  /** The account a command runs as, for the `uid` backend. */
  user?: { uid: number; gid: number } | undefined;
  /** What the `uid` backend's account must not be able to read. */
  dataDirectory: string;
  home?: string;
  /**
   * Writable like the workspace; absent, the OS's temp folder and /tmp.
   * macOS's per-user temp folder is added either way.
   */
  temp?: string[];
}

/** Where `path` resolves, any missing tail kept as written. */
async function resolved(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    const parent = dirname(path);
    return parent === path ? path : join(await resolved(parent), basename(path));
  }
}

/** The program spawn would run for `file`: as given with a slash, else the first regular file of that name on `path`. */
async function located(file: string, cwd: string, path: string | undefined): Promise<string> {
  const candidates = file.includes("/")
    ? [resolve(cwd, file)]
    : (path ?? "")
        .split(delimiter)
        .filter((entry) => isAbsolute(entry))
        .map((entry) => join(entry, file));
  for (const candidate of candidates) {
    if ((await stat(candidate).catch(() => undefined))?.isFile() === true) return candidate;
  }
  throw new Error(`terminal_command_not_found:${file}`);
}

/** Hands bwrap its filter on descriptor 3; one that has already failed may not read it. */
export function writeSeccomp(child: ChildProcess, seccomp: Buffer): void {
  const pipe = child.stdio[3] as Writable | null | undefined;
  pipe?.on("error", () => undefined);
  pipe?.end(seccomp);
}

/** Runs a harmless command and says how it ended. */
async function probe(
  file: string,
  args: string[],
  options: { cwd?: string; uid?: number; gid?: number; seccomp?: Buffer } = {},
): Promise<{ code: number | null; stderr: string } | { error: string }> {
  const { seccomp, ...spawnOptions } = options;
  return await new Promise((settle) => {
    let stderr = "";
    const child = spawn(file, args, {
      ...spawnOptions,
      env: { PATH: process.env.PATH ?? "" },
      stdio: ["ignore", "ignore", "pipe", ...(seccomp === undefined ? [] : ["pipe" as const])],
    });
    if (seccomp !== undefined) writeSeccomp(child, seccomp);
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.once("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      settle({ error: error.code ?? error.message });
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      settle({ code, stderr: stderr.trim().split("\n")[0] ?? "" });
    });
  });
}

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
const NO_ALLOWANCE: SandboxAllowance = { network: false, symlinks: false };

async function seatbelt(paths: SandboxPaths, reach: typeof probe): Promise<CommandSandbox | string> {
  const tried = await reach(SANDBOX_EXEC, ["-p", seatbeltProfile(paths, NO_ALLOWANCE), "/usr/bin/true"], {
    cwd: paths.workspace,
  });
  if ("error" in tried) return `seatbelt: ${SANDBOX_EXEC} could not start (${tried.error})`;
  if (tried.code !== 0) {
    // sandbox_apply fails inside another sandbox, which macOS does not nest.
    return /sandbox_apply/.test(tried.stderr)
      ? `seatbelt: ${tried.stderr}: MELRA already runs inside a sandbox, such as examples/deploy/macos/melra.sb; ` +
          "start it outside that one, which the per-command profiles replace"
      : `seatbelt: ${SANDBOX_EXEC} exited ${tried.code}: ${tried.stderr}`;
  }
  return {
    backend: "seatbelt",
    async confine(command, allowance) {
      const file = await located(command.file, command.cwd, command.path);
      return { file: SANDBOX_EXEC, args: ["-p", seatbeltProfile(paths, allowance), file, ...command.args] };
    },
  };
}

/** What lets bwrap make its namespaces where it is installed but cannot. */
const BWRAP_FIX =
  "let unprivileged users create user namespaces (on Ubuntu 24.04, sysctl " +
  "kernel.apparmor_restrict_unprivileged_userns=0 or an AppArmor profile giving /usr/bin/bwrap userns; " +
  "on older Debian, kernel.unprivileged_userns_clone=1), and under systemd allow them as " +
  "examples/deploy/systemd/melra.service does";

async function bubblewrap(paths: SandboxPaths, reach: typeof probe): Promise<CommandSandbox | string> {
  const seccomp = symlinkFilter();
  if (seccomp === undefined) return `bubblewrap: no symbolic-link filter for ${process.arch}`;
  // Each time: bwrap mounts over a denied path only if it is there, and one
  // may appear after startup.
  const split = async (): Promise<BwrapPaths> => {
    const found = await Promise.all(
      paths.denied.map(async (path) => ({ path, stats: await stat(path).catch(() => undefined) })),
    );
    return {
      workspace: paths.workspace,
      temp: paths.temp,
      deniedDirectories: found.filter(({ stats }) => stats?.isDirectory() === true).map(({ path }) => path),
      deniedFiles: found.filter(({ stats }) => stats !== undefined && !stats.isDirectory()).map(({ path }) => path),
    };
  };
  let bwrap: string;
  try {
    bwrap = await located("bwrap", "/", process.env.PATH);
  } catch {
    return "bubblewrap: bwrap is not installed; install the bubblewrap package";
  }
  const tried = await reach(bwrap, bwrapArgv(await split(), NO_ALLOWANCE, paths.workspace, ["true"]), { seccomp });
  if ("error" in tried || tried.code !== 0) {
    return `bubblewrap: ${"error" in tried ? tried.error : tried.stderr || `exited ${tried.code}`}; ${BWRAP_FIX}`;
  }
  return {
    backend: "bubblewrap",
    async confine(command, allowance) {
      const file = await located(command.file, command.cwd, command.path);
      return {
        file: bwrap,
        args: bwrapArgv(await split(), allowance, command.cwd, [file, ...command.args]),
        ...(allowance.symlinks ? {} : { seccomp }),
      };
    },
  };
}

/** Exits 3 naming the first path it can read, or enter as a directory; `access` judges by the real ids. */
const REACHABLE =
  "const fs=require('fs'),{R_OK,X_OK}=fs.constants;" +
  "const can=(p,m)=>{try{fs.accessSync(p,m);return true}catch{return false}};" +
  "const hit=process.argv.slice(1).find((p)=>can(p,R_OK)||(can(p,X_OK)&&fs.statSync(p).isDirectory()));" +
  "if(hit!==undefined){process.stderr.write(hit);process.exitCode=3}";

/** `node` arguments for the `uid` backend's probe: which of `paths`, if any, the account running it can reach. */
export function reachableProbe(paths: readonly string[]): string[] {
  return ["-e", REACHABLE, ...paths];
}

/**
 * How the `uid` backend signals a command's group: `node` as the commands'
 * account, given no environment, so nothing of MELRA's reaches a process
 * that account may read.
 */
export function signaller(user: { uid: number; gid: number }, group: number, signal: NodeJS.Signals) {
  return {
    file: process.execPath,
    args: ["-e", "try{process.kill(-Number(process.argv[1]),process.argv[2])}catch{}", String(group), signal],
    options: { ...user, cwd: "/", env: {}, stdio: "ignore" as const },
  };
}

/** Why the `uid` backend's probe refuses the sandbox, or nothing when the account reached none of its paths. */
export function uidRefusal(
  tried: Awaited<ReturnType<typeof probe>>,
  user: { uid: number; gid: number },
  dataDirectory: string,
): string | undefined {
  if ("error" in tried) {
    return (
      `uid: cannot run a command as ${user.uid}:${user.gid} (${tried.error}); run MELRA as root with ` +
      "CAP_SETUID and CAP_SETGID, as examples/deploy/compose/compose.yaml does"
    );
  }
  if (tried.code === 3) {
    return tried.stderr === dataDirectory
      ? `uid: ${user.uid} can read ${dataDirectory}; make it MELRA's own, mode 0700`
      : `uid: ${user.uid} can read ${tried.stderr}; make it unreadable to it`;
  }
  if (tried.code !== 0) return `uid: a command as ${user.uid}:${user.gid} exited ${tried.code}: ${tried.stderr}`;
  return undefined;
}

/**
 * The `uid` backend: no wrapper, only another account, for a container where
 * MELRA runs as root with CAP_SETUID and CAP_SETGID alone. The account cannot
 * read MELRA's data or any denied path, which the probe checks; nothing here
 * stops it writing elsewhere, reaching the network or making a link, which
 * the container decides. MELRA, holding no CAP_KILL, signals its commands as
 * that account. `reach` runs the probe, a test's stand-in in place of a real
 * account.
 */
export async function switchUser(
  user: { uid: number; gid: number },
  dataDirectory: string,
  denied: readonly string[],
  reach: typeof probe = probe,
): Promise<CommandSandbox | string> {
  if (process.getuid?.() === user.uid) return `uid: sandbox.user ${user.uid} is the account MELRA runs as`;
  // As that account, which proves the switch works and MELRA's files are out of reach.
  const tried = await reach(process.execPath, reachableProbe([...new Set([dataDirectory, ...denied])]), {
    ...user,
    cwd: "/",
  });
  const refused = uidRefusal(tried, user, dataDirectory);
  if (refused !== undefined) return refused;
  return {
    backend: "uid",
    async confine(command) {
      return { file: command.file, args: command.args, ...user };
    },
    signal(group, signal) {
      const { file, args, options } = signaller(user, group, signal);
      spawn(file, args, options).on("error", () => undefined);
    },
  };
}

/**
 * macOS's per-user temp folder, which `xcrun` (behind /usr/bin/git, python3,
 * make and the rest of the Command Line Tools) writes its cache to whatever
 * TMPDIR says. Empty elsewhere, or when getconf cannot say.
 */
async function darwinUserTemp(): Promise<string[]> {
  if (process.platform !== "darwin") return [];
  return await new Promise((done) => {
    execFile("/usr/bin/getconf", ["DARWIN_USER_TEMP_DIR"], (error, stdout) => {
      const path = String(stdout).trim();
      done(error === null && isAbsolute(path) ? [path] : []);
    });
  });
}

/**
 * The first sandbox that works on this host, each tried with a harmless
 * command: Seatbelt on macOS; bubblewrap, then another account, on Linux.
 * None, it gives what each one said, with how to fix it. `reach` runs each
 * probe and `platform` picks the backends, for a test's stand-ins.
 */
export async function detectSandbox(
  options: SandboxOptions,
  reach: typeof probe = probe,
  platform: NodeJS.Platform = process.platform,
): Promise<{ sandbox: CommandSandbox } | { problems: string[] }> {
  const home = options.home ?? homedir();
  const allowed = new Set(options.readable ?? []);
  const logins = HOME_SECRETS.filter((entry) => !allowed.has(entry)).map((entry) => join(home, entry.slice(2)));
  const paths: SandboxPaths = {
    workspace: await realpath(options.workspace),
    temp: [...new Set(await Promise.all([...(options.temp ?? [tmpdir(), "/tmp"]), ...(await darwinUserTemp())].map(resolved)))],
    denied: [...new Set(await Promise.all([...options.denied, ...logins].map(resolved)))],
  };
  const tries =
    platform === "darwin"
      ? [() => seatbelt(paths, reach)]
      : platform === "linux"
        ? [
            () => bubblewrap(paths, reach),
            () =>
              options.user === undefined
                ? Promise.resolve(
                    "uid: no sandbox.user in the policy file, for a container where MELRA runs as root with CAP_SETUID and CAP_SETGID",
                  )
                : switchUser(options.user, options.dataDirectory, paths.denied, reach),
          ]
        : [];
  const problems: string[] = [];
  for (const attempt of tries) {
    const found = await attempt();
    if (typeof found !== "string") return { sandbox: found };
    problems.push(found);
  }
  if (tries.length === 0) {
    problems.push(
      platform === "win32"
        ? "none on win32: run MELRA under WSL2 with bubblewrap, or in the container pair (examples/deploy/compose)"
        : `none on ${platform}`,
    );
  }
  return { problems };
}
