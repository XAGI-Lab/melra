// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `melra probe`, run from inside an agent's box before the agent starts, so
 * "the operator says it is confined" becomes "these checks passed". Each check
 * tries one thing the box should stop, in the most harmless form that still
 * shows whether it got through, and is `open` when it did:
 *
 *   workspace-write  create a file in the workspace, then remove it
 *   melra-home-read  open the server's database and payload key; nothing is read
 *   public-connect   a TCP connection to a public address; nothing is sent
 *   local-connect    a TCP connection to another port here; nothing is sent
 *   program-start    start the shell, which exits at once
 *
 * Only a refusal counts as confined: an attempt with nothing to try (no
 * workspace, no shell, a name that does not resolve) is open, `not tested`.
 * Then it checks that the MELRA endpoint it was given answers, without a
 * token. It changes no setting and proves only the checks on this list.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { open, rm } from "node:fs/promises";
import { request, type IncomingMessage } from "node:http";
import { connect, createServer, type AddressInfo } from "node:net";
import { join } from "node:path";
import { printable } from "@melra/server/kernel";
import { mark, paint, table } from "./output.js";

/**
 * A public address that always listens (Cloudflare's resolver, on 443). An
 * address, not a name, so a box that resolves no names is still tested.
 */
const DEFAULT_PUBLIC = "1.1.1.1:443";
const CONNECT_TIMEOUT_MS = 3_000;
/** What a box does to stop an attempt; any other error proves nothing. */
const REFUSALS = ["EACCES", "EPERM", "EROFS"];

export interface Attempt {
  open: boolean;
  detail: string;
}

export interface Check {
  name: string;
  target: string;
  attempt: () => Promise<Attempt>;
}

export interface Endpoint {
  transport: "socket" | "http";
  target: string;
  answers: () => Promise<{ answers: boolean; detail: string }>;
}

export interface ProbeReport {
  /** Every check confined, and MELRA answered: the only case that exits 0. */
  passed: boolean;
  checks: Array<{ name: string; target: string; outcome: "confined" | "open"; detail: string }>;
  melra: { transport: Endpoint["transport"]; target: string; answers: boolean; detail: string };
}

export interface ProbeOptions {
  workspace: string;
  /**
   * The MELRA_HOME of the MELRA the box is given, as the box sees it. Unset,
   * `melra-home-read` is not tested: the box's own default says nothing about
   * the server's.
   */
  dataDirectory?: string;
  /** `host:port`; default `DEFAULT_PUBLIC`. */
  public?: string;
  /** `host:port`; default a port this probe listens on, on 127.0.0.1. */
  local?: string;
  /** One of the two is required: MELRA runs outside the box. */
  socketPath?: string;
  url?: string;
}

const code = (error: unknown) =>
  (error as NodeJS.ErrnoException).code ?? (error instanceof Error ? error.message : String(error));

function refused(error: unknown, what: string): Attempt {
  return REFUSALS.includes(code(error))
    ? { open: false, detail: `${what}: ${code(error)}` }
    : { open: true, detail: `not tested: ${code(error)}` };
}

/** `host:port`, with an IPv6 host in brackets. */
function hostPort(value: string, flag: string): { host: string; port: number } {
  const match = /^(?:\[([^\]]+)\]|([^:[\]\s]+)):(\d{1,5})$/.exec(value);
  const port = Number(match?.[3]);
  if (match === null || port < 1 || port > 65_535) throw new Error(`${flag} must be <host>:<port>`);
  return { host: match[1] ?? match[2]!, port };
}

/**
 * A loopback `http:` URL, as an origin: the path, query and fragment are
 * dropped, so a pasted console URL's `?token=` is never sent.
 */
function loopbackOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("probe_url_invalid: --url must be an http:// URL on loopback");
  }
  if (
    url.protocol !== "http:" ||
    url.username !== "" ||
    url.password !== "" ||
    !(url.hostname === "localhost" || url.hostname === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(url.hostname))
  ) {
    throw new Error("probe_url_not_loopback: --url must be an http:// URL on loopback, with no credentials");
  }
  return url.origin;
}

async function writeInWorkspace(path: string): Promise<Attempt> {
  try {
    // `wx`: a file already there is never opened, let alone changed.
    await (await open(path, "wx")).close();
  } catch (error) {
    // A workspace missing here is one named wrongly, not one kept out: the
    // agent has to see its workspace.
    return refused(error, "not created");
  }
  try {
    await rm(path);
  } catch (error) {
    return { open: true, detail: `created, and could not be removed (${code(error)}): remove ${path}` };
  }
  return { open: true, detail: "created a probe file, and removed it" };
}

