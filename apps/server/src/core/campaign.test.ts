import { describe, expect, it } from "vitest";
import { createInMemoryEventStore, EventStoreUnavailableError } from "@ai-dm/memory";
import type { EventStore } from "@ai-dm/memory";
import { fold, reduce } from "@ai-dm/schemas";
import type { GameEvent } from "@ai-dm/schemas";
import {
  builtOf,
  createCampaign,
  encounterOf,
  loadCampaign,
  resolveEncounter,
  startEncounter,
  worldFor,
} from "./campaign.js";
import type { Campaign, CreateCampaignInput } from "./campaign.js";
import { buildEncounterById, UnknownEncounterError } from "../encounters/index.js";

const clock = (): string => "2026-08-19T10:00:00.000Z";

function uuids(): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  };
}

const NARRATION_WINDOW = 2;
const ENCOUNTER_ID = "goblin-ambush";

/** The `CreateCampaignInput` fields shared by every test below; a test spreads
 * this and overrides only what it cares about. `store` and `uuid` are fresh
 * per call so two tests never share state or collide on generated ids. */
function baseInput(): CreateCampaignInput {
  return {
    campaignId: "s1",
    rootSeed: 42,
    store: createInMemoryEventStore(),
    clock,
    uuid: uuids(),
  };
}

/**
 * `createCampaign` followed by `startEncounter` — what `POST /campaigns` does
 * today, and what every test that wants a board wants. Genesis is two events
 * now, so a campaign with an open encounter is two calls; the `uuid` port is
 * shared between them, so event ids stay sequential across both.
 */
async function startedCampaign(input: CreateCampaignInput): Promise<Campaign> {
  const campaign = await createCampaign(input);
  return startEncounter({
    campaign,
    encounterId: ENCOUNTER_ID,
    store: input.store,
    clock: input.clock,
    uuid: input.uuid,
  });
}

describe("createCampaign", () => {
  it("opens the stream with no encounter", async () => {
    // The state the whole split exists for: a campaign that has a world and
    // no board. Nothing could express it before genesis became two events.
    const input = baseInput();
    const campaign = await createCampaign(input);
    expect(campaign.state.encounter).toBeNull();
    expect(campaign.built).toBeNull();
    expect(campaign.state.world.campaignId).toBe("s1");
    expect(campaign.state.world.rootSeed).toBe(42);
    expect(campaign.state.world.appliedClientMessageIds).toEqual([]);
    expect(campaign.recentNarrations).toEqual([]);
  });

  it("writes a campaign_started event as sequence 0, carrying only the root seed", async () => {
    const input = baseInput();
    await createCampaign(input);
    const events = await input.store.readSince("s1", -1);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ sequence: 0, type: "campaign_started" });
    // Named, never snapshotted: no `state` and no `encounterId` — the first
    // is what keeps live campaign state from being aliased into the store,
    // and the second now belongs to `encounter_started` instead.
    expect(events[0]?.payload).toEqual({ rootSeed: 42 });
  });

  // `worldFor` and `builtOf` both call `encounterOf` first and propagate
  // whatever it throws, so all three assertions below pin the same single
  // throw rather than three independent behaviours — `builtOf`'s own
  // disagreement guard (the case where `encounterOf` succeeds but `built`
  // disagrees with it) gets its own coverage in the `builtOf` describe block
  // below instead.
  it("refuses the board through encounterOf; worldFor/builtOf propagate its throw", async () => {
    const campaign = await createCampaign(baseInput());
    expect(() => encounterOf(campaign)).toThrow(/no encounter open/);
    expect(() => worldFor(campaign)).toThrow(/no encounter open/);
    expect(() => builtOf(campaign)).toThrow(/no encounter open/);
  });
});

