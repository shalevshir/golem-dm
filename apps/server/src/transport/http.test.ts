import { describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { EncounterCatalogue } from "@ai-dm/schemas";
import { createInMemoryEventStore } from "../core/event-store.js";
import { encounterCatalogue } from "../encounters/index.js";
import { createSessionRegistry, registerHttpRoutes } from "./http.js";
import type { SessionRegistry } from "./http.js";

function appWith() {
  const store = createInMemoryEventStore();
  let n = 0;
  const registry = createSessionRegistry({
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

describe("POST /sessions", () => {
  it("creates a session and returns its id", async () => {
    const { app } = appWith();
    const response = await app.inject({
      method: "POST",
      url: "/sessions",
      payload: { encounterId: "goblin-ambush" },
    });
    expect(response.statusCode).toBe(201);
    expect(JSON.parse(response.body)).toMatchObject({ sessionId: expect.any(String) as string });
  });

  it("rejects an unknown encounter with 404", async () => {
    const { app } = appWith();
    const response = await app.inject({
      method: "POST",
      url: "/sessions",
      payload: { encounterId: "nope" },
    });
    expect(response.statusCode).toBe(404);
  });

  it("rejects a body with no encounterId with 400", async () => {
    const { app } = appWith();
    const response = await app.inject({ method: "POST", url: "/sessions", payload: {} });
    expect(response.statusCode).toBe(400);
  });

  it("makes the created session retrievable from the registry", async () => {
    const { app, registry } = appWith();
    const response = await app.inject({
      method: "POST",
      url: "/sessions",
      payload: { encounterId: "goblin-ambush" },
    });
    const { sessionId } = JSON.parse(response.body) as { sessionId: string };
    expect(await registry.get(sessionId)).not.toBeNull();
  });

  it(
    "responds 500 for any error other than UnknownEncounterError, even one whose " +
      "message starts with the same words",
    async () => {
      // Guards the C-34 fix itself: a handler that detected the 404 case with
      // `message.startsWith("Unknown encounter")` instead of `instanceof
      // UnknownEncounterError` would misroute this to 404. The message is
      // deliberately chosen to collide with that regex.
      const app = Fastify();
      const registry: SessionRegistry = {
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
        url: "/sessions",
        payload: { encounterId: "goblin-ambush" },
      });
      expect(response.statusCode).toBe(500);
    },
  );
});

describe("SessionRegistry", () => {
  // The `live` cache is what lets two WS connections onto the same session
  // (Task 14) share one mutable `Session` object rather than each folding its
  // own copy — `nextSequence` lives on that object and the pipeline advances
  // it in place. `registry.get` returning a *non-null* session proves nothing
  // about that: `loadSession` also returns a (different, freshly-folded)
  // non-null `Session` by reading the log straight through. Only object
  // identity distinguishes "served from cache" from "silently re-derived
  // every time".
  it("caches the created session, so a later get returns the identical object", async () => {
    const { registry } = appWith();
    const created = await registry.create("goblin-ambush");
    const fetched = await registry.get(created.state.sessionId);
    expect(fetched).toBe(created);
  });

  it("does not re-read the event log on a cache hit", async () => {
    const { registry, store } = appWith();
    const created = await registry.create("goblin-ambush");
    const readSince = vi.spyOn(store, "readSince");
    await registry.get(created.state.sessionId);
    expect(readSince).not.toHaveBeenCalled();
  });

  // CRITICAL-1 unit coverage: `tryBegin`/`end` are the actual mutual-exclusion
  // primitive `ws.ts` builds its per-session guard on — see
  // `ws.test.ts`'s "CRITICAL-1" test for the end-to-end proof over real
  // sockets that this closes the corrupted-log hazard.
  it("tryBegin claims a session's in-flight slot exactly once until end releases it", () => {
    const { registry } = appWith();
    expect(registry.tryBegin("s1")).toBe(true);
    expect(registry.tryBegin("s1")).toBe(false);
    registry.end("s1");
    expect(registry.tryBegin("s1")).toBe(true);
  });

  it("tracks in-flight slots independently per session id", () => {
    const { registry } = appWith();
    expect(registry.tryBegin("s1")).toBe(true);
    expect(registry.tryBegin("s2")).toBe(true);
    registry.end("s1");
    expect(registry.tryBegin("s2")).toBe(false);
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

    const body = response.json<{
      encounterId: string;
      combatants: { combatantId: string; nameEnglish: string; maxHp: number; faction: string }[];
      actions: { actionId: string; nameEnglish: string }[];
    }>();

    expect(body.encounterId).toBe("goblin-ambush");
    expect(body.combatants.map((each) => each.combatantId).sort()).toEqual([
      "goblin-a",
      "goblin-b",
      "hero",
    ]);

    const hero = body.combatants.find((each) => each.combatantId === "hero");
    // The hero is a real CharacterSheet (C-13 is closed); a character sheet
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
    const body = response.json<{ actions: { actionId: string; nameEnglish: string }[] }>();

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
