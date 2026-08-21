import { describe, expect, it } from "vitest";
import { fold } from "@ai-dm/schemas";
import type { GameEvent } from "@ai-dm/schemas";
import { createInMemoryEventStore } from "./event-store.js";
import { createSession, loadSession, worldFor } from "./session.js";
import type { CreateSessionInput } from "./session.js";

const clock = (): string => "2026-08-19T10:00:00.000Z";

function uuids(): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  };
}

const NARRATION_WINDOW = 2;

/** The `CreateSessionInput` fields shared by every test below; a test spreads
 * this and overrides only what it cares about. `store` and `uuid` are fresh
 * per call so two tests never share state or collide on generated ids. */
function baseInput(): CreateSessionInput {
  return {
    sessionId: "s1",
    encounterId: "goblin-ambush",
    rootSeed: 42,
    store: createInMemoryEventStore(),
    clock,
    uuid: uuids(),
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

  it("resolves the encounter's scene card once at creation", async () => {
    const session = await createSession({ ...baseInput(), encounterId: "goblin-ambush" });
    expect(session.sceneEnglish).toContain("hillside");
    expect(session.recentNarrations).toEqual([]);
  });
});

describe("loadSession", () => {
  it("returns null for a session that was never created", async () => {
    expect(await loadSession({ sessionId: "nope", store: createInMemoryEventStore() })).toBeNull();
  });

  it("rebuilds an identical projection from a log of exactly one event", async () => {
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

  // On a log of exactly one event (just the genesis), `events.slice(1)` folds
  // an empty array — indistinguishable from `slice(0)`, from `events` itself,
  // or from several other wrong slices — and `nextSequence` collides with
  // `createSession`'s hardcoded 1, with `events.length`, and with `sequence`.
  // A non-empty tail is required to actually exercise the slice and the
  // `nextSequence` derivation, which Task 9 and Task 14 depend on to place
  // their next append.
  it("rebuilds an identical projection by folding a non-empty tail", async () => {
    const store = createInMemoryEventStore();
    const created = await createSession({
      sessionId: "s1",
      encounterId: "goblin-ambush",
      rootSeed: 42,
      store,
      clock,
      uuid: uuids(),
    });

    const movedCombatants = created.state.combatants.map((each) =>
      each.combatantId === "goblin-a" ? { ...each, position: [7, 3] } : each,
    );
    const genUuid = uuids();
    const tail: GameEvent[] = [
      {
        eventId: genUuid(),
        sessionId: "s1",
        sequence: 1,
        timestamp: clock(),
        type: "state_delta_applied",
        payload: { combatants: movedCombatants },
      },
      {
        eventId: genUuid(),
        sessionId: "s1",
        sequence: 2,
        timestamp: clock(),
        type: "scene_changed",
        payload: { kind: "turn_advanced" },
      },
    ];
    await store.append("s1", tail);

    const loaded = await loadSession({ sessionId: "s1", store });
    const expected = fold(created.state, tail);

    expect(loaded?.state).toEqual(expected);
    const goblinA = loaded?.state.combatants.find((each) => each.combatantId === "goblin-a");
    expect(goblinA?.position).toEqual([7, 3]);
    expect(loaded?.state.currentActorIndex).toBe(1);
    expect(loaded?.nextSequence).toBe(3);
  });

  it("rebuilds the narration window from the log tail on load", async () => {
    const store = createInMemoryEventStore();
    const session = await createSession({ ...baseInput(), store, encounterId: "goblin-ambush" });

    for (const text of ["ראשון.", "שני.", "שלישי."]) {
      await store.append(session.state.sessionId, [
        {
          eventId: `e-${text}`,
          sessionId: session.state.sessionId,
          sequence: session.nextSequence++,
          timestamp: "2026-08-21T00:00:00.000Z",
          type: "narrative_emitted",
          payload: { actorId: "hero", streamId: "s", text, source: "model", promptVersion: "v" },
        },
      ]);
    }

    const loaded = await loadSession({ sessionId: session.state.sessionId, store });
    expect(loaded?.recentNarrations).toEqual(["שני.", "שלישי."]);
    expect(loaded?.recentNarrations).toHaveLength(NARRATION_WINDOW);
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
