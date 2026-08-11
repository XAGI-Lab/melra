// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

// Usage-bounded grants, through the whole kernel.
//
// `validUntil` bounds a window. These bound what happens inside it, and the
// only interesting questions are about *when* a grant is drawn down: not at
// plan time, not on a call that failed verification, and not again on a
// restart. Nothing here leaves loopback.

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
let root: string;
/** How many requests the far end actually served. */
let served = 0;
/** What the provider reports the refund did. Set per test. */
let state = "succeeded";

const GRANTS = [
  {
    id: "refunds-two",
    capability: "http.post",
    effects: ["mutate"],
    target: "*",
    maxOperations: 2,
    provider: { name: "acme-pay", amountMax: 5_000, dailyMax: 8_000 },
  },
];

/**
 * A runtime over one named data directory. Two calls with the same name are a
 * restart — same durable counts, new process state — and different names are
 * independent installs, which is how each test gets its own budget.
 */
async function open(store: string): Promise<MelraRuntime> {
  return await createMelraRuntime({
    workspaceRoot: root,
    dataDirectory: join(root, store),
    policyPath: join(root, "policy.json"),
  });
}

beforeAll(async () => {
  fixture = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      served += 1;
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

  root = await mkdtemp(join(tmpdir(), "melra-metering-"));
  await writeFile(
    join(root, "policy.json"),
    JSON.stringify({
      version: "metering",
      workspaceRoot: root,
      allowedCommands: [],
      allowedDomains: ["127.0.0.1"],
      allowLocalhost: true,
      mutations: "confirm",
      approvalTtlMs: 300_000,
      maxFileBytes: 1_000_000,
      capabilities: GRANTS,
    }),
  );
});

afterAll(async () => {
  await new Promise<void>((resolve) => fixture.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
});

const refund = (amount = 1_000) =>
  TaskRequestSchema.parse({
    goal: "Refund a charge",
    operation: {
      kind: "http",
      action: "request",
      method: "POST",
      url: `http://127.0.0.1:${port}/refunds`,
      content: '{"charge":"ch_1"}',
      spend: { provider: "acme-pay", amount, currency: "USD" },
    },
    requiredEvidence: [
      {
        type: "http_resource_matches",
        url: `http://127.0.0.1:${port}/refunds/{{json.id}}`,
        path: "json.state",
        value: "succeeded",
      },
    ],
  });

async function run(runtime: MelraRuntime, request: ReturnType<typeof refund>) {
  const planned = runtime.controller.plan(request);
  if (planned.status === "policy_blocked") return planned;
  const approval =
    planned.approval === undefined
      ? undefined
      : {
          approvalId: planned.approval.approvalId,
          phrase: planned.approval.phrase,
        };
  return (await runtime.controller.execute(planned.id, approval)).task;
}

describe("a grant that runs out", () => {
  it("spends on commit, survives a restart, and refuses the third", async () => {
    const first = await open("restart");
    expect((await run(first, refund())).status).toBe("verified_success");

    // The count is durable, so what the second process sees is what the first
    // one spent. A budget that refilled on restart would not be a budget.
    await first.close();
    const second = await open("restart");
    expect((await run(second, refund())).status).toBe("verified_success");

    const third = await run(second, refund());
    expect(third.status).toBe("policy_blocked");
    expect(third.policyDecision?.reason).toBe(
      "capability_usage_exhausted:refunds-two",
    );
    await second.close();
  });

  it("does not spend on a call that succeeded without doing the work", async () => {
    // Same fixture, same 201 — the provider just never moved the money. The
    // grant must not pay for a task that landed `partial`.
    state = "pending";
    const runtime = await open("unverified");
    const before = runtime.store.capabilityUsage("refunds-two", "");
    const task = await run(runtime, refund());
    expect(task.status).toBe("partial");
    expect(runtime.store.capabilityUsage("refunds-two", "").operations).toBe(
      before.operations,
    );
    await runtime.close();
    state = "succeeded";
  });

  it("refuses an amount over the per-operation ceiling before anything runs", async () => {
    const runtime = await open("ceiling");
    const servedBefore = served;
    const task = await run(runtime, refund(9_000));
    expect(task.status).toBe("policy_blocked");
    expect(task.policyDecision?.reason).toBe(
      "capability_amount_exceeded:refunds-two",
    );
    // Refused at policy, like every other deny: no socket was opened.
    expect(served).toBe(servedBefore);
    await runtime.close();
  });

  it("does not cover an operation that declared no spend at all", async () => {
    const runtime = await open("undeclared");
    const undeclared = TaskRequestSchema.parse({
      ...refund(),
      operation: {
        kind: "http",
        action: "request",
        method: "POST",
        url: `http://127.0.0.1:${port}/refunds`,
        content: '{"charge":"ch_1"}',
      },
    });
    const task = await run(runtime, undeclared);
    // The grant is provider-shaped, so it covers declared spends only. An
    // undeclared one is ungranted rather than free — and the refusal says which
    // of the two fixes applies, since the grant itself is not the thing missing.
    expect(task.status).toBe("policy_blocked");
    expect(task.policyDecision?.reason).toBe(
      "capability_spend_not_declared:http.post",
    );
    await runtime.close();
  });
});
