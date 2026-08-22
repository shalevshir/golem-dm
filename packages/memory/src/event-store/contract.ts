import { describe, expect, it } from "vitest";
import type { GameEvent, SessionState } from "@ai-dm/schemas";
import { SequenceConflictError, SessionMismatchError } from "./port.js";
import type { EventStore } from "./port.js";

let counter = 0;
/** A session id no other test case in this process has used. */
function freshSessionId(): string {
  counter += 1;
  return `contract-${String(counter)}-${String(Date.now())}`;
}

function event(sessionId: string, sequence: number): GameEvent {
  return {
    eventId: `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
    sessionId,
    sequence,
    timestamp: "2026-08-19T10:00:00.000Z",
    type: "player_input",
    // Only JSON-round-trip-safe values: a jsonb column drops a key whose
    // value is `undefined`, turns `NaN` into `null` and a `Date` into a
    // string, none of which the in-memory store does. Keeping payloads
    // plain is what lets one suite hold both stores to the same equality.
    payload: { note: `event ${String(sequence)}` },
  };
}

function stateFor(sessionId: string): SessionState {
  return {
    sessionId,
    rootSeed: 1,
    encounterId: "e1",
    grid: { width: 1, height: 1, tiles: [["normal"]] },
    combatants: [],
    turnOrder: [],
    currentActorIndex: 0,
    round: 1,
    appliedClientMessageIds: [],
  };
}

/**
 * Every promise `port.ts` makes, asserted against any implementation.
 *
 * Assertions are on value, never on object identity: only the in-memory
 * store could ever satisfy identity, so asserting it would bake a
 * one-implementation detail into a shared contract.
 */
export function describeEventStoreContract(label: string, makeStore: () => EventStore): void {
  describe(label, () => {
    it("reads back what it appended, in sequence order", async () => {
      const store = makeStore();
      const s = freshSessionId();
      await store.append(s, [event(s, 0), event(s, 1)]);
      const read = await store.readSince(s, -1);
      expect(read.map((each) => each.sequence)).toEqual([0, 1]);
    });

    it("reads back the whole event, payload included", async () => {
      const store = makeStore();
      const s = freshSessionId();
      const appended = event(s, 0);
      await store.append(s, [appended]);
      expect(await store.readSince(s, -1)).toEqual([appended]);
    });

    it("reads only events after the given sequence", async () => {
      const store = makeStore();
      const s = freshSessionId();
      await store.append(s, [event(s, 0), event(s, 1), event(s, 2)]);
      expect((await store.readSince(s, 0)).map((each) => each.sequence)).toEqual([1, 2]);
    });

    it("returns an empty list for an unknown session", async () => {
      expect(await makeStore().readSince(freshSessionId(), -1)).toEqual([]);
    });

    it("returns an empty list past the tail of a known session", async () => {
      const store = makeStore();
      const s = freshSessionId();
      await store.append(s, [event(s, 0), event(s, 1)]);
      expect(await store.readSince(s, 99)).toEqual([]);
    });

    it("returns a fresh array from readSince, not a live reference", async () => {
      const store = makeStore();
      const s = freshSessionId();
      await store.append(s, [event(s, 0)]);
      const first = await store.readSince(s, -1);
      first.push(event(s, 99));
      expect((await store.readSince(s, -1)).map((each) => each.sequence)).toEqual([0]);
    });

    it("accepts an empty batch", async () => {
      const store = makeStore();
      const s = freshSessionId();
      await expect(store.append(s, [])).resolves.toBeUndefined();
      expect(await store.readSince(s, -1)).toEqual([]);
    });

    it("rejects a duplicate sequence", async () => {
      const store = makeStore();
      const s = freshSessionId();
      await store.append(s, [event(s, 0)]);
      await expect(store.append(s, [event(s, 0)])).rejects.toBeInstanceOf(SequenceConflictError);
    });

    it("rejects a duplicate sequence within the same batch", async () => {
      const store = makeStore();
      const s = freshSessionId();
      await expect(store.append(s, [event(s, 0), event(s, 0)])).rejects.toBeInstanceOf(
        SequenceConflictError,
      );
      expect(await store.readSince(s, -1)).toEqual([]);
    });

    it("rejects an event whose own sessionId disagrees with the append target", async () => {
      const store = makeStore();
      const s = freshSessionId();
      const other = freshSessionId();
      await expect(
        store.append(s, [{ ...event(s, 0), sessionId: other }]),
      ).rejects.toBeInstanceOf(SessionMismatchError);
      // Neither the target session nor the event's own session gained a
      // record — a rejected batch must leave no trace on either side.
      expect(await store.readSince(s, -1)).toEqual([]);
      expect(await store.readSince(other, -1)).toEqual([]);
    });

    it("checks sessionId before sequence, in batch order", async () => {
      const store = makeStore();
      const s = freshSessionId();
      const other = freshSessionId();
      await store.append(s, [event(s, 0)]);
      // Event 0 conflicts; event 1 mismatches. The conflict is reached
      // first, so that is the error — the precedence `findAppendConflict`
      // exists to pin down.
      await expect(
        store.append(s, [event(s, 0), { ...event(s, 1), sessionId: other }]),
      ).rejects.toBeInstanceOf(SequenceConflictError);
    });

    it("appends a batch atomically — a conflict anywhere writes nothing", async () => {
      const store = makeStore();
      const s = freshSessionId();
      await store.append(s, [event(s, 0)]);
      await expect(store.append(s, [event(s, 1), event(s, 0)])).rejects.toBeInstanceOf(
        SequenceConflictError,
      );
      // The good half of the batch must not have landed: a crash mid-turn
      // may not leave half a turn in the log.
      expect((await store.readSince(s, -1)).map((each) => each.sequence)).toEqual([0]);
    });

    it("keeps sessions isolated", async () => {
      const store = makeStore();
      const s = freshSessionId();
      const other = freshSessionId();
      await store.append(s, [event(s, 0)]);
      await store.append(other, [event(other, 0)]);
      expect(await store.readSince(s, -1)).toHaveLength(1);
    });

    it("has no snapshot until one is written", async () => {
      expect(await makeStore().latestSnapshot(freshSessionId())).toBeNull();
    });

    it("returns the newest snapshot, state included", async () => {
      const store = makeStore();
      const s = freshSessionId();
      const newer = { ...stateFor(s), round: 4 };
      await store.putSnapshot(s, 50, stateFor(s));
      await store.putSnapshot(s, 100, newer);
      // The full payload, not just the sequence — losing the state blob on
      // the way through is the likeliest failure mode of a SQL-backed
      // implementation (JSONB serialization).
      expect(await store.latestSnapshot(s)).toEqual({ sequence: 100, state: newer });
    });

    it("ignores a snapshot whose sequence does not improve on the current one", async () => {
      const store = makeStore();
      const s = freshSessionId();
      await store.putSnapshot(s, 100, stateFor(s));
      await store.putSnapshot(s, 50, { ...stateFor(s), round: 4 });
      expect(await store.latestSnapshot(s)).toEqual({ sequence: 100, state: stateFor(s) });
    });

    it("ignores a snapshot at the sequence already stored", async () => {
      const store = makeStore();
      const s = freshSessionId();
      await store.putSnapshot(s, 100, stateFor(s));
      await store.putSnapshot(s, 100, { ...stateFor(s), round: 9 });
      expect(await store.latestSnapshot(s)).toEqual({ sequence: 100, state: stateFor(s) });
    });

    it("keeps snapshots isolated per session", async () => {
      const store = makeStore();
      const s = freshSessionId();
      await store.putSnapshot(s, 50, stateFor(s));
      expect(await store.latestSnapshot(freshSessionId())).toBeNull();
    });
  });
}
