import type { GameEvent } from "@ai-dm/schemas";
import { SequenceConflictError, SessionMismatchError } from "./port.js";

/**
 * The append precondition, shared by both stores so neither can drift from
 * it. Order is observable and therefore part of the contract: each event's
 * `sessionId` is checked before its `sequence`, walking the batch in order,
 * so a batch whose first event conflicts and whose second mismatches raises
 * `SequenceConflictError` — not the other way round.
 *
 * `taken` holds the sequences already present for this session. The returned
 * error is thrown by the caller; returning it rather than throwing keeps this
 * function usable inside a transaction callback, where the throw is what
 * triggers the rollback.
 */
export function findAppendConflict(
  sessionId: string,
  events: readonly GameEvent[],
  taken: ReadonlySet<number>,
): SequenceConflictError | SessionMismatchError | null {
  const seen = new Set(taken);
  for (const event of events) {
    if (event.sessionId !== sessionId) {
      return new SessionMismatchError(sessionId, event.sessionId);
    }
    if (seen.has(event.sequence)) {
      return new SequenceConflictError(sessionId, event.sequence);
    }
    seen.add(event.sequence);
  }
  return null;
}
