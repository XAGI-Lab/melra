// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { CredentialsSchema } from "@melra/protocol";
import { CredentialBroker } from "./credentials.js";

const roots: string[] = [];

afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

async function secretFile(mode: number): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "melra-credentials-"));
  roots.push(root);
  const path = join(root, "stripe.key");
  await writeFile(path, "sk_live_from_a_file\n");
  await chmod(path, mode);
  return path;
}

const stripe = {
  stripe: {
    source: { env: "MELRA_TEST_STRIPE_KEY" },
    inject: { header: "Authorization", scheme: "Bearer" },
    hosts: ["api.stripe.com"],
    capability: "http.post:https://api.stripe.com/v1/refunds*",
  },
};

const broker = (
  definitions: unknown = stripe,
  environment: NodeJS.ProcessEnv = { MELRA_TEST_STRIPE_KEY: "sk_live_secret" },
): CredentialBroker =>
  new CredentialBroker(CredentialsSchema.parse(definitions), environment);

describe("credential broker", () => {
  it("injects the secret for an operation the delegation covers", async () => {
    const { headers, used } = await broker().headersFor({
      host: "api.stripe.com",
      capability: "http.post",
      target: "https://api.stripe.com/v1/refunds",
    });
    expect(headers.authorization).toBe("Bearer sk_live_secret");
    // The names are what a caller may see. The values are what it may not.
    expect(used).toEqual(["stripe"]);
  });

  it("sends a request to another host unauthenticated rather than refusing it", async () => {
    const { headers, used } = await broker().headersFor({
      host: "api.example.com",
      capability: "http.post",
      target: "https://api.example.com/v1/refunds",
    });
    expect(headers).toEqual({});
    expect(used).toEqual([]);
  });

  it("refuses an operation outside the delegation without reading the secret", async () => {
    // The source points at a file that does not exist. A `credential_source_*`
    // or `ENOENT` here would mean the broker read first and checked second —
    // the refusal has to land before the plaintext is anywhere near the process.
    const refusing = broker({
      stripe: {
        ...stripe.stripe,
        source: { file: join(tmpdir(), "melra-nonexistent-credential") },
      },
    });
    await expect(
      refusing.headersFor({
        host: "api.stripe.com",
        capability: "http.delete",
        target: "https://api.stripe.com/v1/customers/cus_1",
      }),
    ).rejects.toThrow("credential_capability_not_covered:stripe");
  });

  it("reads a mode-0600 file and refuses a permissive one", async () => {
    const path = await secretFile(0o600);
    const request = {
      host: "api.stripe.com",
      capability: "http.post",
      target: "https://api.stripe.com/v1/refunds",
    };
    const definitions = {
      stripe: { ...stripe.stripe, source: { file: path } },
    };
    const { headers } = await broker(definitions).headersFor(request);
    expect(headers.authorization).toBe("Bearer sk_live_from_a_file");

    await chmod(path, 0o644);
    const permissive = broker(definitions).headersFor(request);
    if (process.platform === "win32") {
      // Windows does not carry the mode bits this checks, so the guard cannot
      // fire there. Asserting it would only test the platform.
      await expect(permissive).resolves.toBeDefined();
    } else {
      await expect(permissive).rejects.toThrow(
        "credential_file_permissions_too_open",
      );
    }
  });

  it("fails loudly when the source names nothing", async () => {
    await expect(
      broker(stripe, {}).headersFor({
        host: "api.stripe.com",
        capability: "http.post",
        target: "https://api.stripe.com/v1/refunds",
      }),
    ).rejects.toThrow("credential_source_missing:stripe");
  });

  it("rejects an unknown field in a definition", () => {
    expect(() =>
      CredentialsSchema.parse({
        stripe: { ...stripe.stripe, allowRedirects: true },
      }),
    ).toThrow();
  });
});
