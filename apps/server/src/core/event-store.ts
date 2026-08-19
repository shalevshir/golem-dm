// The event log's storage boundary. Shaped around the SQL it will become:
// `append` is an atomic batch that conflicts on (sessionId, sequence), which
// is exactly `game_events`' unique constraint. The Postgres implementation in
// `@ai-dm/memory` is then a second implementation of this interface, not a
// refactor of its callers.
import type { GameEvent, SessionState } from "@ai-dm/schemas";

export class SequenceConflictError extends Error {
  constructor(sessionId: string, sequence: number) {
    super(`Event ${String(sequence)} already exists for session ${sessionId}`);
    this.name = "SequenceConflictError";
  }
}

export interface EventStore {
  /**
   * Atomic over the batch. A turn emits several events and a crash mid-turn
   * must not leave half a turn in the log, so either all of them land or none.
   */
  append(sessionId: string, events: readonly GameEvent[]): Promise<void>;
  /** Everything with `sequence > afterSequence`, in ascending order. */
  readSince(sessionId: string, afterSequence: number): Promise<GameEvent[]>;
  latestSnapshot(sessionId: string): Promise<{ sequence: number; state: SessionState } | null>;
  putSnapshot(sessionId: string, sequence: number, state: SessionState): Promise<void>;
}

interface SessionLog {
  events: GameEvent[];
  snapshot: { sequence: number; state: SessionState } | null;
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
    // `Promise.resolve(...)` directly rather than being declared `async`
    // with nothing to await (see @typescript-eslint/require-await).
    append(sessionId, events) {
      const log = logFor(sessionId);
      const taken = new Set(log.events.map((each) => each.sequence));

      // Validate the whole batch before mutating anything — that is what makes
      // this atomic, and what the SQL version gets from its transaction.
      for (const event of events) {
        if (taken.has(event.sequence)) {
          return Promise.reject(new SequenceConflictError(sessionId, event.sequence));
        }
        taken.add(event.sequence);
      }
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
      return Promise.resolve(logs.get(sessionId)?.snapshot ?? null);
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
