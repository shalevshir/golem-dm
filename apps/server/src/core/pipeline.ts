// The turn pipeline, as one async generator over ports. Order is fixed by
// `apps/server/CLAUDE.md`: input -> validate -> events appended before the ack
// -> narrative streams -> enemy turns.
//
// The rule that holds the whole thing together: appending an event and
// yielding its frame is ONE operation (`emit` below). No path may do one
// without the other, so the socket can never show an event that was not
// logged, or miss one that was.
//
// `clock`, `uuid` and `seedFor` are ports, not globals. That is what lets a
// test assert an exact event stream, and what makes a replayed campaign
// reproduce the fight rather than a new one.
//
// `join`, `free_text` and the player's own `structured_action` (Task 9) are
// followed by the hostile sweep and the per-turn narration timeout (Task 10),
// appended to the same `structured_action` case after a successful player
// turn.
import {
  abilityCheck,
  affinityOf,
  affordancesFor,
  applyTurn,
  availableEdges,
  completeCurrentNode,
  DC_BY_DIFFICULTY,
  diffScene,
  rollDeathSave,
  sceneStateFrom,
  seeded,
  traverseEdge,
  validateExecuteTurn,
} from "@ai-dm/rules-engine";
import type { AuthoredWorld, SceneTransition, TurnEffect } from "@ai-dm/rules-engine";
import {
  availableActionsFor,
  buildNarrationBrief,
  createDeterministicNarrative,
  createDeterministicSceneNarrative,
  DEFAULT_EMBEDDING_SPEC,
  INTENT_PROMPT_VERSION,
  NARRATIVE_PROMPT_VERSION,
  SCENE_PROMPT_VERSION,
} from "@ai-dm/agents";
import type {
  EmbeddingPort,
  IntentAgent,
  IntentResult,
  NarrativePort,
  SceneBeat,
  SceneNarrationInput,
  SceneNarrativePort,
  SceneSummaryPort,
  TacticalAgent,
  TurnProposalFailure,
  TurnProposalResult,
  TurnProposalSource,
} from "@ai-dm/agents";
import {
  EventStoreUnavailableError,
  SequenceConflictError,
  CampaignMismatchError,
} from "@ai-dm/memory";
import type { EpisodicStore, EventStore } from "@ai-dm/memory";
import { CheckRolledPayload, conclusionOf, IntentClassifiedPayload, reduce } from "@ai-dm/schemas";
import { indexEpisode, memoryLines, retrieveMemories, summarizeEpisode } from "./episodic.js";
import type {
  AbilityKey,
  CampaignState,
  ClientMessage,
  Condition,
  DerivedCharacter,
  EntityStatus,
  GameEvent,
  NarrationSource,
  SceneSnapshot,
  ServerFrame,
  Skill,
} from "@ai-dm/schemas";
import { builtOf, encounterOf, NARRATION_WINDOW, sceneStaticsOf, worldFor } from "./campaign.js";
import type { Campaign } from "./campaign.js";
import { buildEncounterById } from "../encounters/index.js";

/** `apps/server/CLAUDE.md`: snapshot every 50 events. */
export const SNAPSHOT_EVERY = 50;

/**
 * Per-turn tactical-agent metrics (`apps/server/CLAUDE.md`: "tokens in/out,
 * cached tokens, latency, retries, cost ... emitted as structured logs from
 * day one"). Recorded only for turns that actually called the tactical
 * agent — a player's `structured_action` makes no model call and has
 * nothing to report.
 *
 * Two of the spec's five fields are deliberately absent:
 * - Cached tokens: `TokenUsage` (`packages/agents/src/providers/usage.ts`)
 *   is exactly `{ promptTokens, completionTokens, totalTokens }` — no
 *   cache-read field exists anywhere in the port layer to report.
 * - Cost: the pricing table lives in `tools/sim`, which nothing under
 *   `apps/server` may depend on (dependency direction, root CLAUDE.md §5).
 *   A cost figure computed from `TokenUsage` alone would also be *wrong*,
 *   not merely missing — cache reads bill differently and nothing here
 *   reports them.
 */
export interface TacticalTurnMetrics {
  actorId: string;
  /**
   * "ok" when a legal turn came back (whatever produced it — see `source`);
   * otherwise the failure `kind` from `TurnProposalFailure`. Kept separate
   * from `source` rather than folded into it: this dimension is "did the
   * turn resolve," `source` below is "which call produced it," and
   * conflating them made a failed proposal read as if it named a model
   * tier it never actually had.
   */
  outcome: "ok" | TurnProposalFailure["kind"];
  /**
   * Present only when `outcome === "ok"` — `TurnProposalFailure` carries no
   * model tier to report, so there is nothing honest to put here for
   * `aborted`/`no_legal_turn`.
   */
  source?: TurnProposalSource;
  /**
   * `usage.length`: attempts the provider actually BILLED for, not every
   * attempt the agent made. `createTacticalAgent`'s attempt loop
   * (`packages/agents/src/tactical/index.ts`) only pushes onto `usage`
   * `if (result.error.usage !== undefined)` — an attempt that failed before
   * the provider reported any usage (e.g. `provider_error`) contributes no
   * entry, so `usage.length` can undercount attempts. `index.test.ts`'s
   * "does not invent usage for a rejection the provider did not price" pins
   * exactly this: a two-attempt run reporting `usage.length === 1`. Named
   * for what it actually measures rather than "attempts".
   */
  billedAttempts: number;
  /**
   * `proposal.rejections.length`: every attempt the agent made, billed or
   * not — the true retry count the metrics contract asks for, which
   * `billedAttempts` alone would silently undercount whenever an attempt
   * failed unbilled.
   */
  retries: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Wall time around this turn's `tactical.proposeTurn` call. */
  latencyMs: number;
}

/**
 * Per-turn narrative-agent metrics, mirroring `TacticalTurnMetrics` above for
 * the other agent role. Deliberately NOT `NarrativeFinish` (`@ai-dm/agents`)
 * plus an `actorId` — that type's `usage`/`error` fields come from the
 * Hebrew agent's own `onFinish` callback (wired separately in `main.ts`),
 * which the pipeline never sees, and neither field exists at all when a
 * fallback rung produced the turn with no model call behind it. What the
 * pipeline itself knows, for every narrated turn regardless of which rung
 * produced it, is exactly these four fields.
 */
export interface NarrativeTurnMetrics {
  actorId: string;
  /** Which rung of the degradation ladder produced this narration. */
  source: NarrationSource;
  /** Wall time, via `ports.clock()`, around the narration for this turn. */
  latencyMs: number;
  promptVersion: string;
}

/**
 * Per-call intent-router metrics, mirroring `TacticalTurnMetrics`'s shape for
 * a third model tier. `outcome` is `"ok"` or an `AdapterErrorCode` — the same
 * "resolution vs. producer" split `TacticalTurnMetrics.outcome` documents,
 * kept as an open `string` for the reason `ActionRejectedPayload`'s own codes
 * are: a closed enum here becomes a migration the first time an adapter code
 * is added, and this type has no dependency-direction reason to import one
 * from `@ai-dm/agents` anyway.
 */
