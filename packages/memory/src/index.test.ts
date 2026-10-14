// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it } from "vitest";
import { MemoryOperationSchema } from "@melra/protocol";
import { SqliteStore } from "@melra/storage-sqlite";
import {
  LocalMemory,
  rankMemories,
  redactMemoryValue,
  type RankedMemory,
} from "./index.js";

let store: SqliteStore | undefined;

afterEach(() => {
  store?.close();
  store = undefined;
});

describe("LocalMemory", () => {
  it("redacts common secret formats before persistence", () => {
    const fakeGithubToken = ["ghp", "123456789012345678901234"].join("_");
    const result = redactMemoryValue(
      `token ${fakeGithubToken} and password=hunter2`,
    );
    expect(result.value).not.toContain("hunter2");
    expect(result.value).not.toContain("ghp_123");
    expect(result.redactions.length).toBeGreaterThan(0);
  });

  it("redacts private keys and cloud credentials, not only tokens", () => {
    // GovBench found these stored verbatim: memory had its own pattern list
    // that knew neither shape.
    const pem = [
      "-----BEGIN OPENSSH PRIVATE KEY-----",
      "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ",
      "-----END OPENSSH PRIVATE KEY-----",
    ].join("\n");
    const truncated = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA";
    const awsKeyId = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
    const jwt = ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", "dozjgNryP4J3jVmNHl0w5N"].join(".");
    for (const secret of [pem, truncated, awsKeyId, jwt]) {
      const result = redactMemoryValue(`deploy note: ${secret} (keep)`);
      expect(result.value, secret.slice(0, 20)).not.toContain(secret.slice(12, 40));
      expect(result.redactions.length).toBeGreaterThan(0);
    }
    // Ordinary text around them survives.
    expect(redactMemoryValue(`key ${awsKeyId} rotated`).value).toBe("key [REDACTED_AWS_KEY_ID] rotated");
    expect(redactMemoryValue("BEGIN the PRIVATE meeting at 10").value).toBe("BEGIN the PRIVATE meeting at 10");
  });

  it("redacts speaker and episode metadata before persistence", () => {
    store = new SqliteStore(":memory:");
    const memory = new LocalMemory(store);
    const fakeGithubToken = ["ghp", "123456789012345678901234"].join("_");
    const result = memory.execute(
      MemoryOperationSchema.parse({
        kind: "memory",
        action: "put",
        id: "00000000-0000-4000-8000-000000000041",
        scope: "workspace",
        key: "turn",
        value: "Safe value",
        speaker: "Alex password=hunter2",
        episodeId: fakeGithubToken,
        sequence: 1,
      }),
    ) as { redactions: string[] };
    const persisted = store.getMemory(
      "00000000-0000-4000-8000-000000000041",
    );

    expect(persisted?.speaker).not.toContain("hunter2");
    expect(persisted?.episodeId).not.toContain("ghp_123");
    expect(result.redactions.length).toBeGreaterThanOrEqual(2);
  });

  it("keeps memory isolated by scope", () => {
    store = new SqliteStore(":memory:");
    const memory = new LocalMemory(store);
    memory.execute(
      MemoryOperationSchema.parse({
        kind: "memory",
        action: "put",
        scope: "workspace",
        key: "product",
        value: "MELRA",
      }),
    );
    const workspace = memory.execute(
      MemoryOperationSchema.parse({
        kind: "memory",
        action: "search",
        scope: "workspace",
        query: "melra",
      }),
    ) as { memories: unknown[] };
    const user = memory.execute(
      MemoryOperationSchema.parse({
        kind: "memory",
        action: "search",
        scope: "user",
        query: "melra",
      }),
    ) as { memories: unknown[] };
    expect(workspace.memories).toHaveLength(1);
    expect(user.memories).toHaveLength(0);
  });

  it("uses persisted episode and speaker metadata during search", () => {
    store = new SqliteStore(":memory:");
    const memory = new LocalMemory(store);
    memory.execute(
      MemoryOperationSchema.parse({
        kind: "memory",
        action: "put",
        id: "00000000-0000-4000-8000-000000000031",
        scope: "workspace",
        key: "prompt",
        value: "What topic did you research?",
        speaker: "Jordan",
        episodeId: "conversation-a",
        sequence: 10,
      }),
    );
    memory.execute(
      MemoryOperationSchema.parse({
        kind: "memory",
        action: "put",
        id: "00000000-0000-4000-8000-000000000032",
        scope: "workspace",
        key: "answer",
        value: "Adoption agencies.",
        speaker: "Alex",
        episodeId: "conversation-a",
        sequence: 11,
      }),
    );

    const result = memory.execute(
      MemoryOperationSchema.parse({
        kind: "memory",
        action: "search",
        scope: "workspace",
        query: "What did Alex research?",
      }),
    ) as { memories: RankedMemory[] };

    expect(result.memories.map((entry) => entry.id)).toContain(
      "00000000-0000-4000-8000-000000000032",
    );
    expect(
      result.memories.find(
        (entry) => entry.id === "00000000-0000-4000-8000-000000000032",
      )?.scoreBreakdown.speaker,
    ).toBeGreaterThan(0);
  });

  it("ranks rare exact evidence ahead of generic duplicates", () => {
    const now = "2026-07-28T00:00:00.000Z";
    const ranked = rankMemories(
      [
        {
          id: "00000000-0000-4000-8000-000000000001",
          scope: "workspace",
          key: "release",
          value: "The launch codename is aurora.",
          source: "test",
          confidence: 0.95,
          tags: ["launch"],
          createdAt: now,
          updatedAt: now,
        },
        {
          id: "00000000-0000-4000-8000-000000000002",
          scope: "workspace",
          key: "generic",
          value: "The release process has a launch checklist.",
          source: "test",
          confidence: 1,
          tags: [],
          createdAt: now,
          updatedAt: now,
        },
        {
          id: "00000000-0000-4000-8000-000000000003",
          scope: "workspace",
          key: "duplicate",
          value: "The release process has a launch checklist.",
          source: "test",
          confidence: 1,
          tags: [],
          createdAt: now,
          updatedAt: now,
        },
      ],
      "launch codename aurora",
      3,
      Date.parse(now),
    );
    expect(ranked[0]?.id).toBe("00000000-0000-4000-8000-000000000001");
    expect(ranked[0]?.scoreBreakdown.lexical).toBeGreaterThan(0);
    expect(ranked[2]?.scoreBreakdown.diversityPenalty).toBeGreaterThan(0);
  });

  it("propagates relevance only to adjacent records in the same episode", () => {
    const now = "2026-07-28T00:00:00.000Z";
    const ranked = rankMemories(
      [
        {
          id: "00000000-0000-4000-8000-000000000011",
          scope: "workspace",
          key: "prompt",
          value: "What topic did you research?",
          source: "test",
          confidence: 1,
          tags: [],
          episodeId: "conversation-a",
          sequence: 10,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: "00000000-0000-4000-8000-000000000012",
          scope: "workspace",
          key: "answer",
          value: "Adoption agencies.",
          source: "test",
          confidence: 1,
          tags: [],
          episodeId: "conversation-a",
          sequence: 11,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: "00000000-0000-4000-8000-000000000013",
          scope: "workspace",
          key: "unrelated",
          value: "Private banking.",
          source: "test",
          confidence: 1,
          tags: [],
          episodeId: "conversation-b",
          sequence: 11,
          createdAt: now,
          updatedAt: now,
        },
      ],
      "What did Alex research?",
      3,
      Date.parse(now),
    );

    expect(ranked.map((memory) => memory.id)).toContain(
      "00000000-0000-4000-8000-000000000012",
    );
    expect(ranked.map((memory) => memory.id)).not.toContain(
      "00000000-0000-4000-8000-000000000013",
    );
  });

  it("boosts a record spoken by the entity named in the query", () => {
    const now = "2026-07-28T00:00:00.000Z";
    const ranked = rankMemories(
      [
        {
          id: "00000000-0000-4000-8000-000000000021",
          scope: "workspace",
          key: "turn-one",
          value: "I enjoy hiking and painting.",
          source: "test",
          confidence: 1,
          tags: [],
          speaker: "Jordan",
          createdAt: now,
          updatedAt: now,
        },
        {
          id: "00000000-0000-4000-8000-000000000022",
          scope: "workspace",
          key: "turn-two",
          value: "I enjoy hiking and painting.",
          source: "test",
          confidence: 1,
          tags: [],
          speaker: "Alex",
          createdAt: now,
          updatedAt: now,
        },
      ],
      "What does Alex enjoy?",
      2,
      Date.parse(now),
    );

    expect(ranked[0]?.id).toBe("00000000-0000-4000-8000-000000000022");
  });

  it("supports expiry and scoped supersession", () => {
    store = new SqliteStore(":memory:");
    const memory = new LocalMemory(store);
    const first = memory.execute(
      MemoryOperationSchema.parse({
        kind: "memory",
        action: "put",
        scope: "workspace",
        key: "runtime",
        value: "Use version one",
      }),
    ) as { id: string };
    memory.execute(
      MemoryOperationSchema.parse({
        kind: "memory",
        action: "put",
        scope: "workspace",
        key: "runtime",
        value: "Use version two",
        supersedesId: first.id,
      }),
    );
    memory.execute(
      MemoryOperationSchema.parse({
        kind: "memory",
        action: "put",
        scope: "workspace",
        key: "expired",
        value: "Do not retrieve this",
        expiresAt: "2020-01-01T00:00:00.000Z",
      }),
    );
    const current = memory.execute(
      MemoryOperationSchema.parse({
        kind: "memory",
        action: "search",
        scope: "workspace",
        query: "runtime version",
      }),
    ) as { memories: unknown[] };
    expect(current.memories).toHaveLength(1);
    expect(JSON.stringify(current)).toContain("version two");
    expect(JSON.stringify(current)).not.toContain("version one");
    expect(JSON.stringify(current)).not.toContain("Do not retrieve");
    expect(() =>
      memory.execute(
        MemoryOperationSchema.parse({
          kind: "memory",
          action: "put",
          scope: "workspace",
          id: first.id,
          key: "runtime",
          value: "Try to revive version one",
        }),
      ),
    ).toThrow("memory_superseded_record_immutable");
  });

  it("cannot delete or overwrite a record through a different scope", () => {
    store = new SqliteStore(":memory:");
    const memory = new LocalMemory(store);
    const inserted = memory.execute(
      MemoryOperationSchema.parse({
        kind: "memory",
        action: "put",
        scope: "workspace",
        key: "isolated",
        value: "workspace only",
      }),
    ) as { id: string };
    const wrongScopeDelete = memory.execute(
      MemoryOperationSchema.parse({
        kind: "memory",
        action: "delete",
        scope: "user",
        id: inserted.id,
      }),
    );
    expect(wrongScopeDelete.deleted).toBe(false);
    expect(store.getMemory(inserted.id)?.value).toBe("workspace only");
    expect(() =>
      memory.execute(
        MemoryOperationSchema.parse({
          kind: "memory",
          action: "put",
          scope: "user",
          id: inserted.id,
          key: "isolated",
          value: "cross-scope overwrite",
        }),
      ),
    ).toThrow("memory_scope_mismatch");
  });

  it("reclaims unreachable records on the next write", () => {
    store = new SqliteStore(":memory:");
    const memory = new LocalMemory(store, { maxAgeDays: 0, maxPerScope: 0 });
    store.putMemory({
      id: "00000000-0000-4000-8000-0000000000e1",
      scope: "workspace",
      key: "stale",
      value: "already expired",
      source: "test",
      confidence: 0.5,
      tags: [],
      expiresAt: "2000-01-01T00:00:00.000Z",
      createdAt: "2000-01-01T00:00:00.000Z",
      updatedAt: "2000-01-01T00:00:00.000Z",
    });
    // Nothing reads it, but until a write happens nothing removes it either.
    expect(store.listMemories("workspace", 10)).toHaveLength(0);
    expect(
      store.getMemory("00000000-0000-4000-8000-0000000000e1"),
    ).toBeDefined();

    const result = memory.execute(
      MemoryOperationSchema.parse({
        kind: "memory",
        action: "put",
        scope: "workspace",
        key: "fresh",
        value: "still here",
      }),
    );
    expect(result.compacted).toEqual({
      expired: 1,
      superseded: 0,
      evicted: 0,
    });
    expect(
      store.getMemory("00000000-0000-4000-8000-0000000000e1"),
    ).toBeUndefined();
    expect(store.listMemories("workspace", 10)).toHaveLength(1);
  });
});
