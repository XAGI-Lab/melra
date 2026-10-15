// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

// Two runtimes on one MELRA home, as a `serve` and a CLI command beside it
// are. Building a runtime recovers, and recovery used to take the other one's
// live task for a crashed one.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskRequestSchema } from "@melra/protocol";
import { createMelraRuntime, type MelraRuntime, type PredicateVerifier } from "../src/index.js";

const roots: string[] = [];
const runtimes: MelraRuntime[] = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const runtime of runtimes.splice(0)) await runtime.close().catch(() => undefined);
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** A custom check that holds the task in `verifying` until released. */
function heldCheck() {
  let entered!: () => void;
  let release!: () => void;
  const inside = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const verifier: PredicateVerifier<{ type: "held_check" }> = {
    type: "held_check",
    async check() {
      entered();
      await released;
      return { passed: true, summary: "held" } as never;
    },
  };
  return { verifier, inside, release };
}

async function pair() {
  const root = await mkdtemp(join(tmpdir(), "melra-runtime-recovery-"));
  roots.push(root);
  const held = heldCheck();
  const options = { workspaceRoot: root, dataDirectory: join(root, ".melra"), environment: {} };
  const first = await createMelraRuntime({ ...options, evidenceVerifiers: [held.verifier] });
  runtimes.push(first);
  const planned = first.controller.plan(
    TaskRequestSchema.parse({
      goal: "Write and check",
      operation: { kind: "file", action: "write", path: "out.txt", content: "x" },
      requiredEvidence: [{ type: "custom", verifier: "held_check" }],
    }),
  );
  const running = first.controller.execute(planned.id, {
    approvalId: planned.approval!.approvalId,
    phrase: planned.approval!.phrase,
  });
  running.catch(() => undefined);
  await held.inside;
  const start = async () => {
    const second = await createMelraRuntime(options);
    runtimes.push(second);
    return second;
  };
  return { first, held, id: planned.id, running, start };
}

describe("recovery between runtimes sharing a home", () => {
  it("does not take a live runtime's task when another starts", async () => {
    const { first, held, id, running, start } = await pair();
    const second = await start();
    expect(second.store.getTask(id)?.status).toBe("verifying");

    held.release();
    expect((await running).task.status).toBe("verified_success");
    expect(first.controller.receipts({ taskId: id }).receipts).toHaveLength(1);
  });

  it("sweeps up a task once the runtime running it is gone", async () => {
    const { first, id, start } = await pair();
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const second = await start();
    expect(second.store.getTask(id)?.status).toBe("verifying");

    first.store.close();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(second.store.getTask(id)?.status).toBe("recovery_required");
  });

  it("waits for a sweep in flight before closing the database under it", async () => {
    const root = await mkdtemp(join(tmpdir(), "melra-runtime-recovery-"));
    roots.push(root);
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const runtime = await createMelraRuntime({
      workspaceRoot: root,
      dataDirectory: join(root, ".melra"),
      environment: {},
    });
    let finish: (() => void) | undefined;
    vi.spyOn(runtime.workflows, "recoverInterrupted").mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () => resolve([]);
        }),
    );
    vi.advanceTimersByTime(30_000);
    expect(finish).toBeDefined();
    let closed = false;
    const closing = runtime.close().then(() => {
      closed = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    // Closing the store now would fail the pass with "database is not open".
    expect(closed).toBe(false);
    finish!();
    await closing;
    expect(closed).toBe(true);
  });
});
