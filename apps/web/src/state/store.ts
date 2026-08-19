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
import { reduce } from "@ai-dm/schemas";
import type { ServerFrame, SessionState, TurnAffordances } from "@ai-dm/schemas";

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
}

export const initialClientState: ClientState = {
  snapshot: null,
  sequence: 0,
  affordances: null,
  narrative: "",
  narrativeStreamId: null,
  lastError: null,
  lastRejection: null,
};

export function applyFrame(state: ClientState, frame: ServerFrame): ClientState {
  switch (frame.type) {
    case "session_state":
      // Authoritative on arrival. Affordances computed against an older board
      // go with it — the server sends a fresh set if the player is up.
      return {
        ...state,
        snapshot: frame.snapshot,
        sequence: frame.sequence,
        affordances: null,
        lastError: null,
      };

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
