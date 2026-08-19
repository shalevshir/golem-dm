// The projection. State is a fold of the event log and nothing else
// (invariant 3), so this function is the only place a `SessionState` changes
// shape — and it is pure, total and never mutates its input, which is what
// lets the same fold run on the client.
//
// `GameEvent.payload` is `z.record(z.string(), z.unknown())` on the wire, so
// every payload this cares about is parsed here rather than cast. An event
// whose payload does not parse is a bug in whoever wrote it, and throwing is
// better than folding a half-understood event into state.
import { z } from "zod";
import type { GameEvent, SessionState } from "@ai-dm/schemas";
import { Combatant } from "@ai-dm/schemas";

// The task brief's "Interfaces" preview names this pair `SessionStartedPayload`
// and `TurnAdvancedPayload`, but `GameEvent.type` has no `session_started` or
// `turn_advanced` member — turn advancement is one `kind` of `scene_changed`,
// and nothing in this file (or the rest of the event enum) needs a
// session-started payload at all. That preview list predates the brief's own
// worked implementation below and was not kept in sync with it; the worked
// implementation is what was built and tested here. This schema parses the
// whole `scene_changed` payload — `kind` is what `reduce` switches on below.
export const PlayerInputPayload = z.object({ clientMessageId: z.string() });
export const StateDeltaAppliedPayload = z.object({ combatants: z.array(Combatant) });
export const SceneChangedPayload = z.object({ kind: z.string() });

export function reduce(state: SessionState, event: GameEvent): SessionState {
  switch (event.type) {
    case "player_input": {
      const { clientMessageId } = PlayerInputPayload.parse(event.payload);
      return {
        ...state,
        appliedClientMessageIds: [...state.appliedClientMessageIds, clientMessageId],
      };
    }

    case "state_delta_applied": {
      const { combatants } = StateDeltaAppliedPayload.parse(event.payload);
      return { ...state, combatants };
    }

    case "scene_changed": {
      const { kind } = SceneChangedPayload.parse(event.payload);
      if (kind !== "turn_advanced") return state;
      const next = state.currentActorIndex + 1;
      const wrapped = next >= state.turnOrder.length;
      return {
        ...state,
        currentActorIndex: wrapped ? 0 : next,
        round: wrapped ? state.round + 1 : state.round,
      };
    }

    // Recorded for replay, audit and 7b's rejection dataset, but they change
    // no projected field. Listed explicitly rather than caught by `default` so
    // adding a `GameEvent` type fails the exhaustiveness check here.
    case "intent_classified":
    case "action_proposed":
    case "action_validated":
    case "action_rejected":
    case "dice_rolled":
    case "narrative_emitted":
    case "session_snapshot":
      return state;
  }
}

export function fold(state: SessionState, events: readonly GameEvent[]): SessionState {
  return events.reduce(reduce, state);
}