describe("startEncounter", () => {
  it("projects the encounter's combatants and turn order", async () => {
    const campaign = await startedCampaign(baseInput());
    expect(encounterOf(campaign).turnOrder).toEqual(["hero", "goblin-a", "goblin-b"]);
    expect(encounterOf(campaign).combatants).toHaveLength(3);
    expect(encounterOf(campaign).round).toBe(1);
    expect(encounterOf(campaign).currentActorIndex).toBe(0);
  });

  it("writes an encounter_started event carrying only the encounter id", async () => {
    const input = baseInput();
    await startedCampaign(input);
    const events = await input.store.readSince("s1", -1);
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ sequence: 1, type: "encounter_started" });
    expect(events[1]?.payload).toEqual({ encounterId: ENCOUNTER_ID });
  });

  it("seeds encounterId, grid and turnOrder — the three reduce never writes", async () => {
    const campaign = await startedCampaign(baseInput());
    expect(encounterOf(campaign).encounterId).toBe(ENCOUNTER_ID);
    expect(encounterOf(campaign).grid.width).toBe(12);
    expect(encounterOf(campaign).grid.height).toBe(12);
    expect(encounterOf(campaign).turnOrder).toEqual(["hero", "goblin-a", "goblin-b"]);
  });

  it("resolves the encounter's scene card, reachable through builtOf", async () => {
    const campaign = await startedCampaign(baseInput());
    expect(builtOf(campaign).sceneEnglish).toContain("hillside");
    expect(builtOf(campaign).encounterId).toBe(ENCOUNTER_ID);
  });

  it("mutates the campaign it was handed rather than returning a copy", async () => {
    // `http.ts`'s registry and every live socket alias one `Campaign` object
    // (CRITICAL-1). A `startEncounter` that returned a fresh record would
    // leave all of them holding the encounter-less one.
    const input = baseInput();
    const created = await createCampaign(input);
    const started = await startEncounter({
      campaign: created,
      encounterId: ENCOUNTER_ID,
      store: input.store,
      clock: input.clock,
      uuid: input.uuid,
    });
    expect(started).toBe(created);
    expect(created.state.encounter).not.toBeNull();
  });

  it("refuses a second encounter inside an open bracket, appending nothing", async () => {
    // The fold guard runs before the append, so a refused event never
    // reaches an append-only log — there is no correction event that could
    // take it back out.
    const input = baseInput();
    const campaign = await startedCampaign(input);
    await expect(
      startEncounter({
        campaign,
        encounterId: ENCOUNTER_ID,
        store: input.store,
        clock: input.clock,
        uuid: input.uuid,
      }),
    ).rejects.toThrow(/already open/);
    expect(await input.store.readSince("s1", -1)).toHaveLength(2);
    expect(campaign.nextSequence).toBe(2);
  });

  it("refuses an unknown encounter id before appending anything", async () => {
    const input = baseInput();
    const campaign = await createCampaign(input);
    await expect(
      startEncounter({
        campaign,
        encounterId: "not-a-real-encounter",
        store: input.store,
        clock: input.clock,
        uuid: input.uuid,
      }),
    ).rejects.toThrow(UnknownEncounterError);
    expect(await input.store.readSince("s1", -1)).toHaveLength(1);
  });

  // Mirrors `pipeline.test.ts`'s pair of `internal_error` tests for `emit`:
  // a store rejection AFTER the guard has already passed (a known encounter
  // id, no bracket open) must leave every field this function would
  // otherwise write untouched, the same way a failed append never bumps
  // `emit`'s `nextSequence`.
  it("leaves state, built and nextSequence untouched when append rejects post-guard", async () => {
    const input = baseInput();
    const campaign = await createCampaign(input);
    const stateBefore = campaign.state;
    const builtBefore = campaign.built;
    const nextSequenceBefore = campaign.nextSequence;
    const failingStore: EventStore = {
      ...input.store,
      append: () => Promise.reject(new EventStoreUnavailableError("append", new Error("boom"))),
    };

    await expect(
      startEncounter({
        campaign,
        encounterId: ENCOUNTER_ID,
        store: failingStore,
        clock: input.clock,
        uuid: input.uuid,
      }),
    ).rejects.toThrow(EventStoreUnavailableError);

    expect(campaign.state).toBe(stateBefore);
    expect(campaign.built).toBe(builtBefore);
    expect(campaign.nextSequence).toBe(nextSequenceBefore);
  });
});

