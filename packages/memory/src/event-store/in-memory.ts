import type { GameEvent } from "@ai-dm/schemas";
import type { EventSnapshot, EventStore } from "./port.js";
import { findAppendConflict } from "./validate.js";

interface CampaignLog {
  events: GameEvent[];
  snapshot: EventSnapshot | null;
}

/**
 * The copy this store keeps of whatever a caller hands it.
 *
 * A JSON round trip rather than `structuredClone`, because the Postgres
 * store writes to a jsonb column and a jsonb round trip is lossy in three
 * ways `structuredClone` is not: it drops a key whose value is `undefined`,
 * turns `NaN`/`Infinity` into `null`, and turns a `Date` into its ISO
 * string. Cloning faithfully here would leave the two implementations
 * disagreeing on exactly those payloads — a divergence the conformance suite
 * now pins (`contract.ts`, "drops a payload key whose value is undefined"),
 * per `packages/memory/CLAUDE.md`: a behaviour only one store has is a bug in
 * the contract. Taking the durable store's lossiness on deliberately is what
 * makes the pair interchangeable.
 */
function storedCopy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function createInMemoryEventStore(): EventStore {
  const logs = new Map<string, CampaignLog>();

  function logFor(campaignId: string): CampaignLog {
    const existing = logs.get(campaignId);
    if (existing !== undefined) return existing;
    const created: CampaignLog = { events: [], snapshot: null };
    logs.set(campaignId, created);
    return created;
  }

  return {
    // No `async`/`await` needed anywhere here — the store is entirely
    // synchronous under the hood — so every method below returns
    // `Promise.resolve(...)` or `Promise.reject(...)` directly rather than
    // being declared `async` with nothing to await (see
    // @typescript-eslint/require-await).
    append(campaignId, events) {
      // Read the existing events without creating a map entry for an
      // unknown campaign — `logFor` (which does create one) is only called
      // once validation has fully passed, below. Otherwise a rejected batch
      // against a campaign nobody has written to yet would leave an empty
      // log record behind: not observable through the four public methods,
      // but not "literally unchanged" either, and a rolled-back SQL INSERT
      // would leave nothing.
      const existingEvents = logs.get(campaignId)?.events ?? [];
      const taken = new Set(existingEvents.map((each) => each.sequence));

      // Validate the whole batch before mutating anything — that is what
      // makes this atomic, and what the Postgres store gets from its
      // transaction.
      const conflict = findAppendConflict(campaignId, events, taken);
      if (conflict !== null) return Promise.reject(conflict);

      const log = logFor(campaignId);
      // Copied on the way in, not retained by reference: the Postgres store
      // serializes to jsonb inside `append`, so the caller's object stops
      // mattering the moment the call returns. Keeping the caller's own
      // objects here would let a later mutation rewrite history in this
      // store and not the other one — the mirror of the `putSnapshot` case,
      // and just as much a contract violation.
      log.events.push(...events.map(storedCopy));
      log.events.sort((a, b) => a.sequence - b.sequence);
      return Promise.resolve();
    },

    readSince(campaignId, afterSequence) {
      const events =
        logs.get(campaignId)?.events.filter((each) => each.sequence > afterSequence) ?? [];
      // A deep copy, not just a fresh array: the Postgres store parses rows
      // into new objects, so a caller that mutates a returned event must see
      // the same nothing happen in both stores. Cost is one clone per
      // replayed batch, which happens once per reconnect.
      return Promise.resolve(events.map(storedCopy));
    },

    latestSnapshot(campaignId) {
      const snapshot = logs.get(campaignId)?.snapshot ?? null;
      // `{ ...snapshot }` used to be enough for the array, but `state` is an
      // object the caller could reach into. Same reasoning as `readSince`.
      return Promise.resolve(snapshot === null ? null : storedCopy(snapshot));
    },

    putSnapshot(campaignId, sequence, state) {
      const log = logFor(campaignId);
      if (log.snapshot === null || log.snapshot.sequence < sequence) {
        // Cloned on the way in too: `pipeline.ts` hands us its live
        // `campaign.state` and keeps mutating it after this returns. Same
        // JSON-lossy copy as `append`, for the same reason — `state` lands in
        // a jsonb column on the other side.
        log.snapshot = { sequence, state: storedCopy(state) };
      }
      return Promise.resolve();
    },
  };
}
