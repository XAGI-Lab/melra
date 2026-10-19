// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const image = process.env.MELRA_IMAGE ?? "melra:local";
const platform = process.env.MELRA_PLATFORM;
const root = await mkdtemp(join(tmpdir(), "melra-docker-smoke-"));
const workspace = join(root, "workspace");
const data = join(root, "data");
await mkdir(workspace);
await mkdir(data);
const userArgs =
  process.getuid === undefined || process.getgid === undefined
    ? []
    : ["--user", `${process.getuid()}:${process.getgid()}`];

const childEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(
    (entry) => entry[1] !== undefined,
  ),
);
// The hardened recipe from docs/INSTALLATION.md#docker.
const hardened = [
  "run",
  "--rm",
  ...(platform === undefined ? [] : ["--platform", platform]),
  ...userArgs,
  "-i",
  "--init",
  "--read-only",
  "--security-opt",
  "no-new-privileges:true",
  "--cap-drop",
  "ALL",
  "--tmpfs",
  "/tmp:size=256m,mode=1777",
  "-v",
  `${workspace}:/workspace`,
  "-v",
  `${data}:/data`,
  image,
];
const transport = new StdioClientTransport({
  command: "docker",
  args: [...hardened, "serve"],
  env: childEnvironment,
  stderr: "pipe",
});
const client = new Client({ name: "melra-container-smoke", version: "1.0.0" });

function parse(result) {
  const text = result.content.find((item) => item.type === "text")?.text;
  if (text === undefined) throw new Error("container_smoke_missing_text");
  return JSON.parse(text);
}

try {
  await client.connect(transport);
  const listed = await client.listTools();
  const tools = listed.tools.map((tool) => tool.name).sort();
  const expected = [
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
  if (JSON.stringify(tools) !== JSON.stringify(expected)) {
    throw new Error(`container_smoke_tool_mismatch:${JSON.stringify(tools)}`);
  }
  const planned = parse(
    await client.callTool({
      name: "melra_plan",
      arguments: {
        goal: "Verify the containerized MCP transport",
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
    throw new Error("container_smoke_verification_failed");
  }
  // The recipe's restrictions must be what doctor sees from inside, so an
  // operator reading `isolation` there can trust it (#52).
  const doctor = spawnSync("docker", [...hardened, "doctor"], { encoding: "utf8" });
  const isolation = JSON.parse(doctor.stdout).checks.find((check) => check.name === "isolation");
  for (const expected of ["container", "no capabilities", "no_new_privs", "seccomp filter", "read-only root"]) {
    if (isolation?.status !== "pass" || !isolation.detail.includes(expected)) {
      throw new Error(`container_smoke_isolation_missing:${expected}:${JSON.stringify(isolation)}`);
    }
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        image,
        tools,
        isolation: isolation.detail,
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
