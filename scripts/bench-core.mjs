// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { chromium } from "playwright-core";
import {
  detectBrowserExecutable,
  waitForStableDom,
} from "../packages/browser-runtime/dist/index.js";
import {
  ComputerRuntime,
} from "../packages/computer-runtime/dist/index.js";
import { rankMemories } from "../packages/memory/dist/index.js";
import { ComputerOperationSchema } from "../packages/protocol/dist/index.js";
import { TerminalRuntime } from "../packages/terminal-runtime/dist/index.js";

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

function percentile(values, quantile) {
  const sorted = [...values].sort((left, right) => left - right);
  return Number(
    sorted[
      Math.min(sorted.length - 1, Math.floor(sorted.length * quantile))
    ].toFixed(3),
  );
}

async function memoryBenchmark() {
  const records = Array.from({ length: 1_000 }, (_, index) => ({
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    scope: "workspace",
    key: `record ${index}`,
    value:
      index < 100
        ? `project signal-${index} belongs to checkpoint orbit-${index}`
        : `generic project note ${index % 25} with repeated background context`,
    source: "synthetic-public-benchmark",
    confidence: 0.9,
    tags: [`bucket-${index % 20}`],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  }));
  const latencies = [];
  let recallAt1 = 0;
  let recallAt5 = 0;
  for (let index = 0; index < 100; index += 1) {
    const startedAt = performance.now();
    const ranked = rankMemories(
      records,
      `checkpoint orbit-${index} signal-${index}`,
      5,
      Date.parse("2026-01-01T00:00:00.000Z"),
    );
    latencies.push(performance.now() - startedAt);
    const expected = records[index].id;
    recallAt1 += Number(ranked[0]?.id === expected);
    recallAt5 += Number(ranked.some((memory) => memory.id === expected));
  }
  return {
    corpusSize: records.length,
    queries: 100,
    recallAt1: recallAt1 / 100,
    recallAt5: recallAt5 / 100,
    latencyMs: {
      p50: percentile(latencies, 0.5),
      p95: percentile(latencies, 0.95),
    },
    modelCalls: 0,
    networkCalls: 0,
  };
}

async function terminalBenchmark() {
  const root = await mkdtemp(join(tmpdir(), "melra-terminal-bench-"));
  const runtime = await TerminalRuntime.create({ root });
  const latencies = [];
  let passed = 0;
  try {
    for (let index = 0; index < 30; index += 1) {
      const startedAt = performance.now();
      const result = await runtime.execute({
        kind: "terminal",
        action: "run",
        command: process.execPath,
        args: ["-e", "process.stdout.write('verified')"],
        timeoutMs: 5_000,
        maxOutputChars: 10_000,
      });
      latencies.push(performance.now() - startedAt);
      passed += Number(
        result.success === true &&
          result.exitCode === 0 &&
          result.stdout === "verified",
      );
    }
  } finally {
    runtime.close();
    await rm(root, { recursive: true, force: true });
  }
  return {
    executions: 30,
    verifiedExecutions: passed,
    successRate: passed / 30,
    processLatencyMs: {
      p50: percentile(latencies, 0.5),
      p95: percentile(latencies, 0.95),
    },
    shell: false,
  };
}

const PAGE_HTML = `<!doctype html><html><body><div id="out"></div><script>
window.runProfile = (profile) => {
  const out = document.getElementById("out");
  out.replaceChildren();
  out.dataset.done = "working";
  if (profile === "static") {
    out.textContent = "final";
    out.dataset.done = "done";
    return;
  }
  const steps = profile === "burst" ? 6 : 14;
  const gap = profile === "burst" ? 20 : 50;
  let index = 0;
  const tick = () => {
    index += 1;
    const row = document.createElement("p");
    row.textContent = "row " + index;
    out.appendChild(row);
    if (index < steps) setTimeout(tick, gap);
    else out.dataset.done = "done";
  };
  setTimeout(tick, gap);
};
</script></body></html>`;

async function browserBenchmark() {
  const executablePath = await detectBrowserExecutable();
  if (executablePath === undefined) {
    return { skipped: true, reason: "supported_browser_not_found" };
  }
  const browser = await chromium.launch({ executablePath, headless: true });
  const page = await browser.newPage();
  const results = {};
  try {
    for (const profile of ["static", "burst", "slow"]) {
      results[profile] = {};
      for (const strategy of ["fixed300", "condition"]) {
        const waits = [];
        let correct = 0;
        for (let index = 0; index < 10; index += 1) {
          await page.setContent(PAGE_HTML);
          await page.evaluate((value) => window.runProfile(value), profile);
          const startedAt = performance.now();
          if (strategy === "fixed300") {
            await new Promise((resolvePromise) =>
              setTimeout(resolvePromise, 300),
            );
          } else {
            await waitForStableDom(page, {
              quietWindowMs: 180,
              timeoutMs: 1_500,
            });
          }
          waits.push(performance.now() - startedAt);
          correct += Number(
            (await page.locator("#out").getAttribute("data-done")) === "done",
          );
        }
        results[profile][strategy] = {
          iterations: 10,
          waitMs: {
            p50: percentile(waits, 0.5),
            p95: percentile(waits, 0.95),
          },
          correctReadRate: correct / 10,
        };
      }
    }
  } finally {
    await browser.close();
  }
  return {
    skipped: false,
    browserExecutable: executablePath,
    profiles: results,
  };
}

async function computerBenchmark() {
  const runtime = new ComputerRuntime({
    artifactDirectory: join(tmpdir(), "melra-computer-bench"),
  });
  const operation = ComputerOperationSchema.parse({
    kind: "computer",
    action: "capabilities",
  });
  const latencies = [];
  let capabilities;
  for (let index = 0; index < 30; index += 1) {
    const startedAt = performance.now();
    capabilities = await runtime.execute(operation);
    latencies.push(performance.now() - startedAt);
  }
  return {
    capabilityProbes: 30,
    successfulProbes: 30,
    probeLatencyMs: {
      p50: percentile(latencies, 0.5),
      p95: percentile(latencies, 0.95),
    },
    capabilities,
    taskBenchmark: {
      measured: false,
      reason:
        "OSWorld and OSWorld-MCP require a controlled VM, model policy, and official evaluator; no task-success score is claimed by this microbenchmark.",
    },
  };
}

async function main() {
  const results = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    environment: {
      platform: process.platform,
      architecture: process.arch,
      node: process.version,
    },
    memory: await memoryBenchmark(),
    terminal: await terminalBenchmark(),
    browser: await browserBenchmark(),
    computer: await computerBenchmark(),
    claimBoundary:
      "These are local component microbenchmarks, not cross-product leaderboard results.",
  };
  const output = resolve(
    argument("output") ??
      "docs/research/results/core-microbenchmarks.json",
  );
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(results, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
}

await main();