async function readMelraHome(directory: string | undefined): Promise<Attempt> {
  if (directory === undefined) {
    return { open: true, detail: "not tested: set MELRA_HOME to the server's, as this box sees it" };
  }
  const opened: string[] = [];
  const stopped: string[] = [];
  for (const name of ["melra.sqlite", "payload.key"]) {
    try {
      // Opened and closed, never read: whether it can be is the whole check.
      await (await open(join(directory, name), "r")).close();
      opened.push(name);
    } catch (error) {
      // Missing from the home named as the server's: the box does not show it.
      if (code(error) !== "ENOENT" && !REFUSALS.includes(code(error))) {
        return { open: true, detail: `not tested: ${name} ${code(error)}` };
      }
      stopped.push(`${name} ${code(error)}`);
    }
  }
  return opened.length > 0
    ? { open: true, detail: `opened ${opened.join(" and ")} for reading` }
    : { open: false, detail: `not opened: ${stopped.join(", ")}` };
}

// Only a completed handshake is open, which is why each target is one that
// listens when nothing is in the way. The socket is closed at once.
function connects(target: { host: string; port: number }): Promise<Attempt> {
  return new Promise((settle) => {
    const socket = connect(target);
    const done = (attempt: Attempt) => {
      socket.destroy();
      settle(attempt);
    };
    socket.setTimeout(CONNECT_TIMEOUT_MS, () => done({ open: false, detail: `no connection in ${CONNECT_TIMEOUT_MS} ms` }));
    socket.once("connect", () => done({ open: true, detail: "connected, and closed without sending anything" }));
    socket.once("error", (error) =>
      done(
        // A name the box cannot resolve says nothing of the addresses it can reach.
        /^(ENOTFOUND|EAI_)/.test(code(error))
          ? { open: true, detail: `not tested: ${code(error)}, the name did not resolve; name an address` }
          : { open: false, detail: `not connected: ${code(error)}` },
      ),
    );
  });
}

/**
 * Another port on 127.0.0.1: one this process listens on, so an unconfined
 * box always connects. Inside a container 127.0.0.1 is the container's own,
 * so a port on the host has to be named with `--local`.
 */
async function connectsLocally(): Promise<Attempt> {
  const server = createServer((socket) => socket.destroy());
  const failed = await new Promise<unknown>((settle) => {
    server.once("error", settle);
    server.listen(0, "127.0.0.1", () => settle(undefined));
  });
  // Nothing to connect to proves nothing, so it is not counted as confined.
  if (failed !== undefined) {
    return {
      open: true,
      detail: `not tested: could not listen on 127.0.0.1 (${code(failed)}); name a port that listens outside the box with --local`,
    };
  }
  try {
    const { port } = server.address() as AddressInfo;
    const attempt = await connects({ host: "127.0.0.1", port });
    return { ...attempt, detail: `port ${port}: ${attempt.detail}` };
  } finally {
    server.close();
  }
}

function starts(program: string, args: string[]): Promise<Attempt> {
  return new Promise((settle) => {
    let child: ChildProcess;
    try {
      child = spawn(program, args, { stdio: "ignore" });
    } catch (error) {
      // Node throws, rather than emits, an EPERM from a sandbox.
      settle(refused(error, "not started"));
      return;
    }
    // No shell to start is not a box that stops one.
    child.once("error", (error) => settle(refused(error, "not started")));
    // Waited for, so no process is left behind.
    child.once("spawn", () => child.once("close", () => settle({ open: true, detail: "started, and it exited" })));
  });
}

/**
 * Whether MELRA answers over HTTP, asked without a token: its 401 names it,
 * and a request that carries nothing secret cannot leak it to whatever else
 * might be listening there. At `/` as well as `/mcp`: MELRA asks for the
 * token before it routes, while the approval console, which has no MCP
 * endpoint, serves its page at `/`.
 */
async function answersHttp(target: { socketPath: string } | { origin: string }) {
  for (const path of ["/mcp", "/"]) {
    const wrong = await notMelra(target, path);
    if (wrong !== undefined) return { answers: false, detail: wrong };
  }
  return { answers: true, detail: "MELRA answered, asking for its token; none was sent" };
}

