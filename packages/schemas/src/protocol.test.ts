import { describe, expect, it } from "vitest";
import {
  ActionAffordance,
  ClientMessage,
  EncounterCatalogue,
  MAX_FREE_TEXT_LENGTH,
  ServerFrame,
  CampaignCreated,
  CampaignState,
  TurnAffordances,
} from "./protocol.js";

describe("ClientMessage", () => {
  it("accepts a join with no resumeFrom", () => {
    const parsed = ClientMessage.parse({ type: "join", campaignId: "s1" });
    expect(parsed.type).toBe("join");
  });

  it("accepts a join that resumes from a sequence", () => {
    const parsed = ClientMessage.parse({ type: "join", campaignId: "s1", resumeFrom: 12 });
    expect(parsed).toMatchObject({ resumeFrom: 12 });
  });

  it("rejects a negative resumeFrom", () => {
    expect(() => ClientMessage.parse({ type: "join", campaignId: "s1", resumeFrom: -1 })).toThrow();
  });

  it("accepts a structured action carrying a full ExecuteTurn", () => {
    const parsed = ClientMessage.parse({
      type: "structured_action",
      clientMessageId: "c1",
      actorId: "hero",
      turn: {
        actorId: "hero",
        mainAction: { actionType: "dodge" },
        tacticalRationaleEnglish: "Test fixture.",
      },
    });
    expect(parsed.type).toBe("structured_action");
  });

  it("rejects free text over the length cap before it can reach a prompt", () => {
    const text = "a".repeat(MAX_FREE_TEXT_LENGTH + 1);
    expect(() => ClientMessage.parse({ type: "free_text", clientMessageId: "c1", text })).toThrow();
  });

  it("accepts free text at exactly the cap", () => {
    const text = "a".repeat(MAX_FREE_TEXT_LENGTH);
    expect(ClientMessage.parse({ type: "free_text", clientMessageId: "c1", text }).type).toBe(
      "free_text",
    );
  });

  it("rejects an unknown message type", () => {
    expect(() => ClientMessage.parse({ type: "shout", text: "hi" })).toThrow();
  });
});

describe("ServerFrame", () => {
  it("round-trips a narrative token", () => {
    const frame = ServerFrame.parse({ type: "narrative_token", streamId: "n1", text: "Goblin " });
    expect(frame).toEqual({ type: "narrative_token", streamId: "n1", text: "Goblin " });
  });

  it("round-trips a rejection carrying engine reason codes", () => {
    const frame = ServerFrame.parse({
      type: "rejected",
      clientMessageId: "c1",
      reasons: ["target_out_of_reach"],
      messages: ["Target is 15 ft away, reach is 5 ft."],
    });
    expect(frame).toMatchObject({ reasons: ["target_out_of_reach"] });
  });

  it("rejects an error frame with an unknown code", () => {
    expect(() => ServerFrame.parse({ type: "error", code: "banana", message: "?" })).toThrow();
  });
});

describe("turn_affordances frame", () => {
  const frame = {
    type: "turn_affordances",
    actorId: "hero",
    forSequence: 12,
    reachableTiles: [
      [5, 3],
      [6, 4],
    ],
    actions: [
      {
        actionType: "attack",
        actionId: "spear",
        requiresTarget: true,
        targetableCombatantIds: ["goblin-a"],
      },
      { actionType: "dodge", requiresTarget: false, targetableCombatantIds: [] },
    ],
  };

  it("parses as a ServerFrame", () => {
    const parsed = ServerFrame.parse(frame);
    expect(parsed.type).toBe("turn_affordances");
    // zod strips unknown keys, so asserting only `type` here would still pass
    // a variant that dropped `reachableTiles` (or any other field) entirely
    // — the client's affordance rendering depends on this payload actually
    // surviving the parse, not just the discriminant.
    expect(parsed).toMatchObject({
      reachableTiles: [
        [5, 3],
        [6, 4],
      ],
    });
  });

  it("keeps actionId optional so no-target actions need not invent one", () => {
    const dodge = ActionAffordance.parse({
      actionType: "dodge",
      requiresTarget: false,
      targetableCombatantIds: [],
    });
    expect(dodge.actionId).toBeUndefined();
  });

  it("rejects an unknown actionType rather than passing it through", () => {
    expect(() =>
      ActionAffordance.parse({
        actionType: "somersault",
        requiresTarget: false,
        targetableCombatantIds: [],
      }),
    ).toThrow();
  });

  it("rejects a negative forSequence", () => {
    expect(() => ServerFrame.parse({ ...frame, forSequence: -1 })).toThrow();
  });

  it("exposes the same fields standalone for the engine to return", () => {
    const affordances = TurnAffordances.parse({
      actorId: "hero",
      reachableTiles: [[5, 3]],
      actions: [],
    });
    expect(affordances.reachableTiles).toEqual([[5, 3]]);
  });
});

