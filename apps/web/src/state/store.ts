// The client's projection. It folds each `event` frame with the SAME `reduce`
// the server runs — imported from `@ai-dm/schemas`, not reimplemented — and
// treats a `campaign_state` frame as authoritative whenever one arrives.
//
// Folding rather than requesting a snapshot per turn is what preserves the
// per-event granularity a turn animation needs; re-snapshotting on every
// `campaign_state` is what bounds any divergence to a single turn instead of
// letting it persist silently.
//
// Pure: `applyFrame` never mutates its input, so React state updates and the
// fold-parity test both work the obvious way.
import { z } from "zod";
import { reduce } from "@ai-dm/schemas";
import { ActionType, ActionValidatedPayload, AttackTrace, DiceRolledPayload } from "@ai-dm/schemas";
import type {
  GameEvent,
  ServerFrame,
  CampaignState,
  EncounterState,
  TurnAffordances,
} from "@ai-dm/schemas";

/**
 * The `scene_affordances` frame minus its transport fields. Extracted from
 * `ServerFrame` rather than re-declared: invariant 4 puts the shape in
 * `@ai-dm/schemas` once, and a hand-written twin here is exactly the
 * duplicate it forbids.
 */
export type SceneAffordances = Omit<
  Extract<ServerFrame, { type: "scene_affordances" }>,
  "type" | "forSequence"
>;

export interface ClientState {
  snapshot: CampaignState | null;
  /** The highest sequence folded. Drives `resumeFrom` on a reconnect. */
  sequence: number;
  affordances: TurnAffordances | null;
  /**
   * The out-of-combat twin of `affordances`: the current scene node's edges,
   * as the player is allowed to see them. `null` until the first
   * `scene_affordances` frame, and in a combat-only campaign forever — the
   * server sends whichever of the two frames matches the mode.
   */
  sceneAffordances: SceneAffordances | null;
  /** The current turn's narrative, accumulated from its token stream. */
  narrative: string;
  narrativeStreamId: string | null;
  lastError: { code: string; message: string } | null;
  lastRejection: { reasons: string[]; messages: string[] } | null;
  combatLog: CombatLogTurn[];
}

/**
 * One turn's worth of combat-log content, built client-side from
 * `action_validated` + `dice_rolled` + `scene_changed` events. Not part of
 * `CampaignState` and not folded by `reduce()` -- purely additive display
 * state, the same category as `narrative` below.
 *
 * A zod schema rather than a plain interface because `state/persistence.ts`
 * writes this to `sessionStorage` and has to validate what it reads back,
 * and the repo's rule is that a shape is defined once (CLAUDE.md invariant
 * 4). The type is inferred from it, so the two cannot drift.
 */
export const CombatLogTurn = z.object({
  actorId: z.string(),
  /** Absent only when `forfeited` is true -- no action was ever validated. */
  actionType: ActionType.optional(),
  movedFeet: z.number(),
  attacks: z.array(AttackTrace),
  forfeited: z.boolean(),
});
export type CombatLogTurn = z.infer<typeof CombatLogTurn>;

export const initialClientState: ClientState = {
  snapshot: null,
  sequence: 0,
  affordances: null,
  sceneAffordances: null,
  narrative: "",
  narrativeStreamId: null,
  lastError: null,
  lastRejection: null,
  combatLog: [],
};

/**
 * Folds one event into the combat log. Parsing is defensive here, unlike
 * `reduce()`: a malformed `dice_rolled`/`action_validated` payload -- most
 * likely a `dice_rolled` event persisted before this feature shipped, which
 * lacks `movedFeet` -- is skipped with a warning rather than thrown, because
 * the combat log is a display feature layered on top of state, not state
 * itself. `reduce()`'s own throw-on-malformed-payload policy for
 * `state_delta_applied`/`scene_changed`/`player_input` is untouched by this
 * function and remains correct: the game genuinely cannot render without
 * valid state, but it can render just fine with an incomplete log.
 *
 * `snapshotBefore` is the board as it stood before THIS event -- needed on
 * `scene_changed: turn_advanced` to know whose turn just ended, since the
 * fold that actually updates `currentActorIndex` happens separately (in
 * `reduce`, called alongside this from `applyFrame`). It is the encounter
 * rather than the whole projection because a combat log is about a fight and
 * nothing in the world outside one; nullable because a campaign between
 * fights has no board at all.
 */
