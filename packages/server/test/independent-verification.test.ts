// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

// Independent-channel verification through the whole kernel.
//
// `packages/verifier-core` proves the predicate compares the right things with
// the probe stubbed out. What it cannot prove is the part that decides whether
// this is worth having: that a real second request goes out, that it goes out
// through the same governed adapter as the effect, and that a provider which
// accepted the call without doing the work lands the task `partial` instead of
// `verified_success`. Nothing here leaves loopback.

import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { TaskRequestSchema } from "@melra/protocol";
import { createMelraRuntime } from "../src/index.js";
import type { MelraRuntime } from "../src/runtime.js";

// Every name answers loopback, so a request to a public-looking host the policy
// does not name lands on the fixture below, where it can be counted. The other
// tests use addresses, which are never looked up.
vi.mock("node:dns/promises", () => ({
  lookup: async () => [{ address: "127.0.0.1", family: 4 }],
}));

let fixture: Server;
let port: number;
let runtime: MelraRuntime;
let root: string;
/** `${method} ${path}` for every request the far end saw, in order. */
let seen: string[] = [];
/** What the refund looks like when it is read back. Set per test. */
let state = "pending";

beforeAll(async () => {
  fixture = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      seen.push(`${req.method ?? ""} ${req.url ?? ""}`);
      res.writeHead(req.method === "POST" ? 201 : 200, {
        "content-type": "application/json",
      });
      res.end(
        JSON.stringify(req.method === "POST" ? { id: "rf_1" } : { state }),
      );
    });
  });
  await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
  port = (fixture.address() as AddressInfo).port;

  root = await mkdtemp(join(tmpdir(), "melra-independent-"));
  await writeFile(
    join(root, "policy.json"),
    JSON.stringify({
      version: "independent-verification",
      workspaceRoot: root,
      allowedCommands: [],
      allowedDomains: ["127.0.0.1"],
      allowLocalhost: true,
      mutations: "confirm",
      approvalTtlMs: 300_000,
      maxFileBytes: 1_000_000,
    }),
  );
  runtime = await createMelraRuntime({
    workspaceRoot: root,
    dataDirectory: join(root, ".data"),
    policyPath: join(root, "policy.json"),
    environment: {},
  });
});

afterAll(async () => {
  await runtime.close();
  await new Promise<void>((resolve) => fixture.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
});

const refund = (verifyHost = "127.0.0.1") =>
  TaskRequestSchema.parse({
    goal: "Refund the charge and confirm the provider agrees",
    operation: {
      kind: "http",
      action: "request",
      method: "POST",
      url: `http://127.0.0.1:${port}/refunds`,
      content: '{"charge":"ch_1"}',
    },
    requiredEvidence: [
      {
        type: "http_resource_matches",
        // The id exists only after the effect ran, which is why the URL is
        // completed from the recorded result rather than written out in full.
        url: `http://${verifyHost}:${port}/refunds/{{json.id}}`,
        path: "json.state",
        value: "succeeded",
      },
    ],
  });

async function run(request: ReturnType<typeof refund>) {
  seen = [];
  const planned = runtime.controller.plan(request);
  const approval =
    planned.approval === undefined
      ? undefined
      : {
          approvalId: planned.approval.approvalId,
          phrase: planned.approval.phrase!,
        };
  return await runtime.controller.execute(planned.id, approval);
}

describe("a provider's own state, not the provider's answer", () => {
  it("verifies against a second request that really goes out", async () => {
    state = "succeeded";
    const { task, receipt } = await run(refund());
    expect(task.status).toBe("verified_success");
    // Two requests, in this order: the effect, then the read that confirms it.
    expect(seen).toEqual(["POST /refunds", "GET /refunds/rf_1"]);
    expect(receipt?.evidence[0]?.strength).toBe("independent");
  });

  it("is partial when the call succeeded and the work did not happen", async () => {
    state = "pending";
    const { task, output } = await run(refund());
    // The far end said 201. This is exactly the case an adapter's own word
    // cannot catch, and the reason the whole predicate exists.
    expect(output?.status).toBe(201);
    expect(task.status).toBe("partial");
    expect(seen).toHaveLength(2);
  });

  it("keeps a token in the read's query out of the stored receipt and certificate", async () => {
    state = "succeeded";
    const token = "query-held-A1b2C3d4E5f6";
    const { task, receipt, certificate } = await run(
      TaskRequestSchema.parse({
        ...refund(),
        requiredEvidence: [
          {
            type: "http_resource_matches",
            url: `http://127.0.0.1:${port}/refunds/{{json.id}}?access_token=${token}`,
            path: "json.state",
            value: "succeeded",
          },
        ],
      }),
    );
    expect(task.status).toBe("verified_success");
    // The read went out as declared.
    expect(seen).toEqual(["POST /refunds", `GET /refunds/rf_1?access_token=${token}`]);
    expect(receipt?.evidence[0]?.source).toBe(`http://127.0.0.1:${port}/refunds/rf_1`);
    expect(JSON.stringify(runtime.store.getReceiptsForTask(task.id))).not.toContain(token);
    expect(JSON.stringify(runtime.store.getCertificateForTask(task.id))).not.toContain(token);
    expect(JSON.stringify(certificate)).not.toContain(token);
  });

  it("cannot reach a destination the effect could not reach", async () => {
    state = "succeeded";
    // Same machine, a name the allowlist does not carry. A probe that skipped
    // the boundary would be a way to make the verifier fetch on request.
    const { task, receipt } = await run(refund("localhost"));
    expect(task.status).toBe("partial");
    expect(receipt?.evidence[0]?.passed).toBe(false);
    expect(seen).toEqual(["POST /refunds"]);
  });
});

describe("in enforced mode", () => {
  it("does not read a task's evidence from a host the policy does not name until an operator approves", async () => {
    const home = await mkdtemp(join(tmpdir(), "melra-independent-enforced-"));
    let enforced: MelraRuntime | undefined;
    try {
      await mkdir(join(home, "workspace"));
      await writeFile(join(home, "workspace", "notes.txt"), "workspace-note", "utf8");
      // The default `"*"`, with loopback opened so the fixture can answer.
      await writeFile(join(home, "policy.json"), JSON.stringify({ allowLocalhost: true }), "utf8");
      enforced = await createMelraRuntime({
        workspaceRoot: join(home, "workspace"),
        dataDirectory: join(home, "data"),
        policyPath: join(home, "policy.json"),
        environment: { MELRA_MODE: "enforced" },
      });
      seen = [];
      const read = enforced.controller.plan(
        TaskRequestSchema.parse({
          goal: "Read a note",
          operation: { kind: "file", action: "read", path: "notes.txt" },
          requiredEvidence: [
            { type: "http_resource_matches", url: `http://unlisted.example:${port}/c?d={{content}}`, path: "status", value: 200 },
          ],
        }),
      );
      expect(read.status).toBe("awaiting_approval");
      expect(read.policyDecision.reason).toBe("network_read_unlisted_host");
      await expect(enforced.controller.execute(read.id)).rejects.toThrow(/approval_awaiting_operator/);
      expect(seen).toEqual([]);
      enforced.controller.decide(read.id, enforced.controller.approvalView(read.id).renderDigest, "cli:test");
      expect((await enforced.controller.execute(read.id)).task.status).toBe("verified_success");
      expect(seen).toEqual(["GET /c?d=workspace-note"]);
    } finally {
      await enforced?.close();
      await rm(home, { recursive: true, force: true });
    }
  });
});