export interface IntentCallMetrics {
  /** `"ok"`, or an `AdapterErrorCode` on failure — an open `string` since a
   *  `"ok" | AdapterErrorCode` union collapses to `string` anyway. */
  outcome: string;
  /** Present only when `outcome === "ok"` — a failed call classified nothing. */
  category?: string;
  latencyMs: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/**
 * The fourth billed source. `outcome` is `"ok"` or an `AdapterErrorCode`,
 * an open `string` for the same reason `IntentCallMetrics.outcome` is.
 */
export interface SummaryCallMetrics {
  outcome: string;
  /** `"model"` when the tier produced the summary, `"deterministic"` when it fell back. */
  source: string;
  promptVersion: string;
  latencyMs: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/**
 * The fifth. `completionTokens` is always 0 — an embedding bills input only,
 * which is truthful rather than a gap.
 *
 * Cost is still not computed here: `cache_read_input_tokens` is unreported
 * and the pricing table lives in `tools/sim`, which this app may not import.
 * These are tokens and latency only, so step 11's fix prices them without
 * touching these call sites (episodic-memory spec, Decision 11).
 */
export interface EmbeddingCallMetrics {
  outcome: string;
  /** `"index"` when writing a closed episode, `"retrieve"` when reading on node entry. */
  purpose: string;
  latencyMs: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/** A `putSnapshot` rejection, contained inside `emit` — see `MetricsPort`. */
export interface SnapshotFailureRecord {
  campaignId: string;
  /** The log sequence the failed snapshot would have reflected. */
  sequence: number;
  /** Whatever the store rejected with; `EventStoreUnavailableError` in practice. */
  error: unknown;
}

/**
 * Where the metrics go is a transport decision, not a core one: core calls
 * this port, the transport decides it writes a structured log line. Reading
 * `TimingPort.timings` from the transport instead was rejected — it is an
 * append-only array with no drain/reset API and carries no token counts, so
 * tokens have to be threaded out of the pipeline regardless, and one
 * mechanism beats two. Optional so the pre-existing pipeline tests, and
 * Task 15, need not supply one.
 */
export interface MetricsPort {
  recordTacticalTurn(metrics: TacticalTurnMetrics): void;
  /**
   * A snapshot write that failed. Optional, unlike its two siblings, so that
   * adding it did not invalidate every existing `MetricsPort` implementation
   * — call it through `?.` on both the port and the method.
   *
   * Not a turn metric but an operational one: `emit` contains this failure
   * deliberately (a snapshot is a cache, never authority), which means the
   * turn completes normally and nothing else in the system would ever say
   * that the durable store rejected a write.
   */
  recordSnapshotFailure?(record: SnapshotFailureRecord): void;
  /**
   * One call per narrated turn, from `narrate()` below — the only place
   * that knows both which actor is narrating and which rung produced the
   * text. Without this, a narration that died mid-stream and fell back to
   * the deterministic renderer is indistinguishable in the log from one
   * that streamed cleanly from the model: `apps/server/CLAUDE.md` requires
   * per-turn per-agent instrumentation, and `source` here is what makes
   * that distinction visible.
   */
  recordNarrativeTurn(record: NarrativeTurnMetrics): void;
  /**
   * One call per `free_text` turn that reached the intent router — the third
   * model tier §4.7 calls out as unreportable by construction until step 11's
   * fix. Optional for the same reason `recordSnapshotFailure` is: it must not
   * invalidate a `MetricsPort` implementation written before this task.
   */
  recordIntentCall?(record: IntentCallMetrics): void;
  /**
   * The summary tier's per-call metrics, mirroring its four siblings' shape.
   * Not yet called from `handleCommand`: `SceneSummaryPort.summarize`
   * (`@ai-dm/agents`, Task 5) reports no token usage or source to its
   * caller, so there is nothing truthful to put in `promptTokens` or
   * `source` at a call site today — reporting zeros would misrepresent a
   * real cost, the opposite of `EmbeddingCallMetrics.completionTokens`'s
   * honest zero. Declared now so the type exists the day that port grows a
   * usage-reporting return value; optional for the same reason
   * `recordIntentCall` is.
   */
  recordSummaryCall?(record: SummaryCallMetrics): void;
  /**
   * One call per `indexEpisode`/`retrieveMemories` embedding call —
   * `purpose` tells the two apart. Optional for the same reason its four
   * siblings are.
   */
  recordEmbeddingCall?(record: EmbeddingCallMetrics): void;
}

export interface TurnPorts {
  store: EventStore;
  tactical: TacticalAgent;
  narrative: NarrativePort;
  /** The intent router — `free_text`'s classifier. */
  intent: IntentAgent;
  /** The out-of-combat narrator — `free_text`'s sibling of `narrative`. */
  sceneNarrative: SceneNarrativePort;
  /** Episodic memory's durable index — `@ai-dm/memory`. Never imported
   *  alongside `embedding` anywhere but here and `episodic.ts` (invariant 5). */
  episodic: EpisodicStore;
  /** Episodic memory's embedding adapter — `@ai-dm/agents`. */
  embedding: EmbeddingPort;
  /** The scene-summarizer tier that closes an episode. */
  summary: SceneSummaryPort;
  clock: () => string;
  uuid: () => string;
  /** Deterministic per turn. Recorded in `dice_rolled`; replay reads it back. */
  seedFor: (rootSeed: number, sequence: number) => number;
  turnTimeoutMs: number;
  /** Structured per-turn tactical metrics. Absent means no logging (tests). */
  metrics?: MetricsPort;
  /** Hebrew condition labels, from `loadConditions()`. A port, not a file read:
   *  the pipeline does no I/O of its own. */
  conditionNamesHebrew: ReadonlyMap<Condition, string>;
  /**
   * Governing ability per skill, from `SrdGear.skills` (`loadGear()`). A
   * port, not a file read, for the same reason `conditionNamesHebrew` is —
   * the `check` category (Task 10) needs
   * `DerivedCharacter.skills[skill]` when a skill is named and
   * `abilityModifiers[ability]` otherwise, and this is what tells it which
   * ability a named skill falls under.
   */
  skillAbilities: ReadonlyMap<Skill, AbilityKey>;
}

/** `structured_action` and `free_text` carry one; `join` does not. */
function clientMessageIdOf(command: ClientMessage): string | undefined {
  return command.type === "join" ? undefined : command.clientMessageId;
}

/**
 * Yields from `stream` until `deadline` (an absolute `Date.now()`-style
 * timestamp, NOT a duration) passes, then stops. A wedged provider must not
 * wedge the turn: `apps/server/CLAUDE.md` and the spec both describe ONE 10s
 * cap wrapping the tactical call and the narrative stream together, not two
 * independent budgets — so this takes the deadline the caller already
 * struck (shared with whatever else that turn is doing, see `enemyTurn`)
 * rather than starting its own clock from a duration.
 *
 * Whatever tokens arrived before the cap are kept — a partial sentence beats
 * an empty one, and the caller decides what to do when nothing arrived at
 * all.
 *
 * A naive version of this races `iterator.next()` against a fresh
 * `setTimeout` every loop iteration and never clears it on the fast path, so
 * a long stream leaves one live ~10s timer per chunk. Each iteration here
 * clears its own timer as soon as the race settles, win or lose, so nothing
 * outlives the loop.
 */
async function* untilDeadline(
  stream: AsyncIterable<string>,
  deadline: number,
): AsyncIterable<string> {
  const iterator = stream[Symbol.asyncIterator]();

  // Best-effort, deliberately NOT awaited: signals a cooperative stream (the
  // deterministic port never needs this; a real streaming provider does) to
  // release its connection instead of dangling forever with one abandoned
  // `next()`. A stream that is truly wedged is, by definition, stuck inside
  // an internal (non-yield) `await` its own generator body cannot unwind
  // from until that promise settles — so `iterator.return()` on it never
  // resolves either, and awaiting it here would hang this function forever,
  // exactly the failure this cap exists to prevent. Verified empirically:
  // for a generator suspended on a promise that never settles,
  // `await iterator.return()` itself never settles; for one merely mid-await
  // on something that will settle, `return()` correctly reaches and runs its
  // `finally` block once that step completes, without this caller waiting
  // on it.
  const abandon = (): void => {
    // One `?.` covers the whole chain: if `iterator.return` is absent the
    // call short-circuits to `undefined` and `.catch` is never reached; if
    // present, calling it always yields a `Promise` (never `undefined`), so
    // `.catch` needs no optional marker of its own.
    iterator.return?.().catch(() => {
      // Nothing to do with a rejection from a cancelled stream.
    });
  };

  // This loop has no bound of its own on how long it can be
  // suspended at `yield next.value` below, and abandoning early (a consumer
  // that `break`s out of its `for await`, which propagates `.return()` in
  // here) must still release `iterator` — the `for (;;)` body's own two
  // early-`return`s are not the only way out. Wrapping the whole loop in
  // `try`/`finally` covers all three exits (deadline elapsed, timeout,
  // upstream `.return()`) with the one `abandon()` call, so the two
  // early-exit branches no longer need their own.
  try {
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return;

      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => {
          resolve("timeout");
        }, remaining);
      });

      const next = await Promise.race([iterator.next(), timeout]);
      clearTimeout(timer);

      if (next === "timeout") return;
      if (next.done === true) return;
      yield next.value;
    }
  } finally {
    abandon();
  }
}

/**
 * Whether a narration ended on a sentence rather than mid-word.
 *
 * This is how the pipeline detects BOTH ways a narration comes up short — a
 * provider that errored mid-stream, and a deadline that cut it — with one
 * check. Neither cause is visible to the narrative port: the agent cannot see
 * the deadline, and `untilDeadline` cannot see the provider. What both leave
 * behind is the same artifact, an unterminated sentence, so that is what gets
 * inspected.
 *
 * Inspects a trimmed copy and never a stored one: `narrative_emitted` must
 * carry exactly the concatenation of the frames yielded for this turn.
 */
const NARRATION_TERMINATORS = [".", "!", "?", "…"] as const;

/**
 * `retrieveMemories`'s own sub-deadline inside `sceneNarrate`, capped well
 * under the turn's full `turnTimeoutMs` budget. Retrieval only enriches the
 * prompt with past episodes — losing it degrades to "no memories this turn",
 * a far better outcome than retrieval eating enough of the shared deadline
 * that narration itself has to fall back to deterministic prose (whole-
 * branch review finding 1).
 */
const RETRIEVAL_BUDGET_MS = 750;

function endsComplete(text: string): boolean {
  const trimmed = text.trimEnd();
  return trimmed !== "" && NARRATION_TERMINATORS.some((mark) => trimmed.endsWith(mark));
}

/**
 * The narration degradation ladder's result: the full text produced (the
 * primary stream plus, on a lower rung, whatever the fallback contributed)
 * and which rung produced it. Read back by the caller once `narrationLadder`
 * below has finished — see that function's doc comment for why this is an
 * out-parameter rather than a return value.
 */
interface LadderOutcome {
  text: string;
  source: NarrationSource;
}

/**
 * Streams `primary` until `deadline`, then applies the degradation ladder:
 * empty -> fallback; truncated -> seam + fallback completion. Yields
 * `narrative_token` frames only — the caller owns the `narrative_emitted`
 * emit and the metrics call, since only it knows the actor and the other
 * fields those need.
 *
 * Mutates `out` instead of returning a value. A generator's `return` value
 * is unreachable through `yield*` (the only way a caller can drive this and
 * still forward every frame it yields), so there is no way to hand back
 * `text`/`source` on completion except through a parameter the caller
 * already holds a reference to. Do not "fix" this into a return — that
 * value would be silently discarded by every `yield* narrationLadder(...)`
 * call site.
 */
async function* narrationLadder(args: {
  streamId: string;
  primary: AsyncIterable<string>;
  fallback: () => AsyncIterable<string>;
  deadline: number;
  out: LadderOutcome;
}): AsyncIterable<ServerFrame> {
  const { streamId, primary, fallback, deadline, out } = args;

  let text = "";
  for await (const chunk of untilDeadline(primary, deadline)) {
    text += chunk;
    yield { type: "narrative_token", streamId, text: chunk };
  }

  // The ladder. Neither rung is deadline-bound: `untilDeadline` has already
  // returned, template rendering cannot hang, and gating a fallback on a
  // spent deadline would produce a silent turn — which reads to a player as
  // a dropped connection.
  let source: NarrationSource = "model";

  if (text.trim() === "") {
    // Nothing arrived at all. Render the rule outcome through the terse,
    // always-available Hebrew port `apps/server/CLAUDE.md` names as the
    // fallback — still streamed as narrative_token frames, just from a
    // source that cannot itself hang.
    source = "deterministic";
  } else if (!endsComplete(text)) {
    // Tokens arrived and then stopped mid-sentence. Those tokens are
    // already on the player's screen and cannot be unsent, so the shortfall
    // is repaired by streaming MORE rather than by rewriting less. The
    // ellipsis marks the seam so a truncation reads as a truncation.
    source = "completed";
    const seam = "… ";
    text += seam;
    yield { type: "narrative_token", streamId, text: seam };
  }

  if (source !== "model") {
    for await (const chunk of fallback()) {
      text += chunk;
      yield { type: "narrative_token", streamId, text: chunk };
    }
  }

  out.text = text;
  out.source = source;
}

/**
 * A quest node's narration material: its own English scene card, its
 * location's Hebrew name, and the Hebrew names of every NPC authored at that
 * location. Shared by `sceneNarrate` (the top-level `SceneNarrationInput`
 * fields) and the `free_text` exploration case (the `arrived` beat's own
 * `sceneEnglish`/`locationNameHebrew`) so the two cannot read the node two
 * different ways.
 *
 * Throws on a dangling id rather than returning a default: `loadWorld`
 * refuses a `locationId` that does not resolve, so reaching either branch
 * here means a hand-built world or a corrupt `currentNodeId` — the same
 * corrupt-log posture `builtOf`/`sceneStaticsOf` take (`campaign.ts`).
 */
function questNodeCard(
  authored: AuthoredWorld,
  nodeId: string,
): {
  sceneEnglish: string;
  locationNameHebrew: string;
  npcNamesHebrew: string[];
  npcIds: string[];
} {
  const node = authored.questNodes.get(nodeId);
  if (node === undefined) {
    throw new Error(`No quest node "${nodeId}" in world ${authored.worldId}`);
  }
  const location = authored.locations.get(node.locationId);
  if (location === undefined) {
    throw new Error(`No location "${node.locationId}" in world ${authored.worldId}`);
  }
  const present = Array.from(authored.npcs.values()).filter(
    (npc) => npc.locationId === node.locationId,
  );
  return {
    sceneEnglish: node.sceneEnglish,
    locationNameHebrew: location.nameHebrew,
    npcNamesHebrew: present.map((npc) => npc.nameHebrew),
    npcIds: present.map((npc) => npc.npcId),
  };
}