function foldCombatLog(
  log: readonly CombatLogTurn[],
  snapshotBefore: EncounterState | null,
  event: GameEvent,
): CombatLogTurn[] {
  switch (event.type) {
    case "action_validated": {
      const parsed = ActionValidatedPayload.safeParse(event.payload);
      if (!parsed.success) {
        console.warn("combatLog: skipping malformed action_validated payload", parsed.error);
        return [...log];
      }
      return [
        ...log,
        {
          actorId: parsed.data.actorId,
          actionType: parsed.data.turn.mainAction.actionType,
          movedFeet: 0,
          attacks: [],
          forfeited: false,
        },
      ];
    }

    case "dice_rolled": {
      const parsed = DiceRolledPayload.safeParse(event.payload);
      if (!parsed.success) {
        console.warn("combatLog: skipping malformed dice_rolled payload", parsed.error);
        return [...log];
      }
      const last = log.at(-1);
      if (last === undefined || last.actorId !== parsed.data.actorId) return [...log];
      return [
        ...log.slice(0, -1),
        { ...last, attacks: parsed.data.attacks, movedFeet: parsed.data.movedFeet },
      ];
    }

    case "scene_changed": {
      // No .safeParse() here, unlike the two cases above: reduce()'s own
      // scene_changed case DOES call SceneChangedPayload.parse and throws on
      // a malformed kind, and applyFrame computes `snapshot: reduce(...)`
      // before `combatLog: foldCombatLog(...)` in the same object literal --
      // so a bad payload never reaches this branch at all, it throws first.
      // dice_rolled and action_validated get no such upstream gate (reduce()
      // no-ops both), which is exactly why they need their own parse above.
      if (event.payload["kind"] !== "turn_advanced") return [...log];
      // Unreachable in practice, for the same reason the missing .safeParse()
      // above is safe: `reduce` throws on a `turn_advanced` folded with no
      // encounter open, and `applyFrame` computes `snapshot` before
      // `combatLog` in the same object literal -- so this branch never runs
      // on a log the server produced. Display state no-ops rather than
      // throwing where state itself would throw.
      if (snapshotBefore === null) return [...log];
      const currentActorId = snapshotBefore.turnOrder[snapshotBefore.currentActorIndex];
      if (currentActorId === undefined) return [...log];
      const last = log.at(-1);
      if (last !== undefined && last.actorId === currentActorId) return [...log];
      // A dead (or otherwise non-alive) combatant's turn is skipped by
      // `runEnemyTurns` with no preceding `action_validated` -- structurally
      // identical to a forfeit, but it is not one: the creature was never
      // asked for a turn at all. Without this guard, every fight where a
      // hostile dies mid-encounter renders a spurious "forfeited" entry for
      // the corpse the next time its turn comes up.
      const actor = snapshotBefore.combatants.find((each) => each.combatantId === currentActorId);
      if (actor?.status !== "alive") return [...log];
      // No group was ever opened for the actor whose turn just ended -- a
      // forfeit (e.g. the tactical-budget timeout).
      return [
        ...log,
        {
          actorId: currentActorId,
          actionType: undefined,
          movedFeet: 0,
          attacks: [],
          forfeited: true,
        },
      ];
    }

    // Everything else is out-of-combat or metrics-only and the combat log
    // stays combat-only (the spec's own words): listed explicitly, mirroring
    // `reduce`'s own no-op group in `packages/schemas/src/reduce.ts`, rather
    // than caught by a `default` -- a `default` here would let a future
    // `GameEvent` type reach this function with nobody ever having to decide
    // whether it belongs in the log. Listing every member makes that
    // decision the compiler's: adding a member to `GameEvent["type"]` with no
    // case here fails this switch's exhaustiveness (TS2366) rather than
    // silently falling through.
    case "player_input":
    case "intent_classified":
    case "action_proposed":
    case "action_rejected":
    case "state_delta_applied":
    case "narrative_emitted":
    case "campaign_started":
    case "encounter_started":
    case "encounter_resolved":
    case "quest_node_entered":
    case "quest_node_completed":
    case "world_delta_applied":
    case "check_rolled":
      return [...log];
  }
}

