// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadPayloadKey } from "./payload-key.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "melra-payload-key-"));
  roots.push(root);
  return root;
}

describe("loadPayloadKey", () => {
  it("creates one private key and loads the same bytes on restart", async () => {
    const root = await temporaryRoot();
    const first = await loadPayloadKey({
      dataDirectory: root,
      environment: {},
    });
    const second = await loadPayloadKey({
      dataDirectory: root,
      environment: {},
    });

    expect(first).toEqual(second);
    expect(first).toHaveLength(32);
    if (process.platform !== "win32") {
      expect((await stat(join(root, "payload.key"))).mode & 0o077).toBe(0);
    }
  });

  it("gives two processes starting at once the same key", async () => {
    const root = await temporaryRoot();
    // The second used to find the key file created but still empty, and refuse.
    const [first, second] = await Promise.all([
      loadPayloadKey({ dataDirectory: root, environment: {} }),
      loadPayloadKey({ dataDirectory: root, environment: {} }),
    ]);
    expect(first).toEqual(second);
  });

  it("accepts an exact base64url environment key", async () => {
    const root = await temporaryRoot();
    const expected = Buffer.alloc(32, 13);

    const loaded = await loadPayloadKey({
      dataDirectory: root,
      environment: {
        MELRA_PAYLOAD_KEY: expected.toString("base64url"),
      },
    });

    expect(loaded).toEqual(expected);
  });

  it("rejects invalid environment key material", async () => {
    const root = await temporaryRoot();

    await expect(
      loadPayloadKey({
        dataDirectory: root,
        environment: {
          MELRA_PAYLOAD_KEY: Buffer.alloc(31).toString("base64url"),
        },
      }),
    ).rejects.toThrow("payload_key_environment_invalid");
  });

  it.skipIf(process.platform === "win32")(
    "rejects a symlinked local key path",
    async () => {
      const root = await temporaryRoot();
      const target = join(root, "target.key");
      await writeFile(target, Buffer.alloc(32, 17).toString("base64url"), {
        mode: 0o600,
      });
      await symlink(target, join(root, "payload.key"));

      await expect(
        loadPayloadKey({
          dataDirectory: root,
          environment: {},
        }),
      ).rejects.toThrow("payload_key_path_must_not_be_symlink");
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects a group-readable local key",
    async () => {
      const root = await temporaryRoot();
      const path = join(root, "payload.key");
      await writeFile(path, Buffer.alloc(32, 19).toString("base64url"), {
        mode: 0o600,
      });
      await chmod(path, 0o640);

      await expect(
        loadPayloadKey({
          dataDirectory: root,
          environment: {},
        }),
      ).rejects.toThrow("payload_key_permissions_too_open");
    },
  );

  it("rejects a non-file local key path", async () => {
    const root = await temporaryRoot();
    await mkdir(join(root, "payload.key"));

    await expect(
      loadPayloadKey({
        dataDirectory: root,
        environment: {},
      }),
    ).rejects.toThrow("payload_key_path_not_regular_file");
  });
});
