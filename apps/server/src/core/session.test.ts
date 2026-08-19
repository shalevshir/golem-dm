import { describe, expect, it } from "vitest";
import { createInMemoryEventStore } from "./event-store.js";
import { createSession, loadSession, worldFor } from "./session.js";

const clock = (): string => "2026-08-19T10:00:00.000Z";

function uuids(): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  };
}

describe("createSession", () => {
  it("projects the encounter's combatants and turn order", async () => {
    const store = createInMemoryEventStore();
    const session = await createSession({
      sessionId: "s1",
      encounterId: "goblin-ambush",
      rootSeed: 42,
      store,
      clock,
      uuid: uuids(),
    });
    expect(session.state.turnOrder).toEqual(["hero", "goblin-a", "goblin-b"]);
    expect(session.state.combatants).toHaveLength(3);
    expect(session.state.round).toBe(1);
    expect(session.state.currentActorIndex).toBe(0);
  });

  it("writes a session_snapshot event as sequence 0", async () => {
    const store = createInMemoryEventStore();
    await createSession({
      sessionId: "s1",
      encounterId: "goblin-ambush",
      rootSeed: 42,
      store,
      clock,
      uuid: uuids(),
    });
    const events = await store.readSince("s1", -1);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ sequence: 0, type: "session_snapshot" });
  });

  it("seeds sessionId, rootSeed, encounterId, grid and turnOrder as genesis state", async () => {
    const store = createInMemoryEventStore();
    const session = await createSession({
      sessionId: "s1",
      encounterId: "goblin-ambush",
      rootSeed: 42,
      store,
      clock,
      uuid: uuids(),
    });
    expect(session.state.sessionId).toBe("s1");
    expect(session.state.rootSeed).toBe(42);
    expect(session.state.encounterId).toBe("goblin-ambush");
    expect(session.state.grid.width).toBe(12);
    expect(session.state.grid.height).toBe(12);
    expect(session.state.turnOrder).toEqual(["hero", "goblin-a", "goblin-b"]);
  });
});

describe("loadSession", () => {
  it("returns null for a session that was never created", async () => {
    expect(await loadSession({ sessionId: "nope", store: createInMemoryEventStore() })).toBeNull();
  });

  it("rebuilds an identical projection by folding the log", async () => {
    const store = createInMemoryEventStore();
    const created = await createSession({
      sessionId: "s1",
      encounterId: "goblin-ambush",
      rootSeed: 42,
      store,
      clock,
      uuid: uuids(),
    });
    const loaded = await loadSession({ sessionId: "s1", store });
    expect(loaded?.state).toEqual(created.state);
    expect(loaded?.nextSequence).toBe(created.nextSequence);
  });
});

describe("worldFor", () => {
  it("pairs the projection with a CombatWorld the validator accepts", async () => {
    const store = createInMemoryEventStore();
    const session = await createSession({
      sessionId: "s1",
      encounterId: "goblin-ambush",
      rootSeed: 42,
      store,
      clock,
      uuid: uuids(),
    });
    const world = worldFor(session);
    expect(world.combatants).toEqual(session.state.combatants);
    expect(world.grid).toEqual(session.state.grid);
    expect(world.actionRangesFeet).toBeDefined();
  });
});
