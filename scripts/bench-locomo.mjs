// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { rankMemories } from "../packages/memory/dist/index.js";

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

function percentile(values, quantile) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[
    Math.min(sorted.length - 1, Math.floor(sorted.length * quantile))
  ];
}

function recordsForSample(sample) {
  const records = [];
  for (const [key, turns] of Object.entries(sample.conversation)) {
    if (!/^session_\d+$/.test(key)) continue;
    const date = sample.conversation[`${key}_date_time`] ?? "";
    for (const [sequence, turn] of turns.entries()) {
      records.push({
        id: turn.dia_id,
        scope: "workspace",
        key: `${turn.dia_id} ${turn.speaker}`,
        value: `${date} ${turn.text}`,
        source: "locomo",
        confidence: 1,
        tags: [key],
        speaker: turn.speaker,
        episodeId: key,
        sequence,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      });
    }
  }
  return records;
}

async function main() {
  const datasetArgument = argument("dataset");
  if (datasetArgument === undefined) {
    throw new Error(
      "usage: pnpm benchmark:locomo -- --dataset /path/to/locomo10.json [--output path]",
    );
  }
  const datasetPath = resolve(datasetArgument);
  const datasetBytes = await readFile(datasetPath);
  const dataset = JSON.parse(datasetBytes.toString("utf8"));
  const cutoffs = [5, 20, 50, 100];
  const coverage = Object.fromEntries(cutoffs.map((cutoff) => [cutoff, 0]));
  const fullRecall = Object.fromEntries(cutoffs.map((cutoff) => [cutoff, 0]));
  const latencies = [];
  const byCategory = {};
  let questionCount = 0;

  for (const sample of dataset) {
    const records = recordsForSample(sample);
    for (const question of sample.qa) {
      if (!Array.isArray(question.evidence) || question.evidence.length === 0) {
        continue;
      }
      const startedAt = performance.now();
      const ranked = rankMemories(
        records,
        question.question,
        Math.max(...cutoffs),
        Date.parse("2026-01-01T00:00:00.000Z"),
      );
      latencies.push(performance.now() - startedAt);
      questionCount += 1;
      const category = String(question.category);
      byCategory[category] ??= { questions: 0, coverageAt20: 0 };
      byCategory[category].questions += 1;
      for (const cutoff of cutoffs) {
        const ids = new Set(ranked.slice(0, cutoff).map((memory) => memory.id));
        const recalled = question.evidence.filter((id) => ids.has(id)).length;
        const ratio = recalled / question.evidence.length;
        coverage[cutoff] += ratio;
        if (ratio === 1) fullRecall[cutoff] += 1;
        if (cutoff === 20) byCategory[category].coverageAt20 += ratio;
      }
    }
  }

  const results = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    benchmark: "LoCoMo objective evidence retrieval",
    environment: {
      platform: process.platform,
      architecture: process.arch,
      node: process.version,
    },
    dataset: {
      source: "https://github.com/snap-research/locomo",
      license: "CC-BY-NC-4.0",
      sha256: createHash("sha256").update(datasetBytes).digest("hex"),
      conversations: dataset.length,
      evaluatedQuestions: questionCount,
      excludedQuestions: dataset
        .flatMap((sample) => sample.qa)
        .filter(
          (question) =>
            !Array.isArray(question.evidence) ||
            question.evidence.length === 0,
        ).length,
    },
    system: {
      implementation: "@melra/memory melra-hybrid-v2",
      ingestionUnit: "dialogue turn",
      modelCalls: 0,
      embeddingCalls: 0,
      networkCalls: 0,
    },
    metrics: Object.fromEntries(
      cutoffs.map((cutoff) => [
        `k${cutoff}`,
        {
          meanEvidenceCoverage: Number(
            (coverage[cutoff] / questionCount).toFixed(6),
          ),
          completeEvidenceRecall: Number(
            (fullRecall[cutoff] / questionCount).toFixed(6),
          ),
        },
      ]),
    ),
    categoryCoverageAt20: Object.fromEntries(
      Object.entries(byCategory).map(([category, values]) => [
        category,
        {
          questions: values.questions,
          meanEvidenceCoverage: Number(
            (values.coverageAt20 / values.questions).toFixed(6),
          ),
        },
      ]),
    ),
    queryLatencyMs: {
      samples: latencies.length,
      p50: Number(percentile(latencies, 0.5).toFixed(3)),
      p95: Number(percentile(latencies, 0.95).toFixed(3)),
    },
    limitations: [
      "This is retrieval evidence coverage, not answer accuracy.",
      "The scorer is lexical and local; it does not use embeddings or an LLM reader.",
      "Cross-project numbers are comparable only when ingestion units, k, dataset revision, and evidence metric match.",
    ],
  };

  const output = argument("output");
  if (output !== undefined) {
    const outputPath = resolve(output);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(results, null, 2)}\n`);
  }
  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
}

await main();
