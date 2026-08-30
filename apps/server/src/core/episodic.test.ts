import { describe, expect, it } from "vitest";
import { createInMemoryEpisodicStore } from "@ai-dm/memory";
import { DEFAULT_EMBEDDING_SPEC, createFakeEmbeddingPort } from "@ai-dm/agents";
import { indexEpisode, memoryLines, retrieveMemories, summarizeEpisode } from "./episodic.js";

/** Far enough out that no test below can plausibly hit it. */
const FAR_FUTURE = Date.now() + 60_000;
/** Already past — `raceDeadline`'s timer fires on the next tick either way. */
const ALREADY_PAST = Date.now() - 1;
/** A promise that never settles — the stand-in for a hung provider call. */
function hangs<T>(): Promise<T> {
  return new Promise<T>(() => {
    // Deliberately never resolves or rejects.
  });
}

describe("summarizeEpisode", () => {
  it("uses the model's summary when it returns one", async () => {
    const summary = await summarizeEpisode({
      summary: { summarize: () => Promise.resolve("The gate opened.") },
      input: {
        kind: "quest_node",
        contextEnglish: "The weir.",
        factsEnglish: ["Node completed: quiet-word."],
        recentNarrations: [],
      },
      deadline: FAR_FUTURE,
    });

    expect(summary).toBe("The gate opened.");
  });

  it("falls back to the deterministic summary when the model returns null", async () => {
    const summary = await summarizeEpisode({
      summary: { summarize: () => Promise.resolve(null) },
      input: {
        kind: "quest_node",
        contextEnglish: "The weir.",
        factsEnglish: ["Node completed: quiet-word."],
        recentNarrations: [],
      },
      deadline: FAR_FUTURE,
    });

    expect(summary).toBe("The weir. Node completed: quiet-word.");
  });

  it("falls back when the model throws, rather than failing the turn", async () => {
    const summary = await summarizeEpisode({
      summary: { summarize: () => Promise.reject(new Error("boom")) },
      input: {
        kind: "encounter",
        contextEnglish: "An ambush.",
        factsEnglish: ["Outcome: victory."],
        recentNarrations: [],
      },
      deadline: FAR_FUTURE,
    });

    expect(summary).toBe("An ambush. Outcome: victory.");
  });

  it("falls back to the deterministic summary when the model call hangs past the deadline, rather than hanging the turn", async () => {
    const summary = await summarizeEpisode({
      summary: { summarize: () => hangs() },
      input: {
        kind: "encounter",
        contextEnglish: "An ambush.",
        factsEnglish: ["Outcome: victory."],
        recentNarrations: [],
      },
      deadline: ALREADY_PAST,
    });

    expect(summary).toBe("An ambush. Outcome: victory.");
  });
});

