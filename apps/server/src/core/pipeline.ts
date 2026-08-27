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
import { affordancesFor, applyTurn, seeded, validateExecuteTurn } from "@ai-dm/rules-engine";
import type { TurnEffect } from "@ai-dm/rules-engine";
import {
  availableActionsFor,
  buildNarrationBrief,
  createDeterministicNarrative,
  NARRATIVE_PROMPT_VERSION,
} from "@ai-dm/agents";
import type {
  NarrativePort,
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
import type { EventStore } from "@ai-dm/memory";
import { reduce } from "@ai-dm/schemas";
import type {
  ClientMessage,
  Condition,
  GameEvent,
  NarrationSource,
  ServerFrame,
} from "@ai-dm/schemas";
import { builtOf, encounterOf, NARRATION_WINDOW, worldFor } from "./campaign.js";
import type { Campaign } from "./campaign.js";

/** `apps/server/CLAUDE.md`: snapshot every 50 events. */
export const SNAPSHOT_EVERY = 50;

/**
 * Per-turn tactical-agent metrics (`apps/server/CLAUDE.md`: "tokens in/out,
 * cached tokens, latency, retries, cost ... emitted as structured logs from
 * day one"). Recorded only for turns that actually called the tactical
 * agent — a player's `structured_action` makes no model call and has
 * nothing to report.
 *
 * Two of the spec's five fields are deliberately absent (task-corrections.md
 * addendum, C-23/C-39):
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
   * tier it never actually had (review finding, task 14 round 2).
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
   * (`packages/agents/src/tactical/index.ts:152`) only pushes onto `usage`
   * `if (result.error.usage !== undefined)` — an attempt that failed before
   * the provider reported any usage (e.g. `provider_error`) contributes no
   * entry, so `usage.length` can undercount attempts. `index.test.ts:254`
   * pins exactly this: a two-attempt run reporting `usage.length === 1`.
   * Named for what it actually measures rather than "attempts" (review
   * finding, task 14 round 2).
   */
  billedAttempts: number;
  /**
   * `proposal.rejections.length`: every attempt the agent made, billed or
   * not — the true retry count C-23 asks for, which `billedAttempts` alone
   * would silently undercount whenever an attempt failed unbilled.
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
}

export interface TurnPorts {
  store: EventStore;
  tactical: TacticalAgent;
  narrative: NarrativePort;
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
 * C-19: a naive version of this races `iterator.next()` against a fresh
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

  // C-36b: this loop has no bound of its own on how long it can be
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

function endsComplete(text: string): boolean {
  const trimmed = text.trimEnd();
  return trimmed !== "" && NARRATION_TERMINATORS.some((mark) => trimmed.endsWith(mark));
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
    // payload (C-27, reduce.ts's `.parse` calls) — a throw here must fail
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
    let text = "";
    for await (const chunk of untilDeadline(ports.narrative.stream(input), deadline)) {
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
      for await (const chunk of createDeterministicNarrative().stream(input)) {
        text += chunk;
        yield { type: "narrative_token", streamId, text: chunk };
      }
    }

    // One call per narrated turn, whichever rung produced it — the pipeline
    // is the only place that knows `actorId` and `source`; the agent itself
    // knows neither. `latencyMs` is the two `ports.clock()` reads above and
    // here, not wall time, for the same determinism reason `startedAt` is.
    const latencyMs = Date.parse(ports.clock()) - Date.parse(startedAt);
    ports.metrics?.recordNarrativeTurn({
      actorId,
      source,
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
      text,
      source,
      promptVersion: NARRATIVE_PROMPT_VERSION,
    });

    campaign.recentNarrations = [...campaign.recentNarrations, text].slice(-NARRATION_WINDOW);
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

    // C-23/C-39: `proposal.usage` is the only place token counts for this
    // call exist — `enemyTurn` used to drop it on the floor. One line per
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
   * Run hostiles until it is a party member's turn again, or nobody is left
   * to fight. Bounded by the turn order's length rather than an unbounded
   * loop: each pass through the body either returns or emits exactly one
   * `turn_advanced`, which `reduce` turns into exactly one step of
   * `currentActorIndex` — so a bug that failed to ever return control to the
   * party (or a fight that somehow never runs out of a second living
   * faction) still cannot spin more than `turnOrder.length + 1` iterations
   * here. The encounter's own termination — someone eventually dies — is a
   * property of the combat math (C-31), not of this loop; this bound exists
   * purely so a defect in that math or in `reduce` cannot hang the pipeline.
   */
  async function* runEnemyTurns(): AsyncIterable<ServerFrame> {
    for (let guard = 0; guard <= encounterOf(campaign).turnOrder.length; guard += 1) {
      // Re-read per pass, not hoisted: `enemyTurn` and the skip below both
      // emit, and `emit` replaces `campaign.state` wholesale — a board bound
      // before the loop would describe a turn that has already ended.
      const encounter = encounterOf(campaign);
      const actorId = encounter.turnOrder[encounter.currentActorIndex];
      if (actorId === undefined) return;

      const combatant = encounter.combatants.find((each) => each.combatantId === actorId);
      if (combatant === undefined) return;
      if (combatant.faction === "party") return;

      // A downed or dead creature is skipped, not asked for a turn.
      if (combatant.status !== "alive") {
        yield* emit("scene_changed", { kind: "turn_advanced" });
        continue;
      }

      const livingFactions = new Set(
        encounterOf(campaign)
          .combatants.filter((each) => each.status === "alive")
          .map((each) => each.faction),
      );
      if (livingFactions.size < 2) return;

      yield* enemyTurn(actorId);
    }
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

    // Review round 1, item 5: the spread comes first and the explicit
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

          // C-16 / spec §Reconnect: "without resumeFrom, or when it predates
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
          // instead of 3 events — correct, but wasteful, and per C-30 that
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
        yield {
          type: "error",
          clientMessageId: command.clientMessageId,
          code: "free_text_not_supported",
          message: "Free text is not handled yet. Use the on-screen actions.",
        };
        return;
      }

      case "structured_action": {
        // Idempotency as a projection, not connection state: this survives a
        // reconnect, so a resent action after a dropped ack is dropped here
        // rather than played twice. `reduce` (C-28) appends to
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
        // ended (`state/conclusion.ts`, C-37). A closed bracket is the same
        // moment, one event later.
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
    // C-29: the store throws three error classes on a failed append or read
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
      // own turn, which is exactly the C-1 soft-lock in a rarer costume.
      yield* playerAffordances();
      return;
    }
    throw error;
  }
}