export function applyFrame(state: ClientState, frame: ServerFrame): ClientState {
  switch (frame.type) {
    case "campaign_state": {
      // Authoritative on arrival. Affordances computed against an older board
      // go with it — the server sends a fresh set if the player is up. A
      // `campaign_state` only ever arrives on join or resync, so any
      // transient UI state from before it — an in-flight error, a rejection
      // toast, prior combat-log entries — describes a moment that is now
      // stale; all are cleared with it rather than surviving to render as
      // if they just happened.
      //
      // Unless the frame lands on the sequence already folded, which is not
      // a move to a new moment at all — it is the same one restated. That is
      // exactly what a reload gets: a join without `resumeFrom` is answered
      // with the live projection at the newest sequence, and a client that
      // restored its display state from `state/persistence.ts` is holding a
      // log and a narration describing precisely that sequence. Clearing
      // them there would throw away the only copy of history the server does
      // not project (neither the roll log nor the narration is part of
      // `CampaignState`). The equality is what keeps this honest: the moment
      // the server's sequence and the client's disagree, the server wins and
      // both are dropped.
      const restated = frame.sequence === state.sequence;
      return {
        ...state,
        snapshot: frame.snapshot,
        sequence: frame.sequence,
        affordances: null,
        sceneAffordances: null,
        lastError: null,
        lastRejection: null,
        combatLog: restated ? state.combatLog : [],
        narrative: restated ? state.narrative : "",
        narrativeStreamId: restated ? state.narrativeStreamId : null,
      };
    }

    case "event": {
      if (state.snapshot === null) return state;
      return {
        ...state,
        snapshot: reduce(state.snapshot, frame.event),
        sequence: Math.max(state.sequence, frame.event.sequence),
        // The board just moved; anything computed against the old one is
        // stale. The server pushes a replacement when control is the
        // player's, so clearing here cannot strand the UI.
        affordances: null,
        // Same reasoning for the scene half: a traversal invalidates the
        // edge list, and every path through a turn ends in the
        // `playerAffordances()` call that replaces it.
        sceneAffordances: null,
        combatLog: foldCombatLog(state.combatLog, state.snapshot.encounter, frame.event),
      };
    }

    case "turn_affordances": {
      // Discard a frame older than the state we hold: an affordance set must
      // never be applied to a board that has already moved past it.
      if (frame.forSequence < state.sequence) return state;
      const affordances: TurnAffordances = {
        actorId: frame.actorId,
        reachableTiles: frame.reachableTiles,
        actions: frame.actions,
      };
      return { ...state, affordances };
    }

    case "scene_affordances": {
      // Same staleness rule as `turn_affordances` above: a set of edges must
      // never be applied to a scene that has already moved past them.
      if (frame.forSequence < state.sequence) return state;
      return {
        ...state,
        sceneAffordances: { nodeId: frame.nodeId, edges: frame.edges },
      };
    }

    case "narrative_token":
      return frame.streamId === state.narrativeStreamId
        ? { ...state, narrative: state.narrative + frame.text }
        : { ...state, narrative: frame.text, narrativeStreamId: frame.streamId };

    case "rejected":
      return { ...state, lastRejection: { reasons: frame.reasons, messages: frame.messages } };

    case "error":
      return { ...state, lastError: { code: frame.code, message: frame.message } };
  }
}