describe("indexEpisode", () => {
  it("embeds the summary and writes it so retrieval can find it", async () => {
    const store = createInMemoryEpisodicStore();
    const embedding = createFakeEmbeddingPort();
    const record = {
      campaignId: "c1",
      sequence: 4,
      kind: "quest_node" as const,
      refId: "weir",
      summaryEnglish: "Tobin opened the gate.",
      day: 2,
    };

    await indexEpisode({ store, embedding, spec: DEFAULT_EMBEDDING_SPEC, record, deadline: FAR_FUTURE });

    // The fake port is deterministic, so embedding the same text again gets
    // back the exact vector the record was written under.
    const query = await embedding.embed(DEFAULT_EMBEDDING_SPEC, ["Tobin opened the gate."]);
    expect(query.ok).toBe(true);
    if (!query.ok) return;
    const queryVector = query.value.vectors[0] ?? [];

    const hits = await store.search("c1", queryVector, 3);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.memory.summaryEnglish).toBe("Tobin opened the gate.");
    expect(hits[0]?.score).toBeCloseTo(1, 5);
  });

  it("reports the embedding's usage to its caller", async () => {
    const store = createInMemoryEpisodicStore();
    const embedding = createFakeEmbeddingPort();
    let reported = 0;

    await indexEpisode({
      store,
      embedding,
      spec: DEFAULT_EMBEDDING_SPEC,
      record: {
        campaignId: "c1",
        sequence: 4,
        kind: "quest_node" as const,
        refId: "weir",
        summaryEnglish: "Tobin opened the gate.",
        day: 2,
      },
      deadline: FAR_FUTURE,
      onUsage: (usage) => {
        reported = usage.totalTokens;
      },
    });

    expect(reported).toBeGreaterThan(0);
  });

  it("writes nothing and does not throw when embedding fails", async () => {
    const store = createInMemoryEpisodicStore();
    const failing = {
      embed: () =>
        Promise.resolve({ ok: false as const, error: { code: "provider_error" as const, message: "down" } }),
    };

    await indexEpisode({
      store,
      embedding: failing,
      spec: DEFAULT_EMBEDDING_SPEC,
      record: {
        campaignId: "c1",
        sequence: 4,
        kind: "quest_node" as const,
        refId: "weir",
        summaryEnglish: "Tobin opened the gate.",
        day: 2,
      },
      deadline: FAR_FUTURE,
    });

    expect(await store.search("c1", [1, 0, 0], 3)).toEqual([]);
  });

  it("reports the embedding's AdapterErrorCode through onFailure, not just silence", async () => {
    const store = createInMemoryEpisodicStore();
    const failing = {
      embed: () =>
        Promise.resolve({ ok: false as const, error: { code: "provider_error" as const, message: "down" } }),
    };
    let reported: string | undefined;

    await indexEpisode({
      store,
      embedding: failing,
      spec: DEFAULT_EMBEDDING_SPEC,
      record: {
        campaignId: "c1",
        sequence: 4,
        kind: "quest_node" as const,
        refId: "weir",
        summaryEnglish: "Tobin opened the gate.",
        day: 2,
      },
      deadline: FAR_FUTURE,
      onFailure: (code) => {
        reported = code;
      },
    });

    expect(reported).toBe("provider_error");
  });

  it("writes nothing and does not throw or hang when the embedding call hangs past the deadline", async () => {
    const store = createInMemoryEpisodicStore();
    const hanging = { embed: () => hangs<never>() };

    await indexEpisode({
      store,
      embedding: hanging,
      spec: DEFAULT_EMBEDDING_SPEC,
      record: {
        campaignId: "c1",
        sequence: 4,
        kind: "quest_node" as const,
        refId: "weir",
        summaryEnglish: "Tobin opened the gate.",
        day: 2,
      },
      deadline: ALREADY_PAST,
    });

    expect(await store.search("c1", [1, 0, 0], 3)).toEqual([]);
  });

  // Code review finding: a `store.write` throw used to be caught by the
  // same generic handler as an embedding failure, reporting "embed_failed"
  // regardless of which call actually failed — misdirecting anyone
  // debugging a store outage toward the wrong subsystem.
  it("reports a store write failure as \"store_failed\", distinct from an embedding failure", async () => {
    const embedding = createFakeEmbeddingPort();
    const failingStore = {
      write: () => Promise.reject(new Error("connection refused")),
      search: () => Promise.resolve([]),
    };
    let reported: string | undefined;

    await indexEpisode({
      store: failingStore,
      embedding,
      spec: DEFAULT_EMBEDDING_SPEC,
      record: {
        campaignId: "c1",
        sequence: 4,
        kind: "quest_node" as const,
        refId: "weir",
        summaryEnglish: "Tobin opened the gate.",
        day: 2,
      },
      deadline: FAR_FUTURE,
      onFailure: (code) => {
        reported = code;
      },
    });

    expect(reported).toBe("store_failed");
  });
});