/** Why the answer to a GET of `path`, with no token, is not MELRA's; nothing when it is. */
function notMelra(target: { socketPath: string } | { origin: string }, path: string) {
  return new Promise<string | undefined>((settle) => {
    const replied = (response: IncomingMessage) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        body = (body + chunk).slice(0, 4_096);
      });
      response.on("end", () => {
        let error: unknown;
        try {
          error = (JSON.parse(body) as { error?: unknown }).error;
        } catch {
          // Not JSON, so not MELRA.
        }
        settle(
          response.statusCode === 401 && error === "unauthorized"
            ? undefined
            : `something answered, but not as MELRA does (HTTP ${response.statusCode} at ${path})`,
        );
      });
    };
    const options = { method: "GET", timeout: CONNECT_TIMEOUT_MS };
    const sent =
      "socketPath" in target
        ? request({ ...options, socketPath: target.socketPath, path }, replied)
        : request(new URL(path, target.origin), options, replied);
    sent.once("timeout", () => sent.destroy(new Error(`no answer in ${CONNECT_TIMEOUT_MS} ms`)));
    sent.once("error", (error) => settle(`no answer: ${code(error)}`));
    sent.end();
  });
}

/** The five checks and the endpoint, for this box. Bad flags throw here, before anything runs. */
export function probeChecks(options: ProbeOptions): { checks: Check[]; melra: Endpoint } {
  // A MELRA started inside the box opens MELRA_HOME there, so the box either
  // lets the agent read it too or stops MELRA: such a probe could never pass.
  if (options.url === undefined && options.socketPath === undefined) {
    throw new Error("probe_endpoint_missing: name the MELRA running outside this box with --socket, --url or MELRA_SOCKET");
  }
  const probeFile = join(options.workspace, `.melra-probe-${randomUUID()}`);
  const publicTarget = hostPort(options.public ?? DEFAULT_PUBLIC, "--public");
  const localTarget = options.local === undefined ? undefined : hostPort(options.local, "--local");
  const origin = options.url === undefined ? undefined : loopbackOrigin(options.url);
  const socketPath = options.socketPath;
  const [shell, shellArgs] =
    process.platform === "win32"
      ? [process.env.ComSpec ?? "cmd.exe", ["/d", "/c", "exit 0"]]
      : ["/bin/sh", ["-c", "exit 0"]];
  return {
    checks: [
      { name: "workspace-write", target: options.workspace, attempt: () => writeInWorkspace(probeFile) },
      {
        name: "melra-home-read",
        target: options.dataDirectory ?? "MELRA_HOME",
        attempt: () => readMelraHome(options.dataDirectory),
      },
      { name: "public-connect", target: options.public ?? DEFAULT_PUBLIC, attempt: () => connects(publicTarget) },
      {
        name: "local-connect",
        target: options.local ?? "127.0.0.1",
        attempt: localTarget === undefined ? connectsLocally : () => connects(localTarget),
      },
      { name: "program-start", target: shell, attempt: () => starts(shell, shellArgs) },
    ],
    melra:
      origin !== undefined
        ? { transport: "http", target: origin, answers: () => answersHttp({ origin }) }
        : { transport: "socket", target: socketPath!, answers: () => answersHttp({ socketPath: socketPath! }) },
  };
}

export async function runProbe(checks: readonly Check[], melra: Endpoint): Promise<ProbeReport> {
  const answer = await melra.answers();
  const attempts = await Promise.all(checks.map((check) => check.attempt()));
  const results = checks.map((check, index) => ({
    name: check.name,
    target: check.target,
    outcome: attempts[index]!.open ? ("open" as const) : ("confined" as const),
    detail: attempts[index]!.detail,
  }));
  return {
    passed: answer.answers && results.every((result) => result.outcome === "confined"),
    checks: results,
    melra: { transport: melra.transport, target: melra.target, ...answer },
  };
}

export function renderProbe(report: ProbeReport): string {
  const open = report.checks.filter((check) => check.outcome === "open").length;
  const rows = [
    ...report.checks.map((check) => [
      mark(check.outcome === "confined" ? "pass" : "fail"),
      check.name,
      check.outcome,
      paint.dim(printable(`${check.target}: ${check.detail}`)),
    ]),
    [
      mark(report.melra.answers ? "pass" : "fail"),
      "melra",
      report.melra.answers ? "answers" : "no answer",
      paint.dim(printable(`${report.melra.transport} ${report.melra.target}: ${report.melra.detail}`)),
    ],
  ];
  const problems = [
    ...(open === 0 ? [] : [`${open} of ${report.checks.length} checks open`]),
    ...(report.melra.answers ? [] : ["MELRA did not answer"]),
  ];
  return [
    table(rows, { indent: 2 }),
    "",
    report.passed
      ? `${mark("pass")} ${paint.bold("Confined: every check was stopped, and MELRA answers")}`
      : `${mark("fail")} ${paint.bold(`Not confined: ${problems.join(", ")}`)}`,
  ].join("\n");
}
