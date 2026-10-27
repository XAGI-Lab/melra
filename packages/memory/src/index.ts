// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

import { randomUUID } from "node:crypto";
import type { MemoryOperation } from "@melra/protocol";
import { redactSecrets } from "@melra/receipt-schema";
import {
  SqliteStore,
  type MemoryRecord,
} from "@melra/storage-sqlite";


/**
 * How long an unreachable memory row survives before compaction reclaims it,
 * and an optional ceiling on live memories per scope.
 *
 * Expired and superseded rows are already filtered out of every read path;
 * removing them stops the file growing forever. What a caller can still see is
 * how far back undoing corrections reaches: deleting the live record revives
 * the one it replaced, which compaction keeps, but one replaced before that is
 * kept only `maxAgeDays`. `maxPerScope` deletes memories that can still be
 * read, so `0` (no ceiling) is the default and an operator opts in.
 */
export interface MemoryRetention {
  maxAgeDays: number;
  maxPerScope: number;
}

export const DEFAULT_MEMORY_RETENTION: MemoryRetention = {
  maxAgeDays: 30,
  maxPerScope: 0,
};


// The one list receipts and terminal output use too, so a secret shape added
// there protects memory without anyone remembering a second copy.
export function redactMemoryValue(value: string): {
  value: string;
  redactions: string[];
} {
  return redactSecrets(value);
}

export interface RankedMemory extends MemoryRecord {
  score: number;
  scoreBreakdown: {
    lexical: number;
    phrase: number;
    confidence: number;
    freshness: number;
    context: number;
    speaker: number;
    diversityPenalty: number;
  };
}

const DAY_MS = 86_400_000;
const DEFAULT_HALF_LIFE_DAYS = 30;
const MAX_CANDIDATES = 5_000;
// What a search tokenises at most, about 5,000 records of 800 characters: a
// few hundred milliseconds, where 5,000 values at the 200,000 limit would be
// a gigabyte of text.
const MAX_CANDIDATE_CHARS = 4_000_000;
const CONTEXT_ANCHORS = 20;
const CONTEXT_DEPTH = 2;
const CONTEXT_DECAY = 0.9;
const SPEAKER_BOOST = 0.1;

export function tokenize(value: string): string[] {
  return value.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

function jaccard(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 && right.size === 0) return 1;
  let intersection = 0;
  for (const value of left) {
    if (right.has(value)) intersection += 1;
  }
  return intersection / (left.size + right.size - intersection);
}

function freshness(updatedAt: string, nowMs: number): number {
  const ageDays = Math.max(0, nowMs - Date.parse(updatedAt)) / DAY_MS;
  return Math.exp((-Math.LN2 * ageDays) / DEFAULT_HALF_LIFE_DAYS);
}

/**
 * Deterministic local retrieval with inspectable scoring and no model call.
 *
 * The first pass combines BM25-style term evidence, exact phrase matching,
 * provenance confidence, and freshness. The second pass applies a bounded
 * maximal-marginal-relevance penalty so repeated records do not crowd out
 * distinct evidence. A final bounded pass uses explicit episode order and
 * speaker metadata when the caller supplies them.
 */
