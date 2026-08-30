// The projection. State is a fold of the event log and nothing else
// (invariant 3), so this function is the only place a `CampaignState` changes
// shape — and it is pure, total and never mutates its input.
//
// It lives in `@ai-dm/schemas` so that `apps/web` — which may depend on this
// package and only this package (invariant 5) — has a fold to run at all.
//
// `fold` alone projects a whole campaign log, brackets included. That was not
// true between §4.7 steps 1 and 5: `encounter_started` named an encounter and
// nothing more, so only `apps/server/src/core/campaign.ts`'s `loadCampaign`
// could rebuild a board out of the encounter catalogue, and a client folding
// that event onto `encounter: null` got `state` back unchanged with no error
// — a silent gap, not a throw. Step 5 closed it by putting the initial board
// in the payload (see the `encounter_started` case below), which is the same
// rule genesis already followed: an event names what it declares, completely,
// and the fold reads it without consulting anything else.
//
// One residue remains, and it is bounded: a payload persisted BEFORE step 5
// carries no board, and this function cannot invent one. `loadCampaign` keeps
// a catalogue substitution reached only for those. No client can be affected
// by it — the only logs lacking a board are combat-only campaigns, and
// `POST /campaigns`'s `encounterId` branch still awaits `startEncounter`
// before returning a `campaignId`, so their client always joins after
// `encounter_started` and can never receive it as a live frame.
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
import {
  EncounterStartedPayload,
  EncounterResolvedPayload,
  QuestNodeEnteredPayload,
  QuestNodeCompletedPayload,
  WorldDeltaAppliedPayload,
} from "./events.js";
import type { GameEvent } from "./events.js";
import type { CampaignState, SceneSnapshot } from "./protocol.js";

// `GameEvent.type` has no `session_started` or `turn_advanced` member: turn
// advancement is one `kind` of `scene_changed`, not an event type of its own.
// This schema parses the whole `scene_changed` payload — `kind` is what
// `reduce` switches on below.
export const PlayerInputPayload = z.object({ clientMessageId: z.string() });
export const StateDeltaAppliedPayload = z.object({ combatants: z.array(Combatant) });
export const SceneChangedPayload = z.object({ kind: z.string() });

