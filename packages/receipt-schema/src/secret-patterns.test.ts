// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { SECRET_PATTERNS, redactSecrets, redactStructuredValue } from "./index.js";

type Patterns = ReadonlyArray<readonly [RegExp, string]>;

// SECRET_PATTERNS as they stood before the password-name, token-name and
// URL-userinfo patterns were made to start at their keyword (#353). That change
// was for speed only, so the list must still redact exactly as this one does.
// A later change that means to redact differently replaces this copy.
// Replaced once since, on purpose, when the value parts of the password and
// token patterns changed so that a credential name bound with `=>`, `:=` or
// `::=`, compared with `==`, declared with a type, or given a quoted value with
// spaces or a YAML block scalar of one or more lines loses its whole value.
// Those value parts are copied below; the name parts are still the ones from
// before #353.
const BEFORE: Patterns = [
  [
    /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/g,
    "[REDACTED_PRIVATE_KEY]",
  ],
  [/-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----[\s\S]*/g, "[REDACTED_PRIVATE_KEY]"],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "[REDACTED_AWS_KEY_ID]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[REDACTED_JWT]"],
  [/\b(?:xox[abposre]|xapp)-[A-Za-z0-9-]{10,}\b/g, "[REDACTED_SLACK_TOKEN]"],
  [/\b(?:gh[opurs]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{22,})\b/g, "[REDACTED_GITHUB_TOKEN]"],
  [/\b(?:sk|pk|rk|api|whsec)[-_][a-z0-9_-]{16,}\b/gi, "[REDACTED_API_KEY]"],
  [/\b(?:npm_[A-Za-z0-9]{36,}\b|AIza[A-Za-z0-9_-]{35})/g, "[REDACTED_API_KEY]"],
  [/\bBearer\s+[A-Za-z0-9._~+/-]+=*\b/gi, "Bearer [REDACTED_TOKEN]"],
  [
    /\b((?:proxy-)?authorization["']?\s*:\s*["']?)(?:(?:digest|aws4-hmac-sha256)[ \t]+(?=[^\r\n=]{0,64}=)[^\r\n]+|(?:basic|bearer|negotiate|ntlm|token)[ \t]+(?=[A-Za-z0-9._~+/=-]{0,63}[\d=]|[A-Za-z0-9._~+/=-]{16})[A-Za-z0-9._~+/=-]{8,}|(?![A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+(?![\w.~+/=-]))(?=[A-Za-z0-9._~+/=-]{0,63}\d)[A-Za-z0-9._~+/=-]{16,})/gi,
    "$1[REDACTED_TOKEN]",
  ],
  [
    /(?<![A-Za-z0-9_])(?=(?:[A-Za-z0-9]*_)*(?:password|passwd|passphrase|secret)(?![A-Za-z0-9]))([A-Za-z0-9_]+)(["']?)\s*(?::[ \t]*[A-Za-z_][\w.\[\]<>|]{0,63}[ \t]*=(?![=>])|=>|:{1,3}=|={1,3}|:)\s*(?:(["'])(?:\\.|(?!\3)[^\\\r\n]){1,256}(?=\3)|[|>][-+1-9]{0,2}[ \t]*\r?\n([ \t]+)\S[^\r\n]*(?:(?:\r?\n[ \t]*)*\r?\n\4[^\r\n]*)*|["']?(?!(?:[:=]{1,3}|[|>][-+1-9]{0,2})(?:\s|$|["']))[^\s"',;}]+)/gi,
    "$1$2=[REDACTED]",
  ],
  [
    /(?<![A-Za-z0-9_-])((?:[A-Za-z0-9]*[_-])*[A-Za-z0-9]*(?:token|api[_-]?key|access[_-]?key))(["']?\s*(?:=>|:{1,3}=|={1,3}|:)\s*(?:[|>][-+1-9]{0,2}[ \t]*\r?\n([ \t]+))?(["']?))(?=[A-Za-z0-9._~+/=%-]{0,63}\d)[A-Za-z0-9._~+/=%-]{8,}(?:(?:(?!\4)(?:\\.|[^\\\r\n])){0,256}(?=\4))?(?:(?:\r?\n[ \t]*)*\r?\n\3(?<=[ \t])[^\r\n]*)*/gi,
    "$1$2[REDACTED]",
  ],
  [
    /(?<![a-z0-9+.-])([a-z0-9+.-]+:\/\/)(?:[^\s/?#@:"'<>{}\[\],]*|\$?\{\{?\s*[\w.]+\s*\}\}?):(?!\d+(?:[/?]|$))(?!\{\{?\s*[\w.]+\s*\}\}?@)(?:(?!\$\{|:\/\/)[^\s@"'])+@/gi,
    "$1[REDACTED_URL_CREDENTIALS]@",
  ],
  [/\b(https?:\/\/)(?=[A-Za-z0-9._~%+-]*\d)[A-Za-z0-9._~%+-]{20,}@/gi, "$1[REDACTED_URL_CREDENTIALS]@"],
];

// The live list swapped for `patterns` while `run` runs, so every path that
// reads it, redactArgv and the URL field included, sees the same list.
function withPatterns<T>(patterns: Patterns, run: () => T): T {
  const live = SECRET_PATTERNS as Array<readonly [RegExp, string]>;
  const current = live.splice(0, live.length, ...patterns);
  try {
    return run();
  } finally {
    live.splice(0, live.length, ...current);
  }
}

// Each input through both functions, before and after; the inputs whose
// results differ in any byte, redaction kinds included.
function differences(inputs: readonly string[]): string[] {
  const results = () =>
    inputs.map((text) =>
      JSON.stringify([
        redactSecrets(text),
        redactStructuredValue({ message: text, lines: [text], url: text, command: "curl", args: text.split(" ") }),
      ]),
    );
  const before = withPatterns(BEFORE, results);
  const after = results();
  return inputs.filter((_, index) => before[index] !== after[index]);
}

// Synthetic, and assembled at run time so no literal here reads as a leaked
// credential to a secret scanner.
const fill = (n: number) => "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0".repeat(3).slice(0, n);

// Credential names in the syntaxes they are written in, and names that only
// look like one, each with a few kinds of value.
const names = [
  "password", "PASSWORD", "Password", "db_password", "DB_PASSWORD_FILE", "passwd", "passphrase",
  "secret", "client_secret", "SECRET_KEY", "secret__password", "password_secret_x", "_secret",
  "a-password", "password_hash", "pass_word", "secretive", "xpassword", "password1", "my_secret_token",
  "token", "access_token", "refresh-token", "x-auth-token", "apiKey", "api_key", "API-KEY",
  "accesskey", "aws_access_key", "token_type", "max_tokens", "tokens", "mytoken", "a.token",
];
const syntaxes = [
  (n: string, v: string) => `${n}=${v}`,
  (n: string, v: string) => `export ${n}="${v}"`,
  (n: string, v: string) => `${n}: ${v}`,
  (n: string, v: string) => `  ${n}: '${v}'`,
  (n: string, v: string) => `"${n}": "${v}"`,
  (n: string, v: string) => `{"${n}":"${v}","next":1}`,
  (n: string, v: string) => `--${n}=${v}`,
  (n: string, v: string) => `--${n} ${v}`,
  (n: string, v: string) => `${n} = "${v}"`,
  (n: string, v: string) => `X-${n}: ${v}\r\n`,
  (n: string, v: string) => `GET /cb?${n}=${v}&next=1`,
  (n: string, v: string) => `Server=db;${n}=${v};`,
  (n: string, v: string) => `${n} := ${v}`,
  (n: string, v: string) => `'${n}' => '${v}',`,
  (n: string, v: string) => `${n}:${v}@host`,
  (n: string, v: string) => `${n}=${v}_${n}=${v}`,
  // Bound or compared with an operator of more than one character, declared
  // with a type, a quoted value with spaces or an escaped quote in it, and YAML
  // block scalars of one line, of two, and of two with a blank line between.
  (n: string, v: string) => `:${n} => ${v}`,
  (n: string, v: string) => `${n} := "${v}"`,
  (n: string, v: string) => `${n} ::= ${v}`,
  (n: string, v: string) => `if ${n} == "${v}" {`,
  (n: string, v: string) => `${n} === '${v}'`,
  (n: string, v: string) => `${n} = "${v} ${v}"`,
  (n: string, v: string) => `"${n}": "${v}\\" ${v}"`,
  (n: string, v: string) => `${n}: |\n  ${v}\n`,
  (n: string, v: string) => `  ${n}: >-\n    ${v}\nnext: 1`,
  (n: string, v: string) => `${n}: str = "${v}"`,
  (n: string, v: string) => `${n}: |\n  ${v}\n  ${v}\n`,
  (n: string, v: string) => `${n}: |\n  ${v}\n\n  ${v}\n`,
];
const values = [fill(16), "hunter2", "12345678", "abc", "${VAR}", `${fill(8)}/+=%2F`, "é" + fill(9)];

function corpus(): string[] {
  const basic = Buffer.from(`user:${fill(12)}`).toString("base64");
  const pem = (label: string) => `-----BEGIN ${label}-----\n${fill(40)}\n-----END ${label}-----`;
  // The other tests' fixtures.
  const fixtures = [
    "password=hunter2",
    "export DB_PASSWORD=hunter2",
    "MYSQL_ROOT_PASSWORD: hunter2",
    '{"password": "hunter2"}',
    "AWS_SECRET_ACCESS_KEY=hunter2",
    "DATABASE_URL=postgres://app:hunter2@db/app",
    "the secret ingredient is love",
    "https://deploy:S3cretPass@api.example.com/status",
    `${"github"}_pat_${fill(22)}_${fill(59)}`,
    `${"xoxe"}-1-${fill(30)}`,
    pem("PGP PRIVATE KEY BLOCK"),
    pem("PGP PUBLIC KEY BLOCK"),
    `Authorization: Basic ${basic}`,
    `authorization: token ${fill(32)}`,
    `Proxy-Authorization: Negotiate ${fill(32)}`,
    `Authorization: ${fill(32)}`,
    `x-api-key: ${fill(32)}`,
    `X-Auth-Token: ${fill(32)}`,
    `${"npm"}_${fill(36)}`,
    `//registry.npmjs.org/:_authToken=${fill(32)}`,
    `${"rk"}_live_${fill(24)}`,
    `${"AIza"}${fill(35)}`,
    `https://${fill(32)}@git.example.com/org/repo.git`,
    `https://user:ab/${fill(16)}@host.example.com/`,
    `${"postgresql"}://admin:Zx9{kL]q@db.internal:5432/app`,
    `${"amqp"}://guest:pa[ss]1@rabbit/`,
    `${"postgres"}://admin:Ab3<x>y@db/app`,
    `${"redis"}://:p}w{9@cache:6379`,
    `${"mysql"}://root:2024#Secure!@localhost`,
    `api_key=${fill(32)}`,
    `GET /callback?access_token=${fill(32)}&state=1`,
    `{"access_token":"${fill(32)}","token_type":"bearer"}`,
    `GITHUB_TOKEN: ${fill(32)}`,
    `postgres://app:${fill(257)}@db.cluster-abc.us-east-1.rds.amazonaws.com:5432/app`,
    `https://x-access-token:${fill(32)}@github.com/o/r`,
    '{"max_tokens": 4096, "input_tokens": 5}',
    "input_tokens=5 token_count=12",
    "the token expired; ask for a new token: see the docs",
    "token: string;",
    "const token = getToken();",
    "authorization: none provided (401)",
    "const { authorization: _authorization, ...rest } = x",
    "npm_config_registry=https://registry.npmjs.org/",
    "https://example.com/users?email=a@b.example",
    "https://example.com:8443/files/a@b.png",
    "http://localhost:3000?next=a@b",
    "ssh://git@github.com/org/repo.git",
    "git@github.com:org/repo.git",
    "origin\thttps://myorg@dev.azure.com/myorg/proj/_git/repo (fetch)",
    "pip install git+https://git@github.com/org/repo.git",
    "Acme,https://acme.com,sales@acme.com",
    '["https://a.com","ops@b.com"]',
    '{"website":"https://acme.com","logo":"https://cdn.acme.com/logo.png","email":"ops@acme.com"}',
    '{"url":"https://x.com","a":"b@c"}',
    '{"url":"https://x.com:","a":"b@c"}',
    "http://[::1]:4873/@melra%2fcli",
    "OPENAI_API_KEY: z.string().min(1),",
    "const token = tokens[0];",
    "token = sys.argv[1]",
    ":root { --color-token: #00ff00ab; }",
    "const headers = { authorization: process.env.API_TOKEN_V2 };",
    `f"postgresql://{user}:${fill(12)}@{host}/db"`,
    `postgresql://{{ db.user }}:${fill(12)}@{{ host }}/db`,
    "postgres://${POSTGRES_USER}:" + fill(12) + "@db/app",
    'f"postgresql://{user}:{password}@{host}/db"',
    "postgresql://{{ user }}:{{ password }}@{{ host }}/db",
    "postgres://admin:{password}@db/app",
    "postgres://${DB_USER}:${DB_PASS}@db/app",
    "http://localhost:${port}/@vite/client",
    "password_".repeat(300),
    "a1_".repeat(300),
  ];
  // Terminal output as tools print it.
  const terminal = [
    [
      "$ env | sort",
      `DATABASE_URL=postgres://app:${fill(20)}@db.internal:5432/app`,
      "HOME=/home/dev",
      `GITHUB_TOKEN=${"ghp"}_${fill(36)}`,
      `NPM_TOKEN=${fill(36)}`,
      "PATH=/usr/local/bin:/usr/bin:/bin",
      `POSTGRES_PASSWORD=${fill(16)}`,
      `SECRET_KEY_BASE=${fill(64)}`,
      "TERM=xterm-256color",
    ].join("\n"),
    [
      "$ docker compose config",
      "services:",
      "  db:",
      "    environment:",
      `      POSTGRES_PASSWORD: "${fill(12)}"`,
      "      POSTGRES_USER: app",
      "  api:",
      "    environment:",
      `      - API_KEY=${fill(32)}`,
      `      - REDIS_URL=redis://:${fill(12)}@cache:6379/0`,
      "      - LOG_LEVEL=debug",
    ].join("\n"),
    [
      "*   Trying 93.184.216.34:443...",
      "> GET /v1/me HTTP/2",
      "> Host: api.example.com",
      `> authorization: Bearer ${fill(40)}`,
      `> x-api-key: ${fill(32)}`,
      "> accept: */*",
      "< HTTP/2 200",
      "< content-type: application/json",
      `{"id":42,"access_token":"${fill(32)}","token_type":"bearer","expires_in":3600}`,
    ].join("\r\n"),
    [
      "$ git remote -v",
      `origin\thttps://${fill(32)}@github.com/org/repo.git (fetch)`,
      "upstream\tgit@github.com:org/repo.git (push)",
      "$ npm config list",
      `//registry.npmjs.org/:_authToken=${fill(36)}`,
      'registry = "https://registry.npmjs.org/"',
      "$ pnpm test",
      " ✓ src/index.test.ts (12 tests) 41ms",
      "   max_tokens: 4096, input_tokens: 5, token_count=12",
    ].join("\n"),
    [
      "Error: connect ECONNREFUSED 127.0.0.1:5432",
      `    at Client.connect (postgresql://admin:${fill(10)}@localhost:5432/app)`,
      "    at /app/node_modules/pg/lib/client.js:132:17",
      `2026-10-21T03:45:12.123Z INFO login user=alice password=${fill(9)} ip=10.0.0.7`,
      `2026-10-21T03:45:12.456Z WARN retry url=https://user:${fill(8)}@hooks.example.com/x attempt=2`,
      "2026-10-21T03:45:13.000Z INFO secret santa list updated; tokenizer warmed up",
      "warning: handler suite module is deprecated; see https://docs.example.com/file#max_tokens",
    ].join("\n"),
    [
      "$ kubectl get secret app -o yaml",
      "apiVersion: v1",
      "data:",
      `  password: ${Buffer.from(fill(12)).toString("base64")}`,
      `  api-token: ${fill(24)}`,
      "kind: Secret",
      "metadata:",
      "  name: app",
      "type: Opaque",
    ].join("\n"),
  ];
  const assignments = names.flatMap((n) => syntaxes.flatMap((write) => values.map((v) => write(n, v))));
  // Userinfo in URLs, bare and in the places they turn up.
  const urls = [
    "postgres://app:pw@db/app",
    "postgresql://u:p@h:5432/d",
    "redis://:pw@cache:6379",
    "mongodb+srv://user:pa%40ss@cluster0.example.net/db",
    "https://user:pass@example.com/path?x=1#y",
    "jdbc:mysql://root:pw@localhost:3306/db",
    "s3://bucket/key@v1",
    "git+ssh://git@github.com/o/r.git",
    "a://b://c:d@e",
    "x://u:1/2@h",
    "x://u:123?@h",
    "x://u:12@h",
    "HTTP://U:P@H",
    "://u:p@h",
    "-://u:p@h",
    ".a+b-c://u:p@h",
    "x://{u}:p@h",
    "x://${U}:p@h",
    "x://u:${P}@h",
    "x://u:p${x}@h",
    "x://u:{{ p }}@h",
    "x://[::1]:p@h",
    "x://u:p",
    "x://u:p@",
  ];
  const urlContexts = urls.flatMap((u) => [
    u,
    `"url": "${u}"`,
    `DATABASE_URL=${u}`,
    `(${u})`,
    `${u},next@x.com`,
    `<${u}>`,
    `${u} ${u}`,
    `é${u}`,
  ]);
  return [...fixtures, ...terminal, ...assignments, ...urlContexts];
}

// A seeded mix of keywords, separators, quotes, URL parts and unicode, a few
// characters or words at a time, so names and values meet at every boundary.
function generated(count: number, seed: number): string[] {
  const pieces = [
    ..."pPasSwWordDecrRtTkKenyiI_-:=\"' /@.+%{}$0129aA\n,;#?[]<>~\t",
    "password", "PASSWD", "passphrase", "Secret", "token", "TOKEN", "api_key", "api-key", "apiKey",
    "access_key", "accessKey", "access-key", "db", "my", "x-", "_", "__", "=", ": ", "\": \"", " = ",
    "hunter2", "abcd1234", fill(16), "12345678", "${X}", "{{ y }}", "https://", "postgres://", "://",
    "user:", ":pw@", "@host", "localhost:8080/", "Bearer ", "Authorization: ",
    "é", "ſ", "\u212A", "İ", "你好", "🙂", "\u00a0", "\u2028",
  ];
  // xorshift32: the same strings on every run.
  let state = seed;
  const random = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4_294_967_296;
  };
  return Array.from({ length: count }, () => {
    let text = "";
    const length = 1 + Math.floor(random() * 40);
    for (let i = 0; i < length; i++) text += pieces[Math.floor(random() * pieces.length)] ?? "";
    return text;
  });
}

describe("secret patterns that start at their keyword", () => {
  it("redact a corpus of fixtures, terminal output, assignments and URLs exactly as before", () => {
    const inputs = corpus();
    expect(differences(inputs)).toEqual([]);
    // The corpus reaches the rewritten patterns, and leaves some text alone.
    const kinds = inputs.flatMap((text) => redactSecrets(text).redactions);
    expect(kinds).toEqual(
      expect.arrayContaining(["$1$2=[REDACTED]", "$1$2[REDACTED]", "$1[REDACTED_URL_CREDENTIALS]@"]),
    );
    expect(inputs.some((text) => redactSecrets(text).value === text)).toBe(true);
    // Every input runs through both pattern lists; a loaded runner needs more than the 5 s default.
  }, 30_000);

  it("redact generated text exactly as before", () => {
    const inputs = generated(4_000, 353);
    expect(differences(inputs)).toEqual([]);
    expect(inputs.filter((text) => redactSecrets(text).value !== text).length).toBeGreaterThan(400);
   }, 30_000);
});

describe("secret patterns on a credential name's value", () => {
  it("never report a redaction and leave the value in place", () => {
    let reported = 0;
    for (const n of names) {
      for (const write of syntaxes) {
        for (const v of values) {
          const text = write(n, v);
          const { value, redactions } = redactSecrets(text);
          if (redactions.length === 0) continue;
          reported += 1;
          expect(value, text).not.toContain(v);
        }
      }
    }
    // Most of the corpus is a credential name with a value.
    expect(reported).toBeGreaterThan(3_000);
  });
});
