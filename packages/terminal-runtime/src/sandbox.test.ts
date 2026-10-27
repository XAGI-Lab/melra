// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HOME_SECRETS, TerminalOperationSchema } from "@melra/protocol";
import { TerminalRuntime, bwrapArgv, detectSandbox, seatbeltProfile, symlinkFilter, type CommandSandbox } from "./index.js";
import { reachableProbe, signaller, switchUser, uidRefusal } from "./sandbox.js";

describe("sandbox generators", () => {
  const paths = { workspace: "/w", temp: ["/t"], denied: ["/d", '/q"x'] };

  it("writes a deny-default Seatbelt profile, its denials last", () => {
    const head = [
      "(version 1)",
      "(deny default)",
      "(allow process-exec process-fork)",
      "(allow signal (target same-sandbox))",
      "(allow sysctl-read)",
      "(allow ipc-posix-sem ipc-posix-shm*)",
      "(allow file-read*)",
      '(allow mach-lookup (global-name "com.apple.bsd.dirhelper") (global-name "com.apple.system.opendirectoryd.libinfo"))',
      '(allow file-write* (subpath "/w") (subpath "/t") (literal "/dev/null") (literal "/dev/zero") ' +
        '(literal "/dev/stdout") (literal "/dev/stderr") (literal "/dev/tty") (regex #"^/dev/fd/[0-9]+$"))',
    ];
    // A quote in a path is escaped, so no path ends its string and adds a rule.
    const denied = '(deny file-read* file-write* (subpath "/d") (subpath "/q\\"x"))';
    expect(seatbeltProfile(paths, { network: false, symlinks: false })).toBe(
      [...head, denied, "(deny file-write-create (vnode-type SYMLINK))"].join("\n"),
    );
    // IP and DNS, not every Unix socket: no SSH agent, no Docker daemon.
    const network = [
      '(allow network-outbound (remote ip) (literal "/private/var/run/mDNSResponder"))',
      "(allow network-inbound network-bind (local ip))",
    ];
    expect(seatbeltProfile(paths, { network: true, symlinks: true })).toBe([...head, ...network, denied].join("\n"));
  });

  it("writes a bubblewrap argv that hides MELRA's files and the network", () => {
    const bwrap = { workspace: "/w", temp: ["/t"], deniedDirectories: ["/d"], deniedFiles: ["/f"] };
    const mounts = [
      "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc",
      "--bind", "/t", "/t", "--bind", "/w", "/w",
      "--tmpfs", "/d", "--ro-bind", "/dev/null", "/f",
      "--unshare-pid", "--die-with-parent", "--new-session",
    ];
    expect(bwrapArgv(bwrap, { network: false, symlinks: false }, "/w/sub", ["/bin/ls", "-l"])).toEqual([
      ...mounts, "--unshare-net", "--seccomp", "3", "--chdir", "/w/sub", "--", "/bin/ls", "-l",
    ]);
    expect(bwrapArgv(bwrap, { network: true, symlinks: true }, "/w", ["/bin/ls"])).toEqual([
      ...mounts, "--chdir", "/w", "--", "/bin/ls",
    ]);
  });

  // What the kernel does with a classic BPF seccomp program, for the four
  // instructions it uses.
  const verdict = (filter: Buffer, arch: number, call: number): number => {
    let accumulator = 0;
    for (let at = 0; at < filter.length / 8; at += 1) {
      const [code, jt, jf, k] = [
        filter.readUInt16LE(at * 8),
        filter.readUInt8(at * 8 + 2),
        filter.readUInt8(at * 8 + 3),
        filter.readUInt32LE(at * 8 + 4),
      ];
      if (code === 0x20) accumulator = k === 0 ? call : arch;
      else if (code === 0x15) at += accumulator === k ? jt : jf;
      else if (code === 0x35) at += accumulator >= k ? jt : jf;
      else if (code === 0x06) return k;
      else throw new Error(`unexpected instruction ${code}`);
    }
    throw new Error("the program ran off its end");
  };
  const [ALLOW, EPERM] = [0x7fff0000, 0x00050001];

  it("filters symlink, symlinkat and io_uring_setup on x86_64 and aarch64, and nothing else", () => {
    const x64 = symlinkFilter("x64")!;
    expect(x64.toString("hex")).toBe(
      "2000000004000000150000063e0000c0200000000000000035000400000000401500030058000000" +
        "150002000a01000015000100a9010000060000000000ff7f0600000001000500",
    );
    for (const call of [88, 266, 425, 0x40000000 + 266]) expect(verdict(x64, 0xc000003e, call)).toBe(EPERM);
    for (const call of [0, 1, 59, 82, 86, 265]) expect(verdict(x64, 0xc000003e, call)).toBe(ALLOW);
    // A 32-bit call, whose numbers differ, is refused outright.
    expect(verdict(x64, 0x40000003, 1)).toBe(EPERM);
    const arm64 = symlinkFilter("arm64")!;
    for (const call of [36, 425]) expect(verdict(arm64, 0xc00000b7, call)).toBe(EPERM);
    for (const call of [35, 37, 63, 64, 221]) expect(verdict(arm64, 0xc00000b7, call)).toBe(ALLOW);
    expect(verdict(arm64, 0x40000028, 36)).toBe(EPERM);
    expect(symlinkFilter("riscv64")).toBeUndefined();
  });

  it("signals the uid account's commands from a Node given none of MELRA's environment", () => {
    expect(signaller({ uid: 1000, gid: 1000 }, 42, "SIGTERM")).toEqual({
      file: process.execPath,
      args: ["-e", expect.any(String), "42", "SIGTERM"],
      options: { uid: 1000, gid: 1000, cwd: "/", env: {}, stdio: "ignore" },
    });
  });
});

