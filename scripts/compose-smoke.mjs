// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

// Runs the container pair in examples/deploy/compose/compose.yaml as written
// and checks it from the agent's side. Inside the agent's container, with the
// melra image as a stand-in agent, `melra probe` must find a workspace write,
// MELRA's database and key, a connection out and one to the host each
// refused, and MELRA answering on the socket. Both connections aim at a port
// the runner listens on, so nothing leaves it. Then the stand-in plans a
// file write through the socket with the SDK, an operator approves it from
// MELRA's container, and the stand-in runs it to verified_success with a
// receipt. Then a command the stand-in has MELRA run, approved the same way,
// runs as the image's node, edits the file MELRA wrote, makes a directory,
// and cannot enter MELRA's data. Last, MELRA writes into that directory.
// `--dry-run` prints the docker commands and runs none of them.
// Needs Docker with Compose and a built checkout (the stand-in loads the SDK
// from it); CI runs it on ubuntu-latest.

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SOCKET = "/run/melra/melra.sock";
const FILE = "compose-smoke.txt";
const DIRECTORY = "made-by-command";
// The command edits what MELRA wrote and makes a directory for MELRA to write
// in, then says who it runs as and what it gets entering MELRA_HOME. No `=`,
// which MELRA would judge as a path too.
const COMMAND =
  `require("fs").appendFileSync("${FILE}","edited by the command\\n");require("fs").mkdirSync("${DIRECTORY}");` +
  'try{require("fs").readdirSync("/var/lib/melra");console.log("read",process.getuid())}catch(e){console.log(e.code,process.getuid())}';
const PLANS = {
  write: {
    goal: "Write a file from the agent's container through MELRA",
    operation: { kind: "file", action: "write", path: FILE, content: "written through the socket\n" },
    requiredEvidence: [{ type: "file_exists", path: FILE }],
  },
  command: {
    goal: "Read MELRA's data from a command MELRA runs",
    operation: { kind: "terminal", action: "run", command: "node", args: ["-e", COMMAND] },
    requiredEvidence: [{ type: "exit_code", value: 0 }],
  },
  into: {
    goal: "Write into the directory a command MELRA ran made",
    operation: { kind: "file", action: "write", path: `${DIRECTORY}/by-melra.txt`, content: "written by MELRA\n" },
    requiredEvidence: [{ type: "file_exists", path: `${DIRECTORY}/by-melra.txt` }],
  },
};

// Inside the agent's container: the stand-in agent. Given a plan's name it
// plans it; given a task id, it runs it and fetches the receipt.
async function agent(what) {
  const { MelraClient } = await import("../packages/sdk-ts/dist/index.js");
  const melra = await MelraClient.connect({
    socketPath: process.env.MELRA_SOCKET,
    token: process.env.MELRA_HTTP_TOKEN,
  });
  try {
    const result =
      what in PLANS
        ? await melra.plan(PLANS[what])
        : { ...(await melra.execute(what)), ...(await melra.receipt({ taskId: what })) };
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await melra.close();
  }
}

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const project = `melra-compose-smoke-${randomBytes(4).toString("hex")}`;
const compose = ["compose", "--file", "examples/deploy/compose/compose.yaml", "--project-name", project];
const run = [...compose, "run", "--rm", "-T"];
// The image ships the CLI but not the SDK, so the stand-in takes the SDK from
// this checkout, mounted read-only, and runs this file with --agent.
const sdk = [
  ...run,
  "--volume",
  `${repo}:/melra-src:ro`,
  "--entrypoint",
  "node",
  "agent",
  "/melra-src/scripts/compose-smoke.mjs",
  "--agent",
];
const commands = {
  up: [...compose, "up", "--detach", "--wait", "melra"],
  // `up melra` leaves the agent's network for later; the probe needs its
  // address first.
  create: [...compose, "create", "agent"],
  bridge: ["network", "inspect", "bridge", "--format", "{{(index .IPAM.Config 0).Gateway}}"],
  agentNetwork: ["network", "inspect", `${project}_agent`, "--format", "{{json .IPAM.Config}}"],
  // Which address goes to which check lives here, where the dry run prints it.
  probe: (bridge, agent, port) => [
    ...run,
    "agent",
    "probe",
    "--socket",
    SOCKET,
    "--public",
    `${bridge}:${port}`,
    "--local",
    `${agent}:${port}`,
    "--json",
  ],
  plan: (what) => [...sdk, what],
  approve: (taskId) => [
    ...compose,
    "exec",
    "-T",
    "melra",
    "node",
    "/opt/melra/dist/bin.js",
    "approve",
    taskId,
    "--yes",
    "--json",
  ],
  execute: (taskId) => [...sdk, taskId],
  down: [...compose, "down", "--volumes", "--remove-orphans"],
};

if (process.argv[2] === "--agent") {
  await agent(process.argv[3]);
} else if (process.argv.includes("--dry-run")) {
  for (const args of [
    commands.up,
    commands.create,
    commands.bridge,
    commands.agentNetwork,
    commands.probe("<bridge-gateway>", "<agent-gateway>", "<port>"),
    commands.plan("write"),
    commands.approve("<task-id>"),
    commands.execute("<task-id>"),
    commands.plan("command"),
    commands.plan("into"),
    commands.down,
  ]) {
    process.stdout.write(`docker ${args.join(" ")}\n`);
  }
} else {
  await smoke();
}

