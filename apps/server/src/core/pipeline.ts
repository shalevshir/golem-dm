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
// This task (9) covers `join`, `free_text` and the player's own
// `structured_action`. Enemy turns are Task 10, appended to the same
// `structured_action` case after a successful player turn.
import { applyTurn, seeded, validateExecuteTurn } from "@ai-dm/rules-engine";
import type { TurnEffect } from "@ai-dm/rules-engine";
import type { NarrativePort, TacticalAgent } from "@ai-dm/agents";
import type { ClientMessage, GameEvent, ServerFrame } from "@ai-dm/schemas";
import { SequenceConflictError, SessionMismatchError } from "./event-store.js";
import type { EventStore } from "./event-store.js";
import { reduce } from "./reduce.js";
import type { Session } from "./session.js";
import { worldFor } from "./session.js";

/** `apps/server/CLAUDE.md`: snapshot every 50 events. */
export const SNAPSHOT_EVERY = 50;

export interface TurnPorts {
  store: EventStore;
  tactical: TacticalAgent;
  narrative: NarrativePort;
  clock: () => string;
  uuid: () => string;
  /** Deterministic per turn. Recorded in `dice_rolled`; replay reads it back. */
  seedFor: (rootSeed: number, sequence: number) => number;
  turnTimeoutMs: number;
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
    await ports.store.append(session.state.sessionId, [event]);
    session.nextSequence += 1;
    session.state = reduce(session.state, event);

    if (event.sequence > 0 && event.sequence % SNAPSHOT_EVERY === 0) {
      // A cache, never authority: `loadSession` folds the log regardless.
      await ports.store.putSnapshot(session.state.sessionId, event.sequence, session.state);
    }
    yield { type: "event", event };
  }

  async function* narrate(actorId: string, effect: TurnEffect): AsyncIterable<ServerFrame> {
    const streamId = ports.uuid();
    const actorName = session.built.statBlocks.get(actorId)?.nameEnglish ?? actorId;
    let text = "";
    for await (const chunk of ports.narrative.stream({
      actorName,
      effect,
      namesByCombatantId: namesFor(session),
    })) {
      text += chunk;
      yield { type: "narrative_token", streamId, text: chunk };
    }
    yield* emit("narrative_emitted", { actorId, streamId, text: text.trim() });
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

        yield* emit("player_input", {
          clientMessageId: command.clientMessageId,
          actorId: command.actorId,
        });

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

        yield* emit("action_validated", { actorId: command.actorId, turn: command.turn });

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
        yield* narrate(command.actorId, effect);
        yield* emit("scene_changed", { kind: "turn_advanced" });
        return;
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
