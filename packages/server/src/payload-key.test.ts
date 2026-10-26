// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

import {
  chmod,
  mkdir,
  mkdtemp,
  open,
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

  it("reads the key file as bytes, and clears them once decoded", async () => {
    const root = await temporaryRoot();
    const expected = Buffer.alloc(32, 23);
    await writeFile(join(root, "payload.key"), expected.toString("base64url"), { mode: 0o600 });
    // FileHandle's own prototype: what `readFile` handed back is kept to look
    // at once the key is loaded. A string there stays in V8's heap.
    const probe = await open(join(root, "payload.key"));
    const prototype = Object.getPrototypeOf(probe) as { readFile: (...args: unknown[]) => Promise<unknown> };
    await probe.close();
    const read: unknown[] = [];
    const original = prototype.readFile;
    prototype.readFile = async function (this: unknown, ...args: unknown[]) {
      const value = await original.apply(this, args);
      read.push(value);
      return value;
    };
    try {
      expect(await loadPayloadKey({ dataDirectory: root, environment: {}, sealed: true })).toEqual(expected);
    } finally {
      prototype.readFile = original;
    }
    expect(read).toHaveLength(1);
    expect(Buffer.isBuffer(read[0])).toBe(true);
    expect([...(read[0] as Buffer)].every((byte) => byte === 0)).toBe(true);
  });

  it("takes exactly the canonical base64url of 32 bytes from the key file", async () => {
    const root = await temporaryRoot();
    const path = join(root, "payload.key");
    const load = async (text: string) => {
      await rm(path, { force: true });
      await writeFile(path, text, { mode: 0o600 });
      return loadPayloadKey({ dataDirectory: root, environment: {}, sealed: true });
    };
    // Every byte value in every position, through all 64 characters.
    for (let fill = 0; fill < 256; fill += 1) {
      const key = Buffer.from(Array.from({ length: 32 }, (_, at) => (fill + at * 37) % 256));
      expect(await load(key.toString("base64url"))).toEqual(key);
    }
    const spelled = Buffer.alloc(32, 0xff).toString("base64url");
    for (const text of [
      `${spelled}\n`,
      spelled.slice(0, -1),
      `${spelled.slice(0, -1)}=`,
      `${spelled.slice(0, -1)}/`,
      // The last character's two spare bits set: decodes alike, spelled otherwise.
      `${spelled.slice(0, -1)}${String.fromCharCode(spelled.charCodeAt(42) + 1)}`,
      Buffer.alloc(31).toString("base64url"),
    ]) {
      await expect(load(text), JSON.stringify(text)).rejects.toThrow("payload_key_file_invalid");
    }
  });

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