async function smoke() {
  const base = await mkdtemp(join(tmpdir(), "melra-compose-smoke-"));
  const workspace = join(base, "workspace");
  await mkdir(workspace);
  // The runner's user owns it, and neither root without CAP_DAC_OVERRIDE nor
  // 1000 is that user. What either makes inside, their shared group and
  // MELRA's umask keep open to the other, which the last checks hold it to.
  await chmod(workspace, 0o777);
  const env = { ...process.env, WORKSPACE: workspace, MELRA_HTTP_TOKEN: randomBytes(32).toString("hex") };
  const docker = (args, check = true) => {
    const result = spawnSync("docker", args, { cwd: repo, encoding: "utf8", env, stdio: ["ignore", "pipe", "inherit"] });
    if (check && result.status !== 0) {
      throw new Error(`compose_smoke_failed: docker ${args.join(" ")} exited ${result.status ?? result.error}`);
    }
    return result.stdout;
  };
  // A port on the host that answers when nothing is in the way, on every
  // address. public-connect dials it at docker0's gateway, which any container
  // with a route out reaches; local-connect at the host's address on the
  // agent's network, the only one the agent could reach without a route. The
  // container's own 127.0.0.1 would always answer.
  const listener = createServer((socket) => socket.destroy());

  try {
    docker(commands.up);
    docker(commands.create);
    await new Promise((settle) => listener.listen(0, "0.0.0.0", settle));
    const { port } = listener.address();
    const bridge = docker(commands.bridge).trim();
    // `isolated` leaves the agent's network without a gateway, so this takes
    // where Docker would put the host otherwise: the subnet's first address.
    const [{ Gateway, Subnet }] = JSON.parse(docker(commands.agentNetwork));
    const agentGateway = Gateway || Subnet.replace(/\.\d+\/\d+$/, ".1");
    // Exits 1: program-start starts the shell the agent's image ships, which runs
    // inside the same container, so the probe reports it open.
    const probe = JSON.parse(docker(commands.probe(bridge, agentGateway, port), false));
    for (const name of ["workspace-write", "melra-home-read", "public-connect", "local-connect"]) {
      const check = probe.checks.find((entry) => entry.name === name);
      if (check?.outcome !== "confined") throw new Error(`compose_smoke_open:${name}:${JSON.stringify(check)}`);
    }
    if (!probe.melra.answers) throw new Error(`compose_smoke_no_answer:${probe.melra.detail}`);

    const planned = JSON.parse(docker(commands.plan("write")));
    if (planned.status !== "awaiting_approval" || planned.approval?.phrase !== undefined) {
      throw new Error(`compose_smoke_not_enforced:${JSON.stringify(planned)}`);
    }
    const approved = JSON.parse(docker(commands.approve(planned.id)));
    if (approved.decision?.channel !== "out_of_band") {
      throw new Error(`compose_smoke_not_out_of_band:${JSON.stringify(approved)}`);
    }
    const done = JSON.parse(docker(commands.execute(planned.id)));
    const written = await readFile(join(workspace, FILE), "utf8");
    if (
      done.task?.status !== "verified_success" ||
      done.certificate?.result !== "VERIFIED_SUCCESS" ||
      !/^[a-f0-9]{64}$/.test(done.certificate.digest) ||
      written !== "written through the socket\n"
    ) {
      throw new Error(`compose_smoke_verification_failed:${JSON.stringify(done)}`);
    }
    // A command runs as the image's node, which MELRA's data keeps out, and
    // changes what MELRA made; MELRA then writes in what the command made.
    const command = JSON.parse(docker(commands.plan("command")));
    docker(commands.approve(command.id));
    const ran = JSON.parse(docker(commands.execute(command.id)));
    // The live output: the stored task keeps stdout redacted.
    const confined = String(ran.output?.stdout ?? "").trim();
    if (ran.task?.status !== "verified_success" || confined !== "EACCES 1000") {
      throw new Error(`compose_smoke_command_not_confined:${JSON.stringify({ status: ran.task?.status, stdout: ran.output?.stdout })}`);
    }
    const edited = await readFile(join(workspace, FILE), "utf8");
    if (edited !== "written through the socket\nedited by the command\n") {
      throw new Error(`compose_smoke_command_cannot_edit:${JSON.stringify(edited)}`);
    }
    const into = JSON.parse(docker(commands.plan("into")));
    docker(commands.approve(into.id));
    const wrote = JSON.parse(docker(commands.execute(into.id)));
    if (wrote.task?.status !== "verified_success") {
      throw new Error(`compose_smoke_melra_cannot_write_into:${JSON.stringify(wrote.task)}`);
    }
    process.stdout.write(
      `${JSON.stringify(
        {
          probe: probe.checks.map((check) => `${check.name}: ${check.outcome} (${check.detail})`),
          taskStatus: done.task.status,
          command: confined,
          edited: true,
          into: wrote.task.status,
          approval: approved.decision.channel,
          certificate: done.certificate.result,
          digest: done.certificate.digest,
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    listener.close();
    // What MELRA wrote as root inside what the command made is not this user's
    // to delete: empty the workspace as root first, through the same image.
    docker(["run", "--rm", "--user", "0", "--entrypoint", "rm", "-v", `${workspace}:/w`, process.env.MELRA_IMAGE ?? "melra:local", "-rf", "/w"], false);
    docker(commands.down, false);
    await rm(base, { recursive: true, force: true });
  }
}
