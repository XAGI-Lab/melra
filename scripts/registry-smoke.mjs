// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

// Exercises the published artifact the way an end user gets it: a `melra` that
// came from the registry, on a machine that never built this repo. Everything
// here beyond the script itself is installed, not compiled, so a failure means
// the published tarball is wrong rather than that the source tree is.

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const expectedVersion = process.env.MELRA_EXPECTED_VERSION;
// npm writes a `.cmd` shim on Windows, and a stdio transport spawns without a
// shell, so the bare name resolves to nothing there.
const command =
  process.env.MELRA_COMMAND ??
  (process.platform === "win32" ? "melra.cmd" : "melra");
const root = await mkdtemp(join(tmpdir(), "melra-registry-smoke-"));
const workspace = join(root, "workspace");
const data = join(root, "data");
await mkdir(workspace);
await mkdir(data);

const environment = Object.fromEntries(
  Object.entries(process.env).filter((entry) => entry[1] !== undefined),
);
const transport = new StdioClientTransport({
  command,
  args: ["serve"],
  env: { ...environment, MELRA_WORKSPACE: workspace, MELRA_HOME: data },
  stderr: "pipe",
});
const client = new Client({ name: "melra-registry-smoke", version: "1.0.0" });

function parse(result) {
  const text = result.content.find((item) => item.type === "text")?.text;
  if (text === undefined) throw new Error("registry_smoke_missing_text");
  return JSON.parse(text);
}

const EXPECTED_TOOLS = [
  "melra_capabilities",
  "melra_execute",
  "melra_plan",
  "melra_receipt",
  "melra_task_cancel",
  "melra_task_status",
  "melra_workflow_advance",
  "melra_workflow_cancel",
  "melra_workflow_control",
  "melra_workflow_plan",
  "melra_workflow_status",
];

try {
  await client.connect(transport);
  const tools = (await client.listTools()).tools.map((tool) => tool.name).sort();
  if (JSON.stringify(tools) !== JSON.stringify(EXPECTED_TOOLS)) {
    throw new Error(`registry_smoke_tool_mismatch:${JSON.stringify(tools)}`);
  }
  const capabilities = parse(
    await client.callTool({ name: "melra_capabilities", arguments: {} }),
  );
  // The tag a release moves can point anywhere. Asserting the version proves
  // this run exercised the build that was just published, not a cached older one.
  if (
    expectedVersion !== undefined &&
    capabilities.version !== expectedVersion
  ) {
    throw new Error(
      `registry_smoke_version_mismatch:${capabilities.version}!=${expectedVersion}`,
    );
  }
  const planned = parse(
    await client.callTool({
      name: "melra_plan",
      arguments: {
        goal: "Verify the published MELRA artifact over stdio",
        operation: { kind: "system", action: "info" },
      },
    }),
  );
  const executed = parse(
    await client.callTool({
      name: "melra_execute",
      arguments: { taskId: planned.id },
    }),
  );
  const evidence = parse(
    await client.callTool({
      name: "melra_receipt",
      arguments: { taskId: planned.id },
    }),
  );
  if (
    executed.task.status !== "verified_success" ||
    evidence.certificate.result !== "VERIFIED_SUCCESS" ||
    !/^[a-f0-9]{64}$/.test(evidence.certificate.digest)
  ) {
    throw new Error("registry_smoke_verification_failed");
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        platform: `${process.platform}-${process.arch}`,
        version: capabilities.version,
        tools: tools.length,
        taskStatus: executed.task.status,
        certificate: evidence.certificate.result,
        digest: evidence.certificate.digest,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await client.close();
  await rm(root, { recursive: true, force: true });
}
