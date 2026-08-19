import { describe, expect, it } from "vitest";
import type { GameEvent, SessionState } from "@ai-dm/schemas";
import { SequenceConflictError, createInMemoryEventStore } from "./event-store.js";

function event(sequence: number, type: GameEvent["type"] = "player_input"): GameEvent {
  return {
    eventId: `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
    sessionId: "s1",
    sequence,
    timestamp: "2026-08-19T10:00:00.000Z",
    type,
    payload: {},
  };
}

const state: SessionState = {
  sessionId: "s1",
  rootSeed: 1,
  encounterId: "e1",
  grid: { width: 1, height: 1, tiles: [["normal"]] },
  combatants: [],
  turnOrder: [],
  currentActorIndex: 0,
  round: 1,
  appliedClientMessageIds: [],
};

describe("in-memory EventStore", () => {
  it("reads back what it appended, in sequence order", async () => {
    const store = createInMemoryEventStore();
    await store.append("s1", [event(0), event(1)]);
    const read = await store.readSince("s1", -1);
    expect(read.map((each) => each.sequence)).toEqual([0, 1]);
  });

  it("reads only events after the given sequence", async () => {
    const store = createInMemoryEventStore();
    await store.append("s1", [event(0), event(1), event(2)]);
    expect((await store.readSince("s1", 0)).map((each) => each.sequence)).toEqual([1, 2]);
  });

  it("returns an empty list for an unknown session", async () => {
    const store = createInMemoryEventStore();
    expect(await store.readSince("nope", -1)).toEqual([]);
  });

  it("rejects a duplicate sequence", async () => {
    const store = createInMemoryEventStore();
    await store.append("s1", [event(0)]);
    await expect(store.append("s1", [event(0)])).rejects.toBeInstanceOf(SequenceConflictError);
  });

  it("appends a batch atomically — a conflict anywhere writes nothing", async () => {
    const store = createInMemoryEventStore();
    await store.append("s1", [event(0)]);
    await expect(store.append("s1", [event(1), event(0)])).rejects.toBeInstanceOf(
      SequenceConflictError,
    );
    // The good half of the batch must not have landed: a crash mid-turn may
    // not leave half a turn in the log.
    expect((await store.readSince("s1", -1)).map((each) => each.sequence)).toEqual([0]);
  });

  it("keeps sessions isolated", async () => {
    const store = createInMemoryEventStore();
    await store.append("s1", [event(0)]);
    await store.append("s2", [{ ...event(0), sessionId: "s2" }]);
    expect(await store.readSince("s1", -1)).toHaveLength(1);
  });

  it("has no snapshot until one is written", async () => {
    const store = createInMemoryEventStore();
    expect(await store.latestSnapshot("s1")).toBeNull();
  });

  it("returns the newest snapshot", async () => {
    const store = createInMemoryEventStore();
    await store.putSnapshot("s1", 50, state);
    await store.putSnapshot("s1", 100, { ...state, round: 4 });
    expect(await store.latestSnapshot("s1")).toMatchObject({ sequence: 100 });
  });
});
