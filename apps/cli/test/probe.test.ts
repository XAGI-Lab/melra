// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

// `melra probe`, run where nothing is confined, so every check must come back
// open and the exit code non-zero, and against stubbed checks for the verdict.
// Its "public" host and its MELRA are listeners here, and its unresolvable
// name is under `.invalid`, so no test reaches a host on the network.

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer, type IncomingMessage } from "node:http";
import { createServer, type AddressInfo, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { createMelraRuntime, serveHttp } from "@melra/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  probeChecks,
  renderProbe,
  runProbe,
  type Check,
  type Endpoint,
  type ProbeOptions,
  type ProbeReport,
} from "../src/probe.js";

const execute = promisify(execFile);
const entry = resolve(import.meta.dirname, "../dist/bin.js");
const roots: string[] = [];
const servers: Array<{ close: () => unknown }> = [];

afterEach(async () => {
  // Last started first, so a runtime closes after the servers over it.
  for (const server of servers.splice(0).reverse()) await server.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
});

async function listening<T extends Server | ReturnType<typeof createHttpServer>>(server: T): Promise<number> {
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return (server.address() as AddressInfo).port;
}

async function temporary(prefix = "melra-probe-test-"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

/** Answers every request as MELRA does without a token, and keeps each one. */
function melraLike(seen: IncomingMessage[]) {
  return createHttpServer((request, response) => {
    seen.push(request);
    response.writeHead(401, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "unauthorized" }));
  });
}

// This process's environment without MELRA's, so nothing set here leaks in.
const inherited = Object.fromEntries(
  Object.entries(process.env).filter(
    (pair): pair is [string, string] => pair[1] !== undefined && !pair[0].startsWith("MELRA_"),
  ),
);

async function probe(args: string[], env: Record<string, string>, cwd: string) {
  return execute(process.execPath, [entry, "probe", "--json", ...args], { cwd, env: { ...inherited, ...env } }).then(
    ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
    (error: { code: number; stdout: string; stderr: string }) => error,
  );
}

const stub = (name: string, open: boolean): Check => ({
  name,
  target: name,
  attempt: async () => ({ open, detail: open ? "got through" : "refused" }),
});
const melra = (answers: boolean): Endpoint => ({
  transport: "socket",
  target: "/run/melra.sock",
  answers: async () => ({ answers, detail: answers ? "answered" : "no answer" }),
});