describe("retrieveMemories", () => {
  it("returns the nearest summaries as rendered English lines", async () => {
    const store = createInMemoryEpisodicStore();
    const embedding = createFakeEmbeddingPort();

    await indexEpisode({
      store,
      embedding,
      spec: DEFAULT_EMBEDDING_SPEC,
      record: {
        campaignId: "c1",
        sequence: 4,
        kind: "quest_node" as const,
        refId: "weir",
        summaryEnglish: "Goblins were driven off at the weir.",
        day: 2,
      },
      deadline: FAR_FUTURE,
    });

    const lines = await retrieveMemories({
      store,
      embedding,
      spec: DEFAULT_EMBEDDING_SPEC,
      campaignId: "c1",
      queryEnglish: "Goblins were driven off at the weir.",
      limit: 3,
      deadline: FAR_FUTURE,
    });

    expect(lines).toEqual(["Goblins were driven off at the weir."]);
  });

  it("returns an empty list, not a throw, when embedding fails", async () => {
    const store = createInMemoryEpisodicStore();
    const failing = {
      embed: () =>
        Promise.resolve({ ok: false as const, error: { code: "provider_error" as const, message: "down" } }),
    };

    const lines = await retrieveMemories({
      store,
      embedding: failing,
      spec: DEFAULT_EMBEDDING_SPEC,
      campaignId: "c1",
      queryEnglish: "anything",
      limit: 3,
      deadline: FAR_FUTURE,
    });

    expect(lines).toEqual([]);
  });

  it("reports a deadline loss through onFailure as \"aborted\"", async () => {
    const store = createInMemoryEpisodicStore();
    const hanging = { embed: () => hangs<never>() };
    let reported: string | undefined;

    const lines = await retrieveMemories({
      store,
      embedding: hanging,
      spec: DEFAULT_EMBEDDING_SPEC,
      campaignId: "c1",
      queryEnglish: "anything",
      limit: 3,
      deadline: ALREADY_PAST,
      onFailure: (code) => {
        reported = code;
      },
    });

    expect(lines).toEqual([]);
    expect(reported).toBe("aborted");
  });

  it("returns an empty list, not a hang, when the embedding call hangs past the deadline", async () => {
    const store = createInMemoryEpisodicStore();
    const hanging = { embed: () => hangs<never>() };

    const lines = await retrieveMemories({
      store,
      embedding: hanging,
      spec: DEFAULT_EMBEDDING_SPEC,
      campaignId: "c1",
      queryEnglish: "anything",
      limit: 3,
      deadline: ALREADY_PAST,
    });

    expect(lines).toEqual([]);
  });

  // Code review finding: same conflation as `indexEpisode`'s — a
  // `store.search` throw used to be reported as "embed_failed".
  it("reports a store search failure as \"store_failed\", distinct from an embedding failure", async () => {
    const embedding = createFakeEmbeddingPort();
    const failingStore = {
      write: () => Promise.resolve(),
      search: () => Promise.reject(new Error("connection refused")),
    };
    let reported: string | undefined;

    const lines = await retrieveMemories({
      store: failingStore,
      embedding,
      spec: DEFAULT_EMBEDDING_SPEC,
      campaignId: "c1",
      queryEnglish: "anything",
      limit: 3,
      deadline: FAR_FUTURE,
      onFailure: (code) => {
        reported = code;
      },
    });

    expect(lines).toEqual([]);
    expect(reported).toBe("store_failed");
  });
});

describe("memoryLines", () => {
  it("renders an NPC's band and facts as English lines", () => {
    const lines = memoryLines({
      npcs: [{ nameEnglish: "Tobin", band: "friendly", facts: ["You mended his weir."] }],
      retrieved: [],
    });

    expect(lines).toEqual(["Tobin regards you as friendly. You mended his weir."]);
  });

  it("appends retrieved episodes after the authored facts", () => {
    const lines = memoryLines({
      npcs: [{ nameEnglish: "Tobin", band: "neutral", facts: [] }],
      retrieved: ["Goblins were driven off at the weir."],
    });

    expect(lines).toEqual([
      "Tobin regards you as neutral.",
      "Goblins were driven off at the weir.",
    ]);
  });

  it("is empty when nothing is known", () => {
    expect(memoryLines({ npcs: [], retrieved: [] })).toEqual([]);
  });
});
