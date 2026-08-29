// The projection. State is a fold of the event log and nothing else
// (invariant 3), so this function is the only place a `CampaignState` changes
// shape — and it is pure, total and never mutates its input.
//
// It lives in `@ai-dm/schemas` so that `apps/web` — which may depend on this
// package and only this package (invariant 5) — has a fold to run at all.
// Since the campaign/encounter split, though, this function alone is no
// longer the whole projection: the server's is `reduce` PLUS a catalogue
// substitution (`apps/server/src/core/campaign.ts`'s `loadCampaign`, the
// `encounter_started` branch of its loop, which rebuilds the board `reduce`
// cannot fill — see the comment on that case below), while the client
// (`apps/web/src/state/store.ts`'s `applyFrame`) runs `reduce` alone, with no
// catalogue to substitute from. `fold` therefore can no longer project a
// campaign log across a bracket by itself; `loadCampaign` is the only
// complete projector today.
//
// The gap this opens is silent, not a throw: a client that folds
// `encounter_started` onto `encounter: null` gets `state` back unchanged —
// no error — so its `snapshot.encounter` stays null while the server's own
// projection has a board. `apps/web/src/App.tsx` then renders its "not ready
// yet" placeholder branch (`state.snapshot === null || encounter === null ||
// catalogue === null`) indefinitely, on a live socket that is otherwise
// working fine.
//
// §4.7 step 4 has landed the half of this that was actually load-bearing: a
// campaign no longer has to bundle a fight with its creation at all — a
// `worldId` campaign never does, and its client joins with `state.encounter`
// null from the start. That breaks the OLD justification for calling this
// gap unreachable, which leaned on "campaign creation always bundles a
// fight" as a blanket fact rather than a property of one HTTP route.
//
// It is not yet exercised, though: `POST /campaigns`'s `encounterId` branch
// still awaits `startEncounter` before it hands back a `campaignId`, so a
// combat campaign's very first snapshot a client can ever see already has
// its board — every current path remains as unreachable as this comment used
// to claim. What changed is WHICH step owns closing it. §4.7 step 5 (the
// combat bridge) is what starts a fight on a running campaign a client has
// already joined — the "combat" `free_text` category is explicitly a
// non-goal of this step (see `pipeline.ts`'s narrate-only categories) — and
// the moment that lands, its `encounter_started` streams to an already-open
// socket as a live `event` frame, hitting exactly this gap. This plan does
// not add the fix; `apps/web` still needs one (a catalogue fetch alongside
// `reduce`, or giving up on `fold` projecting a bracket at all) before step 5
// can safely ship.
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

    // Opens the bracket — but only by refusing to open a second one. What
    // the bracket CONTAINS cannot be folded: an encounter's initial board is
    // rebuilt from its `encounterId` through the encounter catalogue, which
    // lives downstream in `apps/server` and can never be imported here
    // (invariant 5). So `apps/server/src/core/campaign.ts` runs this guard,
    // then substitutes the rebuilt board — exactly as it already rebuilds
    // genesis rather than reading a persisted `state` field. The check still
    // belongs here, because `state.encounter` is this function's field and a
    // strictly non-overlapping bracket is what makes it a nullable field
    // rather than a map. The payload is parsed here too, so the file's own
    // rule above ("every payload this cares about is parsed here rather than
    // cast") holds for both bracket events, not just the one that closes —
    // `encounterId` is reported in the already-open error below for the same
    // reason `encounter_resolved`'s mismatch error names both ids.
    case "encounter_started": {
      const { encounterId } = EncounterStartedPayload.parse(event.payload);
      if (state.encounter !== null) {
        throw new Error(
          `encounter_started at sequence ${String(event.sequence)} names encounter ` +
            `${encounterId}, but encounter ${state.encounter.encounterId} is already open`,
        );
      }
      return state;
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
