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

  it("labels a judgement about meaning as such, and nothing else borrows the label", () => {
    expect(evidenceStrength("semantic")).toBe("semantic");
    expect(evidenceStrength("custom:semantic")).toBe("execution");
  });

  it("keeps a verdict's shape through redaction, taking out only secret shapes", () => {
    const judgedBy = {
      verdict: "no",
      judge: "harness:C/agent:grader",
      channel: "in_band",
      judgedAt: "2026-10-22T00:00:00.000Z",
      rationale: "It pastes sk-live-0123456789abcdefghij into the summary.",
    };
    const executedBy = "harness:C/agent:ghp_0123456789abcdefghijABCDEFGHIJ012345";
    // No field name here is a credential's, so nothing is blanked whole.
    expect(
      redactStructuredValue({ type: "semantic", passed: false, summary: "semantic_judgement_no", judgedBy, executedBy })
        .value,
    ).toEqual({
      type: "semantic",
      passed: false,
      summary: "semantic_judgement_no",
      judgedBy: { ...judgedBy, rationale: "It pastes [REDACTED_API_KEY] into the summary." },
      executedBy: "harness:C/agent:[REDACTED_GITHUB_TOKEN]",
    });
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

  it("redacts the credential formats issuers hand out, and leaves ordinary text alone", () => {
    // Synthetic, and assembled at run time so no literal in this file reads as
    // a leaked credential to a secret scanner.
    const fill = (n: number) => "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0".repeat(3).slice(0, n);
    const basic = Buffer.from(`user:${fill(12)}`).toString("base64");
    const pem = (label: string) => `-----BEGIN ${label}-----\n${fill(40)}\n-----END ${label}-----`;
    const secrets: Array<[string, string]> = [
      // [text, the part that must not survive]
      [`${"github"}_pat_${fill(22)}_${fill(59)}`, fill(22)],
      [`${"xoxe"}-1-${fill(30)}`, fill(30)],
      [`${"xapp"}-1-A0123-${fill(30)}`, fill(30)],
      [pem("PGP PRIVATE KEY BLOCK"), fill(40)],
      [`Authorization: Basic ${basic}`, basic],
      [`authorization: token ${fill(32)}`, fill(32)],
      [`Proxy-Authorization: Negotiate ${fill(32)}`, fill(32)],
      [`Authorization: ${fill(32)}`, fill(32)],
      [`x-api-key: ${fill(32)}`, fill(32)],
      [`X-Auth-Token: ${fill(32)}`, fill(32)],
      [`${"npm"}_${fill(36)}`, fill(36)],
      [`//registry.npmjs.org/:_authToken=${fill(32)}`, fill(32)],
      [`${"rk"}_live_${fill(24)}`, fill(24)],
      [`${"whsec"}_${fill(32)}`, fill(32)],
      [`${"AIza"}${fill(35)}`, fill(35)],
      [`https://${fill(32)}@git.example.com/org/repo.git`, fill(32)],
      [`https://user:ab/${fill(16)}@host.example.com/`, fill(16)],
      // Generated passwords hold brackets, braces and `#`.
      [`${"postgresql"}://admin:Zx9{kL]q@db.internal:5432/app`, "Zx9{kL]q"],
      [`${"amqp"}://guest:pa[ss]1@rabbit/`, "pa[ss]1"],
      [`${"postgres"}://admin:Ab3<x>y@db/app`, "Ab3<x>y"],
      [`${"redis"}://:p}w{9@cache:6379`, "p}w{9"],
      [`${"mysql"}://root:2024#Secure!@localhost`, "2024#Secure!"],
      [`api_key=${fill(32)}`, fill(32)],
      [`GET /callback?access_token=${fill(32)}&state=1`, fill(32)],
      [`{"access_token":"${fill(32)}","token_type":"bearer"}`, fill(32)],
      [`GITHUB_TOKEN: ${fill(32)}`, fill(32)],
    ];
    for (const [text, secret] of secrets) {
      const once = redactSecrets(text).value;
      expect(once, text).not.toContain(secret);
      // Stored copies are redacted again on their way into a certificate.
      expect(redactSecrets(once).value, text).toBe(once);
    }
    // What is not a credential stays readable.
    for (const text of [
      '{"max_tokens": 4096, "input_tokens": 5}',
      "max_tokens: 4096",
      "input_tokens=5 token_count=12",
      "the token expired; ask for a new token: see the docs",
      "token: string;",
      "const token = getToken();",
      "authorization: string",
      "Authorization: required",
      "authorization: none provided (401)",
      "{ authorization: task.approval }",
      "const { authorization: _authorization, ...rest } = x",
      "Missing authorization: credentials expired",
      "authorization: undefined",
      pem("PGP PUBLIC KEY BLOCK"),
      "npm_config_registry=https://registry.npmjs.org/",
      "https://example.com/users?email=a@b.example",
      "https://example.com:8443/files/a@b.png",
      "http://localhost:3000?next=a@b",
      "ssh://git@github.com/org/repo.git",
      "git@github.com:org/repo.git",
      // A plain user name is not a credential, and a URL ends where a field,
      // a cell or an IPv6 bracket begins.
      "origin\thttps://myorg@dev.azure.com/myorg/proj/_git/repo (fetch)",
      "pip install git+https://git@github.com/org/repo.git",
      "Acme,https://acme.com,sales@acme.com",
      '["https://a.com","ops@b.com"]',
      '{"website":"https://acme.com","logo":"https://cdn.acme.com/logo.png","email":"ops@acme.com"}',
      '{"url":"https://x.com","a":"b@c"}',
      '{"url":"https://x.com:","a":"b@c"}',
      "http://[::1]:4873/@melra%2fcli",
    ]) {
      expect(redactSecrets(text).value, text).toBe(text);
    }
  });

  it("redacts a field whose name ends in a credential word", () => {
    const secret = "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6";
    const stored = redactStructuredValue({
      access_token: secret,
      refresh_token: secret,
      clientSecret: secret,
      private_key: secret,
      "x-api-key": secret,
      db_password: secret,
    }).value;
    expect(JSON.stringify(stored)).not.toContain(secret);
    // Counts, kinds, and names are not credentials.
    const plain = {
      max_tokens: 4096,
      input_tokens: 5,
      token_type: "bearer",
      credentials: ["billing"],
      idempotencyKey: "order-42",
    };
    expect(redactStructuredValue(plain).value).toEqual(plain);
  });

  it("redacts a URL password of any length, as an RDS IAM token is", () => {
    const fill = (n: number) => "A1b2C3d4E5f6G7h8I9j0".repeat(30).slice(0, n);
    const host = "db.cluster-abc.us-east-1.rds.amazonaws.com";
    const long = fill(257);
    expect(redactSecrets(`postgres://app:${long}@${host}:5432/app`).value).toBe(
      `postgres://[REDACTED_URL_CREDENTIALS]@${host}:5432/app`,
    );
    // A generated IAM auth token is the URL-encoded signed request, well over
    // 256 characters, and goes in as the password.
    const signature = "0123456789abcdef".repeat(4);
    const iam = [
      `${host}%3A5432%2F%3FAction%3Dconnect%26DBUser%3Diam_user`,
      `%26X-Amz-Algorithm%3DAWS4-HMAC-SHA256%26X-Amz-Credential%3D${"AKIA"}${"ABCDEFGHIJKLMNOP"}`,
      "%252F20261020%252Fus-east-1%252Frds-db%252Faws4_request%26X-Amz-Date%3D20261020T101010Z",
      `%26X-Amz-Expires%3D900%26X-Amz-SignedHeaders%3Dhost%26X-Amz-Signature%3D${signature}`,
    ].join("");
    expect(iam.length).toBeGreaterThan(256);
    expect(redactSecrets(`postgresql://iam_user:${iam}@${host}:5432/app`).value).toBe(
      `postgresql://[REDACTED_URL_CREDENTIALS]@${host}:5432/app`,
    );
  });

  it("leaves code that names a token alone, and the host after one", () => {
    for (const text of [
      "OPENAI_API_KEY: z.string().min(1),",
      "const token = tokens[0];",
      "const token = parts[1].trim();",
      "token = sys.argv[1]",
      ":root { --color-token: #00ff00ab; }",
    ]) {
      expect(redactSecrets(text).value, text).toBe(text);
    }
    const token = "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6";
    expect(redactSecrets(`https://x-access-token:${token}@github.com/o/r`).value).toBe(
      "https://[REDACTED_URL_CREDENTIALS]@github.com/o/r",
    );
  });

  it("takes linear time on text built to make a pattern backtrack", () => {
    for (const text of [
      "password_".repeat(2_300),
      // One name made of many credential words, each a place a match can start.
      "secret_".repeat(20_000),
      "a://".repeat(50_000),
      "a-".repeat(50_000),
      "a_".repeat(50_000),
      "a1_".repeat(33_000),
      "npm_".repeat(25_000),
      "authorization: digest ".repeat(5_000),
    ]) {
      const started = performance.now();
      redactSecrets(text);
      // Generous, so a loaded CI runner does not flake: these took seconds to
      // a minute when a name or a URL scheme could start at every character.
      expect(performance.now() - started, text.slice(0, 12)).toBeLessThan(250);
    }
  });

  it("reads an authorization value only when it has the shape of one", () => {
    for (const text of [
      "const headers = { authorization: process.env.API_TOKEN_V2 };",
      "fetch(url, { headers: { Authorization: cfg.auth.v2Token } })",
      "Use Authorization: Basic credentials for the legacy API.",
      "Authorization: OAuth2-based flows are documented below.",
      "Authorization: Digest authentication is required",
    ]) {
      expect(redactSecrets(text).value, text).toBe(text);
    }
    // A parameter-list scheme goes to the end of the line, so neither the
    // signature nor the digest response survives.
    const hex = "0123456789abcdef".repeat(4);
    expect(
      redactSecrets(
        `Authorization: AWS4-HMAC-SHA256 Credential=${"AKIA"}${"ABCDEFGHIJKLMNOP"}/20261020/us-east-1/s3/aws4_request, SignedHeaders=host;x-amz-date, Signature=${hex}\r\nHost: s3.amazonaws.com`,
      ).value,
    ).toBe("Authorization: [REDACTED_TOKEN]\r\nHost: s3.amazonaws.com");
    expect(
      redactSecrets(`Authorization: Digest username="u", realm="r", nonce="n", uri="/", response="${hex.slice(0, 32)}"`)
        .value,
    ).toBe("Authorization: [REDACTED_TOKEN]");
  });

  it("redacts a literal password after a template user, and keeps a template password", () => {
    const secret = `Hunter2${"Secret"}`;
    expect(redactSecrets(`f"postgresql://{user}:${secret}@{host}/db"`).value).toBe(
      'f"postgresql://[REDACTED_URL_CREDENTIALS]@{host}/db"',
    );
    expect(redactSecrets(`postgresql://{{ db.user }}:${secret}@{{ host }}/db`).value).not.toContain(secret);
    // A shell or JavaScript `${USER}` is a template user too.
    expect(redactSecrets("postgres://${POSTGRES_USER}:" + secret + "@db/app").value).toBe(
      "postgres://[REDACTED_URL_CREDENTIALS]@db/app",
    );
    for (const text of [
      'f"postgresql://{user}:{password}@{host}/db"',
      "postgresql://{{ user }}:{{ password }}@{{ host }}/db",
      "postgres://admin:{password}@db/app",
      "postgres://${DB_USER}:${DB_PASS}@db/app",
      "http://localhost:${port}/@vite/client",
    ]) {
      expect(redactSecrets(text).value, text).toBe(text);
    }
  });

  it("keeps a boolean or null under a credential name, which holds no secret", () => {
    const flags = { isSecret: false, hasPassword: true, requiresPassword: false, token: null, password: null };
    expect(redactStructuredValue(flags).value).toEqual(flags);
    // A number may be a PIN, and any string may be the credential: a
    // tokenizer's special tokens and a page token go too.
    expect(
      redactStructuredValue({ pin_password: 4321, eos_token: "</s>", pad_token: "<pad>", nextPageToken: "CiAKGjBp" })
        .value,
    ).toEqual({
      pin_password: "[REDACTED_SENSITIVE_FIELD]",
      eos_token: "[REDACTED_SENSITIVE_FIELD]",
      pad_token: "[REDACTED_SENSITIVE_FIELD]",
      nextPageToken: "[REDACTED_SENSITIVE_FIELD]",
    });
  });

  it("keeps an exit status, which carries no secret", () => {
    const stored = redactStructuredValue({
      requiredEvidence: [
        { type: "exit_code", value: 0 },
        { type: "result_equals", path: "pin", value: 4321 },
        { type: "exit_code", value: "0" },
      ],
    }).value as { requiredEvidence: Array<{ value: unknown }> };
    expect(stored.requiredEvidence.map(({ value }) => value)).toEqual([
      0,
      // Any other value may be the secret itself, number or not.
      "[REDACTED_SENSITIVE_FIELD]",
      "[REDACTED_SENSITIVE_FIELD]",
    ]);
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
