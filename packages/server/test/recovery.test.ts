// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

// Two runtimes on one MELRA home, as a `serve` and a CLI command beside it
// are. Building a runtime recovers, and recovery used to take the other one's
// live task for a crashed one.

import { link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { detectBrowserExecutable } from "@melra/browser-runtime";
import { BrowserOperationSchema, FileOperationSchema, TaskRequestSchema, TerminalOperationSchema } from "@melra/protocol";
// The kernel subpath, as the CLI and an embedder without the MCP interface
// import it; it must carry the verifier types the package root does.
import { createMelraRuntime, type MelraRuntime, type PredicateVerifier } from "../src/kernel.js";

const roots: string[] = [];
const runtimes: MelraRuntime[] = [];

afterEach(async () => {
  vi.useRealTimers();
  // Both taken before anything is awaited: a close that outlasted the hook
  // went on to take, and remove, the next test's root.
  const [closing, removing] = [runtimes.splice(0), roots.splice(0)];
  for (const runtime of closing) await runtime.close().catch(() => undefined);
  await Promise.all(removing.map((root) => rm(root, { recursive: true, force: true })));
}, 60_000);

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
    phrase: planned.approval!.phrase!,
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

  it("keeps its adapters off the files it holds locked", async () => {
    // A data directory inside the workspace, as for `serve` started from home.
    const root = await mkdtemp(join(tmpdir(), "melra-runtime-recovery-"));
    roots.push(root);
    const runtime = await createMelraRuntime({
      workspaceRoot: root,
      dataDirectory: join(root, ".melra"),
      environment: {},
    });
    runtimes.push(runtime);
    const owner = runtime.store.ownerId();
    for (const path of [".melra/melra.sqlite", `.melra/melra.sqlite-owners/${owner}`, ".melra/payload.key"]) {
      const planned = runtime.controller.plan(
        TaskRequestSchema.parse({ goal: "Read", operation: { kind: "file", action: "read", path } }),
      );
      const { task } = await runtime.controller.execute(planned.id);
      expect(task.status).toBe("failed");
      expect(task.error).toContain("path_reserved");
    }
    // The verifier asks the same question before it opens anything.
    const write = runtime.controller.plan(
      TaskRequestSchema.parse({
        goal: "Write and check",
        operation: { kind: "file", action: "write", path: "out.txt", content: "x" },
        requiredEvidence: [{ type: "file_hash", path: ".melra/melra.sqlite", sha256: "0".repeat(64) }],
      }),
    );
    const checked = await runtime.controller.execute(write.id, {
      approvalId: write.approval!.approvalId,
      phrase: write.approval!.phrase!,
    });
    expect(checked.receipt?.evidence[0]?.summary).toBe("verification_path_reserved");
    // Nor does the browser upload them.
    if ((await detectBrowserExecutable()) === undefined) return;
    await expect(
      runtime.router.execute(
        BrowserOperationSchema.parse({
          kind: "browser",
          action: "upload",
          target: { selector: "input" },
          filePaths: [".melra/payload.key"],
          timeoutMs: 1_000,
        }),
      ),
    ).rejects.toThrow("browser_path_reserved");
  }, 120_000);

  it("keeps file effects off the data directory and every directory holding it", async () => {
    const root = await mkdtemp(join(tmpdir(), "melra-runtime-recovery-"));
    roots.push(root);
    const data = join(root, "home", ".melra");
    const runtime = await createMelraRuntime({ workspaceRoot: root, dataDirectory: data, environment: {} });
    runtimes.push(runtime);
    await mkdir(join(root, "fresh"));
    const key = await readFile(join(data, "payload.key"));
    const run = (operation: Record<string, unknown>) =>
      runtime.router.execute(FileOperationSchema.parse({ kind: "file", ...operation }));
    for (const operation of [
      { action: "delete", path: "home/.melra", recursive: true },
      { action: "delete", path: "home", recursive: true },
      { action: "move", path: "home", destination: "elsewhere" },
      { action: "move", path: "fresh", destination: "home/.melra" },
      // What a later start reads, and what is kept there besides.
      { action: "write", path: "home/.melra/policy.json", content: "{}" },
      { action: "write", path: "home/.melra/oauth.json", content: "{}" },
      { action: "mkdir", path: "home/.melra/artifacts", recursive: true },
    ]) {
      await expect(run(operation), JSON.stringify(operation)).rejects.toThrow("path_reserved");
    }
    expect(await readFile(join(data, "payload.key"))).toEqual(key);
    await expect(readFile(join(data, "policy.json"))).rejects.toThrow();
    // Listing names opens nothing, and the rest of the workspace is ordinary.
    expect(await run({ action: "list", path: "home" })).toMatchObject({ entries: [{ name: ".melra" }] });
    await run({ action: "write", path: "home/notes.txt", content: "x" });
  });

  it("lets its artifacts be read, and nothing change them", async () => {
    const root = await mkdtemp(join(tmpdir(), "melra-runtime-recovery-"));
    roots.push(root);
    const data = join(root, ".melra");
    const runtime = await createMelraRuntime({ workspaceRoot: root, dataDirectory: data, environment: {} });
    runtimes.push(runtime);
    const artifacts = join(data, "artifacts");
    await mkdir(artifacts, { recursive: true });
    await writeFile(join(artifacts, "shot.png"), "png");
    // The key under another name among them is still the key.
    await link(join(data, "payload.key"), join(artifacts, "key.png"));
    const run = (operation: Record<string, unknown>) =>
      runtime.router.execute(FileOperationSchema.parse({ kind: "file", ...operation }));
    expect(await run({ action: "read", path: ".melra/artifacts/shot.png" })).toMatchObject({ content: "png" });
    expect(await run({ action: "stat", path: ".melra/artifacts/shot.png" })).toMatchObject({ type: "file" });
    expect(await run({ action: "hash", path: ".melra/artifacts/shot.png" })).toMatchObject({ size: 3 });
    expect(await run({ action: "list", path: ".melra/artifacts" })).toMatchObject({
      entries: expect.arrayContaining([{ name: "shot.png", type: "file" }]),
    });
    for (const operation of [
      { action: "read", path: ".melra/artifacts/key.png" },
      { action: "write", path: ".melra/artifacts/shot.png", content: "x" },
      { action: "write", path: ".melra/artifacts/new.png", content: "x" },
      { action: "delete", path: ".melra/artifacts/shot.png" },
      { action: "delete", path: ".melra/artifacts", recursive: true },
      { action: "move", path: ".melra/artifacts/shot.png", destination: "shot.png" },
      { action: "mkdir", path: ".melra/artifacts/sub" },
    ]) {
      await expect(run(operation), JSON.stringify(operation)).rejects.toThrow("path_reserved");
    }
    expect(await readFile(join(artifacts, "shot.png"), "utf8")).toBe("png");
    // A command may change what it names, so none may name them.
    await expect(
      runtime.router.execute(
        TerminalOperationSchema.parse({ kind: "terminal", action: "run", command: "ls", args: [".melra/artifacts"] }),
      ),
    ).rejects.toThrow("terminal_path_reserved");
    // The verifier only reads.
    const write = runtime.controller.plan(
      TaskRequestSchema.parse({
        goal: "Write and check",
        operation: { kind: "file", action: "write", path: "out.txt", content: "x" },
        requiredEvidence: [{ type: "file_exists", path: ".melra/artifacts/shot.png" }],
      }),
    );
    const checked = await runtime.controller.execute(write.id, {
      approvalId: write.approval!.approvalId,
      phrase: write.approval!.phrase!,
    });
    expect(checked.task.status).toBe("verified_success");
  });

  it("lets the unsafe-local browser read its artifacts, and nothing else there", async () => {
    if ((await detectBrowserExecutable()) === undefined) return;
    const base = await realpath(await mkdtemp(join(tmpdir(), "melra-runtime-recovery-")));
    roots.push(base);
    const workspace = join(base, "workspace");
    const data = join(base, "data");
    await mkdir(workspace);
    const runtime = await createMelraRuntime({
      workspaceRoot: workspace,
      dataDirectory: data,
      environment: { MELRA_UNHINGED: "1" },
    });
    runtimes.push(runtime);
    const artifacts = join(data, "artifacts");
    await mkdir(artifacts, { recursive: true });
    await writeFile(join(artifacts, "shot.png"), "png");
    await link(join(data, "payload.key"), join(artifacts, "key.png"));
    // Something kept deeper in the data directory, linked from the workspace.
    await mkdir(join(data, "profile", "Default"), { recursive: true });
    await writeFile(join(data, "profile", "Default", "page.html"), "<p>kept</p>");
    await symlink(join(data, "profile", "Default"), join(workspace, "linked"));
    await writeFile(join(workspace, "form.html"), `<input type="file" id="f">`);
    const run = (operation: Record<string, unknown>) =>
      runtime.router.execute(BrowserOperationSchema.parse({ kind: "browser", ...operation }));
    await run({ action: "navigate", url: pathToFileURL(join(workspace, "form.html")).href });
    await expect(
      run({ action: "upload", target: { selector: "#f" }, filePaths: [join(artifacts, "shot.png")] }),
    ).resolves.toMatchObject({ uploaded: 1 });
    await expect(
      run({ action: "upload", target: { selector: "#f" }, filePaths: [join(artifacts, "key.png")] }),
    ).rejects.toThrow("browser_path_reserved");
    await expect(
      run({ action: "navigate", url: pathToFileURL(join(workspace, "linked", "page.html")).href }),
    ).rejects.toThrow("browser_path_reserved");
  }, 120_000);

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

  it("seals an older writer's records during the periodic recovery sweep without restarting (#466)", async () => {
    const root = await mkdtemp(join(tmpdir(), "melra-runtime-recovery-"));
    roots.push(root);
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const runtime = await createMelraRuntime({
      workspaceRoot: root,
      dataDirectory: join(root, ".melra"),
      environment: {},
    });
    runtimes.push(runtime);

    const database = new DatabaseSync(join(root, ".melra", "melra.sqlite"));
    try {
      const taskId = "00000000-0000-4000-8000-0000000000a1";
      const receiptId = "00000000-0000-4000-8000-0000000000b1";
      database
        .prepare(`
          INSERT INTO receipts(id, task_id, data, created_at)
          VALUES (?, ?, ?, ?)
        `)
        .run(receiptId, taskId, JSON.stringify({ receiptId, taskId, endedAt: "2026-01-01T00:00:00.000Z" }), "2026-01-01T00:00:00.000Z");

      const unsealedBefore = database
        .prepare("SELECT COUNT(*) AS count FROM record_chain WHERE record_table = 'receipts' AND record_key = ?")
        .get(JSON.stringify([receiptId])) as { count: number };
      expect(unsealedBefore.count).toBe(0);

      // Advance timers by 30 seconds to trigger the periodic recovery sweep
      await vi.advanceTimersByTimeAsync(30_000);

      const sealedAfter = database
        .prepare("SELECT swept FROM record_chain WHERE record_table = 'receipts' AND record_key = ?")
        .get(JSON.stringify([receiptId])) as { swept: number } | undefined;
      expect(sealedAfter).toBeDefined();
      expect(sealedAfter?.swept).toBe(1);
    } finally {
      database.close();
    }
  });

  it("seals an older writer's records when sweep() is invoked directly", async () => {
    const root = await mkdtemp(join(tmpdir(), "melra-runtime-recovery-"));
    roots.push(root);
    const runtime = await createMelraRuntime({
      workspaceRoot: root,
      dataDirectory: join(root, ".melra"),
      environment: {},
    });
    runtimes.push(runtime);

    const database = new DatabaseSync(join(root, ".melra", "melra.sqlite"));
    try {
      const taskId = "00000000-0000-4000-8000-0000000000a2";
      const receiptId = "00000000-0000-4000-8000-0000000000b2";
      database
        .prepare(`
          INSERT INTO receipts(id, task_id, data, created_at)
          VALUES (?, ?, ?, ?)
        `)
        .run(receiptId, taskId, JSON.stringify({ receiptId, taskId, endedAt: "2026-01-01T00:00:00.000Z" }), "2026-01-01T00:00:00.000Z");

      await runtime.sweep();

      const sealedAfter = database
        .prepare("SELECT swept FROM record_chain WHERE record_table = 'receipts' AND record_key = ?")
        .get(JSON.stringify([receiptId])) as { swept: number } | undefined;
      expect(sealedAfter).toBeDefined();
      expect(sealedAfter?.swept).toBe(1);
    } finally {
      database.close();
    }
  });
});
