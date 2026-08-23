import { describe, expect, it } from "vitest";
import type { GameEvent, CampaignState, EncounterState } from "@ai-dm/schemas";
import { SequenceConflictError, CampaignMismatchError } from "./port.js";
import type { EventStore } from "./port.js";

let counter = 0;
/** A campaign id no other test case in this process has used. */
function freshCampaignId(): string {
  counter += 1;
  return `contract-${String(counter)}-${String(Date.now())}`;
}

function event(campaignId: string, sequence: number): GameEvent {
  return {
    eventId: `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
    campaignId,
    sequence,
    timestamp: "2026-08-19T10:00:00.000Z",
    type: "player_input",
    // Deliberately plain, so the cases that assert whole-event equality do
    // not double as a test of value normalization. The lossy values a jsonb
    // column imposes — a key whose value is `undefined`, `NaN`, a `Date` —
    // are not excluded from the contract, they are pinned by their own cases
    // at the bottom of this suite, which is what stops a future payload
    // drifting outside the set the two stores agree on.
    payload: { note: `event ${String(sequence)}` },
  };
}

function stateFor(campaignId: string): CampaignState {
  return {
    world: { campaignId, rootSeed: 1, appliedClientMessageIds: [] },
    encounter: {
      encounterId: "e1",
      grid: { width: 1, height: 1, tiles: [["normal"]] },
      combatants: [],
      turnOrder: [],
      currentActorIndex: 0,
      round: 1,
    },
  };
}

/** `stateFor` at a different round, for the cases that need two snapshots a
 * store can tell apart. */
function stateAtRound(campaignId: string, round: number): CampaignState {
  const state = stateFor(campaignId);
  return { ...state, encounter: { ...boardOf(state), round } };
}

/**
 * The projected board, or a failure. `stateFor` always opens one, so a null
 * here means the fixture stopped matching the projection rather than a case
 * a store has to handle.
 *
 * These deep-copy assertions matter more now than they did flat: the field
 * they poke at sits a level down, so a store that copied only the top level
 * would hand back a board the caller can still write through.
 */
function boardOf(state: CampaignState): EncounterState {
  const { encounter } = state;
  if (encounter === null) throw new Error("expected the fixture to open an encounter");
  return encounter;
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
      const s = freshCampaignId();
      await store.append(s, [event(s, 0), event(s, 1)]);
      const read = await store.readSince(s, -1);
      expect(read.map((each) => each.sequence)).toEqual([0, 1]);
    });

    it("reads back the whole event, payload included", async () => {
      const store = makeStore();
      const s = freshCampaignId();
      const appended = event(s, 0);
      await store.append(s, [appended]);
      expect(await store.readSince(s, -1)).toEqual([appended]);
    });

    it("reads only events after the given sequence", async () => {
      const store = makeStore();
      const s = freshCampaignId();
      await store.append(s, [event(s, 0), event(s, 1), event(s, 2)]);
      expect((await store.readSince(s, 0)).map((each) => each.sequence)).toEqual([1, 2]);
    });

    it("returns an empty list for an unknown campaign", async () => {
      expect(await makeStore().readSince(freshCampaignId(), -1)).toEqual([]);
    });

    it("returns an empty list past the tail of a known campaign", async () => {
      const store = makeStore();
      const s = freshCampaignId();
      await store.append(s, [event(s, 0), event(s, 1)]);
      expect(await store.readSince(s, 99)).toEqual([]);
    });

    it("returns a fresh array from readSince, not a live reference", async () => {
      const store = makeStore();
      const s = freshCampaignId();
      await store.append(s, [event(s, 0)]);
      const first = await store.readSince(s, -1);
      first.push(event(s, 99));
      expect((await store.readSince(s, -1)).map((each) => each.sequence)).toEqual([0]);
    });

    it("accepts an empty batch", async () => {
      const store = makeStore();
      const s = freshCampaignId();
      await expect(store.append(s, [])).resolves.toBeUndefined();
      expect(await store.readSince(s, -1)).toEqual([]);
    });

    it("rejects a duplicate sequence", async () => {
      const store = makeStore();
      const s = freshCampaignId();
      await store.append(s, [event(s, 0)]);
      await expect(store.append(s, [event(s, 0)])).rejects.toBeInstanceOf(SequenceConflictError);
    });

    it("rejects a duplicate sequence within the same batch", async () => {
      const store = makeStore();
      const s = freshCampaignId();
      await expect(store.append(s, [event(s, 0), event(s, 0)])).rejects.toBeInstanceOf(
        SequenceConflictError,
      );
      expect(await store.readSince(s, -1)).toEqual([]);
    });

    it("rejects an event whose own campaignId disagrees with the append target", async () => {
      const store = makeStore();
      const s = freshCampaignId();
      const other = freshCampaignId();
      await expect(
        store.append(s, [{ ...event(s, 0), campaignId: other }]),
      ).rejects.toBeInstanceOf(CampaignMismatchError);
      // Neither the target campaign nor the event's own campaign gained a
      // record — a rejected batch must leave no trace on either side.
      expect(await store.readSince(s, -1)).toEqual([]);
      expect(await store.readSince(other, -1)).toEqual([]);
    });

    it("checks campaignId before sequence, in batch order", async () => {
      const store = makeStore();
      const s = freshCampaignId();
      const other = freshCampaignId();
      await store.append(s, [event(s, 0)]);
      // Event 0 conflicts; event 1 mismatches. The conflict is reached
      // first, so that is the error — the precedence `findAppendConflict`
      // exists to pin down.
      await expect(
        store.append(s, [event(s, 0), { ...event(s, 1), campaignId: other }]),
      ).rejects.toBeInstanceOf(SequenceConflictError);
    });

    it("appends a batch atomically — a conflict anywhere writes nothing", async () => {
      const store = makeStore();
      const s = freshCampaignId();
      await store.append(s, [event(s, 0)]);
      await expect(store.append(s, [event(s, 1), event(s, 0)])).rejects.toBeInstanceOf(
        SequenceConflictError,
      );
      // The good half of the batch must not have landed: a crash mid-turn
      // may not leave half a turn in the log.
      expect((await store.readSince(s, -1)).map((each) => each.sequence)).toEqual([0]);
    });

    it("keeps campaigns isolated", async () => {
      const store = makeStore();
      const s = freshCampaignId();
      const other = freshCampaignId();
      await store.append(s, [event(s, 0)]);
      await store.append(other, [event(other, 0)]);
      expect(await store.readSince(s, -1)).toHaveLength(1);
    });

    it("has no snapshot until one is written", async () => {
      expect(await makeStore().latestSnapshot(freshCampaignId())).toBeNull();
    });

    it("returns the newest snapshot, state included", async () => {
      const store = makeStore();
      const s = freshCampaignId();
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
      const s = freshCampaignId();
      await store.putSnapshot(s, 100, stateFor(s));
      await store.putSnapshot(s, 50, stateAtRound(s, 4));
      expect(await store.latestSnapshot(s)).toEqual({ sequence: 100, state: stateFor(s) });
    });

    it("ignores a snapshot at the sequence already stored", async () => {
      const store = makeStore();
      const s = freshCampaignId();
      await store.putSnapshot(s, 100, stateFor(s));
      await store.putSnapshot(s, 100, stateAtRound(s, 9));
      expect(await store.latestSnapshot(s)).toEqual({ sequence: 100, state: stateFor(s) });
    });

    it("keeps snapshots isolated per campaign", async () => {
      const store = makeStore();
      const s = freshCampaignId();
      await store.putSnapshot(s, 50, stateFor(s));
      expect(await store.latestSnapshot(freshCampaignId())).toBeNull();
    });

    it("does not expose the stored snapshot state to a caller's mutation", async () => {
      const store = makeStore();
      const s = freshCampaignId();
      await store.putSnapshot(s, 50, stateFor(s));

      const first = await store.latestSnapshot(s);
      expect(first).not.toBeNull();
      if (first === null) return;
      boardOf(first.state).round = 99;

      const second = await store.latestSnapshot(s);
      expect(second === null ? null : boardOf(second.state).round).toBe(1);
    });

    it("does not let a caller mutate the state it handed to putSnapshot", async () => {
      const store = makeStore();
      const s = freshCampaignId();
      const state = stateFor(s);
      await store.putSnapshot(s, 50, state);
      // `pipeline.ts` passes its live `campaign.state` here and keeps
      // mutating it afterwards, so a store holding that object by reference
      // would silently rewrite a snapshot that was already taken.
      boardOf(state).round = 99;

      const stored = await store.latestSnapshot(s);
      expect(stored === null ? null : boardOf(stored.state).round).toBe(1);
    });

    it("does not expose stored events to a caller's mutation", async () => {
      const store = makeStore();
      const s = freshCampaignId();
      await store.append(s, [event(s, 0)]);

      const first = await store.readSince(s, -1);
      const mutated = first[0];
      expect(mutated).toBeDefined();
      if (mutated === undefined) return;
      mutated.payload.note = "tampered";

      const second = await store.readSince(s, -1);
      expect(second[0]?.payload.note).toBe("event 0");
    });

    it("does not let a caller mutate an event it handed to append", async () => {
      const store = makeStore();
      const s = freshCampaignId();
      const appended = event(s, 0);
      await store.append(s, [appended]);
      // The mirror of the `putSnapshot` case above, and the direction that
      // actually diverged: the Postgres store serializes to jsonb inside
      // `append`, so the caller's object stops mattering the moment the call
      // returns, while a store that kept the reference would let this line
      // rewrite a log that is supposed to be append-only.
      appended.payload.note = "tampered";

      expect((await store.readSince(s, -1))[0]?.payload.note).toBe("event 0");
    });

    // The three cases below pin the boundary of "the two stores are
    // interchangeable". A jsonb column is a lossy round trip, and the losses
    // are silent: without these, a payload carrying one of these values works
    // in a dev run on the in-memory store, loses a key on the Postgres
    // deploy, and only surfaces as a `.parse` failure in `reduce` at the next
    // restart. Making the loss itself the contract means both stores lose the
    // same thing, and a future divergence breaks a test rather than a deploy.
    it("drops a payload key whose value is undefined", async () => {
      const store = makeStore();
      const s = freshCampaignId();
      await store.append(s, [
        { ...event(s, 0), payload: { note: "kept", missing: undefined } },
      ]);

      const stored = (await store.readSince(s, -1))[0];
      expect(stored).toBeDefined();
      if (stored === undefined) return;
      // `toEqual` treats `{ missing: undefined }` and `{}` as equal, so the
      // assertion has to be on key presence or it would pass either way.
      expect(Object.hasOwn(stored.payload, "missing")).toBe(false);
      expect(stored.payload.note).toBe("kept");
    });

    it("stores NaN as null in a payload", async () => {
      const store = makeStore();
      const s = freshCampaignId();
      await store.append(s, [{ ...event(s, 0), payload: { roll: Number.NaN } }]);

      const stored = (await store.readSince(s, -1))[0];
      expect(stored?.payload.roll).toBeNull();
    });

    it("stores a Date in a payload as its ISO string", async () => {
      const store = makeStore();
      const s = freshCampaignId();
      const when = new Date("2026-08-19T10:00:00.000Z");
      await store.append(s, [{ ...event(s, 0), payload: { when } }]);

      const stored = (await store.readSince(s, -1))[0];
      expect(stored?.payload.when).toBe("2026-08-19T10:00:00.000Z");
    });
  });
}