/**
 * The ability a `check` category's roll and log entry are attributed to.
 * When the router names a skill, the engine's own skill→ability mapping
 * (`ports.skillAbilities`, from `SrdGear.skills`) governs — never the
 * model's own `ability` field — so the two cannot disagree (design spec
 * Decision 5: "the model chooses a word; the engine owns every number").
 * `skillAbilities` covers every `Skill` member (built from the same SRD
 * gear data `deriveCharacter` derives skills from in `main.ts`), so a lookup
 * miss here means a skill was added to the schema without adding it to that
 * data — the same corrupt-content posture `questNodeCard` takes on a
 * dangling node or location id.
 */
function checkAbilityFor(
  skillAbilities: ReadonlyMap<Skill, AbilityKey>,
  classification: { ability: AbilityKey; skill?: Skill | undefined },
): AbilityKey {
  if (classification.skill === undefined) return classification.ability;
  const ability = skillAbilities.get(classification.skill);
  if (ability === undefined) {
    throw new Error(`No governing ability for skill "${classification.skill}"`);
  }
  return ability;
}

/**
 * A check's modifier, straight off the derived sheet (design spec Decision
 * 6): `DerivedCharacter.skills[skill]` when a skill is named, else
 * `abilityModifiers[ability]` — both already fold ability score AND
 * proficiency in, so nothing here adds either a second time.
 *
 * `DerivedCharacter`'s zod schema types `skills`/`abilityModifiers` as
 * partial records (`z.record` over a closed enum widens to
 * `Partial<Record<...>>`), even though `deriveCharacter` always fills every
 * entry for every character it derives. The `??` fallback and the final
 * guard exist to satisfy that type, not because either lookup is expected to
 * miss at runtime — a miss means a corrupt `DerivedCharacter`, not a
 * legitimate "no modifier" case.
 */
function checkModifierFor(character: DerivedCharacter, ability: AbilityKey, skill?: Skill): number {
  const bySkill = skill === undefined ? undefined : character.skills[skill];
  const resolved = bySkill ?? character.abilityModifiers[ability];
  if (resolved === undefined) {
    throw new Error(`${character.characterId} has no modifier for ability "${ability}"`);
  }
  return resolved;
}

/**
 * A real, compiler-enforced exhaustiveness check — the "no `default`"
 * switches elsewhere in this codebase (`reduce.ts`, the scene engine's
 * `evaluatePredicate`/`describePredicate`/`applyEffect`) get this for free
 * because they are value-returning functions: a missing `case` there leaves
 * a code path with no `return`, which is TS2366 under `strictNullChecks`.
 * The `free_text` category switch (below) has no such function to lean on —
 * `handleCommand` is a generator, and nothing requires every branch to
 * "return a value" — so a missing case there would otherwise compile clean
 * and silently fall through. Called on the value TypeScript has narrowed to
 * `never` immediately after a switch whose cases cover every member of a
 * discriminated union: if a member is ever left unhandled, that value is no
 * longer `never` and this call fails to compile.
 */
function assertNever(value: never): never {
  throw new Error(`unreachable: ${JSON.stringify(value)}`);
}