describe("EncounterCatalogue", () => {
  const hero = {
    combatantId: "hero",
    nameEnglish: "Guard",
    nameHebrew: "שומר",
    maxHp: 11,
    faction: "party",
  };
  const goblin = {
    combatantId: "goblin-a",
    nameEnglish: "Goblin Warrior",
    nameHebrew: "גובלין לוחם",
    maxHp: 9,
    faction: "hostile",
  };
  const catalogue = {
    encounterId: "goblin-ambush",
    combatants: [hero, goblin],
    actions: [
      { actionId: "spear", nameEnglish: "Spear", nameHebrew: "חנית" },
      { actionId: "scimitar", nameEnglish: "Scimitar", nameHebrew: "חרב מעוקלת" },
    ],
  };

  it("parses a valid catalogue", () => {
    const parsed = EncounterCatalogue.parse(catalogue);
    expect(parsed.combatants).toHaveLength(2);
    // No character spawns in this fixture, so the default must fill in
    // rather than leaving the field missing or undefined.
    expect(parsed.characters).toEqual([]);
  });

  it("rejects a combatant with a non-positive maxHp", () => {
    expect(() =>
      EncounterCatalogue.parse({ ...catalogue, combatants: [{ ...hero, maxHp: 0 }] }),
    ).toThrow();
  });

  it("rejects a combatant with an unknown faction", () => {
    expect(() =>
      EncounterCatalogue.parse({ ...catalogue, combatants: [{ ...hero, faction: "wildling" }] }),
    ).toThrow();
  });

  it("rejects a combatant with an empty nameHebrew", () => {
    expect(() =>
      EncounterCatalogue.parse({ ...catalogue, combatants: [{ ...hero, nameHebrew: "" }] }),
    ).toThrow();
  });

  it("rejects a combatant missing nameHebrew entirely", () => {
    // Distinct from the empty-string case above: `.min(1)` rejects a
    // present-but-empty value either way, required or optional, so only an
    // omitted key exercises whether the field is actually required. Built as
    // a fresh literal rather than a destructuring-omit of `hero`, which would
    // leave an unused `nameHebrew` binding behind.
    const combatantWithoutNameHebrew = {
      combatantId: hero.combatantId,
      nameEnglish: hero.nameEnglish,
      maxHp: hero.maxHp,
      faction: hero.faction,
    };
    expect(() =>
      EncounterCatalogue.parse({ ...catalogue, combatants: [combatantWithoutNameHebrew] }),
    ).toThrow();
  });

  it("rejects an action with an empty nameHebrew", () => {
    expect(() =>
      EncounterCatalogue.parse({
        ...catalogue,
        actions: [{ actionId: "spear", nameEnglish: "Spear", nameHebrew: "" }],
      }),
    ).toThrow();
  });

  it("rejects an action missing nameHebrew entirely", () => {
    // Mirrors "rejects a combatant missing nameHebrew entirely" above: a
    // fresh literal, not a destructuring-omit, so no unused binding is left
    // behind.
    const actionWithoutNameHebrew = { actionId: "spear", nameEnglish: "Spear" };
    expect(() =>
      EncounterCatalogue.parse({ ...catalogue, actions: [actionWithoutNameHebrew] }),
    ).toThrow();
  });
});

describe("CampaignCreated", () => {
  it("parses a valid POST /campaigns response", () => {
    const parsed = CampaignCreated.parse({ campaignId: "s1" });
    expect(parsed.campaignId).toBe("s1");
  });

  it("rejects a response missing campaignId", () => {
    expect(() => CampaignCreated.parse({})).toThrow();
  });
});

describe("CampaignState", () => {
  it("requires the fields a projection is folded into", () => {
    const state = CampaignState.parse({
      campaignId: "s1",
      rootSeed: 7,
      encounterId: "goblin-ambush",
      grid: { width: 1, height: 1, tiles: [["normal"]] },
      combatants: [],
      turnOrder: [],
      currentActorIndex: 0,
      round: 1,
      appliedClientMessageIds: [],
    });
    expect(state.round).toBe(1);
  });
});
