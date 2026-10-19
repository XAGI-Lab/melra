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

  it("redacts the key, source and tags too", () => {
    store = new SqliteStore(":memory:");
    const memory = new LocalMemory(store);
    const token = ["ghp", "123456789012345678901234"].join("_");
    memory.execute(
      MemoryOperationSchema.parse({
        kind: "memory",
        action: "put",
        id: "00000000-0000-4000-8000-000000000042",
        scope: "workspace",
        key: `deploy token ${token}`,
        value: "Safe value",
        source: `copied from GITHUB_TOKEN=${token}`,
        tags: [token, "ops"],
      }),
    );
    const persisted = store.getMemory("00000000-0000-4000-8000-000000000042");
    expect(JSON.stringify(persisted)).not.toContain(token);
    expect(persisted?.tags).toContain("ops");
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

  it("edits a superseding record without losing it or the one it replaced", () => {
    store = new SqliteStore(":memory:");
    const memory = new LocalMemory(store);
    const put = (fields: Record<string, unknown>) =>
      memory.execute(
        MemoryOperationSchema.parse({ kind: "memory", action: "put", scope: "workspace", key: "runtime", ...fields }),
      ) as { id: string };
    const first = put({ value: "Use version one" });
    const second = put({ value: "Use version two", supersedesId: first.id });
    // The obvious edit: send the record's own fields back, supersedesId included.
    put({ id: second.id, value: "Use version two (fixed)", supersedesId: first.id });
    expect(store.getMemory(second.id)?.value).toBe("Use version two (fixed)");
    expect(store.getMemory(first.id)?.supersededBy).toBe(second.id);
    // A third record cannot supersede what is already superseded, and trying
    // leaves the current one alone.
    expect(() => put({ value: "Use version three", supersedesId: first.id })).toThrow(
      "memory_supersedes_target_invalid",
    );
    expect(store.getMemory(second.id)?.value).toBe("Use version two (fixed)");
  });

  it("brings back what a deleted or edited-away correction replaced", () => {
    store = new SqliteStore(":memory:");
    const memory = new LocalMemory(store);
    const run = (fields: Record<string, unknown>) =>
      memory.execute(MemoryOperationSchema.parse({ kind: "memory", scope: "workspace", ...fields }));
    const put = (fields: Record<string, unknown>) =>
      run({ action: "put", key: "runtime", ...fields }) as { id: string };
    const listed = () =>
      (run({ action: "list" }) as { memories: { id: string }[] }).memories.map(({ id }) => id).sort();

    const first = put({ value: "Use version one" });
    const second = put({ value: "Use version two", supersedesId: first.id });
    expect(listed()).toEqual([second.id]);
    // Undoing a mistaken correction used to leave the original hidden for
    // good: unreadable, immutable, impossible to supersede, then compacted.
    run({ action: "delete", id: second.id });
    expect(listed()).toEqual([first.id]);
    put({ id: first.id, value: "Use version one, still" });
    const third = put({ value: "Use version three", supersedesId: first.id });
    expect(listed()).toEqual([third.id]);
    // An edit that stops superseding it hands it back the same way.
    put({ id: third.id, value: "Use version three, on its own" });
    expect(listed()).toEqual([first.id, third.id].sort());
  });

  it("links a chain around a deleted middle record, and keeps an expired correction's original retired", async () => {
    store = new SqliteStore(":memory:");
    const memory = new LocalMemory(store);
    const run = (fields: Record<string, unknown>) =>
      memory.execute(MemoryOperationSchema.parse({ kind: "memory", scope: "workspace", ...fields }));
    const put = (fields: Record<string, unknown>) =>
      run({ action: "put", key: "runtime", ...fields }) as { id: string };
    const listed = () =>
      (run({ action: "list" }) as { memories: { value: string }[] }).memories.map(({ value }) => value).sort();

    const a = put({ value: "v1" });
    const b = put({ value: "v2", supersedesId: a.id });
    const c = put({ value: "v3", supersedesId: b.id });
    // Deleting the middle one revived v1 beside v3, its current replacement.
    run({ action: "delete", id: b.id });
    expect(listed()).toEqual(["v3"]);
    expect(store.getMemory(c.id)?.supersedesId).toBe(a.id);
    // The chain is whole again: undoing v3 brings back v1.
    run({ action: "delete", id: c.id });
    expect(listed()).toEqual(["v1"]);

    // A correction that expired after its put, deleted before any later put
    // compacts it away: the same as after, its original stays retired.
    const d = put({ key: "other", value: "w1" });
    const e = put({ key: "other", value: "w2", supersedesId: d.id, expiresAt: new Date(Date.now() + 200).toISOString() });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(store.getMemory(e.id)).toBeDefined();
    run({ action: "delete", id: e.id });
    expect(listed()).toEqual(["v1"]);

    // The same for one in the middle of a chain: deleting it before
    // compaction spliced the chain, and deleting its successor then revived
    // the original, which compaction removing it first never did.
    const f = put({ key: "third", value: "x1" });
    const g = put({ key: "third", value: "x2", supersedesId: f.id, expiresAt: new Date(Date.now() + 200).toISOString() });
    const h = put({ key: "third", value: "x3", supersedesId: g.id });
    await new Promise((resolve) => setTimeout(resolve, 300));
    run({ action: "delete", id: g.id });
    run({ action: "delete", id: h.id });
    expect(listed()).toEqual(["v1"]);

    // And for an edit of an expired correction that drops what it superseded.
    const k = put({ key: "fourth", value: "y1" });
    const m = put({ key: "fourth", value: "y2", supersedesId: k.id, expiresAt: new Date(Date.now() + 200).toISOString() });
    await new Promise((resolve) => setTimeout(resolve, 300));
    put({ id: m.id, key: "fourth", value: "y3" });
    expect(listed()).toEqual(["v1", "y3"]);
  });

  it("leaves what an expired correction replaced retired", () => {
    store = new SqliteStore(":memory:");
    const memory = new LocalMemory(store);
    const run = (fields: Record<string, unknown>) =>
      memory.execute(MemoryOperationSchema.parse({ kind: "memory", scope: "workspace", ...fields }));
    const first = run({ action: "put", key: "runtime", value: "Use version one" }) as { id: string };
    run({
      action: "put",
      key: "runtime",
      value: "Use version two until the migration",
      supersedesId: first.id,
      expiresAt: "2020-01-01T00:00:00.000Z",
    });
    // The lapse of a correction is not evidence the old fact is true again.
    run({ action: "put", key: "other", value: "Any write compacts the scope" });
    const { memories } = run({ action: "list", includeSuperseded: true }) as {
      memories: { id: string; key: string }[];
    };
    expect(memories.filter(({ key }) => key === "runtime").map(({ id }) => id)).toEqual([first.id]);
    expect(store.getMemory(first.id)?.supersededBy).toBeDefined();
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