// The `uid` backend with its probe stood in for, so on every OS and with no
// second account: what it asks the account to try, and what it says back.
describe("the uid backend's verdict", () => {
  const user = { uid: (process.getuid?.() ?? 0) + 1, gid: 4242 };

  it("has its account try MELRA's data and every denied path", async () => {
    const calls: unknown[][] = [];
    const found = await switchUser(user, "/data", ["/etc/policy.json", "/home/.ssh", "/data"], async (...call) => {
      calls.push(call);
      return { code: 0, stderr: "" };
    });
    expect(typeof found === "string" ? found : found.backend).toBe("uid");
    expect(calls).toEqual([[process.execPath, reachableProbe(["/data", "/etc/policy.json", "/home/.ssh"]), { ...user, cwd: "/" }]]);
    const reached = await switchUser(user, "/data", ["/home/.ssh"], async () => ({ code: 3, stderr: "/home/.ssh" }));
    expect(reached).toBe(`uid: ${user.uid} can read /home/.ssh; make it unreadable to it`);
  });

  it("names the data directory, or the other path, its account could read", () => {
    expect(uidRefusal({ code: 3, stderr: "/data" }, user, "/data")).toBe(`uid: ${user.uid} can read /data; make it MELRA's own, mode 0700`);
    expect(uidRefusal({ code: 3, stderr: "/etc/policy.json" }, user, "/data")).toBe(
      `uid: ${user.uid} can read /etc/policy.json; make it unreadable to it`,
    );
    expect(uidRefusal({ error: "EPERM" }, user, "/data")).toMatch(/^uid: cannot run a command as \d+:4242 \(EPERM\)/);
    expect(uidRefusal({ code: 0, stderr: "" }, user, "/data")).toBeUndefined();
  });

  // Through detectSandbox, with Linux's backends on every OS and bubblewrap's
  // probe failing, so the uid one is tried with what startup resolved.
  it("is handed the resolved deny list, the logins under home among it", async () => {
    const base = await mkdtemp(join(tmpdir(), "melra-sandbox-uid-"));
    try {
      const [workspace, data, home, policy] = ["workspace", "data", "home", "policy.json"].map((name) => join(base, name)) as [
        string, string, string, string,
      ];
      for (const directory of [workspace, data, join(home, ".ssh")]) await mkdir(directory, { recursive: true });
      await writeFile(policy, "{}");
      const calls: unknown[][] = [];
      const options = { workspace, denied: [data, policy], dataDirectory: data, user, home, temp: [base] };
      const found = await detectSandbox(
        options,
        async (...call) => {
          calls.push(call);
          return { error: "ENOENT" };
        },
        "linux",
      );
      expect("problems" in found).toBe(true);
      const real = await realpath(base);
      const denied = [
        join(real, "data"),
        join(real, "policy.json"),
        ...HOME_SECRETS.map((entry) => join(real, "home", entry.slice(2))),
      ];
      expect(calls.filter(([file]) => file === process.execPath)).toEqual([
        [process.execPath, reachableProbe([...new Set([data, ...denied])]), { ...user, cwd: "/" }],
      ]);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

// The `uid` backend's probe, run as this account rather than another: what it
// names is a path the commands' account could read, and refuses the sandbox.
describe.runIf(process.platform !== "win32" && process.getuid?.() !== 0)("the uid backend's probe", () => {
  it("names the first path it can read, or enter as a directory, of every one it is given", async () => {
    const base = await mkdtemp(join(tmpdir(), "melra-sandbox-reach-"));
    const [closed, enterable, secret, readable] = ["closed", "enterable", "secret", "readable"].map((name) => join(base, name)) as [
      string, string, string, string,
    ];
    const reach = (paths: string[]) => spawnSync(process.execPath, reachableProbe(paths), { encoding: "utf8" });
    try {
      await mkdir(closed, { mode: 0o700 });
      await mkdir(enterable, { mode: 0o700 });
      await writeFile(join(enterable, "melra.sqlite"), "records");
      await writeFile(secret, "key", { mode: 0o600 });
      await writeFile(readable, "policy");
      // Enterable without being listable, so a file it holds opens by name.
      await chmod(enterable, 0o311);
      await chmod(closed, 0o000);
      await chmod(secret, 0o000);
      expect(reach([closed, secret, join(base, "missing")])).toMatchObject({ status: 0, stderr: "" });
      expect(reach([closed, enterable, readable])).toMatchObject({ status: 3, stderr: enterable });
      expect(reach([closed, secret, readable])).toMatchObject({ status: 3, stderr: readable });
    } finally {
      await Promise.all([chmod(closed, 0o700), chmod(enterable, 0o700)]).catch(() => undefined);
      await rm(base, { recursive: true, force: true });
    }
  });
});

// The real thing, where this host has one: Seatbelt on macOS, bubblewrap on
// Linux where it can make its namespaces. Elsewhere this suite is skipped.
const probed = await (async () => {
  if (process.platform !== "darwin" && process.platform !== "linux") return undefined;
  const directory = await mkdtemp(join(tmpdir(), "melra-sandbox-probe-"));
  try {
    const found = await detectSandbox({ workspace: directory, denied: [], dataDirectory: join(directory, "data") });
    return "sandbox" in found ? found.sandbox.backend : undefined;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
})();

describe.runIf(probed !== undefined)(`commands in the ${probed} sandbox`, () => {
  let base: string;
  let [workspace, temp, outside, data, home] = ["", "", "", "", ""];
  let runtime: (allowance: { network: boolean; symlinks: boolean }) => Promise<TerminalRuntime>;
  let confined: TerminalRuntime;
  const node = async (script: string, within = confined) =>
    await within.execute(
      TerminalOperationSchema.parse({ kind: "terminal", action: "run", command: process.execPath, args: ["-e", script] }),
    );
  beforeAll(async () => {
    // Not under macOS's per-user temp folder, which every command may write.
    base = await mkdtemp(join(process.platform === "darwin" ? "/private/tmp" : tmpdir(), "melra-sandbox-"));
    [workspace, temp, outside, data, home] = ["workspace", "temp", "outside", "data", "home"].map((name) => join(base, name)) as [
      string, string, string, string, string,
    ];
    for (const directory of [workspace, temp, outside, join(data, "artifacts"), join(home, ".ssh")]) {
      await mkdir(directory, { recursive: true });
    }
    await writeFile(join(data, "payload.key"), "key");
    await writeFile(join(home, ".ssh", "id_ed25519"), "private");
    await writeFile(join(home, ".npmrc"), "registry=https://example.invalid/");
    // The temp folder is the test's own, so "outside" is outside it too.
    const found = await detectSandbox({ workspace, denied: [data], readable: ["~/.npmrc"], dataDirectory: data, home, temp: [temp] });
    if (!("sandbox" in found)) throw new Error(found.problems.join("; "));
    const { sandbox } = found;
    runtime = (allowance) => TerminalRuntime.create({ root: workspace, sandbox, allowance: () => allowance });
    confined = await runtime({ network: false, symlinks: false });
  });
  afterAll(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it("does its ordinary work in the workspace and temp", async () => {
    const result = await node(
      `const fs = require("fs"); fs.writeFileSync("made.txt", "1"); fs.writeFileSync(${JSON.stringify(join(temp, "scratch"))}, "1");` +
        `process.stdout.write(fs.readFileSync(${JSON.stringify(join(home, ".npmrc"))}, "utf8"))`,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("registry=https://example.invalid/");
    expect(existsSync(join(workspace, "made.txt"))).toBe(true);
    expect(existsSync(join(temp, "scratch"))).toBe(true);
  }, 30_000);

  it("cannot write outside the workspace and temp", async () => {
    const result = await node(`require("fs").writeFileSync(${JSON.stringify(join(outside, "escaped"))}, "1")`);
    expect(result.exitCode).not.toBe(0);
    expect(existsSync(join(outside, "escaped"))).toBe(false);
  }, 30_000);

  it("cannot read MELRA's data or a login under home", async () => {
    for (const path of [join(data, "payload.key"), join(home, ".ssh", "id_ed25519")]) {
      const result = await node(`process.stdout.write(require("fs").readFileSync(${JSON.stringify(path)}, "utf8"))`);
      expect(result.exitCode, path).not.toBe(0);
      expect(result.stdout).toBe("");
    }
  }, 30_000);

  it("opens a socket only with the network trait", async () => {
    const server = createServer((socket) => socket.end("hello"));
    await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
    const { port } = server.address() as AddressInfo;
    const connect =
      `require("net").connect(${port}, "127.0.0.1").on("data", (d) => { process.stdout.write(String(d)); process.exit(0); })` +
      `.on("error", (e) => { process.stdout.write(e.code); process.exit(3); })`;
    try {
      const refused = await node(connect);
      expect(refused.exitCode).toBe(3);
      const allowed = await node(connect, await runtime({ network: true, symlinks: false }));
      expect(allowed.stdout).toBe("hello");
    } finally {
      server.close();
    }
  }, 30_000);

  // An SSH agent's socket, or a daemon's: under Seatbelt the trait is IP and
  // DNS. Bubblewrap leaves Unix sockets on the filesystem reachable.
  it.runIf(probed === "seatbelt")("connects to no Unix socket, with the network trait too", async () => {
    const path = join(outside, "agent.sock");
    const server = createServer((socket) => socket.end("identities"));
    await new Promise<void>((listening) => server.listen(path, listening));
    try {
      const result = await node(
        `require("net").connect(${JSON.stringify(path)}).on("data", (d) => { process.stdout.write(String(d)); process.exit(0); })` +
          `.on("error", (e) => { process.stdout.write(e.code); process.exit(3); })`,
        await runtime({ network: true, symlinks: false }),
      );
      expect(result.stdout).toBe("EPERM");
    } finally {
      server.close();
    }
  }, 30_000);

  // Python's multiprocessing makes POSIX semaphores, which a deny-default
  // profile refuses unless it names them.
  const python = "/usr/bin/python3";
  const lock = "import multiprocessing; multiprocessing.Lock(); print('locked')";
  it.runIf(probed === "seatbelt" && spawnSync(python, ["-c", lock]).status === 0)(
    "lets Python's multiprocessing make its semaphores",
    async () => {
      const result = await confined.execute(
        TerminalOperationSchema.parse({ kind: "terminal", action: "run", command: python, args: ["-c", lock] }),
      );
      expect(result.stderr).toBe("");
      expect(result.stdout).toBe("locked\n");
    },
    30_000,
  );

  it("makes a symbolic link only where it is allowed one", async () => {
    const link = (name: string) => `require("fs").symlinkSync("made.txt", ${JSON.stringify(name)})`;
    const refused = await node(link("refused-link"));
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stderr).toMatch(/EPERM/);
    const allowed = await node(link("allowed-link"), await runtime({ network: false, symlinks: true }));
    expect(allowed.exitCode).toBe(0);
  }, 30_000);

  it("refuses a program that is not there as spawn would", async () => {
    await expect(
      confined.execute(TerminalOperationSchema.parse({ kind: "terminal", action: "run", command: "melra-no-such-program" })),
    ).rejects.toThrow("terminal_command_not_found:melra-no-such-program");
  }, 30_000);
});

// The `uid` backend's commands run as an account MELRA may not signal. Here
// the account is this one, so switching to it needs no privilege, and the
// sandbox's signal is the only way the timeout is let reach it.
describe.runIf(process.platform !== "win32")("a command run as the sandbox's account", () => {
  it("is stopped through the sandbox's own signal", async () => {
    const root = await mkdtemp(join(tmpdir(), "melra-sandbox-account-"));
    const signals: string[] = [];
    const sandbox: CommandSandbox = {
      backend: "uid",
      confine: async ({ file, args }) => ({ file, args, uid: process.getuid!(), gid: process.getgid!() }),
      signal: (group, signal) => {
        signals.push(signal);
        process.kill(-group, signal);
      },
    };
    try {
      const runtime = await TerminalRuntime.create({ root, sandbox });
      await expect(
        runtime.execute(
          TerminalOperationSchema.parse({
            kind: "terminal",
            action: "run",
            command: process.execPath,
            args: ["-e", "setInterval(() => {}, 1000)"],
            timeoutMs: 500,
          }),
        ),
      ).rejects.toThrow("terminal_timeout");
      expect(signals[0]).toBe("SIGTERM");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
