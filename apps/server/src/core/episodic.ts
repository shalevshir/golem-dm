// Episodic memory's composition point. This is the one place the embedding
// adapter (`@ai-dm/agents`) and the vector store (`@ai-dm/memory`) meet —
// they cannot import each other (invariant 5), and they do not need to: the
// store takes vectors, so `apps/server` embeds and then writes.
import { createDeterministicSceneSummary } from "@ai-dm/agents";
import type { EmbeddingPort, EmbeddingSpec, SceneSummaryInput, SceneSummaryPort } from "@ai-dm/agents";
import type { EpisodicStore } from "@ai-dm/memory";
import type { EpisodicMemory, FactionBand } from "@ai-dm/schemas";

/**
 * A summary, unconditionally. The model supplies the interpretive content
 * that makes a memory worth retrieving; the deterministic skeleton
 * guarantees a row exists when it cannot — so an episode is never lost to a
 * provider outage, a missing key, or a spent deadline.
 */
export async function summarizeEpisode(args: {
  summary: SceneSummaryPort;
  input: SceneSummaryInput;
}): Promise<string> {
  const fallback = async (): Promise<string> =>
    (await createDeterministicSceneSummary().summarize(args.input)) ?? args.input.contextEnglish;

  try {
    const summary = await args.summary.summarize(args.input);
    return summary ?? (await fallback());
  } catch {
    // A summarizer failure must not fail the turn that closed the episode.
    return fallback();
  }
}

/**
 * Embed, then write. Best-effort on purpose: the summary is already durable
 * in the event log by the time this runs, so a failure here costs retrieval
 * quality until the next reindex and costs correctness nothing (invariant 3).
 * It must never throw into the turn pipeline.
 */
export async function indexEpisode(args: {
  store: EpisodicStore;
  embedding: EmbeddingPort;
  spec: EmbeddingSpec;
  record: EpisodicMemory;
  onUsage?: (usage: { promptTokens: number; completionTokens: number; totalTokens: number }) => void;
}): Promise<void> {
  try {
    const result = await args.embedding.embed(args.spec, [args.record.summaryEnglish]);
    if (!result.ok) return;
    args.onUsage?.(result.value.usage);

    const vector = result.value.vectors[0];
    if (vector === undefined) return;

    await args.store.write(args.record, vector);
  } catch {
    // Swallowed deliberately — see the doc comment above.
  }
}

/**
 * The `limit` nearest episodes' summaries, or an empty list on any failure.
 * Retrieval is a prompt-quality nicety; it never blocks or fails a turn.
 */
export async function retrieveMemories(args: {
  store: EpisodicStore;
  embedding: EmbeddingPort;
  spec: EmbeddingSpec;
  campaignId: string;
  queryEnglish: string;
  limit: number;
  onUsage?: (usage: { promptTokens: number; completionTokens: number; totalTokens: number }) => void;
}): Promise<string[]> {
  try {
    const result = await args.embedding.embed(args.spec, [args.queryEnglish]);
    if (!result.ok) return [];
    args.onUsage?.(result.value.usage);

    const vector = result.value.vectors[0];
    if (vector === undefined) return [];

    const hits = await args.store.search(args.campaignId, vector, args.limit);
    return hits.map((hit) => hit.memory.summaryEnglish);
  } catch {
    return [];
  }
}

export interface NpcMemory {
  nameEnglish: string;
  band: FactionBand;
  facts: readonly string[];
}

/**
 * One English list from both memory sources. Authored NPC facts come first
 * because they are certain; retrieved episodes follow because they are not.
 * The narrator sees one block — the provenance split matters to us, not to
 * the prompt.
 */
export function memoryLines(args: {
  npcs: readonly NpcMemory[];
  retrieved: readonly string[];
}): string[] {
  const npcLines = args.npcs.map((npc) =>
    [`${npc.nameEnglish} regards you as ${npc.band}.`, ...npc.facts].join(" "),
  );

  return [...npcLines, ...args.retrieved];
}