describe("resolveEncounter", () => {
  it("closes the bracket and keeps the world", async () => {
    const input = baseInput();
    const campaign = await startedCampaign(input);
    campaign.state = reduce(campaign.state, {
      eventId: "00000000-0000-4000-8000-00000000ffff",
      campaignId: "s1",
      sequence: campaign.nextSequence++,
      timestamp: clock(),
      type: "player_input",
      payload: { clientMessageId: "c1" },
    });

    await resolveEncounter({
      campaign,
      outcome: "victory",
      survivorIds: ["hero"],
      store: input.store,
      clock: input.clock,
      uuid: input.uuid,
    });

    expect(campaign.state.encounter).toBeNull();
    expect(campaign.built).toBeNull();
    // Idempotency spans the campaign, not the fight: a resent action must
    // still be recognized as a duplicate after the encounter it named ended.
    expect(campaign.state.world.appliedClientMessageIds).toEqual(["c1"]);
  });

  // `ResolveEncounterInput` has no `encounterId` field at all, so there is no
  // caller-supplied alternative for this to be pinning against — what this
  // actually proves is the exact shape and contents of the appended
  // `encounter_resolved` payload: `encounterId` from the open encounter,
  // `outcome` and `survivorIds` from the input, nothing else.
  it("writes encounter_resolved naming the open encounter, outcome and survivors", async () => {
    const input = baseInput();
    const campaign = await startedCampaign(input);
    await resolveEncounter({
      campaign,
      outcome: "victory",
      survivorIds: ["hero"],
      store: input.store,
      clock: input.clock,
      uuid: input.uuid,
    });
    const events = await input.store.readSince("s1", -1);
    expect(events.at(-1)).toMatchObject({ type: "encounter_resolved" });
    expect(events.at(-1)?.payload).toEqual({
      encounterId: ENCOUNTER_ID,
      outcome: "victory",
      survivorIds: ["hero"],
    });
  });

  it("refuses to close a bracket that was never opened", async () => {
    const input = baseInput();
    const campaign = await createCampaign(input);
    await expect(
      resolveEncounter({
        campaign,
        outcome: "victory",
        survivorIds: [],
        store: input.store,
        clock: input.clock,
        uuid: input.uuid,
      }),
    ).rejects.toThrow(/no encounter open/);
    expect(await input.store.readSince("s1", -1)).toHaveLength(1);
  });

  // The `resolveEncounter` sibling of `startEncounter`'s equivalent test
  // above: the guard here is `encounterOf(campaign)`, and a store rejection
  // after it has already passed must leave `state`, `built` and
  // `nextSequence` exactly as they were, not half-closed.
  it("leaves state, built and nextSequence untouched when append rejects post-guard", async () => {
    const input = baseInput();
    const campaign = await startedCampaign(input);
    const stateBefore = campaign.state;
    const builtBefore = campaign.built;
    const nextSequenceBefore = campaign.nextSequence;
    const failingStore: EventStore = {
      ...input.store,
      append: () => Promise.reject(new EventStoreUnavailableError("append", new Error("boom"))),
    };

    await expect(
      resolveEncounter({
        campaign,
        outcome: "victory",
        survivorIds: ["hero"],
        store: failingStore,
        clock: input.clock,
        uuid: input.uuid,
      }),
    ).rejects.toThrow(EventStoreUnavailableError);

    expect(campaign.state).toBe(stateBefore);
    expect(campaign.built).toBe(builtBefore);
    expect(campaign.nextSequence).toBe(nextSequenceBefore);
  });
});

