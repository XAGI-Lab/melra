// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  createCertificate,
  evidenceStrength,
  redactArgv,
  redactSecrets,
  redactStructuredValue,
  sha256,
} from "./index.js";

describe("receipt and certificate primitives", () => {
  it("canonicalizes object keys before hashing", () => {
    expect(canonicalJson({ b: 2, a: { d: 4, c: 3 } })).toBe(
      '{"a":{"c":3,"d":4},"b":2}',
    );
    expect(sha256({ b: 2, a: 1 })).toBe(sha256({ a: 1, b: 2 }));
  });

  it("binds the certificate digest to every public field", () => {
    const certificate = createCertificate({
      taskId: "cff6c496-88b9-442b-b6ef-6f63f57364a3",
      goal: "Verify a deterministic outcome",
      result: "VERIFIED_SUCCESS",
      policyVersion: "1",
      receiptIds: ["3f5676d5-1c17-4670-8fa1-ddd55170d5a0"],
      evidence: [
        { type: "result_equals", passed: true, summary: "matched" },
      ],
      createdAt: "2026-07-28T00:00:00.000Z",
    });
    const { digest, ...unsigned } = certificate;
    expect(digest).toBe(sha256(unsigned));
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("redacts secret-shaped strings and sensitive fields recursively", () => {
    const redacted = redactStructuredValue({
      page: "password=hunter2",
      nested: { authorization: "Bearer should-never-persist" },
      values: ["ghp_123456789012345678901234"],
    }) as {
      value: {
        page: string;
        nested: { authorization: string };
        values: string[];
      };
      redactions: string[];
    };
    expect(redacted.value.page).not.toContain("hunter2");
    expect(redacted.value.nested.authorization).toBe(
      "[REDACTED_SENSITIVE_FIELD]",
    );
    expect(redacted.value.values[0]).not.toContain("ghp_");
    expect(redacted.redactions.length).toBeGreaterThanOrEqual(2);
  });

  it("ranks re-read state above the adapter's own report", () => {
    // The distinction the field exists for: a file the kernel went back and
    // looked at outranks the adapter saying the call returned.
    expect(evidenceStrength("file_hash")).toBe("state");
    expect(evidenceStrength("operation_completed")).toBe("execution");
  });

  it("reads an unknown evidence type as the weakest claim", () => {
    // A predicate added without a decision in the table, or a type from a
    // future version, must not inherit a strength it never earned.
    expect(evidenceStrength("predicate_from_a_later_version")).toBe("execution");
  });

  it("keeps ordinary terminal arguments and takes out only their credentials", () => {
    const R = "[REDACTED_SENSITIVE_ARG]";
    const argv = (args: string[]) => redactArgv(args).value;
    // What ran stays readable: nothing here is a credential.
    const plain = ["check", "--version", "src/index.ts", "-p", "22", "mkdir", "-pv", "sort", "-u", "file"];
    expect(argv(plain)).toEqual(plain);
    expect(redactArgv(plain).redactions).toEqual([]);

    expect(argv(["--token", "abc", "--verbose"])).toEqual(["--token", R, "--verbose"]);
    expect(argv(["--token=abc", "--api-key=xyz", "--db-password", "p"])).toEqual([
      `--token=${R}`,
      `--api-key=${R}`,
      "--db-password",
      R,
    ]);
    expect(argv(["-phunter2", "-u", "root"])).toEqual([`-p${R}`, "-u", "root"]);
    expect(argv(["-u", "admin:hunter2"])).toEqual(["-u", `admin:${R}`]);
    expect(argv(["GITHUB_TOKEN=abc", "MY_API_KEY=x", "PATH=/bin"])).toEqual([
      `GITHUB_TOKEN=${R}`,
      `MY_API_KEY=${R}`,
      "PATH=/bin",
    ]);
    expect(argv(["-H", "Authorization: Bearer abc", "-H", "Accept: text/plain"])).toEqual([
      "-H",
      `Authorization: ${R}`,
      "-H",
      "Accept: text/plain",
    ]);
    expect(argv(["postgres://app:s3cret@db:5432/app", "https://example.com/a"])).toEqual([
      `postgres://${R}@db:5432/app`,
      "https://example.com/a",
    ]);
    // A secret with a known shape goes wherever it sits.
    expect(argv(["echo", "ghp_123456789012345678901234"])[1]).not.toContain("ghp_");
  });

  it("takes credentials out of the argument forms tools actually use", () => {
    const R = "[REDACTED_SENSITIVE_ARG]";
    const argv = (args: string[], command?: string) => redactArgv(args, command).value;
    expect(argv(["-ualice:hunter2", "--proxy-user", "bob:pw", "-U", "carol:pw2"], "curl")).toEqual([
      `-ualice:${R}`,
      "--proxy-user",
      `bob:${R}`,
      "-U",
      `carol:${R}`,
    ]);
    expect(argv(["--secret-key", "abc", "--s3-secret-access-key=x", "--passphrase", "xyz"])).toEqual([
      "--secret-key",
      R,
      `--s3-secret-access-key=${R}`,
      "--passphrase",
      R,
    ]);
    // Built here, not written out: a literal Basic header in the source reads
    // as a leaked credential to secret scanners.
    const basic = Buffer.from("user:pass").toString("base64");
    expect(argv([`--header=Authorization: Basic ${basic}`], "wget")[0]).not.toContain(basic);
    expect(argv(["redis://:hunter2@cache:6379/0"], "redis-cli")[0]).not.toContain("hunter2");
    // `-p...` is a password only after a mysql-family program.
    const find = [".", "-name", "*.log", "-print", "-path", "./x", "-prune", "-perm", "644"];
    expect(argv(find, "find")).toEqual(find);
    expect(argv(["-pthread", "-pedantic", "main.c"], "gcc")).toEqual(["-pthread", "-pedantic", "main.c"]);
    expect(argv(["-u", "root", "-phunter2"], "mysql")).toEqual(["-u", "root", `-p${R}`]);
    expect(argv(["mysql", "-phunter2"], "env")).toEqual(["mysql", `-p${R}`]);
  });

  it("takes credentials out of URLs, prompt answers, and assignments in text", () => {
    const stored = redactStructuredValue({
      operation: { kind: "http", url: "https://deploy:S3cretPass@api.example.com/status" },
    }).value as { operation: { url: string } };
    expect(stored.operation.url).toBe("https://api.example.com/status");
    // The stdin answer to `Password:`.
    expect(JSON.stringify(redactStructuredValue({ operation: { action: "send", input: "hunter2" } }).value)).not.toContain(
      "hunter2",
    );
    // A request's args are redacted with their own program in mind.
    const find = redactStructuredValue({ command: "find", args: [".", "-print"] }).value as { args: string[] };
    expect(find.args).toEqual([".", "-print"]);
    for (const text of [
      "export DB_PASSWORD=hunter2",
      "MYSQL_ROOT_PASSWORD: hunter2",
      '{"password": "hunter2"}',
      "AWS_SECRET_ACCESS_KEY=hunter2",
      "DATABASE_URL=postgres://app:hunter2@db/app",
    ]) {
      expect(redactSecrets(text).value, text).not.toContain("hunter2");
    }
    expect(redactSecrets("the secret ingredient is love").value).toBe("the secret ingredient is love");
  });

  it("redacts args in a stored request instead of blanking them", () => {
    const redacted = redactStructuredValue({
      operation: { command: "pnpm", args: ["check", "--token=abc"] },
      nested: { args: { not: "a list" } },
    }).value as { operation: { args: string[] }; nested: { args: Record<string, string> } };
    expect(redacted.operation.args).toEqual(["check", "--token=[REDACTED_SENSITIVE_ARG]"]);
    expect(redacted.nested.args.not).toBe("[REDACTED_SENSITIVE_FIELD]");
  });
});
