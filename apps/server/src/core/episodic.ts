// Episodic memory's composition point. This is the one place the embedding
// adapter (`@ai-dm/agents`) and the vector store (`@ai-dm/memory`) meet —
// they cannot import each other (invariant 5), and they do not need to: the
// store takes vectors, so `apps/server` embeds and then writes.
import { createDeterministicSceneSummary } from "@ai-dm/agents";
import type { EmbeddingPort, EmbeddingSpec, SceneSummaryInput, SceneSummaryPort } from "@ai-dm/agents";
import type { EpisodicStore } from "@ai-dm/memory";
import type { EpisodicMemory, FactionBand } from "@ai-dm/schemas";

/**
 * A unique per-import sentinel, not a string: neither `SceneSummaryPort.summarize`
 * nor `EmbeddingPort.embed` exposes an `AbortSignal` on its interface (that
 * would reach back into Tasks 2/5's port shapes, out of this task's scope),
 * so a stall is bounded from the outside with `Promise.race` against a
 * timer instead. A `Symbol` can never collide with a real return value the
 * way a string sentinel like `"timeout"` theoretically could.
 */
const DEADLINE_TIMEOUT = Symbol("episodic-deadline-timeout");

/**
 * Races `promise` against `deadline` (an absolute `Date.now()`-style
 * timestamp, matching `pipeline.ts`'s own convention — never a duration).
 * Resolves to `DEADLINE_TIMEOUT` if the deadline passes first; otherwise
 * settles exactly as `promise` does, rejection included, so each caller's
 * own `try`/`catch` still catches a real failure. A timed-out `promise`
 * itself is not cancelled (neither port takes an `AbortSignal`) — it is
 * simply no longer awaited, the same "abandon rather than force-cancel"
 * posture `untilDeadline` above documents for the narration ladder.
 */
function raceDeadline<T>(promise: Promise<T>, deadline: number): Promise<T | typeof DEADLINE_TIMEOUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof DEADLINE_TIMEOUT>((resolve) => {
    timer = setTimeout(
      () => {
        resolve(DEADLINE_TIMEOUT);
      },
      Math.max(0, deadline - Date.now()),
    );
  });
  // `Promise.race` lets a `promise` rejection propagate untouched — no
  // manual `reject()` call here to (mis)construct a rejection reason from.
  return Promise.race([promise, timeout]).finally(() => {
    clearTimeout(timer);
  });
}

/**
 * A summary, unconditionally. The model supplies the interpretive content
 * that makes a memory worth retrieving; the deterministic skeleton
 * guarantees a row exists when it cannot — so an episode is never lost to a
 * provider outage, a missing key, or a spent deadline. `deadline` binds this
 * to the turn's own budget (spec: "under its own deadline") — a summarizer
 * that stalls degrades to the deterministic fallback exactly like a `null`
 * or a throw, rather than hanging the turn that closed the episode.
 */
export async function summarizeEpisode(args: {
  summary: SceneSummaryPort;
  input: SceneSummaryInput;
  deadline: number;
}): Promise<string> {
  const fallback = async (): Promise<string> =>
    (await createDeterministicSceneSummary().summarize(args.input)) ?? args.input.contextEnglish;

  try {
    const summary = await raceDeadline(args.summary.summarize(args.input), args.deadline);
    return summary === DEADLINE_TIMEOUT || summary === null ? await fallback() : summary;
  } catch {
    // A summarizer failure must not fail the turn that closed the episode.
    return fallback();
  }
}

/**
 * Embed, then write. Best-effort on purpose: the summary is already durable
 * in the event log by the time this runs, so a failure here costs retrieval
 * quality until the next reindex and costs correctness nothing (invariant 3).
 * It must never throw into the turn pipeline, and it must never outlast the
 * turn's own deadline — a stalled embed call is treated exactly like a
 * failed one (`!result.ok`): nothing is written, and control returns to the
 * caller promptly.
 */
export async function indexEpisode(args: {
  store: EpisodicStore;
  embedding: EmbeddingPort;
  spec: EmbeddingSpec;
  record: EpisodicMemory;
  deadline: number;
  onUsage?: (usage: { promptTokens: number; completionTokens: number; totalTokens: number }) => void;
  /**
   * Fires with a failure code wherever this function would otherwise swallow
   * one silently — an `AdapterErrorCode` from a failed `embed()` call,
   * `"aborted"` for a deadline race lost, or a sensible ad hoc string
   * (`"no_vector"`, `"embed_failed"`) for the other branches. Purely a
   * signal: it changes nothing about how the turn degrades, only whether
   * anything downstream can tell "no memories yet" apart from "embedding has
   * been broken since deploy" (whole-branch review finding 2).
   */
  onFailure?: (code: string) => void;
}): Promise<void> {
  try {
    const result = await raceDeadline(
      args.embedding.embed(args.spec, [args.record.summaryEnglish]),
      args.deadline,
    );
    if (result === DEADLINE_TIMEOUT) {
      args.onFailure?.("aborted");
      return;
    }
    if (!result.ok) {
      args.onFailure?.(result.error.code);
      return;
    }
    args.onUsage?.(result.value.usage);

    const vector = result.value.vectors[0];
    if (vector === undefined) {
      args.onFailure?.("no_vector");
      return;
    }

    await args.store.write(args.record, vector);
  } catch {
    // Swallowed deliberately — see the doc comment above.
    args.onFailure?.("embed_failed");
  }
}

/**
 * The `limit` nearest episodes' summaries, or an empty list on any failure
 * — including a stalled embedding call past `deadline`, treated the same as
 * a failed one. Retrieval is a prompt-quality nicety; it never blocks or
 * fails a turn, and it must never be the reason a turn's narration is late.
 */
export async function retrieveMemories(args: {
  store: EpisodicStore;
  embedding: EmbeddingPort;
  spec: EmbeddingSpec;
  campaignId: string;
  queryEnglish: string;
  limit: number;
  deadline: number;
  onUsage?: (usage: { promptTokens: number; completionTokens: number; totalTokens: number }) => void;
  /** Same contract as `indexEpisode`'s `onFailure` — see its doc comment. */
  onFailure?: (code: string) => void;
}): Promise<string[]> {
  try {
    const result = await raceDeadline(args.embedding.embed(args.spec, [args.queryEnglish]), args.deadline);
    if (result === DEADLINE_TIMEOUT) {
      args.onFailure?.("aborted");
      return [];
    }
    if (!result.ok) {
      args.onFailure?.(result.error.code);
      return [];
    }
    args.onUsage?.(result.value.usage);

    const vector = result.value.vectors[0];
    if (vector === undefined) {
      args.onFailure?.("no_vector");
      return [];
    }

    const hits = await args.store.search(args.campaignId, vector, args.limit);
    return hits.map((hit) => hit.memory.summaryEnglish);
  } catch {
    args.onFailure?.("embed_failed");
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