describe("loadCampaign", () => {
  it("returns null for a campaign that was never created", async () => {
    expect(
      await loadCampaign({ campaignId: "nope", store: createInMemoryEventStore() }),
    ).toBeNull();
  });

  it("rebuilds an identical projection from a log of exactly one event", async () => {
    // One event is now a campaign that has not entered a fight yet, so this
    // also pins that a campaign with no encounter reloads as one, rather
    // than as a load failure.
    const input = baseInput();
    const created = await createCampaign(input);
    const loaded = await loadCampaign({ campaignId: "s1", store: input.store });
    expect(loaded?.state).toEqual(created.state);
    expect(loaded?.state.encounter).toBeNull();
    expect(loaded?.built).toBeNull();
    expect(loaded?.nextSequence).toBe(created.nextSequence);
  });

  it("rebuilds the encounter's initial board from its own encounter_started", async () => {
    // The load path's half of `initialEncounterState`: `reduce` cannot fill
    // the bracket it opens, so this proves `loadCampaign` substitutes the
    // rebuilt board rather than leaving a hole where the fold left one.
    const input = baseInput();
    const created = await startedCampaign(input);
    const loaded = await loadCampaign({ campaignId: "s1", store: input.store });
    expect(loaded?.state).toEqual(created.state);
    expect(loaded?.built?.encounterId).toBe(ENCOUNTER_ID);
    expect(loaded?.nextSequence).toBe(created.nextSequence);
  });

  it("reloads a campaign whose encounter has been resolved as encounter-less", async () => {
    const input = baseInput();
    const campaign = await startedCampaign(input);
    await resolveEncounter({
      campaign,
      outcome: "victory",
      survivorIds: ["hero"],
      store: input.store,
      clock: input.clock,
      uuid: input.uuid,
    });

    const loaded = await loadCampaign({ campaignId: "s1", store: input.store });
    expect(loaded?.state).toEqual(campaign.state);
    expect(loaded?.state.encounter).toBeNull();
    // Cleared in step with the projection, so `builtOf` cannot serve a board
    // the fold says is gone.
    expect(loaded?.built).toBeNull();
    expect(loaded?.nextSequence).toBe(3);
  });

  it("throws on a log that does not start with campaign_started", async () => {
    const store = createInMemoryEventStore();
    await store.append("s1", [
      {
        eventId: "00000000-0000-4000-8000-000000000001",
        campaignId: "s1",
        sequence: 0,
        timestamp: clock(),
        type: "scene_changed",
        payload: { kind: "turn_advanced" },
      },
    ]);
    await expect(loadCampaign({ campaignId: "s1", store })).rejects.toThrow(
      /does not start with campaign_started/,
    );
  });

  // On a log of exactly one event (just the genesis), `events.slice(1)` folds
  // an empty array — indistinguishable from `slice(0)`, from `events` itself,
  // or from several other wrong slices — and `nextSequence` collides with
  // `createCampaign`'s hardcoded 1, with `events.length`, and with `sequence`.
  // A non-empty tail is required to actually exercise the slice and the
  // `nextSequence` derivation, which Task 9 and Task 14 depend on to place
  // their next append.
  it("rebuilds an identical projection by folding a non-empty tail", async () => {
    const input = baseInput();
    const created = await startedCampaign(input);

    const movedCombatants = encounterOf(created).combatants.map((each) =>
      each.combatantId === "goblin-a" ? { ...each, position: [7, 3] } : each,
    );
    const genUuid = uuids();
    // Sequences 0 and 1 are the two genesis events, so a tail starts at 2.
    const tail: GameEvent[] = [
      {
        eventId: genUuid(),
        campaignId: "s1",
        sequence: 2,
        timestamp: clock(),
        type: "state_delta_applied",
        payload: { combatants: movedCombatants },
      },
      {
        eventId: genUuid(),
        campaignId: "s1",
        sequence: 3,
        timestamp: clock(),
        type: "scene_changed",
        payload: { kind: "turn_advanced" },
      },
    ];
    await input.store.append("s1", tail);

    const loaded = await loadCampaign({ campaignId: "s1", store: input.store });
    // `fold` is enough for a tail that opens no bracket — `created.state`
    // already has the board `encounter_started` could not fold in.
    const expected = fold(created.state, tail);

    expect(loaded?.state).toEqual(expected);
    const goblinA = loaded?.state.encounter?.combatants.find(
      (each) => each.combatantId === "goblin-a",
    );
    expect(goblinA?.position).toEqual([7, 3]);
    expect(loaded?.state.encounter?.currentActorIndex).toBe(1);
    expect(loaded?.nextSequence).toBe(4);
  });

  it("rebuilds the narration window from the log tail on load", async () => {
    const store = createInMemoryEventStore();
    const campaign = await startedCampaign({ ...baseInput(), store });

    for (const text of ["ראשון.", "שני.", "שלישי."]) {
      await store.append(campaign.state.world.campaignId, [
        {
          eventId: `e-${text}`,
          campaignId: campaign.state.world.campaignId,
          sequence: campaign.nextSequence++,
          timestamp: "2026-08-21T00:00:00.000Z",
          type: "narrative_emitted",
          payload: { actorId: "hero", streamId: "s", text, source: "model", promptVersion: "v" },
        },
      ]);
    }

    const loaded = await loadCampaign({ campaignId: campaign.state.world.campaignId, store });
    expect(loaded?.recentNarrations).toEqual(["שני.", "שלישי."]);
    expect(loaded?.recentNarrations).toHaveLength(NARRATION_WINDOW);
    expect(loaded?.built?.sceneEnglish).toBe(builtOf(campaign).sceneEnglish);
  });

  it("tolerates a narrative_emitted payload missing source and promptVersion", async () => {
    const store = createInMemoryEventStore();
    const campaign = await startedCampaign({ ...baseInput(), store });

    const events: GameEvent[] = [
      {
        eventId: "e-1",
        campaignId: campaign.state.world.campaignId,
        sequence: campaign.nextSequence++,
        timestamp: "2026-08-21T00:00:00.000Z",
        type: "narrative_emitted",
        payload: {
          actorId: "hero",
          streamId: "s",
          text: "ראשון.",
          source: "model",
          promptVersion: "v",
        },
      },
      // Mirrors what `pipeline.ts`'s `emit("narrative_emitted", { actorId, streamId, text })`
      // writes today — no `source`, no `promptVersion` (Task 12 is what adds them). A payload
      // from before this convention existed must not stop the campaign from loading.
      {
        eventId: "e-2",
        campaignId: campaign.state.world.campaignId,
        sequence: campaign.nextSequence++,
        timestamp: "2026-08-21T00:00:00.000Z",
        type: "narrative_emitted",
        payload: { actorId: "hero", streamId: "s", text: "רביעי." },
      },
      {
        eventId: "e-3",
        campaignId: campaign.state.world.campaignId,
        sequence: campaign.nextSequence++,
        timestamp: "2026-08-21T00:00:00.000Z",
        type: "narrative_emitted",
        payload: {
          actorId: "hero",
          streamId: "s",
          text: "שני.",
          source: "model",
          promptVersion: "v",
        },
      },
    ];
    await store.append(campaign.state.world.campaignId, events);

    const loaded = await loadCampaign({ campaignId: campaign.state.world.campaignId, store });
    expect(loaded).not.toBeNull();
    expect(loaded?.recentNarrations).toEqual(["ראשון.", "שני."]);
  });
});

