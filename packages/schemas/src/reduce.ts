// The projection. State is a fold of the event log and nothing else
// (invariant 3), so this function is the only place a `CampaignState` changes
// shape — and it is pure, total and never mutates its input.
//
// It lives in `@ai-dm/schemas` rather than in `apps/server` so that client and
// server run the SAME fold, not two that must agree. `apps/web` may depend on
// this package and only this package (invariant 5); an equivalent-but-separate
// client fold was the alternative, and the drift it invites is exactly what
// this placement removes. `apps/server/src/core/` imports it from here.
//
// Nothing here may import a Node built-in, or `apps/web`'s bundle breaks — and
// nothing here may import `@ai-dm/rules-engine`, which would invert the
// dependency direction. The fresh action economy below is
// `ActionEconomy.parse({})` for that second reason; the engine's `startTurn()`
// is defined as the same expression, so there is one definition, not two.
//
// `GameEvent.payload` is `z.record(z.string(), z.unknown())` on the wire, so
// every payload this cares about is parsed here rather than cast. An event
// whose payload does not parse is a bug in whoever wrote it, and throwing is
// better than folding a half-understood event into state.
import { z } from "zod";
import { Combatant, ActionEconomy } from "./world.js";
import type { GameEvent } from "./events.js";
import type { CampaignState } from "./protocol.js";

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

export function reduce(state: CampaignState, event: GameEvent): CampaignState {
  switch (event.type) {
    // Campaign scope: an id applies to the whole campaign, not to whichever
    // fight happened to be open when it arrived. A resent action must still
    // be recognized as a duplicate after the encounter it named has ended.
    case "player_input": {
      const { clientMessageId } = PlayerInputPayload.parse(event.payload);
      return {
        ...state,
        world: {
          ...state.world,
          appliedClientMessageIds: [...state.world.appliedClientMessageIds, clientMessageId],
        },
      };
    }

    case "state_delta_applied": {
      const { combatants } = StateDeltaAppliedPayload.parse(event.payload);
      // Loud, not silent. A combat event outside a bracket means the log is
      // corrupt or a producer is wrong, and returning `state` here would
      // project a plausible-looking board out of an impossible history —
      // far worse to debug than a throw at the sequence that caused it.
      // Same class as this function's existing `.parse` failures.
      if (state.encounter === null) {
        throw new Error(
          `Combat event ${event.type} at sequence ${String(event.sequence)} with no encounter open`,
        );
      }
      return { ...state, encounter: { ...state.encounter, combatants } };
    }

    case "scene_changed": {
      const { kind } = SceneChangedPayload.parse(event.payload);
      if (kind !== "turn_advanced") return state;
      // Checked after the `kind` gate, not before: `turn_advanced` is the one
      // kind that is a combat signal (this event keeps a narrative name it
      // has never earned), and it is exactly the kind this branch writes the
      // encounter for. Guarding the whole event type instead would make any
      // future out-of-combat scene change — the kind §4.7's step 4 will
      // emit — throw for arriving where it belongs.
      if (state.encounter === null) {
        throw new Error(
          `Combat event ${event.type} at sequence ${String(event.sequence)} with no encounter open`,
        );
      }
      const encounter = state.encounter;
      const next = encounter.currentActorIndex + 1;
      const wrapped = next >= encounter.turnOrder.length;
      const currentActorIndex = wrapped ? 0 : next;
      const round = wrapped ? encounter.round + 1 : encounter.round;

      // A fresh action economy is the start of a turn (mirrors
      // `tools/sim/src/engine/encounter.ts`'s reset at the same logical
      // moment). `applyTurn` sets `actionEconomy: plan.economyAfter` on
      // whoever just acted, spending it — nothing else ever clears it, so
      // without this reset here, the combatant whose turn is beginning
      // would carry forward *their own* spent economy from *their own*
      // prior turn, forever after their first-ever turn (`actionEconomy` is
      // per-combatant; nobody else's economy is involved or affected).
      // `turn_advanced` is exactly the event that marks a new turn
      // starting, so the fold is where this belongs, not the pipeline: no
      // new event type, no protocol change, and replay reproduces it by
      // construction rather than depending on an emitter. Resetting a
      // dead/unconscious upcoming actor is harmless — nothing here revives
      // anyone, and `validateExecuteTurn` still refuses a non-`alive` actor
      // a turn regardless of its economy.
      const upNextId = encounter.turnOrder[currentActorIndex];
      const combatants = encounter.combatants.map((each) =>
        each.combatantId === upNextId ? { ...each, actionEconomy: ActionEconomy.parse({}) } : each,
      );

      return { ...state, encounter: { ...encounter, currentActorIndex, round, combatants } };
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

    // Declared ahead of the projection split that gives them meaning: the
    // next task moves the combat fields under `state.encounter`, and two of
    // these three become the events that open and close that bracket.
    // `campaign_started` stays a no-op even then — like genesis today, the
    // world it declares is rebuilt from its payload before the fold begins
    // rather than folded out of it.
    case "campaign_started":
    case "encounter_started":
    case "encounter_resolved":
      return state;
  }
}

export function fold(state: CampaignState, events: readonly GameEvent[]): CampaignState {
  return events.reduce(reduce, state);
}