// Guards the four out-of-combat scene events, mirroring the encounter-null
// throws above in both structure and message wording family: a scene event
// with no scene open is the same corrupt-log class as a combat event with no
// encounter open, and gets the same loud-not-silent treatment.
function sceneOrThrow(state: CampaignState, event: GameEvent): SceneSnapshot {
  if (state.world.scene === null) {
    throw new Error(
      `Scene event ${event.type} at sequence ${String(event.sequence)} with no scene open`,
    );
  }
  return state.world.scene;
}

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
      // encounter for. §4.7 step 4 ended up modeling out-of-combat scene
      // change as its own event types (`quest_node_entered`,
      // `quest_node_completed`, `world_delta_applied`) rather than a second
      // `scene_changed` kind, so this gate has no current out-of-combat
      // caller — it stays because guarding the whole event type instead would
      // make any future non-`turn_advanced` kind, should one ever exist,
      // throw for arriving where it belongs.
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

    // Opens the bracket AND fills it. The payload carries the whole initial
    // board (spec Decision 2), so this is a complete fold with no catalogue
    // substitution — `apps/server/src/core/campaign.ts` no longer patches a
    // board in behind this branch for a log written from §4.7 step 5 onward.
    //
    // `currentActorIndex: 0` and `round: 1` are derived here rather than
    // carried: they are the same two constants `initialEncounterState` always
    // derived, and a payload that could disagree with them would be a second
    // way to express one fact.
    //
    // A legacy payload — one persisted before step 5, carrying no board —
    // still returns `state` unchanged, exactly as this branch always did.
    // `loadCampaign` keeps its `buildEncounterById` substitution for that
    // case alone, so an old campaign stays loadable.
    case "encounter_started": {
      const { encounterId, grid, combatants, turnOrder } = EncounterStartedPayload.parse(
        event.payload,
      );
      if (state.encounter !== null) {
        throw new Error(
          `encounter_started at sequence ${String(event.sequence)} names encounter ` +
            `${encounterId}, but encounter ${state.encounter.encounterId} is already open`,
        );
      }
      if (grid === undefined || combatants === undefined || turnOrder === undefined) {
        return state;
      }
      return {
        ...state,
        encounter: { encounterId, grid, combatants, turnOrder, currentActorIndex: 0, round: 1 },
      };
    }

    // Closes it, and keeps the world: `appliedClientMessageIds` outlives the
    // fight, while the combatants, their HP and their positions leave with
    // it. Whatever must survive travels in the payload and, from §4.7's step
    // 5 onward, into declared world-state effects.
    //
    // Closing a bracket that was never open is the same corrupt-log class as
    // a combat event outside one, and throws for the same reason: the
    // resulting projection would be indistinguishable from a legitimate one.
    case "encounter_resolved": {
      const { encounterId } = EncounterResolvedPayload.parse(event.payload);
      if (state.encounter === null) {
        throw new Error(
          `encounter_resolved at sequence ${String(event.sequence)} with no encounter open`,
        );
      }
      // `reduce` is the fold for an arbitrary log, not only for the one
      // `resolveEncounter` produces (`resolveEncounter` itself cannot name
      // the wrong encounter — it takes `encounterId` from the open bracket,
      // never from a caller — which is exactly why this check needs its own
      // test at this level rather than one through that function). A
      // `encounter_resolved` naming a different encounter than the one open
      // is the same corrupt-log class as closing a bracket that was never
      // open, one check further: it means some other producer, or a hand-
      // edited log, is closing a fight the projection was not actually in.
      if (encounterId !== state.encounter.encounterId) {
        throw new Error(
          `encounter_resolved at sequence ${String(event.sequence)} names encounter ` +
            `${encounterId} but ${state.encounter.encounterId} is the one open`,
        );
      }
      return { ...state, encounter: null };
    }

    // Replaces `scene.currentNodeId` verbatim. Whether the traversal was
    // legal is `traverseEdge`'s call (`@ai-dm/rules-engine`, invariant 1) —
    // by the time this event exists, that decision is already made, and this
    // fold merely records its result. No band math, no clamp, no authored-
    // world lookup: mechanical, like every branch below it.
    case "quest_node_entered": {
      const scene = sceneOrThrow(state, event);
      const { nodeId } = QuestNodeEnteredPayload.parse(event.payload);
      return {
        ...state,
        world: { ...state.world, scene: { ...scene, currentNodeId: nodeId } },
      };
    }

    // Appends to `scene.completedNodeIds`, folding a repeat of the same node
    // to one entry — idempotent the same way a set would be, without adding
    // a set to the wire format.
    case "quest_node_completed": {
      const scene = sceneOrThrow(state, event);
      const { nodeId } = QuestNodeCompletedPayload.parse(event.payload);
      const completedNodeIds = scene.completedNodeIds.includes(nodeId)
        ? scene.completedNodeIds
        : [...scene.completedNodeIds, nodeId];
      return { ...state, world: { ...state.world, scene: { ...scene, completedNodeIds } } };
    }

    // Merges the engine's already-computed, already-clamped results onto
    // `scene` — never computes one. `relations` replaces the entry for the
    // same unordered faction pair (checked both ways, as a plain two-field
    // comparison — no `pairKey`, which lives in `authored-world.ts` and stays
    // there per invariant 4) or appends a new pair; `day`, when present,
    // replaces `scene.day` outright. Neither field present is a true no-op.
    case "world_delta_applied": {
      const scene = sceneOrThrow(state, event);
      const { relations, day } = WorldDeltaAppliedPayload.parse(event.payload);
      const nextRelations = relations.reduce((acc, entry) => {
        const index = acc.findIndex(
          (existing) =>
            (existing.factionA === entry.factionA && existing.factionB === entry.factionB) ||
            (existing.factionA === entry.factionB && existing.factionB === entry.factionA),
        );
        return index === -1
          ? [...acc, entry]
          : acc.map((existing, i) => (i === index ? entry : existing));
      }, scene.relations);
      return {
        ...state,
        world: {
          ...state.world,
          scene: { ...scene, relations: nextRelations, day: day ?? scene.day },
        },
      };
    }

    // Recorded for replay, audit and 7b's rejection dataset, but they change
    // no projected field. Listed explicitly rather than caught by `default` so
    // adding a `GameEvent` type fails the exhaustiveness check here.
    //
    // `campaign_started` is a no-op for the same reason `encounter_started`
    // cannot fill its own bracket: the world it declares is rebuilt from its
    // payload before the fold begins, not folded out of it. That is what
    // keeps "fold from a snapshot plus events equals fold from the campaign's
    // starting state" true.
    //
    // `check_rolled` joins this group for the same reason `dice_rolled`
    // already does: the roll is already resolved by the time this event
    // exists, and the event exists for replay, audit and metrics, not to
    // change `CampaignState`.
    case "campaign_started":
    case "intent_classified":
    case "action_proposed":
    case "action_validated":
    case "action_rejected":
    case "dice_rolled":
    case "narrative_emitted":
    case "check_rolled":
      return state;
  }
}

export function fold(state: CampaignState, events: readonly GameEvent[]): CampaignState {
  return events.reduce(reduce, state);
}
