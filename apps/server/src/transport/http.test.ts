import { describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { createInMemoryEventStore } from "@ai-dm/memory";
import type { EventStore } from "@ai-dm/memory";
import { EncounterCatalogue } from "@ai-dm/schemas";
import { encounterCatalogue } from "../encounters/index.js";
import { createCampaignRegistry, registerHttpRoutes } from "./http.js";
import type { CampaignRegistry } from "./http.js";

function appWith() {
  const store = createInMemoryEventStore();
  let n = 0;
  const registry = createCampaignRegistry({
    store,
    uuid: () => {
      n += 1;
      return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
    },
    clock: () => "2026-08-19T10:00:00.000Z",
    seed: () => 42,
  });
  const app = Fastify();
  registerHttpRoutes(app, registry);
  return { app, registry, store };
}

describe("POST /campaigns", () => {
  it("creates a campaign and returns its id", async () => {
    const { app } = appWith();
    const response = await app.inject({
      method: "POST",
      url: "/campaigns",
      payload: { encounterId: "goblin-ambush" },
    });
    expect(response.statusCode).toBe(201);
    expect(JSON.parse(response.body)).toMatchObject({ campaignId: expect.any(String) as string });
  });

  it("rejects an unknown encounter with 404", async () => {
    const { app } = appWith();
    const response = await app.inject({
      method: "POST",
      url: "/campaigns",
      payload: { encounterId: "nope" },
    });
    expect(response.statusCode).toBe(404);
  });

  it("appends nothing to the store for an unknown encounterId", async () => {
    // `createCampaign` appends `campaign_started` unconditionally, so unless
    // `create` validates the encounter id BEFORE calling it, an unknown id
    // still writes a durable orphan `game_events` row for a campaign id
    // nobody is ever given. The 404 assertion above cannot discriminate that
    // on its own — the endpoint answers 404 either way — so this asserts the
    // append-nothing half directly against the store.
    const { app, store } = appWith();
    const appendSpy = vi.spyOn(store, "append");

    const response = await app.inject({
      method: "POST",
      url: "/campaigns",
      payload: { encounterId: "nope" },
    });

    expect(response.statusCode).toBe(404);
    expect(appendSpy).not.toHaveBeenCalled();
  });

  it("rejects a body with no encounterId with 400", async () => {
    const { app } = appWith();
    const response = await app.inject({ method: "POST", url: "/campaigns", payload: {} });
    expect(response.statusCode).toBe(400);
  });

  it("creates a scene campaign from a worldId, reachable with scene state and no board", async () => {
    const { app, registry } = appWith();
    const response = await app.inject({
      method: "POST",
      url: "/campaigns",
      payload: { worldId: "emberfall" },
    });
    expect(response.statusCode).toBe(201);

    const { campaignId } = JSON.parse(response.body) as { campaignId: string };
    const campaign = await registry.get(campaignId);
    expect(campaign?.state.world.scene?.currentNodeId).toBe("arrival");
    expect(campaign?.state.encounter).toBeNull();
  });

  it("rejects a worldId this deployment does not author with 404", async () => {
    const { app } = appWith();
    const response = await app.inject({
      method: "POST",
      url: "/campaigns",
      payload: { worldId: "atlantis" },
    });
    expect(response.statusCode).toBe(404);
  });

  it("creates a combat campaign from an encounterId unchanged, with a board", async () => {
    // Pins the encounterId path's behaviour is untouched now that `worldId`
    // exists as an alternative body shape: same 201, and the campaign the
    // registry hands back still has an open board — `startEncounter` still
    // runs for this path and only this one.
    const { app, registry } = appWith();
    const response = await app.inject({
      method: "POST",
      url: "/campaigns",
      payload: { encounterId: "goblin-ambush" },
    });
    expect(response.statusCode).toBe(201);

    const { campaignId } = JSON.parse(response.body) as { campaignId: string };
    const campaign = await registry.get(campaignId);
    expect(campaign?.state.world.scene).toBeNull();
    expect(campaign?.state.encounter).not.toBeNull();
    expect(campaign?.built?.encounterId).toBe("goblin-ambush");
  });

  it("makes the created campaign retrievable from the registry", async () => {
    const { app, registry } = appWith();
    const response = await app.inject({
      method: "POST",
      url: "/campaigns",
      payload: { encounterId: "goblin-ambush" },
    });
    const { campaignId } = JSON.parse(response.body) as { campaignId: string };
    expect(await registry.get(campaignId)).not.toBeNull();
  });

  it(
    "responds 500 for any error other than UnknownEncounterError, even one whose " +
      "message starts with the same words",
    async () => {
      // Guards the 404 discrimination itself: a handler that detected it with
      // `message.startsWith("Unknown encounter")` instead of `instanceof
      // UnknownEncounterError` would misroute this to 404. The message is
      // deliberately chosen to collide with that regex.
      const app = Fastify();
      const registry: CampaignRegistry = {
        create: () => Promise.reject(new Error("Unknown encounter that is really a bug")),
        get: () => Promise.resolve(null),
        tryBegin: () => true,
        end: () => {
          // No in-flight state to release in this stub.
        },
      };
      registerHttpRoutes(app, registry);
      const response = await app.inject({
        method: "POST",
        url: "/campaigns",
        payload: { encounterId: "goblin-ambush" },
      });
      expect(response.statusCode).toBe(500);
    },
  );
});

describe("CampaignRegistry", () => {
  // The `live` cache is what lets two WS connections onto the same campaign
  // (Task 14) share one mutable `Campaign` object rather than each folding its
  // own copy — `nextSequence` lives on that object and the pipeline advances
  // it in place. `registry.get` returning a *non-null* campaign proves nothing
  // about that: `loadCampaign` also returns a (different, freshly-folded)
  // non-null `Campaign` by reading the log straight through. Only object
  // identity distinguishes "served from cache" from "silently re-derived
  // every time".
  it("caches the created campaign, so a later get returns the identical object", async () => {
    const { registry } = appWith();
    const created = await registry.create({ encounterId: "goblin-ambush" });
    const fetched = await registry.get(created.state.world.campaignId);
    expect(fetched).toBe(created);
  });

  it("does not re-read the event log on a cache hit", async () => {
    const { registry, store } = appWith();
    const created = await registry.create({ encounterId: "goblin-ambush" });
    const readSince = vi.spyOn(store, "readSince");
    await registry.get(created.state.world.campaignId);
    expect(readSince).not.toHaveBeenCalled();
  });

  // `tryBegin`/`end` are the actual mutual-exclusion primitive `ws.ts` builds
  // its per-campaign guard on — see `ws.test.ts`'s "rejects a same-campaign
  // command from a SECOND socket while the first is mid-turn" for the
  // end-to-end proof over real sockets that this closes the corrupted-log
  // hazard.
  it("tryBegin claims a campaign's in-flight slot exactly once until end releases it", () => {
    const { registry } = appWith();
    expect(registry.tryBegin("s1")).toBe(true);
    expect(registry.tryBegin("s1")).toBe(false);
    registry.end("s1");
    expect(registry.tryBegin("s1")).toBe(true);
  });

  it("tracks in-flight slots independently per campaign id", () => {
    const { registry } = appWith();
    expect(registry.tryBegin("s1")).toBe(true);
    expect(registry.tryBegin("s2")).toBe(true);
    registry.end("s1");
    expect(registry.tryBegin("s2")).toBe(false);
  });
});

describe("CampaignRegistry.get", () => {
  it("folds a campaign once when two joins race", async () => {
    const { registry, store } = appWith();
    const created = await registry.create({ encounterId: "goblin-ambush" });
    const campaignId = created.state.world.campaignId;

    // A second registry over the same store is what a restarted process
    // looks like: nothing in `live`, everything in the log. The gate holds
    // the fold open so both `get` calls are genuinely in flight at once —
    // which against Postgres is just a network round trip, and `join` sits
    // outside the campaign lock by design (ws.ts).
    let reads = 0;
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow: EventStore = {
      ...store,
      async readSince(id, afterSequence) {
        reads += 1;
        await gate;
        return store.readSince(id, afterSequence);
      },
    };
    const restarted = createCampaignRegistry({
      store: slow,
      uuid: () => "00000000-0000-4000-8000-000000000099",
      clock: () => "2026-08-19T10:00:00.000Z",
      seed: () => 42,
    });

    const both = Promise.all([restarted.get(campaignId), restarted.get(campaignId)]);
    release();
    const [first, second] = await both;

    expect(first).not.toBeNull();
    // One object, not two: two Campaigns would each carry their own
    // nextSequence and both keep appending to the same log.
    expect(first).toBe(second);
    expect(reads).toBe(1);
  });
});

describe("GET /health", () => {
  it("answers 200", async () => {
    const { app } = appWith();
    expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
  });
});

describe("GET /encounters/:encounterId", () => {
  it("returns display names for every combatant in the encounter", async () => {
    const { app } = appWith();
    const response = await app.inject({ method: "GET", url: "/encounters/goblin-ambush" });
    expect(response.statusCode).toBe(200);

    const body = EncounterCatalogue.parse(response.json());

    expect(body.encounterId).toBe("goblin-ambush");
    expect(body.combatants.map((each) => each.combatantId).sort()).toEqual([
      "goblin-a",
      "goblin-b",
      "hero",
    ]);

    const hero = body.combatants.find((each) => each.combatantId === "hero");
    // The hero is a real CharacterSheet; a character sheet
    // is authored in Hebrew and has no English name, so `characterStatBlock`
    // uses the characterId as `nameEnglish`.
    expect(hero?.nameEnglish).toBe("hero");
    expect(hero?.faction).toBe("party");
    expect(hero?.maxHp).toBeGreaterThan(0);
  });

  it("dedupes actions by actionId across stat blocks", async () => {
    const { app } = appWith();
    const response = await app.inject({ method: "GET", url: "/encounters/goblin-ambush" });
    expect(response.statusCode).toBe(200);
    const body = EncounterCatalogue.parse(response.json());

    const ids = body.actions.map((each) => each.actionId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("longsword");
    expect(ids).toContain("scimitar");
  });

  it("404s on an unknown encounter", async () => {
    const { app } = appWith();
    const response = await app.inject({ method: "GET", url: "/encounters/nope" });
    expect(response.statusCode).toBe(404);
  });
});

describe("GET /encounters/:encounterId — derived characters and Hebrew labels", () => {
  it("serves the hero's full derivation in the catalogue", async () => {
    const { app } = appWith();
    const response = await app.inject({ method: "GET", url: "/encounters/goblin-ambush" });
    expect(response.statusCode).toBe(200);

    const catalogue = EncounterCatalogue.parse(response.json());
    const hero = catalogue.characters.find((each) => each.characterId === "hero");

    expect(hero?.armorClass).toBe(16);
    expect(hero?.passivePerception).toBe(13);
    expect(hero?.savingThrows.str).toBe(5);
    expect(Object.keys(hero?.skills ?? {})).toHaveLength(18);
    // The client must never need to compute any of this itself.
    expect(hero?.grammaticalGender).toBe("masculine");
  });

  it("labels every combatant and action in Hebrew", async () => {
    const { app } = appWith();
    const response = await app.inject({ method: "GET", url: "/encounters/goblin-ambush" });
    const catalogue = EncounterCatalogue.parse(response.json());

    for (const combatant of catalogue.combatants) {
      expect(combatant.nameHebrew.trim(), combatant.combatantId).not.toBe("");
    }
    for (const action of catalogue.actions) {
      expect(action.nameHebrew.trim(), action.actionId).not.toBe("");
    }
  });

  it("populates characters from the encounter's character spawn, not every combatant", () => {
    // goblin-ambush has three combatants but only one character spawn, so a
    // length of 1 discriminates a spawn-driven list from a combatant-driven
    // one — this guards against `characters` being populated from something
    // other than the spawns.
    const built = encounterCatalogue("goblin-ambush");
    expect(built.characters).toHaveLength(1);
    expect(built.characters[0]?.characterId).toBe("hero");
  });
});