export async function* handleCommand(
  campaign: Campaign,
  command: ClientMessage,
  ports: TurnPorts,
): AsyncIterable<ServerFrame> {
  /**
   * Append one event and yield its frame. The single place either happens.
   * Mutates the campaign in step so a later stage in the same turn reads the
   * state the earlier stage produced.
   */
  async function* emit(
    type: GameEvent["type"],
    payload: Record<string, unknown>,
  ): AsyncIterable<ServerFrame> {
    const event: GameEvent = {
      eventId: ports.uuid(),
      campaignId: campaign.state.world.campaignId,
      sequence: campaign.nextSequence,
      timestamp: ports.clock(),
      type,
      payload,
    };

    // Compute the projection BEFORE persisting anything. `reduce` throws on
    // a malformed player_input / state_delta_applied / scene_changed
    // payload (reduce.ts's `.parse` calls) — a throw here must fail
    // closed, before the event is written, not after. Otherwise a bad
    // payload lands in the log with no frame ever yielded for it, which is
    // exactly the append-without-yield window this function exists to rule
    // out. `reduce` is pure, so computing it early costs nothing and
    // changes no behaviour for event types it treats as a no-op.
    const next = reduce(campaign.state, event);

    await ports.store.append(campaign.state.world.campaignId, [event]);
    campaign.nextSequence += 1;
    campaign.state = next;
    yield { type: "event", event };

    if (event.sequence > 0 && event.sequence % SNAPSHOT_EVERY === 0) {
      // A cache, never authority: `loadCampaign` folds the log regardless.
      // Deliberately after the yield — nothing downstream reads it within
      // the same turn, so it must not sit inside the append-and-yield
      // window either.
      //
      // And its own `try`, so a cache write can never end a turn. The append
      // above already succeeded and `campaign.state`/`nextSequence` already
      // moved, so the turn's outer catch — whose whole justification is that
      // a failure there left the state untouched — is false on this path.
      // Letting an `EventStoreUnavailableError` from here reach it would
      // abort mid-turn with the log already advanced: if the crossing event
      // is the closing `scene_changed`, control has passed to a hostile and
      // `playerAffordances()` returns silently, so the client gets
      // `internal_error` and an inert board that a rejoin cannot repair
      // (`join` replays the same log and calls the same silent
      // `playerAffordances`); if it is `player_input`, the id is already in
      // `appliedClientMessageIds`, so a retry under the same
      // `clientMessageId` is dropped forever. A missing snapshot costs a
      // longer replay on the next reconnect and nothing else.
      try {
        await ports.store.putSnapshot(
          campaign.state.world.campaignId,
          event.sequence,
          campaign.state,
        );
      } catch (error) {
        // Reported, not swallowed: a store that has stopped accepting
        // snapshots is usually about to stop accepting appends, and this is
        // the earliest visible symptom. Through `ports.metrics` because the
        // pipeline does no I/O of its own — where the line goes is the
        // transport's decision (`MetricsPort`'s doc comment), and tests that
        // supply no metrics port simply see the failure contained.
        ports.metrics?.recordSnapshotFailure?.({
          campaignId: campaign.state.world.campaignId,
          sequence: event.sequence,
          error,
        });
      }
    }
  }

  /**
   * `emit`'s sibling for a group of events that must land in ONE append —
   * the fix for a hazard Task 9's review found: the `free_text` exploration
   * case is the first caller anywhere in this file that can produce MORE
   * THAN ONE state-changing scene event from a single engine transition
   * (`quest_node_completed`, optionally `world_delta_applied`, optionally
   * `quest_node_entered`). Three separate `emit` calls means three separate
   * `store.append`s; an `EventStoreUnavailableError` between the first and
   * the second would leave `quest_node_completed` durable with its
   * `world_delta_applied`/`quest_node_entered` never written — and because
   * `completed()` (the scene engine) short-circuits on
   * `completedNodeIds.has(...)`, no LATER turn can ever re-apply that
   * node's effects either. `EventStore.append` already takes an array, so
   * this batches the whole group into the one call that makes it atomic
   * from the store's point of view, same as combat's own multi-attack
   * `dice_rolled` is one event covering several rolls rather than several
   * events.
   *
   * Not a generalization of `emit`, and `emit` itself is untouched: this
   * exists so the ONE caller that needs group atomicity gets it, without
   * changing the append granularity (and therefore the snapshot-cadence
   * timing) of every existing single-event call site, combat's included.
   *
   * Mirrors `emit`'s two invariants, extended across the group: (1) every
   * payload is folded via `reduce` BEFORE anything is persisted, so a
   * malformed payload anywhere in the group throws before the append that
   * would otherwise write it durably with no frame ever yielded for it; (2)
   * each event's frame is yielded against the `CampaignState` that reflects
   * exactly that event and nothing after it — necessary because a snapshot
   * taken mid-group must describe the projection AT that event's sequence,
   * not the group's final state, or a reconnect resuming from that
   * snapshot would silently skip the later events in the same group.
   */
  async function* emitAll(
    items: readonly { type: GameEvent["type"]; payload: Record<string, unknown> }[],
  ): AsyncIterable<ServerFrame> {
    if (items.length === 0) return;

    const startSequence = campaign.nextSequence;
    const timestamp = ports.clock();
    const events: GameEvent[] = items.map((item, index) => ({
      eventId: ports.uuid(),
      campaignId: campaign.state.world.campaignId,
      sequence: startSequence + index,
      timestamp,
      type: item.type,
      payload: item.payload,
    }));

    const folded: { event: GameEvent; state: CampaignState }[] = [];
    let next = campaign.state;
    for (const event of events) {
      next = reduce(next, event);
      folded.push({ event, state: next });
    }

    await ports.store.append(campaign.state.world.campaignId, events);
    campaign.nextSequence += events.length;

    for (const { event, state } of folded) {
      campaign.state = state;
      yield { type: "event", event };

      // Same cadence and the same own-`try` isolation `emit` documents,
      // per event in the group rather than per call — a group spanning a
      // `SNAPSHOT_EVERY` boundary must still snapshot at the crossing
      // event, not only at the group's last one.
      if (event.sequence > 0 && event.sequence % SNAPSHOT_EVERY === 0) {
        try {
          await ports.store.putSnapshot(
            campaign.state.world.campaignId,
            event.sequence,
            campaign.state,
          );
        } catch (error) {
          ports.metrics?.recordSnapshotFailure?.({
            campaignId: campaign.state.world.campaignId,
            sequence: event.sequence,
            error,
          });
        }
      }
    }
  }

  /**
   * `deadline` is an absolute timestamp, struck once by the caller for the
   * whole turn (see `enemyTurn`) — NOT a fresh `ports.turnTimeoutMs` read
   * here. `apps/server/CLAUDE.md` and the spec both describe one 10s cap
   * covering the tactical call and the narration together; if this function
   * started its own clock, a provider that stalled on both would take up to
   * 2x the budget before the turn resolved.
   */
  async function* narrate(
    actorId: string,
    effect: TurnEffect,
    deadline: number,
  ): AsyncIterable<ServerFrame> {
    const streamId = ports.uuid();
    const input = buildNarrationBrief({
      actorId,
      effect,
      combatants: encounterOf(campaign).combatants,
      statBlocks: builtOf(campaign).statBlocks,
      conditionNamesHebrew: ports.conditionNamesHebrew,
      sceneEnglish: builtOf(campaign).sceneEnglish,
      recentNarrations: campaign.recentNarrations,
    });

    // `ports.clock()`, never a bare `Date.now()`: this codebase injects its
    // clock specifically so a test can hold time fixed (every other test in
    // this file's `portsWith` does) or advance it on a known schedule, and a
    // wall-clock read here would defeat that.
    const startedAt = ports.clock();
    const out: LadderOutcome = { text: "", source: "model" };
    yield* narrationLadder({
      streamId,
      primary: ports.narrative.stream(input),
      fallback: () => createDeterministicNarrative().stream(input),
      deadline,
      out,
    });

    // One call per narrated turn, whichever rung produced it — the pipeline
    // is the only place that knows `actorId` and `source`; the agent itself
    // knows neither. `latencyMs` is the two `ports.clock()` reads above and
    // here, not wall time, for the same determinism reason `startedAt` is.
    const latencyMs = Date.parse(ports.clock()) - Date.parse(startedAt);
    ports.metrics?.recordNarrativeTurn({
      actorId,
      source: out.source,
      latencyMs,
      promptVersion: NARRATIVE_PROMPT_VERSION,
    });

    // No `.trim()`: this must carry exactly the concatenation of the
    // narrative_token chunks yielded above, so that a replay cannot diverge
    // from what the client already rendered optimistically while streaming.
    //
    // `promptVersion` is stamped even on a fallback turn: it records which
    // prompt was in force when the turn ran, which is what a benchmark needs
    // to avoid pooling runs across a prompt edit.
    yield* emit("narrative_emitted", {
      actorId,
      streamId,
      text: out.text,
      source: out.source,
      promptVersion: NARRATIVE_PROMPT_VERSION,
    });

    campaign.recentNarrations = [...campaign.recentNarrations, out.text].slice(-NARRATION_WINDOW);
  }

  /**
   * `campaign.state.world.scene`, narrowed once. Re-derived at every call
   * site that needs it rather than bound to a local once, for the same
   * reason `encounterOf`/`sceneStaticsOf` (`campaign.ts`) are: `emit`
   * replaces `campaign.state` wholesale as the turn progresses, so a binding
   * taken earlier would describe a scene that has already moved.
   */
  function currentScene(): SceneSnapshot {
    const { scene } = campaign.state.world;
    if (scene === null) {
      throw new Error(`Campaign ${campaign.state.world.campaignId} has no scene open`);
    }
    return scene;
  }

  /**
   * `narrate`'s sibling for the out-of-combat brief (design spec Decision 7):
   * same ladder, same one-`narrative_emitted`-per-turn contract, same
   * `recentNarrations` window — a different `SceneNarrationInput` and a
   * different prompt version stamped through. `beat` is the caller's job to
   * build (`free_text` below): this only assembles the material every beat
   * shares (the current node's card, the player, the NPCs present) and runs
   * it through the ladder.
   *
   * `deadline` is the SAME absolute timestamp `free_text` struck for its
   * `classify` call, not a fresh one — Decision 6's "one 10s deadline...
   * covers the classify call... and the narration", mirroring `enemyTurn`'s
   * shared budget for its tactical call and its own `narrate`.
   */
  async function* sceneNarrate(
    actorId: string,
    beat: SceneBeat,
    deadline: number,
  ): AsyncIterable<ServerFrame> {
    const statics = sceneStaticsOf(campaign);
    const card = questNodeCard(statics.authored, currentScene().currentNodeId);

    // Retrieval is keyed to the node, not the turn: the query (the node's
    // card plus its NPCs) is static for as long as the campaign stands at
    // this node, so refreshing only on a node change is what makes a
    // six-turn conversation cost one embedding call rather than six
    // (episodic-memory spec, Decision 7).
    const nodeId = currentScene().currentNodeId;
    if (campaign.memoriesForNodeId !== nodeId) {
      const retrieveStartedAt = ports.clock();
      // Latched only on success: a transient failure (a timeout, a
      // rate-limited provider, a store hiccup) must not freeze an empty
      // result in the cache for the rest of the node visit — the whole
      // point of keying the cache to the node is to pay once, not to pay
      // once and then never again try (code review finding). A property on
      // a holder object, not a bare `let`, so the `if` below reads the
      // real post-`onFailure` value rather than TypeScript's control-flow
      // narrowing of a captured primitive back to its pre-call literal.
      const retrieval = { failed: false };
      campaign.recentMemories = await retrieveMemories({
        store: ports.episodic,
        embedding: ports.embedding,
        spec: DEFAULT_EMBEDDING_SPEC,
        campaignId: campaign.state.world.campaignId,
        queryEnglish: [card.sceneEnglish, ...card.npcIds].join(" "),
        limit: 3,
        // A tighter sub-deadline than `sceneNarrate`'s own `deadline`
        // parameter — retrieval is background prompt enrichment, not the
        // narration itself, so it gets its own small budget rather than a
        // share of whatever the turn has left (`RETRIEVAL_BUDGET_MS`'s doc
        // comment; whole-branch review finding 1).
        deadline: Math.min(deadline, Date.now() + RETRIEVAL_BUDGET_MS),
        onUsage: (usage) => {
          ports.metrics?.recordEmbeddingCall?.({
            outcome: "ok",
            purpose: "retrieve",
            latencyMs: Date.parse(ports.clock()) - Date.parse(retrieveStartedAt),
            promptTokens: usage.promptTokens,
            completionTokens: usage.completionTokens,
            totalTokens: usage.totalTokens,
          });
        },
        onFailure: (code) => {
          retrieval.failed = true;
          ports.metrics?.recordEmbeddingCall?.({
            outcome: code,
            purpose: "retrieve",
            latencyMs: Date.parse(ports.clock()) - Date.parse(retrieveStartedAt),
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: 0,
          });
        },
      });
      if (!retrieval.failed) {
        campaign.memoriesForNodeId = nodeId;
      }
    }

    // `affinityOf` reads the engine's `SceneState`, not the wire
    // `SceneSnapshot` `currentScene()` returns — the same conversion
    // `before`/`sceneStateFrom(currentScene())` uses everywhere else in this
    // file. This is `affinityOf`'s first call site outside `@ai-dm/rules-engine`.
    const sceneState = sceneStateFrom(currentScene());
    const input: SceneNarrationInput = {
      beat,
      sceneEnglish: card.sceneEnglish,
      playerNameHebrew: statics.character.nameHebrew,
      playerGender: statics.character.grammaticalGender,
      npcNamesHebrew: card.npcNamesHebrew,
      recentNarrations: campaign.recentNarrations,
      memoryEnglish: memoryLines({
        npcs: card.npcIds.map((npcId) => {
          const affinity = affinityOf(sceneState, npcId);
          return {
            nameEnglish: statics.authored.npcs.get(npcId)?.nameEnglish ?? npcId,
            band: affinity.band,
            facts: affinity.facts,
          };
        }),
        retrieved: campaign.recentMemories,
      }),
    };

    const streamId = ports.uuid();
    const startedAt = ports.clock();
    const out: LadderOutcome = { text: "", source: "model" };
    yield* narrationLadder({
      streamId,
      primary: ports.sceneNarrative.stream(input),
      fallback: () => createDeterministicSceneNarrative().stream(input),
      deadline,
      out,
    });

    const latencyMs = Date.parse(ports.clock()) - Date.parse(startedAt);
    ports.metrics?.recordNarrativeTurn({
      actorId,
      source: out.source,
      latencyMs,
      promptVersion: SCENE_PROMPT_VERSION,
    });

    yield* emit("narrative_emitted", {
      actorId,
      streamId,
      text: out.text,
      source: out.source,
      promptVersion: SCENE_PROMPT_VERSION,
    });

    campaign.recentNarrations = [...campaign.recentNarrations, out.text].slice(-NARRATION_WINDOW);
  }

  /**
   * One hostile turn. The validate -> retry-once -> fallback loop is the
   * agent's own (step 7a, `packages/agents/src/tactical/index.ts`); this only
   * stamps its rejections into the log and applies whatever legal turn came
   * back. Never lets the proposal itself touch state — `applyTurn` below is
   * the only thing that mutates the world, and only after the rules engine
   * has already validated the proposal inside `proposeTurn`.
   *
   * One shared 10s budget for the whole turn — the tactical proposal AND the
   * narration that follows it — per `apps/server/CLAUDE.md` ("hard turn
   * timeout 10s") and the spec ("A 10s hard cap wraps the narrative stream
   * and the tactical call"): a single cap, not two independent ones. A
   * `deadline` struck once here and threaded through both the
   * `AbortController` and `narrate` means a provider that stalls on both
   * still resolves within `ports.turnTimeoutMs` total, not up to 2x it.
   */
  async function* enemyTurn(actorId: string): AsyncIterable<ServerFrame> {
    const world = worldFor(campaign);
    const statBlock = builtOf(campaign).statBlocks.get(actorId);
    const deadline = Date.now() + ports.turnTimeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(
      () => {
        controller.abort();
      },
      Math.max(0, deadline - Date.now()),
    );

    let proposal: TurnProposalResult;
    const proposalStartedAt = Date.now();
    try {
      proposal = await ports.tactical.proposeTurn({
        world,
        actorId,
        availableActions: statBlock === undefined ? [] : availableActionsFor(statBlock),
        turnOrder: encounterOf(campaign).turnOrder,
        abortSignal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    // `proposal.usage` is the only place token counts for this call exist;
    // nothing else downstream can recover them. One line per
    // turn that reached the tactical agent, regardless of whether it ended
    // in a legal turn or a forfeit, since both cost real tokens.
    if (ports.metrics !== undefined) {
      const totals = proposal.usage.reduce(
        (sum, each) => ({
          promptTokens: sum.promptTokens + each.promptTokens,
          completionTokens: sum.completionTokens + each.completionTokens,
          totalTokens: sum.totalTokens + each.totalTokens,
        }),
        { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      );
      ports.metrics.recordTacticalTurn({
        actorId,
        outcome: proposal.ok ? "ok" : proposal.kind,
        ...(proposal.ok ? { source: proposal.source } : {}),
        billedAttempts: proposal.usage.length,
        retries: proposal.rejections.length,
        ...totals,
        latencyMs: Date.now() - proposalStartedAt,
      });
    }

    // Every attempt the agent made, whether or not one succeeded. This is the
    // dataset step 7b's rejection analysis reads.
    for (const rejection of proposal.rejections) {
      yield* emit("action_rejected", { ...rejection });
    }

    if (!proposal.ok) {
      // `aborted` (the 10s budget) or `no_legal_turn`. Either way the creature
      // forfeits its turn rather than the pipeline stalling.
      yield* emit("scene_changed", { kind: "turn_advanced" });
      return;
    }

    yield* emit("action_validated", { actorId, turn: proposal.turn, source: proposal.source });

    const seed = ports.seedFor(campaign.state.world.rootSeed, campaign.nextSequence);
    const { world: after, effect } = applyTurn({
      world,
      actorId,
      turn: proposal.turn,
      plan: proposal.plan,
      context: { statBlocks: builtOf(campaign).statBlocks },
      rng: seeded(seed),
    });

    yield* emit("dice_rolled", {
      actorId,
      seed,
      attacks: effect.attacks,
      movedFeet: effect.movedFeet,
    });
    yield* emit("state_delta_applied", { combatants: after.combatants });
    yield* narrate(actorId, effect, deadline);
    yield* emit("scene_changed", { kind: "turn_advanced" });
  }

  /**
   * Run hostiles — and, since death-saves-persistent-hp, an Unconscious
   * party member's own automatic death save — until it is a conscious party
   * member's turn again, or nobody is left to fight. Bounded rather than an
   * unbounded loop: each pass through the body either returns or emits
   * exactly one `turn_advanced`, which `reduce` turns into exactly one step
   * of `currentActorIndex`, so a bug that failed to ever return control to
   * the party (or a fight that somehow never runs out of a second living
   * faction) still cannot spin forever here.
   *
   * The bound is `turnOrder.length * (maxRounds + 1)`, not bare
   * `turnOrder.length` — a death save resolves within at most 5 rolls
   * (`rollDeathSave` moves one of two counters toward 3 on every roll, never
   * a no-op), which can span several rounds with nothing for the player to
   * do in between, so a single call here must be able to auto-play the rest
   * of the fight up to its own authored round cap, not just one circuit of
   * the turn order. `resolveIfConcluded`'s own `maxRounds` terminator is
   * what actually ends a fight that runs that long; this bound only has to
   * outlast it, never enforce it a second way.
   */
  async function* runEnemyTurns(): AsyncIterable<ServerFrame> {
    const bound = encounterOf(campaign).turnOrder.length * (builtOf(campaign).maxRounds + 1);
    for (let guard = 0; guard <= bound; guard += 1) {
      // Re-read per pass, not hoisted: `enemyTurn` and the skip below both
      // emit, and `emit` replaces `campaign.state` wholesale — a board bound
      // before the loop would describe a turn that has already ended.
      const encounter = encounterOf(campaign);
      const actorId = encounter.turnOrder[encounter.currentActorIndex];
      if (actorId === undefined) return;

      const combatant = encounter.combatants.find((each) => each.combatantId === actorId);
      if (combatant === undefined) return;

      if (combatant.faction === "party") {
        if (combatant.status === "alive") return; // control returns to the player, as today
        // Unconscious with a death save still pending: this IS this turn —
        // there is no proposal to make, so the pipeline rolls for them
        // rather than waiting on a `structured_action` that can never
        // arrive (RULES_REFERENCE.md §8's former gap; spec Decision 5).
        if (combatant.status === "unconscious" && (combatant.deathSaves?.successes ?? 0) < 3) {
          yield* rollDeathSaveTurn(actorId);
          continue;
        }
        // Dead, fled, or stabilized-and-unconscious: nothing to do this
        // turn — the same silent skip a downed monster gets below.
        yield* emit("scene_changed", { kind: "turn_advanced" });
        continue;
      }

      // A downed or dead creature is skipped, not asked for a turn.
      if (combatant.status !== "alive") {
        yield* emit("scene_changed", { kind: "turn_advanced" });
        continue;
      }

      // The same rule `conclusionOf` states, read from the one definition
      // rather than spelled a second way here (spec Decision 3).
      if (conclusionOf(encounterOf(campaign)) !== "ongoing") return;

      yield* enemyTurn(actorId);
    }
  }

  /**
   * One automatic death save for an Unconscious party member, on their own
   * turn. No tactical call, no narration — there is no proposal to make and
   * (per the brief) no new narration to write; the moment the hero fell
   * unconscious already narrated through the ordinary attack path
   * (`AttackTrace.targetStatusAfter`), which both narrators already render.
   * Mirrors `enemyTurn`'s own shape at the point it commits a roll: one seed
   * off the campaign sequence, one `state_delta_applied`, one
   * `turn_advanced`.
   */
  async function* rollDeathSaveTurn(actorId: string): AsyncIterable<ServerFrame> {
    const encounter = encounterOf(campaign);
    const combatant = encounter.combatants.find((each) => each.combatantId === actorId);
    if (combatant === undefined) throw new Error(`No combatant ${actorId} in this encounter`);

    const seed = ports.seedFor(campaign.state.world.rootSeed, campaign.nextSequence);
    const result = rollDeathSave(combatant.deathSaves ?? { successes: 0, failures: 0 }, seeded(seed));

    const status: EntityStatus =
      result.outcome === "dead" ? "dead" : result.outcome === "revived" ? "alive" : "unconscious";
    const currentHp =
      result.outcome === "revived" ? Math.max(1, combatant.currentHp) : combatant.currentHp;

    const combatants = encounter.combatants.map((each) =>
      each.combatantId === actorId ? { ...each, status, currentHp, deathSaves: result.state } : each,
    );
    yield* emit("state_delta_applied", { combatants });
    yield* emit("scene_changed", { kind: "turn_advanced" });
  }

  /**
   * Push the player's affordances, if it is a party member's turn. The rule
   * is one idea, not a list: emit whenever this call is about to hand control
   * back without the turn having advanced past the player. That is the end of
   * a `join`, the end of a turn that came back round to them, a rejected
   * action, and a failed append — the last two because the turn did not
   * advance, so the move is still theirs. The client nulls its affordances on
   * every event frame, so any of these that does not re-push leaves the board
   * inert with no way back short of a reconnect.
   *
   * Silent when no encounter is open, when it is a hostile's turn, when the
   * actor is missing, or when the encounter has no stat block for them — none
   * of those are error conditions for the client, they simply mean there is
   * nothing to offer. The first of those is why this reads
   * `campaign.state.encounter` rather than going through `encounterOf`: a
   * campaign between fights has no board to offer affordances on, and a
   * `join` there must still answer with its `campaign_state` frame rather
   * than throw.
   */
  // Not `async function*`: unlike `emit`/`runEnemyTurns`, nothing here
  // awaits — `affordancesFor` is a pure, synchronous call into the rules
  // engine. `@typescript-eslint/require-await` correctly flags an `async`
  // generator with no `await` in it, so this is a plain generator instead;
  // `yield*`-ing it from the async `handleCommand` generator works the same
  // either way.
  function* playerAffordances(): Iterable<ServerFrame> {
    const encounter = campaign.state.encounter;
    if (encounter === null) return;
    const actorId = encounter.turnOrder[encounter.currentActorIndex];
    if (actorId === undefined) return;

    const actor = encounter.combatants.find((each) => each.combatantId === actorId);
    if (actor === undefined || actor.faction !== "party" || actor.status !== "alive") return;

    const statBlock = builtOf(campaign).statBlocks.get(actorId);
    if (statBlock === undefined) return;

    // The spread comes first and the explicit
    // fields after, so the pipeline's own `type`/`forSequence` stay
    // authoritative even if `TurnAffordances` ever grows a field with
    // either name — previously the spread came last and would have
    // silently clobbered them.
    yield {
      ...affordancesFor(worldFor(campaign), actorId, statBlock),
      type: "turn_affordances",
      forSequence: campaign.nextSequence - 1,
    };
  }

  /**
   * Ends the fight if it is over, and turns a won one back into scene
   * progress (spec Decisions 4, 5 and 7).
   *
   * Two terminators. `conclusionOf` answers "one faction left standing", the
   * rule the client has always read the board with. `maxRounds` answers the
   * one the bridge itself creates: before step 5 an unresolvable fight was a
   * stuck board on a combat-only campaign, visible and recoverable by
   * reload; now the same stalemate strands a campaign outside its own
   * narrative permanently, because `free_text`'s Guard 2 refuses input for as
   * long as the bracket stays open. The number is already authored and
   * already built — only the comparison was missing.
   *
   * Silent when the campaign has no scene to return to. For a combat-only
   * campaign the fight IS the campaign, and closing its bracket would null
   * `state.encounter` with `scene` already null — a projection in neither
   * combat nor a scene, which `apps/web` can only render as its "not ready"
   * placeholder. Winning would blank the screen. So those campaigns end
   * exactly as they do today: no event, board still projected, and the client
   * reads victory or defeat off `conclusionOf` itself.
   */
  async function* resolveIfConcluded(): AsyncIterable<ServerFrame> {
    const encounter = campaign.state.encounter;
    if (encounter === null) return;
    if (campaign.sceneStatics === null) return;

    const conclusion = conclusionOf(encounter);
    const outcome =
      conclusion !== "ongoing"
        ? conclusion
        : encounter.round > builtOf(campaign).maxRounds
          ? "stalemate"
          : null;
    if (outcome === null) return;

    const survivorIds = encounter.combatants
      .filter((each) => each.status === "alive")
      .map((each) => each.combatantId);

    // A fresh budget, not a stale one: nothing upstream in this turn (the
    // player's `narrate`, `runEnemyTurns`) left a deadline in scope here,
    // and reusing an earlier stage's would already be spent by the time
    // this stage starts — the same reasoning `enemyTurn` and `narrate`
    // already follow, each striking its own `ports.turnTimeoutMs` budget
    // for its own independent model call rather than sharing one across
    // stages that run in sequence.
    const deadline = Date.now() + ports.turnTimeoutMs;

    // Closes the "encounter" episode, unconditionally — win, loss or
    // stalemate all end the fight and are all worth remembering. Computed
    // before `events` is built so the summary can travel in
    // `encounter_resolved`'s own payload rather than a later event.
    const summaryEnglish = await summarizeEpisode({
      summary: ports.summary,
      input: {
        kind: "encounter",
        // `BuiltEncounter` carries no `descriptionEnglish` (that field lives
        // only on the catalogue's `EncounterDefinition`) — `sceneEnglish` is
        // its narrator-facing copy, the same field `narrate()` above already
        // reads off `builtOf(campaign)` for this encounter's atmosphere.
        contextEnglish: builtOf(campaign).sceneEnglish,
        factsEnglish: [`Outcome: ${outcome}.`, `Survivors: ${survivorIds.join(", ")}.`],
        recentNarrations: campaign.recentNarrations,
      },
      deadline,
    });

    // The hero's ending HP, carried into `scene.heroHp` on a won fight only
    // (spec Decision 6) — a loss or stalemate leaves it exactly where it was
    // going in, the same "nothing else changes" rule the rest of this
    // branch already follows for a non-victory outcome.
    const hero = encounter.combatants.find((each) => each.characterId !== undefined);
    const events: { type: GameEvent["type"]; payload: Record<string, unknown> }[] = [
      {
        type: "encounter_resolved",
        payload: {
          encounterId: encounter.encounterId,
          outcome,
          survivorIds,
          summaryEnglish,
          ...(outcome === "victory" && hero !== undefined ? { heroHp: hero.currentHp } : {}),
        },
      },
    ];

    // Only a won fight advances the arc. Defeat and stalemate close the
    // bracket and change nothing else, so the player lands back in the scene
    // at the same node and can re-enter — which rebuilds a fresh board from
    // the catalogue. Known ceiling, recorded in the spec: a defeated solo PC
    // narratively walking it off is wrong, and permadeath wants its own
    // decision rather than a subsystem smuggled into this step.
    //
    // Set only on a won fight, and read after `emitAll` below to index the
    // node's own "quest_node" episode — a node completed by combat is
    // otherwise never summarized or indexed at all, unlike one completed
    // through exploration, and its combat-resolved history becomes silently
    // unretrievable (code review finding).
    let completedNode: { nodeId: string; summaryEnglish: string } | null = null;

    if (outcome === "victory") {
      const statics = sceneStaticsOf(campaign);
      const before = sceneStateFrom(currentScene());
      const transition = completeCurrentNode(statics.authored, before, statics.character.maxHp);
      // Invalid means the node's own entry gate no longer holds, which cannot
      // happen for a node already entered — `completeCurrentNode` short-
      // circuits on an already-completed node and this one is not yet
      // completed. Throw rather than silently skip: a false here means the
      // authored world and the log disagree, the same corrupt-content posture
      // `currentScene` and `sceneStaticsOf` take.
      if (!transition.valid) {
        throw new Error(
          `Campaign ${campaign.state.world.campaignId} cannot complete encounter node ` +
            `${before.currentNodeId}: ${transition.rejections.map((each) => each.message).join("; ")}`,
        );
      }
      // Diffed off the engine's own pre/post states, never re-read from the
      // node's declared effects — the same rule the exploration branch
      // follows, so the payload records what the engine actually did,
      // post-clamp, and cannot disagree with it.
      const delta = diffScene(before, transition.state);

      // Closes the "quest_node" episode for the node this victory completed
      // — the same summarize-and-index treatment the exploration path's own
      // node completion gets, so a node finished by combat is exactly as
      // retrievable later as one finished by talking.
      const nodeSummaryEnglish = await summarizeEpisode({
        summary: ports.summary,
        input: {
          kind: "quest_node",
          contextEnglish: questNodeCard(statics.authored, before.currentNodeId).sceneEnglish,
          factsEnglish: [
            `Node completed: ${before.currentNodeId}.`,
            ...delta.npcAffinities.map(
              (entry) => `${entry.npcId} now regards the player as ${entry.band}.`,
            ),
            ...delta.relations.map(
              (entry) => `${entry.factionA} and ${entry.factionB} now stand at ${entry.band}.`,
            ),
          ],
          recentNarrations: campaign.recentNarrations,
        },
        // Same closing-stage budget the encounter's own `summaryEnglish`
        // was computed under, above.
        deadline,
      });

      events.push({
        type: "quest_node_completed",
        payload: { nodeId: before.currentNodeId, summaryEnglish: nodeSummaryEnglish },
      });
      if (
        delta.relations.length > 0 ||
        delta.npcAffinities.length > 0 ||
        delta.day !== undefined ||
        delta.heroHp !== undefined
      ) {
        events.push({
          type: "world_delta_applied",
          payload: {
            relations: delta.relations,
            npcAffinities: delta.npcAffinities,
            ...(delta.day === undefined ? {} : { day: delta.day }),
            ...(delta.heroHp === undefined ? {} : { heroHp: delta.heroHp }),
          },
        });
      }

      completedNode = { nodeId: before.currentNodeId, summaryEnglish: nodeSummaryEnglish };
    }

    // `emitAll` (unlike `emit`) yields no return value either, and
    // `encounter_resolved` is always `events[0]` — so its sequence is
    // whatever `campaign.nextSequence` is right now, one read before the
    // append that assigns it.
    const resolvedSequence = campaign.nextSequence;

    yield* emitAll(events);
    // `emitAll` moves `campaign.state` and never `built`. Clearing it here
    // keeps both halves of the bracket written in one place, which is what
    // `Campaign.built`'s doc comment actually asks for — rather than leaving
    // `builtOf`'s guard to catch the desync one read later.
    campaign.built = null;

    // Fire-and-forget, not `await`ed: nothing in `resolveIfConcluded`
    // narrates after this point (the turn's narration already streamed via
    // `narrate()` before `runEnemyTurns`/`resolveIfConcluded` ran), so there
    // is no "after the narration yield" point to defer past here the way the
    // quest-node-completion site defers past its own `sceneNarrate`. Making
    // the player's response wait on indexing anyway would cost latency for
    // no narration benefit — `indexEpisode` is already best-effort and never
    // throws, so `void` is safe (whole-branch review finding 1).
    const indexStartedAt = ports.clock();
    void indexEpisode({
      store: ports.episodic,
      embedding: ports.embedding,
      spec: DEFAULT_EMBEDDING_SPEC,
      record: {
        campaignId: campaign.state.world.campaignId,
        sequence: resolvedSequence,
        kind: "encounter",
        refId: encounter.encounterId,
        summaryEnglish,
        day: currentScene().day,
      },
      // The same budget `summaryEnglish` was computed under, above — one
      // closing-stage deadline shared across both its calls, mirroring how
      // `enemyTurn` shares one `deadline` between its tactical call and its
      // own `narrate`.
      deadline,
      onUsage: (usage) => {
        ports.metrics?.recordEmbeddingCall?.({
          outcome: "ok",
          purpose: "index",
          latencyMs: Date.parse(ports.clock()) - Date.parse(indexStartedAt),
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          totalTokens: usage.totalTokens,
        });
      },
      onFailure: (code) => {
        ports.metrics?.recordEmbeddingCall?.({
          outcome: code,
          purpose: "index",
          latencyMs: Date.parse(ports.clock()) - Date.parse(indexStartedAt),
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
        });
      },
    });

    // `quest_node_completed` is always `events[1]` in the victory branch —
    // right after `encounter_resolved` — the same one-read-before-the-append
    // rule `resolvedSequence` itself relies on.
    if (completedNode !== null) {
      const nodeIndexStartedAt = ports.clock();
      void indexEpisode({
        store: ports.episodic,
        embedding: ports.embedding,
        spec: DEFAULT_EMBEDDING_SPEC,
        record: {
          campaignId: campaign.state.world.campaignId,
          sequence: resolvedSequence + 1,
          kind: "quest_node",
          refId: completedNode.nodeId,
          summaryEnglish: completedNode.summaryEnglish,
          day: currentScene().day,
        },
        deadline,
        onUsage: (usage) => {
          ports.metrics?.recordEmbeddingCall?.({
            outcome: "ok",
            purpose: "index",
            latencyMs: Date.parse(ports.clock()) - Date.parse(nodeIndexStartedAt),
            promptTokens: usage.promptTokens,
            completionTokens: usage.completionTokens,
            totalTokens: usage.totalTokens,
          });
        },
        onFailure: (code) => {
          ports.metrics?.recordEmbeddingCall?.({
            outcome: code,
            purpose: "index",
            latencyMs: Date.parse(ports.clock()) - Date.parse(nodeIndexStartedAt),
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: 0,
          });
        },
      });
    }
  }

  try {
    switch (command.type) {
      case "join": {
        // The existing body, verbatim, moved into a nested generator so all
        // four of its exits are covered by one affordance push rather than
        // four copies of it. `command` is narrowed to the "join" member by
        // the switch above, but that narrowing does not carry into a nested
        // function's closure over the same binding (TS treats a closed-over
        // parameter conservatively) — so it is threaded through as its own
        // explicitly-typed parameter instead, shadowing the outer name. The
        // body below is otherwise untouched.
        async function* joinFrames(
          command: Extract<ClientMessage, { type: "join" }>,
        ): AsyncIterable<ServerFrame> {
          const campaignId = campaign.state.world.campaignId;

          if (command.resumeFrom === undefined) {
            // Nothing to resume from: hand back the live projection wholesale.
            yield {
              type: "campaign_state",
              sequence: campaign.nextSequence - 1,
              snapshot: campaign.state,
            };
            return;
          }

          // Spec §Reconnect: "without resumeFrom, or when it predates
          // the retained log: campaign_state at the newest snapshot, then the
          // events since [the snapshot]." A resumeFrom older than the newest
          // snapshot is exactly the case a store that eventually prunes old
          // events would no longer be able to serve directly.
          //
          // Deliberate approximation: nothing actually prunes today, so
          // "older than the newest snapshot" is being used as a stand-in for
          // "predates the retained log" rather than a direct read of a
          // retention floor. That means a client only 3 events behind a
          // snapshot at sequence 50 still gets a whole `CampaignState` resent
          // instead of 3 events — correct, but wasteful, and that
          // payload only grows over a campaign's lifetime. Gate this on a real
          // retention floor once the store has one.
          const snapshot = await ports.store.latestSnapshot(campaignId);
          if (snapshot !== null && command.resumeFrom < snapshot.sequence) {
            yield { type: "campaign_state", sequence: snapshot.sequence, snapshot: snapshot.state };
            for (const event of await ports.store.readSince(campaignId, snapshot.sequence)) {
              yield { type: "event", event };
            }
            return;
          }

          const tail = await ports.store.readSince(campaignId, command.resumeFrom);
          if (tail.length === 0) {
            // IMPORTANT-2: `resumeFrom` already at (or past) the newest
            // sequence — a client that missed nothing. `join` must have
            // exactly one guaranteed response so "you're caught up" is never
            // indistinguishable from a dropped join; the natural choice is the
            // same `campaign_state` frame a resumeFrom-less join gets, at the
            // current projection.
            yield {
              type: "campaign_state",
              sequence: campaign.nextSequence - 1,
              snapshot: campaign.state,
            };
            return;
          }
          for (const event of tail) {
            yield { type: "event", event };
          }
          return;
        }

        yield* joinFrames(command);
        yield* playerAffordances();
        return;
      }

      case "free_text": {
        // Guard 1, mirroring `structured_action`'s own dedupe: must run
        // before anything else, since a resend can arrive after the turn it
        // named already resolved.
        if (campaign.state.world.appliedClientMessageIds.includes(command.clientMessageId)) {
          return;
        }

        // Guard 2: an open encounter. Free text in combat is a later step's
        // question (design spec Decision 6) — the on-screen actions are the
        // only input surface while a bracket is open.
        if (campaign.state.encounter !== null) {
          yield {
            type: "error",
            clientMessageId: command.clientMessageId,
            code: "free_text_not_supported",
            message: "Use the on-screen actions during combat.",
          };
          return;
        }

        // Guard 3: no scene at all — unchanged legacy behaviour for a
        // combat-only campaign between fights, predating §4.7 step 4.
        if (campaign.state.world.scene === null) {
          yield {
            type: "error",
            clientMessageId: command.clientMessageId,
            code: "free_text_not_supported",
            message: "Free text is not handled yet. Use the on-screen actions.",
          };
          return;
        }

        const statics = sceneStaticsOf(campaign);

        // One shared 10s budget for this turn's classify call AND its
        // narration — see `enemyTurn`'s identical rationale and
        // `sceneNarrate`'s doc comment. `controller` wraps only the classify
        // call (the one thing here that takes an `AbortSignal`); `deadline`
        // itself, not the controller, is what `sceneNarrate` shares it with.
        const deadline = Date.now() + ports.turnTimeoutMs;
        const controller = new AbortController();
        const timer = setTimeout(
          () => {
            controller.abort();
          },
          Math.max(0, deadline - Date.now()),
        );

        let classifyResult: IntentResult;
        const classifyStartedAt = Date.now();
        try {
          yield* emit("player_input", {
            clientMessageId: command.clientMessageId,
            actorId: statics.character.characterId,
            text: command.text,
          });

          const before = sceneStateFrom(currentScene());
          const options = availableEdges(statics.authored, before);
          if (!options.valid) {
            // The same corrupt-log posture `sceneStaticsOf`/`builtOf` take:
            // `currentNodeId` failing to resolve here means the log or the
            // world content is broken, not that the player did anything
            // wrong.
            throw new Error(
              `Campaign ${campaign.state.world.campaignId} scene is corrupt: ` +
                options.rejections.map((each) => each.message).join("; "),
            );
          }

          classifyResult = await ports.intent.classify({
            text: command.text,
            sceneEnglish: questNodeCard(statics.authored, before.currentNodeId).sceneEnglish,
            edges: options.edges.map((each) => ({
              to: each.edge.to,
              labelEnglish: each.edge.labelEnglish,
              open: each.open,
            })),
            abortSignal: controller.signal,
          });
        } finally {
          clearTimeout(timer);
        }

        if (ports.metrics !== undefined) {
          const totals = classifyResult.usage.reduce(
            (sum, each) => ({
              promptTokens: sum.promptTokens + each.promptTokens,
              completionTokens: sum.completionTokens + each.completionTokens,
              totalTokens: sum.totalTokens + each.totalTokens,
            }),
            { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          );
          ports.metrics.recordIntentCall?.({
            outcome: classifyResult.ok ? "ok" : classifyResult.error.code,
            ...(classifyResult.ok ? { category: classifyResult.classification.category } : {}),
            latencyMs: Date.now() - classifyStartedAt,
            ...totals,
          });
        }

        if (!classifyResult.ok) {
          // `player_input` already landed above — the message WAS received —
          // but nothing about the scene moves: no `intent_classified`, no
          // scene event. Same posture as `structured_action`'s outer catch.
          yield {
            type: "error",
            clientMessageId: command.clientMessageId,
            code: "internal_error",
            message: classifyResult.error.message,
          };
          yield* playerAffordances();
          return;
        }

        const { classification } = classifyResult;
        // `.parse`d rather than passed straight through: `IntentClassifiedPayload`
        // (invariant 4) was previously referenced only by its own test —
        // decoration, not the single schema/parse/type definition the
        // invariant requires. Parsing here is what makes it load-bearing.
        // The spread makes the parsed, precisely-typed result a fresh object
        // literal again, which is what lets it satisfy `emit`'s
        // `Record<string, unknown>` parameter (a named object type is not
        // otherwise assignable to an index-signature type).
        yield* emit("intent_classified", {
          ...IntentClassifiedPayload.parse({
            clientMessageId: command.clientMessageId,
            actorId: statics.character.characterId,
            classification,
            provider: classifyResult.provider,
            modelId: classifyResult.modelId,
            promptVersion: INTENT_PROMPT_VERSION,
          }),
        });

        switch (classification.category) {
          case "exploration": {
            const before = sceneStateFrom(currentScene());
            const { targetNodeId } = classification;

            // `null` means "conclude the current node" (Decision 1) — the
            // `completeCurrentNode` hook a TERMINAL node needs, never
            // "nothing else matched". A node with edges out still gates on
            // one of THOSE, so a `null` there is refused exactly like a bad
            // edge id: the shipped `guild-offer` has one open edge and a
            // real effect, and an utterance the model reads as "no edge
            // clearly matches" (e.g. "I look at the sky") must not silently
            // complete it and shift a faction band the player never asked
            // to move. Checked structurally (`edges.length`, not `open`
            // edges) — a node whose only edges are currently closed is
            // still non-terminal; it has somewhere to go, just not yet.
            const currentNode = statics.authored.questNodes.get(before.currentNodeId);
            const isNonTerminal = currentNode !== undefined && currentNode.edges.length > 0;

            const transition: SceneTransition =
              targetNodeId === null && isNonTerminal
                ? {
                    valid: false,
                    rejections: [
                      {
                        reason: "precondition_unmet",
                        message:
                          `"${before.currentNodeId}" is not a terminal node; ` +
                          "conclude it by choosing one of its edges instead",
                        subjectId: before.currentNodeId,
                      },
                    ],
                  }
                : targetNodeId === null
                  ? completeCurrentNode(statics.authored, before, statics.character.maxHp)
                  : traverseEdge(statics.authored, before, targetNodeId, statics.character.maxHp);

            if (!transition.valid) {
              // Refusal is data all the way to the player's ear (Decision 6):
              // no error frame, no event beyond the two already emitted, and
              // `campaign.state.world.scene` is untouched — this branch never
              // calls `emit` for a scene event.
              yield* sceneNarrate(
                statics.character.characterId,
                {
                  kind: "refused",
                  messages: transition.rejections.map((each) => each.message),
                },
                deadline,
              );
              yield* playerAffordances();
              return;
            }

            // `nodeId` is always the node being LEFT (or, for a
            // `completeCurrentNode` with no traversal, the one already
            // current) — `traverseEdge`/`completeCurrentNode` both complete
            // it internally before ever computing `transition.state`.
            // Unconditional, whether or not this particular call actually
            // changed anything: `reduce`'s fold of a repeat is idempotent
            // (Decision 4), so a second `quest_node_completed` for an
            // already-completed node is a harmless no-op, not a double
            // completion.
            //
            // Diffed against the engine's OWN pre/post states, never
            // re-read off the node's declared effects (Decision 4's last
            // paragraph) — and included only when something actually
            // changed, so re-completing an already-completed node (whose
            // `completeCurrentNode` call returns the SAME state, unchanged)
            // produces no second `world_delta_applied`.
            //
            // All of this batch's events go through ONE `emitAll` call,
            // not up to three `emit` calls: this is one engine transition,
            // and Task 9's review found that spreading it across several
            // appends leaves a window where a store failure between them
            // durably completes a node whose delta or destination never
            // landed, with no later turn able to repair it (`completed()`
            // short-circuits on a node already in `completedNodeIds`).
            // `emitAll` makes the group one append; Decision 4's three
            // separate EVENTS are unchanged, only the append granularity is.
            const delta = diffScene(before, transition.state);

            // Closes the "quest_node" episode for the node just left —
            // unconditional, mirroring `quest_node_completed`'s own
            // unconditional emit above: a repeat completion of an
            // already-completed node still gets summarized, the same
            // harmless-no-op posture `reduce`'s idempotent fold takes.
            const nodeSummaryEnglish = await summarizeEpisode({
              summary: ports.summary,
              input: {
                kind: "quest_node",
                contextEnglish: questNodeCard(statics.authored, before.currentNodeId).sceneEnglish,
                factsEnglish: [
                  `Node completed: ${before.currentNodeId}.`,
                  ...delta.npcAffinities.map(
                    (entry) => `${entry.npcId} now regards the player as ${entry.band}.`,
                  ),
                  ...delta.relations.map(
                    (entry) => `${entry.factionA} and ${entry.factionB} now stand at ${entry.band}.`,
                  ),
                ],
                recentNarrations: campaign.recentNarrations,
              },
              // This case's own shared budget — the same `deadline` the
              // classify call above and `sceneNarrate` below both run under.
              deadline,
            });

            const sceneEvents: { type: GameEvent["type"]; payload: Record<string, unknown> }[] = [
              {
                type: "quest_node_completed",
                payload: { nodeId: before.currentNodeId, summaryEnglish: nodeSummaryEnglish },
              },
            ];
            if (
              delta.relations.length > 0 ||
              delta.npcAffinities.length > 0 ||
              delta.day !== undefined ||
              delta.heroHp !== undefined
            ) {
              sceneEvents.push({
                type: "world_delta_applied",
                payload: {
                  relations: delta.relations,
                  npcAffinities: delta.npcAffinities,
                  ...(delta.day === undefined ? {} : { day: delta.day }),
                  ...(delta.heroHp === undefined ? {} : { heroHp: delta.heroHp }),
                },
              });
            }
            if (targetNodeId !== null) {
              sceneEvents.push({ type: "quest_node_entered", payload: { nodeId: targetNodeId } });
            }

            // The bridge (spec Decision 1). Entering a node that declares an
            // encounter opens a bracket, and it joins THIS group rather than
            // taking an `emit` of its own: it is part of the same engine
            // transition, and splitting it off would reopen exactly the
            // window `emitAll` exists to close — a durable
            // `quest_node_entered` whose fight never started, on a node the
            // scene engine's `completed()` short-circuit can never re-enter.
            //
            // Read off the node actually entered, which for a traversal is
            // the target and for a `completeCurrentNode` is the node already
            // current — the same node `sceneNarrate` below narrates.
            const enteredNodeId = targetNodeId ?? before.currentNodeId;
            const enteredNode = statics.authored.questNodes.get(enteredNodeId);
            // `transition.state.heroHp`, not `before`'s: this node's own
            // effects (a `long_rest` alongside its `encounterId`, however
            // unlikely) have already been applied by this point. Floored the
            // same way `campaign.ts`'s `startEncounter` floors a retry.
            const bridged =
              enteredNode?.encounterId === undefined
                ? null
                : buildEncounterById(
                    enteredNode.encounterId,
                    Math.max(1, transition.state.heroHp),
                  );
            if (bridged !== null) {
              sceneEvents.push({
                type: "encounter_started",
                payload: {
                  encounterId: bridged.encounterId,
                  grid: bridged.world.grid,
                  combatants: bridged.world.combatants,
                  turnOrder: bridged.turnOrder,
                },
              });
            }

            // `quest_node_completed` is always `sceneEvents[0]` — same
            // one-read-before-the-append rule `resolveIfConcluded` uses,
            // since `emitAll` returns no sequence of its own.
            const completedSequence = campaign.nextSequence;

            yield* emitAll(sceneEvents);

            // `emitAll` moves `campaign.state` but never `built` — the
            // fourth-writer hazard `Campaign.built`'s doc comment names. Set
            // it here, in the same place the bracket was opened, so
            // `builtOf`'s guard has nothing to catch.
            if (bridged !== null) campaign.built = bridged;

            // Reads `currentScene()` fresh, post-emit: for a traversal this
            // is the new node; for a `completeCurrentNode` it is the same
            // one, and either way `sceneNarrate` narrates whatever node the
            // player is standing in now. `targetNodeId === null` means no
            // traversal happened (Decision 1's "conclude the current node"
            // path) — narrating that as `arrived` would tell the player they
            // reached a place they were already standing in, so it gets its
            // own beat instead (whole-branch review finding 2).
            const card = questNodeCard(statics.authored, currentScene().currentNodeId);
            yield* sceneNarrate(
              statics.character.characterId,
              targetNodeId === null
                ? { kind: "concluded", locationNameHebrew: card.locationNameHebrew }
                : { kind: "arrived", locationNameHebrew: card.locationNameHebrew },
              deadline,
            );

            // Fire-and-forget, not `await`ed: `indexEpisode` needs nothing
            // from `sceneNarrate` (the summary it writes is already durable
            // in the event log via `emitAll` above), and is explicitly
            // best-effort. Narration has already streamed by this point, but
            // `handleCommand`'s generator is drained under the campaign lock
            // (`transport/ws.ts`) until it returns — an `await` here would
            // still hold that lock, and therefore the player's NEXT command,
            // for as long as the embed+write call takes. `void` releases it
            // immediately, matching the encounter-resolution site's identical
            // reasoning (whole-branch review finding 1, code review finding).
            const indexStartedAt = ports.clock();
            void indexEpisode({
              store: ports.episodic,
              embedding: ports.embedding,
              spec: DEFAULT_EMBEDDING_SPEC,
              record: {
                campaignId: campaign.state.world.campaignId,
                sequence: completedSequence,
                kind: "quest_node",
                refId: before.currentNodeId,
                summaryEnglish: nodeSummaryEnglish,
                day: currentScene().day,
              },
              deadline,
              onUsage: (usage) => {
                ports.metrics?.recordEmbeddingCall?.({
                  outcome: "ok",
                  purpose: "index",
                  latencyMs: Date.parse(ports.clock()) - Date.parse(indexStartedAt),
                  promptTokens: usage.promptTokens,
                  completionTokens: usage.completionTokens,
                  totalTokens: usage.totalTokens,
                });
              },
              onFailure: (code) => {
                ports.metrics?.recordEmbeddingCall?.({
                  outcome: code,
                  purpose: "index",
                  latencyMs: Date.parse(ports.clock()) - Date.parse(indexStartedAt),
                  promptTokens: 0,
                  completionTokens: 0,
                  totalTokens: 0,
                });
              },
            });

            // For symmetry with `structured_action`'s ending — out of combat
            // (guaranteed by guard 2 above) this yields nothing; the
            // client's input re-enables on the `narrative_emitted` fold
            // instead.
            yield* playerAffordances();
            return;
          }

          case "check": {
            const ability = checkAbilityFor(ports.skillAbilities, classification);
            const modifier = checkModifierFor(statics.character, ability, classification.skill);
            const dc = DC_BY_DIFFICULTY[classification.difficulty];
            const seed = ports.seedFor(campaign.state.world.rootSeed, campaign.nextSequence);

            // `abilityScore: 10` is not a placeholder: `modifier` above
            // already folds the character's ability score AND proficiency
            // (design spec Decision 6), so passing it as `situationalBonus`
            // is the check's ENTIRE contribution. `abilityScore: 10` makes
            // `abilityCheck`'s own ability-modifier term
            // (`abilityModifier(10) === 0`) contribute exactly nothing, so
            // `situationalBonus` alone is what decides the roll rather than
            // being added on top of a second, redundant ability term.
            const result = abilityCheck(
              { abilityScore: 10, situationalBonus: modifier, dc },
              seeded(seed),
            );

            // See `intent_classified`'s own comment above: `.parse`d so
            // `CheckRolledPayload` is load-bearing too, not decoration.
            yield* emit("check_rolled", {
              ...CheckRolledPayload.parse({
                actorId: statics.character.characterId,
                ability,
                ...(classification.skill === undefined ? {} : { skill: classification.skill }),
                difficulty: classification.difficulty,
                dc,
                naturalRoll: result.naturalRoll,
                rolls: result.rolls,
                modifier: result.modifier,
                total: result.total,
                success: result.success,
                seed,
              }),
            });

            // No state change (design spec Non-goals: a check informs
            // narration and the log, it does not gate traversal) — this
            // branch never calls `emit`/`emitAll` for a scene event.
            yield* sceneNarrate(
              statics.character.characterId,
              {
                kind: "check",
                ability,
                ...(classification.skill === undefined ? {} : { skill: classification.skill }),
                success: result.success,
              },
              deadline,
            );
            yield* playerAffordances();
            return;
          }

          // Narrate-only categories (design spec Decision 6): a grounded
          // reply off the scene card and the category alone, no event beyond
          // the `player_input`/`intent_classified` pair already emitted
          // above, and no state change. `combat` does not enter combat here
          // (Non-goals: the combat bridge is a later step) — it only tells
          // the player fighting is not available this way yet.
          case "social":
          case "ooc":
          case "combat": {
            yield* sceneNarrate(
              statics.character.characterId,
              { kind: "reply", category: classification.category },
              deadline,
            );
            yield* playerAffordances();
            return;
          }
        }

        // Reached only when `classification.category` matched none of the
        // cases above — unreachable today because every member of
        // `IntentClassification`'s discriminant is listed, which is exactly
        // what lets TypeScript narrow `classification` to `never` here. This
        // is the real exhaustiveness check the plain "no default" switch
        // above cannot provide on its own: `handleCommand` is a generator
        // (`AsyncIterable<ServerFrame>`), so a missing `case` does not trip
        // TS2366 the way it would in a value-returning function like
        // `reduce`'s — nothing forces every branch to "return a value".
        // Deleting a case here makes `classification` still include that
        // member's literal type at this point, `never` becomes a lie, and
        // the file fails to compile. That is the property this line exists
        // to buy, not the throw's message (which is genuinely unreachable
        // while the schema's five members match the five cases above).
        assertNever(classification);
        return;
      }

      case "structured_action": {
        // Idempotency as a projection, not connection state: this survives a
        // reconnect, so a resent action after a dropped ack is dropped here
        // rather than played twice. `reduce` appends to
        // `appliedClientMessageIds` unconditionally — it does not dedupe —
        // so this check is the only thing standing between a resend and a
        // second turn. It must run before anything else, including the
        // turn-order check: by the time a duplicate arrives, the turn it
        // named may already have moved on to someone else.
        if (campaign.state.world.appliedClientMessageIds.includes(command.clientMessageId)) return;

        // No open bracket, so there is no turn to take. `not_your_turn`
        // rather than a new code: the situation is the one that code already
        // covers — a click the affordance frame does not sanction, which the
        // client deliberately does not surface (`ErrorBanner.tsx`) — and it
        // is already the answer a player gets for acting after a fight has
        // ended (`packages/schemas/src/conclusion.ts`). A closed bracket is
        // the same moment, one event later.
        //
        // Refused with a frame rather than `encounterOf`'s throw because this
        // is the one place a closed bracket is an ordinary client mistake
        // instead of a corrupt log: nothing else on the turn path is
        // reachable without a board, but a socket can send this at any time.
        if (campaign.state.encounter === null) {
          yield {
            type: "error",
            clientMessageId: command.clientMessageId,
            code: "not_your_turn",
            message: "No encounter is open in this campaign.",
          };
          return;
        }

        const encounter = encounterOf(campaign);
        const currentActorId = encounter.turnOrder[encounter.currentActorIndex];
        if (currentActorId !== command.actorId) {
          yield {
            type: "error",
            clientMessageId: command.clientMessageId,
            code: "not_your_turn",
            message: `It is ${currentActorId ?? "nobody"}'s turn.`,
          };
          return;
        }

        // Resolved before player_input is appended: this is a defensive
        // branch (turn order and combatants both come from the same
        // projection, so it should be unreachable), but if it ever does
        // fire, the client must still be able to retry the same
        // clientMessageId. Appending player_input first would mark it
        // permanently applied and the dedupe check above would silently
        // drop every retry.
        const world = worldFor(campaign);
        const actor = world.combatants.find((each) => each.combatantId === command.actorId);
        if (actor === undefined) {
          yield {
            type: "error",
            clientMessageId: command.clientMessageId,
            code: "internal_error",
            message: `No combatant ${command.actorId} in this encounter.`,
          };
          return;
        }

        yield* emit("player_input", {
          clientMessageId: command.clientMessageId,
          actorId: command.actorId,
        });

        const validation = validateExecuteTurn(command.turn, actor, world);
        if (!validation.valid) {
          const reasons = validation.rejections.map((each) => each.reason);
          const messages = validation.rejections.map((each) => each.message);
          yield* emit("action_rejected", {
            actorId: command.actorId,
            attempt: 1,
            stage: "engine",
            reasons,
            messages,
            proposedTurn: command.turn,
            provider: "human",
            modelId: "human",
          });
          // No auto-retry for a human: that loop exists because a model
          // cannot read a UI. The turn does not advance.
          yield { type: "rejected", clientMessageId: command.clientMessageId, reasons, messages };
          // A rejection is a third point at which the pipeline knows control
          // sits with the player, alongside `join` and a completed turn: the
          // turn did not advance, so it is still their move. Without this,
          // the client's own event-frame fold (which clears affordances on
          // every event, including `action_rejected`) is left with no
          // affordance frame ever following, and no way to recover short of
          // a reconnect.
          yield* playerAffordances();
          return;
        }

        // `source: "human"` mirrors the rejection path just above
        // (`provider: "human"`, `modelId: "human"`) so both call sites for
        // this actor read uniformly — the enemy path's `action_validated`
        // (below, in `enemyTurn`) stamps `source` too, from
        // `TurnProposalSource`. `reduce` treats the field as a no-op either
        // way; this is purely for a reader of the log.
        yield* emit("action_validated", {
          actorId: command.actorId,
          turn: command.turn,
          source: "human",
        });

        const seed = ports.seedFor(campaign.state.world.rootSeed, campaign.nextSequence);
        const { world: after, effect } = applyTurn({
          world,
          actorId: command.actorId,
          turn: command.turn,
          plan: validation.plan,
          context: { statBlocks: builtOf(campaign).statBlocks },
          rng: seeded(seed),
        });

        yield* emit("dice_rolled", {
          actorId: command.actorId,
          seed,
          attacks: effect.attacks,
          movedFeet: effect.movedFeet,
        });
        yield* emit("state_delta_applied", { combatants: after.combatants });
        // A single shared cap for this turn's post-validation stretch — see
        // `enemyTurn`'s identical rationale. The player path has no
        // tactical call to share the budget with, so the deadline is
        // simply struck here, immediately before the narration that is
        // this stretch's only external, potentially-slow call.
        yield* narrate(command.actorId, effect, Date.now() + ports.turnTimeoutMs);
        yield* emit("scene_changed", { kind: "turn_advanced" });
        yield* runEnemyTurns();
        yield* resolveIfConcluded();
        yield* playerAffordances();
        return;
      }

      default: {
        // Exhaustiveness guard: `reduce` gets this for free by returning
        // `CampaignState` (a missing case fails to compile), but this
        // function returns `void` via `yield`, so a fourth `ClientMessage`
        // member would otherwise compile and silently yield zero frames
        // instead of failing loudly. `command` is `never` here as long as
        // every real member is handled above — if it stops being `never`,
        // that is this guard doing its job.
        const exhaustiveCheck: never = command;
        throw new Error(`Unhandled ClientMessage type: ${JSON.stringify(exhaustiveCheck)}`);
      }
    }
  } catch (error) {
    // The store throws three error classes on a failed append or read
    // (SequenceConflictError, CampaignMismatchError, EventStoreUnavailableError).
    // None has a dedicated ServerErrorCode, so all fold onto internal_error.
    // Because this sits outside `emit`, a failed append never bumps
    // `nextSequence` or mutates `campaign.state` — the append-and-yield
    // invariant holds by never letting either half happen without the other.
    // Anything else still rethrows: a programmer error must not be swallowed
    // into a frame, which is why the store wraps its own failures in a class
    // rather than this catching everything.
    if (
      error instanceof SequenceConflictError ||
      error instanceof CampaignMismatchError ||
      error instanceof EventStoreUnavailableError
    ) {
      const clientMessageId = clientMessageIdOf(command);
      yield {
        type: "error",
        ...(clientMessageId === undefined ? {} : { clientMessageId }),
        code: "internal_error",
        message: error.message,
      };
      // Same reasoning as the rejection path: a failed append leaves
      // `campaign.state` untouched (that is the whole point of doing this
      // outside `emit`), so the turn did not advance and control is still
      // wherever it was. If that is the player, they must get a fresh
      // affordance set — the frames `emit` already streamed before the
      // throw have nulled the client's, and an `error` frame does not
      // replace them. Without this the board goes inert on the player's
      // own turn — the inert-board soft-lock, in a rarer costume.
      yield* playerAffordances();
      return;
    }
    throw error;
  }
}
