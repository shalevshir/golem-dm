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
        grid: {
          width: 2,
          height: 2,
          tiles: [
            ["normal", "normal"],
            ["normal", "normal"],
          ],
        },
        combatants: [],
        turnOrder: [],
        currentActorIndex: 0,
        round: 1,
      },
    };
  }

  /**
   * `includeBracket` defaults to false so the fold-identity test below
   * ("folds to the same state from zero and from a snapshot", unchanged)
   * keeps folding exactly the stream it always has. `genesisState` there is
   * a state with an encounter already OPEN, and an `encounter_started`
   * arriving on top of it would throw "already open" — these two new event
   * types are gated to the round-trip test only, which compares raw events
   * rather than folding them (do not "fix" this by changing `genesisState`,
   * which is correct as it stands).
   */
  function stream(campaignId: string, includeBracket = false): GameEvent[] {
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
    // `@ai-dm/schemas`' `reduce.ts` — `{ combatants: Combatant[] }`. A
    // minimal valid `Combatant` is substituted here so `fold` can parse it,
    // with a per-index `currentHp` so each delta actually changes projected
    // state.
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

    if (!includeBracket) return [genesis, ...deltas];

    // Task 7, step 2 (round-trip half): proves these two new event types'
    // jsonb payloads survive Postgres unchanged, the one property this file
    // can prove about them — the projection half (loadCampaign across two
    // real encounters) lives in apps/server/src/core/replay.test.ts instead,
    // since folding a bracket needs the encounter catalogue, which
    // @ai-dm/memory may never import (dependency direction).
    const started: GameEvent = {
      eventId: "00000000-0000-4000-8000-000000000061",
      campaignId,
      sequence: 61,
      timestamp: "2026-08-22T10:00:00.000Z",
      type: "encounter_started",
      payload: { encounterId: "e1" },
    };
    const resolved: GameEvent = {
      eventId: "00000000-0000-4000-8000-000000000062",
      campaignId,
      sequence: 62,
      timestamp: "2026-08-22T10:00:00.000Z",
      type: "encounter_resolved",
      payload: { encounterId: "e1", outcome: "victory", survivorIds: ["c1"] },
    };
    return [genesis, ...deltas, started, resolved];
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
    // Task 7: with the bracket events included, this also proves
    // encounter_started's and encounter_resolved's jsonb payloads —
    // `{ encounterId }` and `{ encounterId, outcome, survivorIds }` — round
    // trip through Postgres unchanged, the same as every other event type
    // already covered here.
    const events = stream(campaignId, true);
    await store.append(campaignId, events);
    // Not just the projection — the events themselves. A jsonb payload or a
    // truncated timestamp that changed in transit would show here first.
    expect(await store.readSince(campaignId, -1)).toEqual(events);
  });
});