describe("worldFor", () => {
  it("pairs the projection with a CombatWorld the validator accepts", async () => {
    const campaign = await startedCampaign(baseInput());
    const world = worldFor(campaign);
    expect(world.combatants).toEqual(encounterOf(campaign).combatants);
    expect(world.grid).toEqual(encounterOf(campaign).grid);
    expect(world.actionRangesFeet).toBeDefined();
  });
});

describe("builtOf", () => {
  // `builtOf`'s own disagreement guard (`built === null` or `built.encounterId
  // !== encounter.encounterId`) is dead in every other test in this suite:
  // `encounterOf` throws first whenever the bracket is closed, and every test
  // that gets past it holds `built` in lockstep with `state.encounter`
  // because it only ever went through `createCampaign`/`startEncounter`/
  // `resolveEncounter`. These two tests construct the disagreement directly
  // — the guard's only justification (per the doc comment on `Campaign.built`
  // and the deletion of the old `sceneEnglish` field) needs a test that can
  // actually fail.
  it("throws when built is null while the projection has an encounter open", async () => {
    const campaign = await startedCampaign(baseInput());
    campaign.built = null;
    // Distinguishable from `encounterOf`'s "no encounter open" message:
    // `encounterOf` does not throw here at all (the projection has a board),
    // so this is `builtOf`'s own guard firing, not a propagated throw.
    expect(() => builtOf(campaign)).toThrow(/built encounter none/);
    expect(() => builtOf(campaign)).not.toThrow(/no encounter open/);
  });

  it("throws when built names a different encounter than the one open", async () => {
    const campaign = await startedCampaign(baseInput());
    const real = campaign.built;
    if (real === null) throw new Error("expected startedCampaign to have set built");
    // Fabricated by spreading the real `BuiltEncounter` with a different id,
    // rather than looking up a second encounter — the catalogue holds only
    // goblin-ambush.
    campaign.built = { ...real, encounterId: "some-other-encounter" };
    expect(() => builtOf(campaign)).toThrow(/built encounter some-other-encounter/);
  });
});