export function rankMemories(
  records: MemoryRecord[],
  query: string,
  limit: number,
  nowMs = Date.now(),
): RankedMemory[] {
  const queryTokens = [...new Set(tokenize(query))];
  if (queryTokens.length === 0) return [];
  const queryTokenSet = new Set(queryTokens);
  const queryIndex = new Map(queryTokens.map((term, index) => [term, index]));
  const documents = records.map((record) => {
    const tokens = tokenize(`${record.key} ${record.value} ${record.tags.join(" ")}`);
    // Counted once, so each query term is a lookup rather than another pass
    // over the record (#405).
    const counts = new Map<string, number>();
    for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
    return { record, tokens, counts };
  });
  const documentFrequency = new Map<string, number>();
  for (const document of documents) {
    for (const token of document.counts.keys()) {
      documentFrequency.set(
        token,
        (documentFrequency.get(token) ?? 0) + 1,
      );
    }
  }
  const averageLength =
    documents.reduce((total, document) => total + document.tokens.length, 0) /
    Math.max(1, documents.length);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const scored = documents
    .map(({ record, tokens, counts }) => {
      // The query terms the record holds, found from whichever side is
      // smaller, so a long query over many records is not a lookup per term
      // per record (#405). Summed in query order, as a pass over every term
      // adds them, so the score is the same to the bit.
      const matched: number[] = [];
      if (counts.size < queryTokens.length) {
        for (const token of counts.keys()) {
          const index = queryIndex.get(token);
          if (index !== undefined) matched.push(index);
        }
        matched.sort((left, right) => left - right);
      } else {
        queryTokens.forEach((term, index) => {
          if (counts.has(term)) matched.push(index);
        });
      }
      let lexical = 0;
      for (const index of matched) {
        const term = queryTokens[index]!;
        const containing = documentFrequency.get(term) ?? 0;
        const idf = Math.log(
          1 + (documents.length - containing + 0.5) / (containing + 0.5),
        );
        const frequency = counts.get(term)!;
        const denominator =
          frequency +
          1.2 *
            (1 - 0.75 + 0.75 * (tokens.length / Math.max(1, averageLength)));
        lexical += idf * ((frequency * 2.2) / denominator);
      }
      const normalizedLexical = lexical / Math.max(1, queryTokens.length);
      const phrase = `${record.key} ${record.value}`
        .toLocaleLowerCase()
        .includes(normalizedQuery)
        ? 1
        : 0;
      const fresh = freshness(record.updatedAt, nowMs);
      const base =
        normalizedLexical * 0.62 +
        phrase * 0.16 +
        record.confidence * 0.14 +
        fresh * 0.08;
      return {
        record,
        tokenSet: new Set(tokens),
        base,
        normalizedLexical,
        phrase,
        fresh,
      };
    })
    .filter(
      (candidate) =>
        candidate.normalizedLexical > 0 || candidate.phrase > 0,
    )
    .sort(
      (left, right) =>
        right.base - left.base ||
        right.record.updatedAt.localeCompare(left.record.updatedAt),
    );

  const selected: Array<{
    candidate: (typeof scored)[number];
    ranked: RankedMemory;
  }> = [];
  const remaining = scored.map((candidate) => ({
    candidate,
    maxSimilarity: 0,
  }));
  const diversityDepth = Math.min(limit, 20);
  while (remaining.length > 0 && selected.length < diversityDepth) {
    let bestIndex = 0;
    let bestAdjusted = Number.NEGATIVE_INFINITY;
    let bestPenalty = 0;
    for (let index = 0; index < remaining.length; index += 1) {
      const entry = remaining[index]!;
      const candidate = entry.candidate;
      const penalty = entry.maxSimilarity;
      const adjusted = candidate.base * 0.88 - penalty * 0.12;
      if (
        adjusted > bestAdjusted ||
        (adjusted === bestAdjusted &&
          candidate.record.updatedAt >
            remaining[bestIndex]!.candidate.record.updatedAt)
      ) {
        bestIndex = index;
        bestAdjusted = adjusted;
        bestPenalty = penalty;
      }
    }
    const [entry] = remaining.splice(bestIndex, 1);
    if (entry === undefined) break;
    const candidate = entry.candidate;
    selected.push({
      candidate,
      ranked: {
        ...candidate.record,
        score: Number(bestAdjusted.toFixed(6)),
        scoreBreakdown: {
          lexical: Number(candidate.normalizedLexical.toFixed(6)),
          phrase: candidate.phrase,
          confidence: candidate.record.confidence,
          freshness: Number(candidate.fresh.toFixed(6)),
          context: 0,
          speaker: 0,
          diversityPenalty: Number(bestPenalty.toFixed(6)),
        },
      },
    });
    for (const remainingEntry of remaining) {
      remainingEntry.maxSimilarity = Math.max(
        remainingEntry.maxSimilarity,
        jaccard(remainingEntry.candidate.tokenSet, candidate.tokenSet),
      );
    }
  }
  for (
    let index = 0;
    index < remaining.length && selected.length < limit;
    index += 1
  ) {
    const candidate = remaining[index]!.candidate;
    selected.push({
      candidate,
      ranked: {
        ...candidate.record,
        score: Number((candidate.base * 0.88).toFixed(6)),
        scoreBreakdown: {
          lexical: Number(candidate.normalizedLexical.toFixed(6)),
          phrase: candidate.phrase,
          confidence: candidate.record.confidence,
          freshness: Number(candidate.fresh.toFixed(6)),
          context: 0,
          speaker: 0,
          diversityPenalty: 0,
        },
      },
    });
  }
  const rankedById = new Map(
    selected.map(({ ranked }) => [ranked.id, ranked]),
  );
  const episodeSequence = new Map<string, MemoryRecord[]>();
  for (const record of records) {
    if (record.episodeId === undefined || record.sequence === undefined) {
      continue;
    }
    const key = `${record.episodeId}\u0000${record.sequence}`;
    const entries = episodeSequence.get(key) ?? [];
    entries.push(record);
    episodeSequence.set(key, entries);
  }
  for (const { ranked: anchor } of selected.slice(0, CONTEXT_ANCHORS)) {
    if (anchor.episodeId === undefined || anchor.sequence === undefined) {
      continue;
    }
    for (let distance = 1; distance <= CONTEXT_DEPTH; distance += 1) {
      for (const direction of [-1, 1]) {
        const key = `${anchor.episodeId}\u0000${
          anchor.sequence + direction * distance
        }`;
        for (const neighbor of episodeSequence.get(key) ?? []) {
          const context = anchor.score * CONTEXT_DECAY ** distance;
          const existing = rankedById.get(neighbor.id);
          if (existing === undefined) {
            rankedById.set(neighbor.id, {
              ...neighbor,
              score: Number(context.toFixed(6)),
              scoreBreakdown: {
                lexical: 0,
                phrase: 0,
                confidence: neighbor.confidence,
                freshness: Number(
                  freshness(neighbor.updatedAt, nowMs).toFixed(6),
                ),
                context: Number(context.toFixed(6)),
                speaker: 0,
                diversityPenalty: 0,
              },
            });
          } else if (context > existing.scoreBreakdown.context) {
            existing.score = Number(
              Math.max(existing.score, context).toFixed(6),
            );
            existing.scoreBreakdown.context = Number(context.toFixed(6));
          }
        }
      }
    }
  }
  for (const ranked of rankedById.values()) {
    if (
      ranked.speaker !== undefined &&
      tokenize(ranked.speaker).some((token) => queryTokenSet.has(token))
    ) {
      ranked.score = Number((ranked.score + SPEAKER_BOOST).toFixed(6));
      ranked.scoreBreakdown.speaker = SPEAKER_BOOST;
    }
  }
  return [...rankedById.values()]
    .sort(
      (left, right) =>
        right.score - left.score ||
        right.updatedAt.localeCompare(left.updatedAt),
    )
    .slice(0, limit);
}

