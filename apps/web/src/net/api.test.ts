// The HTTP half of "parse, never cast" — the rule this task exists to
// enforce — is otherwise only enforced by reading the code. These tests
// prove it: a malformed body must throw, not fall through as an
// incorrectly-typed value.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSession, fetchCatalogue } from "./api.js";

interface StubbedResponse {
  ok: boolean;
  status?: number;
  body: unknown;
}

function stubFetch(response: StubbedResponse): void {
  vi.stubGlobal(
    "fetch",
    vi.fn((): Promise<Response> =>
      Promise.resolve({
        ok: response.ok,
        status: response.status ?? (response.ok ? 200 : 500),
        json: (): Promise<unknown> => Promise.resolve(response.body),
      } as Response),
    ),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const validCatalogue = {
  encounterId: "goblin-ambush",
  combatants: [
    {
      combatantId: "goblin-a",
      nameEnglish: "Goblin Warrior",
      nameHebrew: "גובלין לוחם",
      maxHp: 9,
      faction: "hostile",
    },
  ],
  actions: [{ actionId: "scimitar", nameEnglish: "Scimitar", nameHebrew: "חרב מגל" }],
  // Explicit, not omitted: `EncounterCatalogue.parse` fills a missing
  // `characters` key with this same default, and "parses a valid catalogue"
  // below asserts the parsed result equals this fixture exactly — an
  // omitted key here would not `toEqual` the defaulted-in `[]` the parse
  // actually produces.
  characters: [],
};

describe("fetchCatalogue", () => {
  it("parses a valid catalogue", async () => {
    stubFetch({ ok: true, body: validCatalogue });
    await expect(fetchCatalogue("goblin-ambush")).resolves.toEqual(validCatalogue);
  });

  it("rejects a malformed catalogue rather than returning it", async () => {
    stubFetch({
      ok: true,
      body: {
        ...validCatalogue,
        combatants: [{ ...validCatalogue.combatants[0], maxHp: 0 }],
      },
    });
    await expect(fetchCatalogue("goblin-ambush")).rejects.toThrow();
  });

  it("rejects a body missing the combatants field entirely", async () => {
    stubFetch({
      ok: true,
      body: { encounterId: "goblin-ambush", actions: validCatalogue.actions },
    });
    await expect(fetchCatalogue("goblin-ambush")).rejects.toThrow();
  });

  it("throws on a non-OK response instead of parsing the error body", async () => {
    stubFetch({ ok: false, status: 404, body: { error: "unknown encounter" } });
    await expect(fetchCatalogue("missing")).rejects.toThrow(/404/);
  });
});

describe("createSession", () => {
  it("returns the session id from a valid body", async () => {
    stubFetch({ ok: true, body: { sessionId: "s1" } });
    await expect(createSession("goblin-ambush")).resolves.toBe("s1");
  });

  it("rejects a body missing sessionId rather than returning undefined", async () => {
    stubFetch({ ok: true, body: {} });
    await expect(createSession("goblin-ambush")).rejects.toThrow();
  });

  it("throws on a non-OK response instead of parsing the error body", async () => {
    stubFetch({ ok: false, status: 500, body: { error: "boom" } });
    await expect(createSession("goblin-ambush")).rejects.toThrow(/500/);
  });
});
