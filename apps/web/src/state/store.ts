// The client's projection. It folds each `event` frame with the SAME `reduce`
// the server runs — imported from `@ai-dm/schemas`, not reimplemented — and
// treats a `session_state` frame as authoritative whenever one arrives.
//
// Folding rather than requesting a snapshot per turn is what preserves the
// per-event granularity a turn animation needs; re-snapshotting on every
// `session_state` is what bounds any divergence to a single turn instead of
// letting it persist silently.
//
// Pure: `applyFrame` never mutates its input, so React state updates and the
// fold-parity test both work the obvious way.
import { z } from "zod";
import { reduce } from "@ai-dm/schemas";
import { ActionType, ActionValidatedPayload, AttackTrace, DiceRolledPayload } from "@ai-dm/schemas";
import type { GameEvent, ServerFrame, SessionState, TurnAffordances } from "@ai-dm/schemas";

export interface ClientState {
  snapshot: SessionState | null;
  /** The highest sequence folded. Drives `resumeFrom` on a reconnect. */
  sequence: number;
  affordances: TurnAffordances | null;
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
 * `SessionState` and not folded by `reduce()` -- purely additive display
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
 * `snapshotBefore` is the snapshot as it stood before THIS event -- needed
 * on `scene_changed: turn_advanced` to know whose turn just ended, since the
 * fold that actually updates `currentActorIndex` happens separately (in
 * `reduce`, called alongside this from `applyFrame`).
 */
function foldCombatLog(
  log: readonly CombatLogTurn[],
  snapshotBefore: SessionState,
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

    default:
      return [...log];
  }
}

export function applyFrame(state: ClientState, frame: ServerFrame): ClientState {
  switch (frame.type) {
    case "session_state": {
      // Authoritative on arrival. Affordances computed against an older board
      // go with it — the server sends a fresh set if the player is up. A
      // `session_state` only ever arrives on join or resync, so any
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
      // `SessionState`). The equality is what keeps this honest: the moment
      // the server's sequence and the client's disagree, the server wins and
      // both are dropped.
      const restated = frame.sequence === state.sequence;
      return {
        ...state,
        snapshot: frame.snapshot,
        sequence: frame.sequence,
        affordances: null,
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
        combatLog: foldCombatLog(state.combatLog, state.snapshot, frame.event),
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
