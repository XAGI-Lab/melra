// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

// The credential broker through the whole kernel.
//
// `packages/policy-core` proves the broker picks the right header. What it
// cannot prove is the part that matters operationally: that the secret reaches
// the far end, that it reaches *nothing else* — not the plan, not the result the
// caller reads, not the receipt, not the SQLite file on disk — and that the two
// scoping lists behave differently on a miss. Nothing here leaves loopback.

import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TaskRequestSchema } from "@melra/protocol";
import { createMelraRuntime } from "../src/index.js";
import type { MelraRuntime } from "../src/runtime.js";

const SECRET = "sk_live_kernel_held_never_agent_held";

let fixture: Server;
let port: number;
let runtime: MelraRuntime;
let root: string;
/** What the far end actually received, per request, in order. */
const seen: { url: string; authorization: string | undefined }[] = [];

beforeAll(async () => {
  fixture = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      seen.push({
        url: req.url ?? "",
        authorization: req.headers.authorization,
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
  port = (fixture.address() as AddressInfo).port;

  root = await mkdtemp(join(tmpdir(), "melra-credentials-"));
  await writeFile(
    join(root, "policy.json"),
    JSON.stringify({
      version: "credential-broker",
      workspaceRoot: root,
      allowedCommands: [],
      // `localhost` and `127.0.0.1` are the same machine and a different name,
      // which is exactly the shape needed to prove host scoping: one is the
      // credential's host, the other is not.
      allowedDomains: ["127.0.0.1", "localhost"],
      allowLocalhost: true,
      mutations: "confirm",
      approvalTtlMs: 300_000,
      maxFileBytes: 1_000_000,
      credentials: {
        billing: {
          source: { env: "MELRA_TEST_BILLING_KEY" },
          inject: { header: "Authorization", scheme: "Bearer" },
          hosts: ["127.0.0.1"],
          capability: "http.post:http://127.0.0.1:*/charges*",
        },
      },
    }),
  );
  process.env.MELRA_TEST_BILLING_KEY = SECRET;
  runtime = await createMelraRuntime({
    workspaceRoot: root,
    dataDirectory: join(root, ".data"),
    policyPath: join(root, "policy.json"),
  });
});

afterAll(async () => {
  delete process.env.MELRA_TEST_BILLING_KEY;
  await runtime.close();
  await new Promise<void>((resolve) => fixture.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
});

const charge = (host: string, method = "POST", path = "/charges") =>
  TaskRequestSchema.parse({
    goal: "Charge the customer",
    operation: {
      kind: "http",
      action: "request",
      method,
      url: `http://${host}:${port}${path}`,
      content: '{"amount":100}',
    },
    requiredEvidence: [{ type: "result_equals", path: "status", value: 200 }],
  });

async function run(request: ReturnType<typeof charge>) {
  const planned = runtime.controller.plan(request);
  const approval =
    planned.approval === undefined
      ? undefined
      : { approvalId: planned.approval.approvalId, phrase: planned.approval.phrase };
  return { planned, ...(await runtime.controller.execute(planned.id, approval)) };
}

describe("a credential the agent never holds", () => {
  it("reaches the far end and nothing else", async () => {
    const { planned, task, output, receipt } = await run(charge("127.0.0.1"));
    expect(task.status).toBe("verified_success");
    expect(seen.at(-1)?.authorization).toBe(`Bearer ${SECRET}`);
    // The caller learns which credential authorised the call, which is what a
    // receipt is for, and learns nothing it could replay.
    expect(output?.credentials).toEqual(["billing"]);

    const everythingTheCallerSees = JSON.stringify({ planned, task, output, receipt });
    expect(everythingTheCallerSees).toContain("billing");
    expect(everythingTheCallerSees).not.toContain(SECRET);
  });

  it("is not in the database either", async () => {
    // The live caller may see a response; the durable record may not. A secret
    // on disk outlives the process that was allowed to hold it.
    const bytes = await readFile(join(root, ".data", "melra.sqlite"));
    expect(bytes.includes(Buffer.from(SECRET))).toBe(false);
  });

  it("lets a request to another host go out unauthenticated", async () => {
    const { task } = await run(charge("localhost"));
    expect(task.status).toBe("verified_success");
    // Not refused — sent without the header. A secret that follows whatever URL
    // the caller picked is scoped to nothing at all.
    expect(seen.at(-1)?.authorization).toBeUndefined();
  });

  it("refuses an operation outside the delegation before anything is sent", async () => {
    const before = seen.length;
    // Same host, same credential, an operation the capability does not name.
    const { task } = await run(charge("127.0.0.1", "DELETE", "/charges/ch_1"));
    expect(task.status).toBe("failed");
    expect(task.error).toContain("credential_capability_not_covered:billing");
    expect(seen).toHaveLength(before);
  });
});
