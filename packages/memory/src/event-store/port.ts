// The event log's storage boundary, and the two implementations' shared
// contract. `append` is an atomic batch that conflicts on
// (sessionId, sequence), which is exactly `game_events`' primary key — the
// Postgres store gets that atomicity from a transaction, the in-memory one
// from validating the whole batch before mutating anything.
import type { GameEvent, SessionState } from "@ai-dm/schemas";

export class SequenceConflictError extends Error {
  readonly sessionId: string;
  readonly sequence: number;

  constructor(sessionId: string, sequence: number) {
    super(`Event ${String(sequence)} already exists for session ${sessionId}`);
    this.name = "SequenceConflictError";
    this.sessionId = sessionId;
    this.sequence = sequence;
  }
}

/**
 * Raised when an event's own `sessionId` disagrees with the session it was
 * appended to. The log must never hold a row whose own payload contradicts
 * the stream containing it — a Postgres implementation that derives
 * `session_id` from the row rather than the call argument would silently
 * diverge from this one otherwise.
 */
export class SessionMismatchError extends Error {
  readonly sessionId: string;
  readonly eventSessionId: string;

  constructor(sessionId: string, eventSessionId: string) {
    super(
      `Event has sessionId "${eventSessionId}", which does not match the session "${sessionId}" it was appended to`,
    );
    this.name = "SessionMismatchError";
    this.sessionId = sessionId;
    this.eventSessionId = eventSessionId;
  }
}

/**
 * Every other way a durable store can fail: a dropped connection, a lock or
 * statement timeout, a deadlock, or a stored row that no longer parses as a
 * `GameEvent`. It exists so the store's failure surface stays a closed set of
 * three classes — `pipeline.ts` special-cases exactly those and rethrows
 * anything else, and an unhandled rejection there reaches a transport
 * catch-all that restores no player affordances.
 *
 * The in-memory store never raises this. It is not a bug that it doesn't:
 * the shared contract permits it, it does not require it.
 */
export class EventStoreUnavailableError extends Error {
  readonly operation: string;

  constructor(operation: string, cause: unknown) {
    // `{ cause }` rather than a redeclared field: `Error.cause` already
    // exists in the ES2022 lib, and redeclaring it would need `override`
    // under `noImplicitOverride`.
    super(`Event store unavailable during ${operation}`, { cause });
    this.name = "EventStoreUnavailableError";
    this.operation = operation;
  }
}

/** A projected `SessionState`, cached at the log `sequence` it reflects. */
export interface EventSnapshot {
  sequence: number;
  state: SessionState;
}

export interface EventStore {
  /**
   * Atomic over the batch. A turn emits several events and a crash mid-turn
   * must not leave half a turn in the log, so either all of them land or none.
   * Rejects with `SequenceConflictError` on a sequence collision (including a
   * duplicate within the batch itself) or `SessionMismatchError` if an
   * event's own `sessionId` disagrees with `sessionId`. Either rejection
   * leaves the store exactly as it was before the call.
   */
  append(sessionId: string, events: readonly GameEvent[]): Promise<void>;
  /** Everything with `sequence > afterSequence`, in ascending order. */
  readSince(sessionId: string, afterSequence: number): Promise<GameEvent[]>;
  latestSnapshot(sessionId: string): Promise<EventSnapshot | null>;
  /**
   * Keeps only the newest snapshot: a call whose `sequence` is less than or
   * equal to the one already stored is a no-op. Snapshots are a cache, never
   * authority — `fold(events)` must equal the snapshot at every snapshot
   * point, so this exists purely to speed up reconnect.
   */
  putSnapshot(sessionId: string, sequence: number, state: SessionState): Promise<void>;
}
