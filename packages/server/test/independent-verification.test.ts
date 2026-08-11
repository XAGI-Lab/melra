// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

// Independent-channel verification through the whole kernel.
//
// `packages/verifier-core` proves the predicate compares the right things with
// the probe stubbed out. What it cannot prove is the part that decides whether
// this is worth having: that a real second request goes out, that it goes out
// through the same governed adapter as the effect, and that a provider which
// accepted the call without doing the work lands the task `partial` instead of
// `verified_success`. Nothing here leaves loopback.

import { createServer, type Server } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TaskRequestSchema } from "@melra/protocol";
import { createMelraRuntime } from "../src/index.js";
import type { MelraRuntime } from "../src/runtime.js";

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
          phrase: planned.approval.phrase,
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
