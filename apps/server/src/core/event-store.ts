// The event log's storage boundary. Shaped around the SQL it will become:
// `append` is an atomic batch that conflicts on (sessionId, sequence), which
// is exactly `game_events`' unique constraint. The Postgres implementation in
// `@ai-dm/memory` is then a second implementation of this interface, not a
// refactor of its callers.
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

interface SessionLog {
  events: GameEvent[];
  snapshot: EventSnapshot | null;
}

export function createInMemoryEventStore(): EventStore {
  const logs = new Map<string, SessionLog>();

  function logFor(sessionId: string): SessionLog {
    const existing = logs.get(sessionId);
    if (existing !== undefined) return existing;
    const created: SessionLog = { events: [], snapshot: null };
    logs.set(sessionId, created);
    return created;
  }

  return {
    // No `async`/`await` needed anywhere here — the store is entirely
    // synchronous under the hood — so every method below returns
    // `Promise.resolve(...)` or `Promise.reject(...)` directly rather than
    // being declared `async` with nothing to await (see
    // @typescript-eslint/require-await).
    append(sessionId, events) {
      // Read the existing events without creating a map entry for an
      // unknown session — `logFor` (which does create one) is only called
      // once validation has fully passed, below. Otherwise a rejected batch
      // against a session nobody has written to yet would leave an empty
      // log record behind: not observable through the four public methods,
      // but not "literally unchanged" either, and a rolled-back SQL INSERT
      // would leave nothing.
      const existingEvents = logs.get(sessionId)?.events ?? [];
      const taken = new Set(existingEvents.map((each) => each.sequence));

      // Validate the whole batch before mutating anything — that is what makes
      // this atomic, and what the SQL version gets from its transaction.
      for (const event of events) {
        // The log must never hold a row whose own `sessionId` disagrees
        // with the stream containing it.
        if (event.sessionId !== sessionId) {
          return Promise.reject(new SessionMismatchError(sessionId, event.sessionId));
        }
        if (taken.has(event.sequence)) {
          return Promise.reject(new SequenceConflictError(sessionId, event.sequence));
        }
        taken.add(event.sequence);
      }
      const log = logFor(sessionId);
      log.events.push(...events);
      log.events.sort((a, b) => a.sequence - b.sequence);
      return Promise.resolve();
    },

    readSince(sessionId, afterSequence) {
      const events =
        logs.get(sessionId)?.events.filter((each) => each.sequence > afterSequence) ?? [];
      return Promise.resolve(events);
    },

    latestSnapshot(sessionId) {
      const snapshot = logs.get(sessionId)?.snapshot ?? null;
      // A copy, never the store's own record: a caller mutating the result
      // must not be able to reach into the cache. Mirrors `readSince`'s
      // `.filter`, which never hands back the live `events` array either.
      return Promise.resolve(snapshot === null ? null : { ...snapshot });
    },

    putSnapshot(sessionId, sequence, state) {
      const log = logFor(sessionId);
      if (log.snapshot === null || log.snapshot.sequence < sequence) {
        log.snapshot = { sequence, state };
      }
      return Promise.resolve();
    },
  };
}
