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
// test assert an exact event stream, and what makes a replayed session
// reproduce the fight rather than a new one.
//
// `join`, `free_text` and the player's own `structured_action` (Task 9) are
// followed by the hostile sweep and the per-turn narration timeout (Task 10),
// appended to the same `structured_action` case after a successful player
// turn.
import { applyTurn, seeded, validateExecuteTurn } from "@ai-dm/rules-engine";
import type { TurnEffect } from "@ai-dm/rules-engine";
import { availableActionsFor, createDeterministicNarrative } from "@ai-dm/agents";
import type {
  NarrativePort,
  TacticalAgent,
  TurnProposalFailure,
  TurnProposalResult,
  TurnProposalSource,
} from "@ai-dm/agents";
import type { ClientMessage, GameEvent, ServerFrame } from "@ai-dm/schemas";
import { SequenceConflictError, SessionMismatchError } from "./event-store.js";
import type { EventStore } from "./event-store.js";
import { reduce } from "./reduce.js";
import type { Session } from "./session.js";
import { worldFor } from "./session.js";

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
}

function namesFor(session: Session): Record<string, string | undefined> {
  const names: Record<string, string | undefined> = {};
  for (const [combatantId, statBlock] of session.built.statBlocks) {
    names[combatantId] = statBlock.nameEnglish;
  }
  return names;
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

export async function* handleCommand(
  session: Session,
  command: ClientMessage,
  ports: TurnPorts,
): AsyncIterable<ServerFrame> {
  /**
   * Append one event and yield its frame. The single place either happens.
   * Mutates the session in step so a later stage in the same turn reads the
   * state the earlier stage produced.
   */
  async function* emit(
    type: GameEvent["type"],
    payload: Record<string, unknown>,
  ): AsyncIterable<ServerFrame> {
    const event: GameEvent = {
      eventId: ports.uuid(),
      sessionId: session.state.sessionId,
      sequence: session.nextSequence,
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
    const next = reduce(session.state, event);

    await ports.store.append(session.state.sessionId, [event]);
    session.nextSequence += 1;
    session.state = next;
    yield { type: "event", event };

    if (event.sequence > 0 && event.sequence % SNAPSHOT_EVERY === 0) {
      // A cache, never authority: `loadSession` folds the log regardless.
      // Deliberately after the yield — nothing downstream reads it within
      // the same turn, so it must not sit inside the append-and-yield
      // window either.
      await ports.store.putSnapshot(session.state.sessionId, event.sequence, session.state);
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
    const actorName = session.built.statBlocks.get(actorId)?.nameEnglish ?? actorId;
    const narrationInput = { actorName, effect, namesByCombatantId: namesFor(session) };
    let text = "";
    const primary = untilDeadline(ports.narrative.stream(narrationInput), deadline);
    for await (const chunk of primary) {
      text += chunk;
      yield { type: "narrative_token", streamId, text: chunk };
    }

    // The cap fired before a single token of `ports.narrative`'s own stream
    // arrived. Render the rule outcome directly through the same terse,
    // always-available port `apps/server/CLAUDE.md` names as the fallback —
    // still streamed as narrative_token frames, just from a source that
    // cannot itself hang.
    if (text.trim() === "") {
      for await (const chunk of createDeterministicNarrative().stream(narrationInput)) {
        text += chunk;
        yield { type: "narrative_token", streamId, text: chunk };
      }
    }
    // No further `.trim()`: this must carry exactly the concatenation of the
    // narrative_token chunks yielded above (the other half of the guarantee
    // Task 5's narrative port makes about its own streamed chunks). Both
    // sources used here happen to need no trimming, but that is a property
    // of those ports, not of this pipeline — a real LLM port with a
    // leading/trailing space must not make replay diverge from what the
    // client already rendered optimistically while streaming.
    yield* emit("narrative_emitted", { actorId, streamId, text });
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
    const world = worldFor(session);
    const statBlock = session.built.statBlocks.get(actorId);
    const deadline = Date.now() + ports.turnTimeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, Math.max(0, deadline - Date.now()));

    let proposal: TurnProposalResult;
    const proposalStartedAt = Date.now();
    try {
      proposal = await ports.tactical.proposeTurn({
        world,
        actorId,
        availableActions: statBlock === undefined ? [] : availableActionsFor(statBlock),
        turnOrder: session.state.turnOrder,
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

    const seed = ports.seedFor(session.state.rootSeed, session.nextSequence);
    const { world: after, effect } = applyTurn({
      world,
      actorId,
      turn: proposal.turn,
      plan: proposal.plan,
      context: { statBlocks: session.built.statBlocks },
      rng: seeded(seed),
    });

    yield* emit("dice_rolled", { actorId, seed, attacks: effect.attacks });
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
    for (let guard = 0; guard <= session.state.turnOrder.length; guard += 1) {
      const actorId = session.state.turnOrder[session.state.currentActorIndex];
      if (actorId === undefined) return;

      const combatant = session.state.combatants.find((each) => each.combatantId === actorId);
      if (combatant === undefined) return;
      if (combatant.faction === "party") return;

      // A downed or dead creature is skipped, not asked for a turn.
      if (combatant.status !== "alive") {
        yield* emit("scene_changed", { kind: "turn_advanced" });
        continue;
      }

      const livingFactions = new Set(
        session.state.combatants
          .filter((each) => each.status === "alive")
          .map((each) => each.faction),
      );
      if (livingFactions.size < 2) return;

      yield* enemyTurn(actorId);
    }
  }

  try {
    switch (command.type) {
      case "join": {
        const sessionId = session.state.sessionId;

        if (command.resumeFrom === undefined) {
          // Nothing to resume from: hand back the live projection wholesale.
          yield {
            type: "session_state",
            sequence: session.nextSequence - 1,
            snapshot: session.state,
          };
          return;
        }

        // C-16 / spec §Reconnect: "without resumeFrom, or when it predates
        // the retained log: session_state at the newest snapshot, then the
        // events since [the snapshot]." A resumeFrom older than the newest
        // snapshot is exactly the case a store that eventually prunes old
        // events would no longer be able to serve directly.
        //
        // Deliberate approximation: nothing actually prunes today, so
        // "older than the newest snapshot" is being used as a stand-in for
        // "predates the retained log" rather than a direct read of a
        // retention floor. That means a client only 3 events behind a
        // snapshot at sequence 50 still gets a whole `SessionState` resent
        // instead of 3 events — correct, but wasteful, and per C-30 that
        // payload only grows over a session's lifetime. Gate this on a real
        // retention floor once the store has one.
        const snapshot = await ports.store.latestSnapshot(sessionId);
        if (snapshot !== null && command.resumeFrom < snapshot.sequence) {
          yield { type: "session_state", sequence: snapshot.sequence, snapshot: snapshot.state };
          for (const event of await ports.store.readSince(sessionId, snapshot.sequence)) {
            yield { type: "event", event };
          }
          return;
        }

        for (const event of await ports.store.readSince(sessionId, command.resumeFrom)) {
          yield { type: "event", event };
        }
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
        if (session.state.appliedClientMessageIds.includes(command.clientMessageId)) return;

        const currentActorId = session.state.turnOrder[session.state.currentActorIndex];
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
        const world = worldFor(session);
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

        const seed = ports.seedFor(session.state.rootSeed, session.nextSequence);
        const { world: after, effect } = applyTurn({
          world,
          actorId: command.actorId,
          turn: command.turn,
          plan: validation.plan,
          context: { statBlocks: session.built.statBlocks },
          rng: seeded(seed),
        });

        yield* emit("dice_rolled", { actorId: command.actorId, seed, attacks: effect.attacks });
        yield* emit("state_delta_applied", { combatants: after.combatants });
        // A single shared cap for this turn's post-validation stretch — see
        // `enemyTurn`'s identical rationale. The player path has no
        // tactical call to share the budget with, so the deadline is
        // simply struck here, immediately before the narration that is
        // this stretch's only external, potentially-slow call.
        yield* narrate(command.actorId, effect, Date.now() + ports.turnTimeoutMs);
        yield* emit("scene_changed", { kind: "turn_advanced" });
        yield* runEnemyTurns();
        return;
      }

      default: {
        // Exhaustiveness guard: `reduce` gets this for free by returning
        // `SessionState` (a missing case fails to compile), but this
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
    // C-29: the store throws two error classes on a bad append
    // (SequenceConflictError, SessionMismatchError). Neither has a
    // dedicated ServerErrorCode, so both fold onto internal_error. Because
    // this sits outside `emit`, a failed append never bumps `nextSequence`
    // or mutates `session.state` — the append-and-yield invariant holds by
    // never letting either half happen without the other.
    if (error instanceof SequenceConflictError || error instanceof SessionMismatchError) {
      const clientMessageId = clientMessageIdOf(command);
      yield {
        type: "error",
        ...(clientMessageId === undefined ? {} : { clientMessageId }),
        code: "internal_error",
        message: error.message,
      };
      return;
    }
    throw error;
  }
}
