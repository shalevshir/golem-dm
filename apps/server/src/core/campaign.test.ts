import { describe, expect, it } from "vitest";
import { createInMemoryEventStore } from "@ai-dm/memory";
import { fold } from "@ai-dm/schemas";
import type { GameEvent } from "@ai-dm/schemas";
import { createCampaign, encounterOf, loadCampaign, worldFor } from "./campaign.js";
import type { CreateCampaignInput } from "./campaign.js";

const clock = (): string => "2026-08-19T10:00:00.000Z";

function uuids(): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  };
}

const NARRATION_WINDOW = 2;

/** The `CreateCampaignInput` fields shared by every test below; a test spreads
 * this and overrides only what it cares about. `store` and `uuid` are fresh
 * per call so two tests never share state or collide on generated ids. */
function baseInput(): CreateCampaignInput {
  return {
    campaignId: "s1",
    encounterId: "goblin-ambush",
    rootSeed: 42,
    store: createInMemoryEventStore(),
    clock,
    uuid: uuids(),
  };
}

describe("createCampaign", () => {
  it("projects the encounter's combatants and turn order", async () => {
    const store = createInMemoryEventStore();
    const campaign = await createCampaign({
      campaignId: "s1",
      encounterId: "goblin-ambush",
      rootSeed: 42,
      store,
      clock,
      uuid: uuids(),
    });
    expect(encounterOf(campaign).turnOrder).toEqual(["hero", "goblin-a", "goblin-b"]);
    expect(encounterOf(campaign).combatants).toHaveLength(3);
    expect(encounterOf(campaign).round).toBe(1);
    expect(encounterOf(campaign).currentActorIndex).toBe(0);
  });

  it("writes a session_snapshot event as sequence 0", async () => {
    const store = createInMemoryEventStore();
    await createCampaign({
      campaignId: "s1",
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

  it("seeds campaignId, rootSeed, encounterId, grid and turnOrder as genesis state", async () => {
    const store = createInMemoryEventStore();
    const campaign = await createCampaign({
      campaignId: "s1",
      encounterId: "goblin-ambush",
      rootSeed: 42,
      store,
      clock,
      uuid: uuids(),
    });
    expect(campaign.state.world.campaignId).toBe("s1");
    expect(campaign.state.world.rootSeed).toBe(42);
    expect(encounterOf(campaign).encounterId).toBe("goblin-ambush");
    expect(encounterOf(campaign).grid.width).toBe(12);
    expect(encounterOf(campaign).grid.height).toBe(12);
    expect(encounterOf(campaign).turnOrder).toEqual(["hero", "goblin-a", "goblin-b"]);
  });

  it("resolves the encounter's scene card once at creation", async () => {
    const campaign = await createCampaign({ ...baseInput(), encounterId: "goblin-ambush" });
    expect(campaign.sceneEnglish).toContain("hillside");
    expect(campaign.sceneEnglish).toBe(campaign.built.sceneEnglish);
    expect(campaign.recentNarrations).toEqual([]);
  });
});

describe("loadCampaign", () => {
  it("returns null for a campaign that was never created", async () => {
    expect(
      await loadCampaign({ campaignId: "nope", store: createInMemoryEventStore() }),
    ).toBeNull();
  });

  it("rebuilds an identical projection from a log of exactly one event", async () => {
    const store = createInMemoryEventStore();
    const created = await createCampaign({
      campaignId: "s1",
      encounterId: "goblin-ambush",
      rootSeed: 42,
      store,
      clock,
      uuid: uuids(),
    });
    const loaded = await loadCampaign({ campaignId: "s1", store });
    expect(loaded?.state).toEqual(created.state);
    expect(loaded?.nextSequence).toBe(created.nextSequence);
  });

  // On a log of exactly one event (just the genesis), `events.slice(1)` folds
  // an empty array — indistinguishable from `slice(0)`, from `events` itself,
  // or from several other wrong slices — and `nextSequence` collides with
  // `createCampaign`'s hardcoded 1, with `events.length`, and with `sequence`.
  // A non-empty tail is required to actually exercise the slice and the
  // `nextSequence` derivation, which Task 9 and Task 14 depend on to place
  // their next append.
  it("rebuilds an identical projection by folding a non-empty tail", async () => {
    const store = createInMemoryEventStore();
    const created = await createCampaign({
      campaignId: "s1",
      encounterId: "goblin-ambush",
      rootSeed: 42,
      store,
      clock,
      uuid: uuids(),
    });

    const movedCombatants = encounterOf(created).combatants.map((each) =>
      each.combatantId === "goblin-a" ? { ...each, position: [7, 3] } : each,
    );
    const genUuid = uuids();
    const tail: GameEvent[] = [
      {
        eventId: genUuid(),
        campaignId: "s1",
        sequence: 1,
        timestamp: clock(),
        type: "state_delta_applied",
        payload: { combatants: movedCombatants },
      },
      {
        eventId: genUuid(),
        campaignId: "s1",
        sequence: 2,
        timestamp: clock(),
        type: "scene_changed",
        payload: { kind: "turn_advanced" },
      },
    ];
    await store.append("s1", tail);

    const loaded = await loadCampaign({ campaignId: "s1", store });
    const expected = fold(created.state, tail);

    expect(loaded?.state).toEqual(expected);
    const goblinA = loaded?.state.encounter?.combatants.find(
      (each) => each.combatantId === "goblin-a",
    );
    expect(goblinA?.position).toEqual([7, 3]);
    expect(loaded?.state.encounter?.currentActorIndex).toBe(1);
    expect(loaded?.nextSequence).toBe(3);
  });

  it("rebuilds the narration window from the log tail on load", async () => {
    const store = createInMemoryEventStore();
    const campaign = await createCampaign({ ...baseInput(), store, encounterId: "goblin-ambush" });

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
    expect(loaded?.sceneEnglish).toBe(campaign.sceneEnglish);
  });

  it("tolerates a narrative_emitted payload missing source and promptVersion", async () => {
    const store = createInMemoryEventStore();
    const campaign = await createCampaign({ ...baseInput(), store, encounterId: "goblin-ambush" });

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
    const store = createInMemoryEventStore();
    const campaign = await createCampaign({
      campaignId: "s1",
      encounterId: "goblin-ambush",
      rootSeed: 42,
      store,
      clock,
      uuid: uuids(),
    });
    const world = worldFor(campaign);
    expect(world.combatants).toEqual(encounterOf(campaign).combatants);
    expect(world.grid).toEqual(encounterOf(campaign).grid);
    expect(world.actionRangesFeet).toBeDefined();
  });
});
