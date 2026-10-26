// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserOperationSchema } from "@melra/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { BrowserRuntime } from "./index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("upload file paths", () => {
  it("reads the root as configured the way the file runtime does, and keeps it confined", async () => {
    // Reached through a directory link above it, as macOS's /tmp is (a
    // junction on Windows), beside a real sibling whose name starts the same.
    const base = await mkdtemp(join(tmpdir(), "melra-upload-"));
    roots.push(base);
    const real = join(base, "real", "ws");
    await mkdir(join(base, "real", "ws-evil"), { recursive: true });
    await mkdir(real);
    await writeFile(join(real, "report.pdf"), "report");
    await writeFile(join(base, "real", "ws-evil", "report.pdf"), "secret");
    const link = process.platform === "win32" ? "junction" : "dir";
    await symlink(join(base, "real"), join(base, "alias"), link);
    await symlink(join(base, "real", "ws-evil"), join(real, "escape"), link);
    const configured = join(base, "alias", "ws");
    const runtime = new BrowserRuntime({
      workspaceRoot: configured,
      artifactDirectory: join(base, "artifacts"),
      allowedDomains: [],
      allowLocalhost: false,
    }) as unknown as { uploadPaths(paths: string[]): Promise<string[]> };
    const file = await realpath(join(real, "report.pdf"));

    expect(await runtime.uploadPaths(["report.pdf", join(configured, "report.pdf"), file])).toEqual([
      file,
      file,
      file,
    ]);
    for (const path of [
      join(`${configured}-evil`, "report.pdf"),
      join(configured, "escape", "report.pdf"),
      join(configured, "..", "ws-evil", "report.pdf"),
    ]) {
      await expect(runtime.uploadPaths([path])).rejects.toThrow("browser_upload_outside_workspace");
    }
  });

  it("refuses a reserved file before starting a browser", async () => {
    const base = await mkdtemp(join(tmpdir(), "melra-upload-"));
    roots.push(base);
    const runtime = new BrowserRuntime({
      workspaceRoot: base,
      artifactDirectory: join(base, "artifacts"),
      // Nothing is there, so starting one would fail with a launch error.
      executablePath: join(base, "no-browser"),
      allowedDomains: [],
      allowLocalhost: false,
      reserved: async (path) => path.endsWith("payload.key"),
    });
    try {
      await expect(
        runtime.execute(
          BrowserOperationSchema.parse({ kind: "browser", action: "upload", target: { selector: "#f" }, filePaths: ["payload.key"] }),
        ),
      ).rejects.toThrow("browser_path_reserved");
    } finally {
      await runtime.close();
    }
  });
});
