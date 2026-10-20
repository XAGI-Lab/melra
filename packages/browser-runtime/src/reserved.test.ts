// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { BrowserOperationSchema } from "@melra/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { BrowserRuntime, detectBrowserExecutable } from "./index.js";

const roots: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** A workspace holding MELRA's data directory, as `serve` started from home has. */
async function layout() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "melra-browser-reserved-")));
  roots.push(root);
  const data = join(root, ".melra");
  await mkdir(data);
  await writeFile(join(data, "payload.key"), "key");
  await writeFile(join(root, "notes.txt"), "notes");
  const reserved = async (path: string) => path === data || path.startsWith(`${data}${sep}`);
  return { root, data, reserved };
}

describe("MELRA's own data", () => {
  it("is never uploaded", async () => {
    const executablePath = await detectBrowserExecutable();
    if (executablePath === undefined) return;
    const { root, reserved } = await layout();
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "text/html");
      response.end(`<input type="file" id="f" multiple>`);
    });
    servers.push(server);
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("fixture_server_address_unavailable");
    const runtime = new BrowserRuntime({
      workspaceRoot: root,
      artifactDirectory: join(root, "artifacts"),
      executablePath,
      allowedDomains: ["127.0.0.1"],
      allowLocalhost: true,
      reserved,
    });
    const run = (operation: Record<string, unknown>) =>
      runtime.execute(BrowserOperationSchema.parse({ kind: "browser", ...operation }));
    try {
      await run({ action: "navigate", url: `http://127.0.0.1:${address.port}/` });
      // Present or absent, a reserved name gets the same answer.
      for (const reservedPath of [".melra/payload.key", ".melra/policy.json"]) {
        await expect(
          run({ action: "upload", target: { selector: "#f" }, filePaths: ["notes.txt", reservedPath] }),
          reservedPath,
        ).rejects.toThrow("browser_path_reserved");
      }
      await expect(run({ action: "upload", target: { selector: "#f" }, filePaths: ["notes.txt"] })).resolves.toMatchObject({
        uploaded: 1,
      });
    } finally {
      await runtime.close();
    }
  }, 120_000);

  it("is never loaded from a file: URL, even unhinged", async () => {
    const executablePath = await detectBrowserExecutable();
    if (executablePath === undefined) return;
    const { root, data, reserved } = await layout();
    const key = pathToFileURL(join(data, "payload.key")).href;
    // Not text, which the browser would show rather than download.
    await writeFile(join(root, "plain.bin"), "bytes");
    const plain = pathToFileURL(join(root, "plain.bin")).href;
    await writeFile(
      join(root, "page.html"),
      `<a id="get" download href="${key}">key</a><a id="plain" download href="${plain}">plain</a>`,
    );
    const artifacts = join(root, "artifacts");
    const runtime = new BrowserRuntime({
      workspaceRoot: root,
      artifactDirectory: artifacts,
      executablePath,
      allowedDomains: ["*"],
      allowLocalhost: true,
      unhinged: true,
      reserved,
    });
    const run = (operation: Record<string, unknown>) =>
      runtime.execute(BrowserOperationSchema.parse({ kind: "browser", ...operation }));
    try {
      await expect(run({ action: "navigate", url: key })).rejects.toThrow("browser_path_reserved");
      await expect(run({ action: "tab_new", url: key })).rejects.toThrow("browser_path_reserved");
      // A page may still be a file, and its link to an ordinary file downloads.
      await run({ action: "navigate", url: pathToFileURL(join(root, "page.html")).href });
      await expect(run({ action: "download", target: { selector: "#plain" }, timeoutMs: 10_000 })).resolves.toMatchObject({
        downloaded: true,
        size: 5,
      });
      expect(await readdir(artifacts)).toHaveLength(1);
      // Its link to the key gets nothing. The click went out, so the outcome is
      // unknown, and it names the refusal.
      await expect(run({ action: "download", target: { selector: "#get" }, timeoutMs: 3_000 })).rejects.toThrow(
        "effect_outcome_unknown:browser_path_reserved",
      );
      expect(await readdir(artifacts)).toHaveLength(1);
    } finally {
      await runtime.close();
    }
  }, 120_000);
});