export class LocalMemory {
  constructor(
    private readonly store: SqliteStore,
    private readonly retention: MemoryRetention = DEFAULT_MEMORY_RETENTION,
  ) {}

  execute(operation: MemoryOperation): Record<string, unknown> {
    switch (operation.action) {
      case "put": {
        if (operation.key === undefined || operation.value === undefined) {
          throw new Error("memory_put_requires_key_and_value");
        }
        const now = new Date().toISOString();
        const redacted = redactMemoryValue(operation.value);
        const redactedKey = redactMemoryValue(operation.key);
        const redactedSpeaker =
          operation.speaker === undefined
            ? undefined
            : redactMemoryValue(operation.speaker);
        const redactedEpisodeId =
          operation.episodeId === undefined
            ? undefined
            : redactMemoryValue(operation.episodeId);
        // Read, checked and written as one transaction: another process
        // editing or deleting the same chain in between left a record hidden
        // with nothing pointing at it, or two live records for one fact.
        const memory = this.store.transaction(() => {
          const existing =
            operation.id === undefined
              ? undefined
              : this.store.getMemory(operation.id);
          if (existing !== undefined && existing.scope !== operation.scope) {
            throw new Error("memory_scope_mismatch");
          }
          if (existing?.supersededBy !== undefined) {
            throw new Error("memory_superseded_record_immutable");
          }
          const superseded =
            operation.supersedesId === undefined
              ? undefined
              : this.store.getMemory(operation.supersedesId);
          if (
            operation.supersedesId !== undefined &&
            (superseded === undefined ||
              superseded.scope !== operation.scope ||
              operation.supersedesId === operation.id ||
              // Already replaced by some other record: superseding it again is
              // not possible, and finding that out after the write lost data.
              (superseded.supersededBy !== undefined && superseded.supersededBy !== operation.id))
          ) {
            throw new Error("memory_supersedes_target_invalid");
          }
          const memory: MemoryRecord = {
            id: operation.id ?? randomUUID(),
            scope: operation.scope,
            // Free text a caller writes, like the value: a token pasted into the
            // key, the source or a tag is no more meant to be kept than one in
            // the value.
            key: redactedKey.value,
            value: redacted.value,
            source: redactMemoryValue(operation.source ?? "mcp-client").value,
            confidence: operation.confidence,
            tags: operation.tags.map((tag) => redactMemoryValue(tag).value),
            ...(redactedSpeaker === undefined
              ? {}
              : { speaker: redactedSpeaker.value }),
            ...(redactedEpisodeId === undefined
              ? {}
              : { episodeId: redactedEpisodeId.value }),
            ...(operation.sequence === undefined
              ? {}
              : { sequence: operation.sequence }),
            ...(operation.expiresAt === undefined
              ? {}
              : { expiresAt: operation.expiresAt }),
            ...(operation.supersedesId === undefined
              ? {}
              : { supersedesId: operation.supersedesId }),
            createdAt: existing?.createdAt ?? now,
            updatedAt: now,
          };
          this.store.putMemory(memory);
          if (
            operation.supersedesId !== undefined &&
            // Re-putting the record that already superseded it is an edit of
            // that record, not a second supersede.
            superseded?.supersededBy !== memory.id &&
            !this.store.supersedeMemory(
              operation.supersedesId,
              operation.scope,
              memory.id,
            )
          ) {
            // Rolled back with the write: what was there stays, and what was new
            // is gone.
            throw new Error("memory_supersedes_target_invalid");
          }
          // An edit that drops or changes what this record supersedes hands the
          // old one back, as deleting the record would.
          // Not when that record has expired: a lapsed correction revives
          // nothing, as when compaction has removed it already.
          if (
            existing?.supersedesId !== undefined &&
            existing.supersedesId !== memory.supersedesId &&
            (existing.expiresAt === undefined || existing.expiresAt > now)
          ) {
            this.store.unsupersedeMemory(existing.supersedesId, memory.scope, memory.id);
          }
          return memory;
        });
        // Compact on the write path rather than on a timer: a scope only grows
        // when something is put into it, so this is the one moment reclaiming
        // is worth doing, and a local store is small enough that the cost is a
        // few deletes against an indexed column.
        const compacted = this.store.compactMemories(
          memory.scope,
          this.retention,
        );
        return {
          stored: true,
          id: memory.id,
          scope: memory.scope,
          key: memory.key,
          tags: memory.tags,
          speaker: memory.speaker ?? null,
          episodeId: memory.episodeId ?? null,
          sequence: memory.sequence ?? null,
          expiresAt: memory.expiresAt ?? null,
          supersedesId: memory.supersedesId ?? null,
          redactions: [
            ...new Set([
              ...redacted.redactions,
              ...(redactedSpeaker?.redactions ?? []),
              ...(redactedEpisodeId?.redactions ?? []),
            ]),
          ],
          compacted,
        };
      }
      case "search": {
        if (operation.query === undefined) {
          throw new Error("memory_search_requires_query");
        }
        const candidates = this.store.memoryCandidates(
          operation.scope,
          MAX_CANDIDATES,
          operation.includeSuperseded,
          MAX_CANDIDATE_CHARS,
        );
        return {
          memories: rankMemories(
            candidates,
            operation.query,
            operation.limit,
          ),
          candidateCount: candidates.length,
          ranking: "melra-hybrid-v2",
        };
      }
      case "list":
        return {
          memories: this.store.listMemories(
            operation.scope,
            operation.limit,
            operation.includeSuperseded,
          ),
        };
      case "delete": {
        if (operation.id === undefined) {
          throw new Error("memory_delete_requires_id");
        }
        return {
          deleted: this.store.deleteMemory(operation.id, operation.scope),
          id: operation.id,
          scope: operation.scope,
        };
      }
      case "clear":
        return {
          cleared: this.store.clearMemories(operation.scope),
          scope: operation.scope,
        };
    }
  }
}