describe("melra probe", () => {
  it("reports every check open where nothing is confined, exits non-zero, and leaves no file behind", async () => {
    const root = await temporary();
    const workspace = join(root, "workspace");
    const home = join(root, "home");
    await mkdir(workspace);
    await mkdir(home);
    // The server's home, as a MELRA outside the box left it.
    await writeFile(join(home, "melra.sqlite"), "");
    await writeFile(join(home, "payload.key"), "");
    const publicPort = await listening(createServer((socket) => socket.destroy()));
    const melraPort = await listening(melraLike([]));
    const run = await probe(
      ["--url", `http://127.0.0.1:${melraPort}`, "--public", `127.0.0.1:${publicPort}`],
      { MELRA_WORKSPACE: workspace, MELRA_HOME: home },
      workspace,
    );
    expect(run.code).toBe(1);
    const report = JSON.parse(run.stdout) as ProbeReport;
    expect(report.passed).toBe(false);
    expect(report.checks.map((check) => [check.name, check.outcome])).toEqual([
      ["workspace-write", "open"],
      ["melra-home-read", "open"],
      ["public-connect", "open"],
      ["local-connect", "open"],
      ["program-start", "open"],
    ]);
    expect(report.checks.every((check) => !check.detail.startsWith("not tested"))).toBe(true);
    expect(report.melra).toMatchObject({ transport: "http", answers: true });
    expect(await readdir(workspace)).toEqual([]);
    expect((await readdir(home)).sort()).toEqual(["melra.sqlite", "payload.key"]);
  });

  it("refuses to run with no MELRA outside the box to ask, or with two", async () => {
    const root = await temporary();
    const none = await probe([], { MELRA_WORKSPACE: root, MELRA_HOME: join(root, "home") }, root);
    expect(none).toMatchObject({ code: 1, stdout: "", stderr: expect.stringContaining("probe_endpoint_missing") });
    const two = await probe(
      ["--url", "http://127.0.0.1:9", "--socket", join(root, "s.sock")],
      { MELRA_WORKSPACE: root, MELRA_HOME: join(root, "home") },
      root,
    );
    expect(two).toMatchObject({ code: 1, stdout: "", stderr: expect.stringContaining("--url and --socket name two endpoints") });
    // Nothing was started that would have made the home.
    expect(await readdir(root)).toEqual([]);
  });

  it.skipIf(process.platform === "win32")(
    "asks MELRA_SOCKET by default, at /mcp and /, with no token, and does not test a MELRA_HOME it was not given",
    async () => {
      const root = await temporary();
      // Short: a socket path has a ~104-byte ceiling on macOS.
      const socketDirectory = await temporary("mp-");
      const socketPath = join(socketDirectory, "melra.sock");
      const seen: IncomingMessage[] = [];
      const server = melraLike(seen);
      servers.push(server);
      await new Promise<void>((done) => server.listen(socketPath, done));
      const publicPort = await listening(createServer((socket) => socket.destroy()));
      // MELRA_HOME blank counts as unset, so the box's own default, where
      // nothing is, is all it could look at: no file there is not a box that
      // hides the server's.
      const run = await probe(
        ["--public", `127.0.0.1:${publicPort}`],
        { MELRA_WORKSPACE: root, MELRA_SOCKET: socketPath, MELRA_HTTP_TOKEN: "secret", MELRA_HOME: " ", HOME: root },
        root,
      );
      const report = JSON.parse(run.stdout) as ProbeReport;
      expect(report.melra).toMatchObject({ transport: "socket", target: socketPath, answers: true });
      expect(seen.map((request) => request.url)).toEqual(["/mcp", "/"]);
      for (const request of seen) expect(request.headers.authorization).toBeUndefined();
      expect(report.checks.find((check) => check.name === "melra-home-read")).toMatchObject({
        outcome: "open",
        detail: expect.stringContaining("not tested"),
      });
    },
  );

  it("passes only when every stubbed check is confined and MELRA answers", async () => {
    const names = ["workspace-write", "melra-home-read", "public-connect", "local-connect", "program-start"];
    const confined = await runProbe(names.map((name) => stub(name, false)), melra(true));
    expect(confined.passed).toBe(true);
    expect(confined.checks.every((check) => check.outcome === "confined")).toBe(true);
    expect(renderProbe(confined)).toContain("Confined: every check was stopped, and MELRA answers");

    const oneOpen = await runProbe(names.map((name) => stub(name, name === "public-connect")), melra(true));
    expect(oneOpen.passed).toBe(false);
    expect(oneOpen.checks.find((check) => check.outcome === "open")?.name).toBe("public-connect");
    expect(renderProbe(oneOpen)).toContain("Not confined: 1 of 5 checks open");

    const silent = await runProbe(names.map((name) => stub(name, false)), melra(false));
    expect(silent.passed).toBe(false);
    expect(renderProbe(silent)).toContain("Not confined: MELRA did not answer");
  });

  it("counts only a refusal as confined: a workspace, home, name or shell it could not try is open", async () => {
    const root = await temporary();
    const attempt = async (options: Partial<ProbeOptions>, name: string) => {
      const { checks } = probeChecks({ workspace: root, url: "http://127.0.0.1:9", ...options });
      return checks.find((check) => check.name === name)!.attempt();
    };
    const untested = { open: true, detail: expect.stringContaining("not tested") };
    expect(await attempt({ workspace: join(root, "elsewhere") }, "workspace-write")).toEqual(untested);
    expect(await attempt({}, "melra-home-read")).toEqual({ open: true, detail: expect.stringContaining("set MELRA_HOME") });
    expect(await attempt({ public: "melra-probe.invalid:443" }, "public-connect")).toEqual(untested);
    // A home named as the server's, with nothing in it as this box sees it.
    expect(await attempt({ dataDirectory: root }, "melra-home-read")).toEqual({
      open: false,
      detail: "not opened: melra.sqlite ENOENT, payload.key ENOENT",
    });
    // No shell in the box: the shell is the one Windows names, so name none.
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    vi.stubEnv("ComSpec", join(root, "no-shell"));
    try {
      expect(await attempt({}, "program-start")).toEqual(untested);
    } finally {
      Object.defineProperty(process, "platform", platform);
      vi.unstubAllEnvs();
    }
  });

  it("asks a loopback URL without a token, and accepts only MELRA's own refusal as an answer", async () => {
    const seen: IncomingMessage[] = [];
    let reply: [number, string] = [200, JSON.stringify({ ok: true })];
    const port = await listening(
      createHttpServer((request, response) => {
        seen.push(request);
        response.writeHead(reply[0], { "content-type": "application/json" });
        response.end(reply[1]);
      }),
    );
    const endpoint = (url: string) => probeChecks({ workspace: tmpdir(), url }).melra;
    // A pasted console URL carries the token; only the origin is used.
    expect(await endpoint(`http://127.0.0.1:${port}/?token=secret`).answers()).toMatchObject({ answers: false });
    // A 401 is not enough: only MELRA's own body names it.
    for (const body of [JSON.stringify({ error: "invalid_token" }), "Unauthorized"]) {
      reply = [401, body];
      expect(await endpoint(`http://127.0.0.1:${port}/mcp`).answers()).toMatchObject({ answers: false });
    }
    reply = [401, JSON.stringify({ error: "unauthorized" })];
    expect(await endpoint(`http://localhost:${port}/mcp`).answers()).toMatchObject({ answers: true });
    for (const request of seen) {
      expect(["/mcp", "/"]).toContain(request.url);
      expect(request.headers.authorization).toBeUndefined();
    }
    for (const url of ["http://example.com/mcp", "https://127.0.0.1/mcp", "http://user:pw@127.0.0.1/mcp"]) {
      expect(() => endpoint(url)).toThrow(/probe_url_not_loopback/);
    }
    expect(() => probeChecks({ workspace: tmpdir(), url: "http://127.0.0.1:9", public: "example.com" })).toThrow(
      "--public must be <host>:<port>",
    );
  });

  it("tells MELRA's MCP endpoint from the approval console, which has none", async () => {
    const root = await temporary();
    await mkdir(join(root, "workspace"));
    const runtime = await createMelraRuntime({
      workspaceRoot: join(root, "workspace"),
      dataDirectory: join(root, "home"),
      environment: {},
    });
    servers.push(runtime);
    const agent = await serveHttp({ runtime, port: 0, token: "agent-token", environment: {} });
    servers.push(agent);
    const console_ = await serveHttp({ runtime, port: 0, approver: "console:test", environment: {} });
    servers.push(console_);
    const endpoint = (port: number) => probeChecks({ workspace: root, url: `http://127.0.0.1:${port}` }).melra;
    expect(await endpoint(agent.port).answers()).toMatchObject({ answers: true });
    expect(await endpoint(console_.port).answers()).toEqual({
      answers: false,
      detail: "something answered, but not as MELRA does (HTTP 200 at /)",
    });
  });
});
