// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ComputerOperationSchema } from "@melra/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { ComputerRuntime, createSystemComputerAdapter, escapeSendKeys } from "./index.js";

/**
 * Windows computer use was entirely absent: the factory had no `win32` branch,
 * so `capabilities` reported `unavailable` and every input action threw a bare
 * `computer_use_unavailable`. CI ran on `windows-latest` and stayed green
 * because nothing exercised Windows behaviour — which is why the adapter tests
 * below run for real on Windows rather than against a stub.
 */
const onWindows = process.platform === "win32";
const roots: string[] = [];

/**
 * Two clocks, and both have to clear the same wait: vitest's own default killed
 * these tests at 5s, and once that was raised the operation's `timeoutMs` cap
 * killed them at 30s — which is why the schema now allows 120s for a computer
 * action like every other operation kind.
 *
 * The wait is real, not slack. A computer action spawns a whole interpreter:
 * `powershell.exe` cold-starts in seconds, the pointer script's
 * `Add-Type -TypeDefinition` runs the C# compiler to build the P/Invoke shim,
 * and the first such spawn after boot pays for a cold disk on top. That cost is
 * per-process, so it is paid on every action, and a caller who leaves
 * `timeoutMs` at its 10s default is closer to the edge on a cold or loaded
 * machine than the number suggests.
 */
const POWERSHELL_TEST_TIMEOUT_MS = 120_000;

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "melra-computer-"));
  roots.push(root);
  return root;
}

describe("escapeSendKeys", () => {
  it("neutralizes the characters SendKeys reads as modifiers", () => {
    // Unescaped, `+` is Shift, `^` is Ctrl, `%` is Alt, `~` is Enter, and the
    // brackets group — so this password would have typed a chord and pressed
    // Enter instead of entering any of these characters.
    expect(escapeSendKeys("a+b^c%d~e")).toBe("a{+}b{^}c{%}d{~}e");
    expect(escapeSendKeys("({x})[y]")).toBe("{(}{{}x{}}{)}{[}y{]}");
  });

  it("leaves ordinary text alone", () => {
    expect(escapeSendKeys("Hello, world 123")).toBe("Hello, world 123");
  });
});

describe.runIf(onWindows)("Windows computer adapter", () => {
  it("reports itself as available rather than unavailable", async () => {
    const runtime = new ComputerRuntime({
      artifactDirectory: await workspace(),
      adapter: createSystemComputerAdapter([]),
    });
    const observed = await runtime.execute(
      ComputerOperationSchema.parse({ kind: "computer", action: "capabilities" }),
    );
    expect(observed.platform).toBe("win32");
    expect(observed.adapter).toBe("windows-powershell");
    expect(observed.available).toBe(true);
    expect(observed.screenshot).toBe(true);
    expect(observed.pointer).toBe(true);
    // The honest ceiling of SendKeys-based input, stated rather than implied.
    expect((observed.limitations as string[]).join(" ")).toContain("focus");
  });

  it("captures a real screenshot to the artifact directory", async () => {
    const artifactDirectory = join(await workspace(), "artifacts");
    const runtime = new ComputerRuntime({
      artifactDirectory,
      adapter: createSystemComputerAdapter([]),
    });
    const observed = await runtime.execute(
      ComputerOperationSchema.parse({
        kind: "computer",
        action: "screenshot",
        timeoutMs: 90_000,
      }),
    );
    expect(observed.captured).toBe(true);
    expect(String(observed.path).startsWith(artifactDirectory)).toBe(true);
    const written = await stat(String(observed.path));
    expect(written.size).toBeGreaterThan(0);
    expect(observed.size).toBe(written.size);
    expect(String(observed.sha256)).toHaveLength(64);
  }, POWERSHELL_TEST_TIMEOUT_MS);

  it("resolves a normalized coordinate against the virtual desktop", async () => {
    const runtime = new ComputerRuntime({
      artifactDirectory: await workspace(),
      adapter: createSystemComputerAdapter([]),
    });
    // A pointer move is the P/Invoke path — the part most likely to be wrong —
    // and moving the cursor on a headless runner has no side effect worth
    // avoiding. Clicking would, so this does not click.
    const observed = await runtime.execute(
      ComputerOperationSchema.parse({
        kind: "computer",
        action: "move",
        x: 0.5,
        y: 0.5,
        coordinateSpace: "normalized",
        timeoutMs: 90_000,
      }),
    );
    expect(observed.success).toBe(true);
    // The pixel point comes back from the script rather than being recomputed
    // here, so a normalized centre must land somewhere other than the origin.
    expect(observed.x).toBeGreaterThan(0);
    expect(observed.y).toBeGreaterThan(0);
  }, POWERSHELL_TEST_TIMEOUT_MS);

  it("names a timeout as a timeout instead of echoing the script", async () => {
    const runtime = new ComputerRuntime({
      artifactDirectory: await workspace(),
      adapter: createSystemComputerAdapter([]),
    });
    /**
     * This is how the screenshot failure first presented: Node builds the
     * rejection message from the whole command line, so the caller received
     * fifteen lines of echoed PowerShell with an empty stderr and no way to
     * tell a killed helper from a script that failed instantly.
     *
     * 100ms is unreachable for a process that has to load the CLR, so this is a
     * timeout by construction rather than by timing luck.
     */
    await expect(
      runtime.execute(
        ComputerOperationSchema.parse({
          kind: "computer",
          action: "screenshot",
          timeoutMs: 100,
        }),
      ),
    ).rejects.toThrow(/^computer_helper_timeout:powershell\.exe:100ms$/);
  }, POWERSHELL_TEST_TIMEOUT_MS);
});