// Task 7 (§4.7 step 1's coverage): everything above proves a bracket opens
// and closes correctly in isolation. Nothing yet proves a campaign survives
// crossing one — this describe block is the first test that could not have
// been written before the campaign/encounter split landed.
describe("a campaign that fights the same encounter twice", () => {
  // The catalogue holds exactly one encounter (`encounters/index.ts`), so
  // "start again" necessarily reuses `goblin-ambush` — the stronger test: the
  // same id must yield a pristine board after the first one was mutated,
  // rather than merely a fresh id nobody has fought before. Damaging a
  // combatant and moving the turn on before resolving is what makes a stale
  // board detectable at all — an untouched board would look identical
  // whether the second `startEncounter` truly rebuilt it or accidentally
  // reused the first one.
  //
  // Proven on both the live path (`startEncounter` itself) and the load path
  // (`loadCampaign`, folding the whole two-bracket log from scratch):
  // `loadCampaign`'s per-encounter rebuild loop is the thing this plan
  // actually introduced, and nothing before this test exercises it across a
  // boundary.
  it("resolving and restarting the same encounter gives a pristine board while the world carries over, live and on reload", async () => {
    const input = baseInput();
    const campaign = await startedCampaign(input);

    // Every mutation below is appended for real, not merely folded into
    // `campaign.state` in memory, for two reasons:
    //
    // - Skipping the append would leave the store's log with a hole at the
    //   sequences these events consume. Nothing downstream would catch it:
    //   the later appends by `resolveEncounter` and `startEncounter` would
    //   still succeed right over the gap, since `findAppendConflict` rejects
    //   duplicate sequences and campaign mismatches, not gaps — no
    //   production path ever produces a log with one.
    // - Without them, the log the load-path assertion (part 3) re-folds
    //   from scratch would carry no combat events at all, so nothing
    //   between the brackets would exercise the substituted board's
    //   contents, only its existence. The `state_delta_applied` below writes
    //   real combatants, and the three `turn_advanced`s that follow actually
    //   walk `turnOrder` — not because the fold's correctness depends on
    //   their shape mid-bracket (`encounter_resolved` discards this board
    //   outright, and the second `encounter_started` substitutes a fresh
    //   one), but because, exactly as the opening comment above already
    //   says, they are what makes a stale board detectable at all.
    async function appendAndFold(event: GameEvent): Promise<void> {
      await input.store.append("s1", [event]);
      campaign.state = reduce(campaign.state, event);
      campaign.nextSequence += 1;
    }

    // The world half of the boundary: appliedClientMessageIds must survive
    // both resolveEncounter and a second startEncounter. Neither call ever
    // appends a player_input — only the pipeline's `structured_action` case
    // does — so one is appended directly here.
    await appendAndFold({
      eventId: input.uuid(),
      campaignId: "s1",
      sequence: campaign.nextSequence,
      timestamp: clock(),
      type: "player_input",
      payload: { clientMessageId: "c1" },
    });

    // Mutate the open board so a stale one would be detectable: damage a
    // combatant, then play a full round forward — turnOrder has 3 members,
    // so three turn_advanced events wrap back around to "hero" and roll
    // `round` to 2, not just move `currentActorIndex` off 0. A single
    // turn_advanced would leave `round` at 1 on the dirty board too,
    // indistinguishable from pristine on that field alone — the fixture
    // needs every field the assertions below check to actually differ.
    // Mirrors `resolveEncounter`'s "closes the bracket and keeps the world"
    // test, one describe block up, for the event shapes.
    const damaged = encounterOf(campaign).combatants.map((each) =>
      each.combatantId === "goblin-a" ? { ...each, currentHp: 1 } : each,
    );
    await appendAndFold({
      eventId: input.uuid(),
      campaignId: "s1",
      sequence: campaign.nextSequence,
      timestamp: clock(),
      type: "state_delta_applied",
      payload: { combatants: damaged },
    });
    for (let turn = 0; turn < 3; turn += 1) {
      await appendAndFold({
        eventId: input.uuid(),
        campaignId: "s1",
        sequence: campaign.nextSequence,
        timestamp: clock(),
        type: "scene_changed",
        payload: { kind: "turn_advanced" },
      });
    }
    expect(encounterOf(campaign).round).toBe(2);
    expect(encounterOf(campaign).currentActorIndex).toBe(0);
    expect(
      encounterOf(campaign).combatants.find((each) => each.combatantId === "goblin-a")?.currentHp,
    ).toBe(1);

    await resolveEncounter({
      campaign,
      outcome: "victory",
      survivorIds: ["hero"],
      store: input.store,
      clock: input.clock,
      uuid: input.uuid,
    });

    const restarted = await startEncounter({
      campaign,
      encounterId: ENCOUNTER_ID,
      store: input.store,
      clock: input.clock,
      uuid: input.uuid,
    });

    // 1. Live path: the second board is pristine, not the mutated first one.
    // `round` and `combatants` are the fields the dirty board actually
    // disagrees with pristine on now (`currentActorIndex` wrapped back to 0
    // on both — still asserted, just no longer the discriminating field).
    const pristine = buildEncounterById(ENCOUNTER_ID).world.combatants;
    expect(encounterOf(restarted).round).toBe(1);
    expect(encounterOf(restarted).currentActorIndex).toBe(0);
    expect(encounterOf(restarted).combatants).toEqual(pristine);
    expect(restarted.built).not.toBeNull();

    // 2. The world survived the boundary — idempotency is campaign-scoped,
    // not fight-scoped, so a resend of "c1" must still be recognized as a
    // duplicate after the encounter that first saw it has already ended.
    expect(restarted.state.world.appliedClientMessageIds).toEqual(["c1"]);

    // 3. Load path: folding the whole log from scratch exercises
    // encounter_started -> substitute -> encounter_resolved -> clear, twice
    // over in one log — now a genuinely contiguous log with the dirtying
    // events for real (part 1's `appendAndFold` calls above), not a log with
    // a hole where they would have been — and must land on exactly what the
    // live campaign has.
    const loaded = await loadCampaign({ campaignId: "s1", store: input.store });
    expect(loaded?.state).toEqual(restarted.state);
    expect(loaded?.built).toEqual(restarted.built);
    expect(loaded?.nextSequence).toBe(restarted.nextSequence);
  });
});
