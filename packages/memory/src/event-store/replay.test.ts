import { afterAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { fold } from "@ai-dm/schemas";
import type { GameEvent, CampaignState } from "@ai-dm/schemas";
import { createPostgresEventStore } from "./postgres.js";

const url = process.env.DATABASE_URL;

// A blank `DATABASE_URL=` must skip exactly like an absent one — `postgres("")`
// does not reject, it falls back to localhost:5432 (postgres-js's
// `parseOptions`), which would trade a clean skip for a confusing
// `FATAL 3D000` against whatever is listening there.
describe.skipIf(url === undefined || url === "")("replay round-trip over Postgres", () => {
  const sql = postgres(url ?? "");
  const store = createPostgresEventStore(drizzle(sql));

  afterAll(async () => {
    await sql.end();
  });

  // Built from @ai-dm/schemas alone rather than from replay.test.ts's
  // goblin-ambush fixture, which lives in apps/server and is out of reach
  // under invariant 5. What is being proved here is the fold identity, and
  // that does not need a real encounter.
  function genesisState(campaignId: string): CampaignState {
    return {
      world: { campaignId, rootSeed: 7, appliedClientMessageIds: [] },
      encounter: {
        encounterId: "e1",
        grid: { width: 2, height: 2, tiles: [["normal", "normal"], ["normal", "normal"]] },
        combatants: [],
        turnOrder: [],
        currentActorIndex: 0,
        round: 1,
      },
    };
  }

  function stream(campaignId: string): GameEvent[] {
    const genesis: GameEvent = {
      eventId: "00000000-0000-4000-8000-000000000000",
      campaignId,
      sequence: 0,
      timestamp: "2026-08-22T10:00:00.000Z",
      // `reduce` treats campaign_started as a no-op — the world it declares
      // is rebuilt from its payload before the fold begins rather than folded
      // out of it — which is exactly what makes "fold from snapshot plus
      // events equals fold from zero" hold. That no-op is also why this
      // payload can be `{}` rather than a real `CampaignStartedPayload`
      // (`{ rootSeed }`): `reduce` never parses `campaign_started`, so an
      // empty payload here is fine and deliberately exercises exactly that
      // property, not a shortcut this test happens to get away with.
      // `genesisState` above stands in for the rebuilt starting state
      // `apps/server`'s `loadCampaign` would separately reconstruct from a
      // real `rootSeed` — this fixture does not need one, since what is
      // being proved here is the fold identity, not a real load.
      type: "campaign_started",
      payload: {},
    };
    // `state_delta_applied`'s payload is `StateDeltaAppliedPayload` in
    // `@ai-dm/schemas`' `reduce.ts` — `{ combatants: Combatant[] }`, not the
    // `{ round }` shape the brief's preview used. That preview predates the
    // implemented `reduce()` (see the note atop `reduce.ts` about the same
    // drift for `CampaignStartedPayload`/`TurnAdvancedPayload`); a minimal
    // valid `Combatant` is substituted here so `fold` can parse it, with a
    // per-index `currentHp` so each delta actually changes projected state.
    const deltas = Array.from({ length: 60 }, (_, index): GameEvent => ({
      eventId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      campaignId,
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
    const campaignId = `replay-${String(Date.now())}`;
    const events = stream(campaignId);
    await store.append(campaignId, events);

    const fromZero = fold(genesisState(campaignId), await store.readSince(campaignId, -1));

    // The cadence pipeline.ts uses: snapshot at 50, then replay the tail.
    await store.putSnapshot(campaignId, 50, fold(genesisState(campaignId), events.slice(0, 51)));
    const snapshot = await store.latestSnapshot(campaignId);
    expect(snapshot).not.toBeNull();
    if (snapshot === null) return;
    const fromSnapshot = fold(snapshot.state, await store.readSince(campaignId, snapshot.sequence));

    expect(fromSnapshot).toEqual(fromZero);
  });

  it("survives a full round trip through the database unchanged", async () => {
    const campaignId = `roundtrip-${String(Date.now())}`;
    const events = stream(campaignId);
    await store.append(campaignId, events);
    // Not just the projection — the events themselves. A jsonb payload or a
    // truncated timestamp that changed in transit would show here first.
    expect(await store.readSince(campaignId, -1)).toEqual(events);
  });
});
