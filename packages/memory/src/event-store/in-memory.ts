import type { GameEvent } from "@ai-dm/schemas";
import type { EventSnapshot, EventStore } from "./port.js";
import { findAppendConflict } from "./validate.js";

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

      // Validate the whole batch before mutating anything — that is what
      // makes this atomic, and what the Postgres store gets from its
      // transaction.
      const conflict = findAppendConflict(sessionId, events, taken);
      if (conflict !== null) return Promise.reject(conflict);

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
      // must not be able to reach into the cache. Mirrors `readSince`, which
      // never hands back the live `events` array either.
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
