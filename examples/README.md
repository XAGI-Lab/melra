# Runnable examples

Each directory contains a complete task request accepted by:

```bash
pnpm melra run --request examples/<example>/task.json
```

Read-only examples execute immediately. Mutation examples request an exact
task-scoped approval phrase. Run them only in a disposable or reviewed
workspace.

Browsing works with the default policy, which allows any public destination and
blocks private, link-local, loopback, and cloud-metadata addresses at the runtime
regardless. The browser example ships a narrower policy that allows only
`example.com`, as a template for restricting a real install:

```bash
MELRA_POLICY=examples/04-browser-inspection/policy.json \
  pnpm melra run --request examples/04-browser-inspection/task.json
```

The API example ships a policy showing how a credential is configured. Without
`GITHUB_TOKEN` set the request goes out unauthenticated and still succeeds — the
point of the file is the shape:

```bash
MELRA_POLICY=examples/08-governed-api-call/policy.json \
  pnpm melra run --request examples/08-governed-api-call/task.json
```

The agent never receives the token. If `GITHUB_TOKEN` is exported, the kernel
reads it at send time and puts it on the wire; the result names `github` under
`credentials` and carries no value anywhere. A request to any other host is sent
without it. See [docs/INSTALLATION.md](../docs/INSTALLATION.md#credentials).

| Example | Capability | Expected result |
|---|---|---|
| `01-system-info` | system | runtime information |
| `02-verified-file-write` | file | file exists and content is verified |
| `03-terminal-check` | terminal | exit code and stdout are verified |
| `04-browser-inspection` | browser | allowlisted page URL and text are verified |
| `05-scoped-memory` | memory | a redacted, scoped record is stored |
| `06-computer-capabilities` | computer | detected adapter and limitations are reported |
| `07-project-decision-memory` | memory | a project procedure is stored with provenance |
| `08-governed-api-call` | http | a 200 from an allowlisted API, verified against the status |
