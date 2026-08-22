import { afterAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { fold } from "@ai-dm/schemas";
import type { GameEvent, SessionState } from "@ai-dm/schemas";
import { createPostgresEventStore } from "./postgres.js";

const url = process.env.DATABASE_URL;

describe.skipIf(url === undefined)("replay round-trip over Postgres", () => {
  const sql = postgres(url ?? "");
  const store = createPostgresEventStore(drizzle(sql));

  afterAll(async () => {
    await sql.end();
  });

  // Built from @ai-dm/schemas alone rather than from replay.test.ts's
  // goblin-ambush fixture, which lives in apps/server and is out of reach
  // under invariant 5. What is being proved here is the fold identity, and
  // that does not need a real encounter.
  function genesisState(sessionId: string): SessionState {
    return {
      sessionId,
      rootSeed: 7,
      encounterId: "e1",
      grid: { width: 2, height: 2, tiles: [["normal", "normal"], ["normal", "normal"]] },
      combatants: [],
      turnOrder: [],
      currentActorIndex: 0,
      round: 1,
      appliedClientMessageIds: [],
    };
  }

  function stream(sessionId: string): GameEvent[] {
    const genesis: GameEvent = {
      eventId: "00000000-0000-4000-8000-000000000000",
      sessionId,
      sequence: 0,
      timestamp: "2026-08-22T10:00:00.000Z",
      // `reduce` treats session_snapshot as a no-op, which is exactly what
      // makes "fold from snapshot plus events equals fold from zero" hold.
      type: "session_snapshot",
      payload: {},
    };
    // `state_delta_applied`'s payload is `StateDeltaAppliedPayload` in
    // `@ai-dm/schemas`' `reduce.ts` — `{ combatants: Combatant[] }`, not the
    // `{ round }` shape the brief's preview used. That preview predates the
    // implemented `reduce()` (see the note atop `reduce.ts` about the same
    // drift for `SessionStartedPayload`/`TurnAdvancedPayload`); a minimal
    // valid `Combatant` is substituted here so `fold` can parse it, with a
    // per-index `currentHp` so each delta actually changes projected state.
    const deltas = Array.from({ length: 60 }, (_, index): GameEvent => ({
      eventId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      sessionId,
      sequence: index + 1,
      timestamp: "2026-08-22T10:00:00.000Z",
      type: "state_delta_applied",
      payload: {
        combatants: [
          {
            combatantId: "c1",
            faction: "party",
            position: [index % 2, index % 2],
            speedFeet: 30,
            maxHp: 10,
            currentHp: Math.max(1, 10 - index),
            armorClass: 12,
          },
        ],
      },
    }));
    return [genesis, ...deltas];
  }

  it("folds to the same state from zero and from a snapshot", async () => {
    const sessionId = `replay-${String(Date.now())}`;
    const events = stream(sessionId);
    await store.append(sessionId, events);

    const fromZero = fold(genesisState(sessionId), await store.readSince(sessionId, -1));

    // The cadence pipeline.ts uses: snapshot at 50, then replay the tail.
    await store.putSnapshot(sessionId, 50, fold(genesisState(sessionId), events.slice(0, 51)));
    const snapshot = await store.latestSnapshot(sessionId);
    expect(snapshot).not.toBeNull();
    if (snapshot === null) return;
    const fromSnapshot = fold(snapshot.state, await store.readSince(sessionId, snapshot.sequence));

    expect(fromSnapshot).toEqual(fromZero);
  });

  it("survives a full round trip through the database unchanged", async () => {
    const sessionId = `roundtrip-${String(Date.now())}`;
    const events = stream(sessionId);
    await store.append(sessionId, events);
    // Not just the projection — the events themselves. A jsonb payload or a
    // truncated timestamp that changed in transit would show here first.
    expect(await store.readSince(sessionId, -1)).toEqual(events);
  });
});
