import { describe, expect, it } from "vitest";
import { zodToJsonSchema } from "zod-to-json-schema";
import { CharacterSheet, ExecuteTurn, GameEvent, GridMap } from "./index.js";

const validSheet = {
  characterId: "pc-1",
  nameHebrew: "אלרון",
  grammaticalGender: "masculine",
  class: "fighter",
  level: 3,
  proficiencyBonus: 2,
  abilities: { str: 16, dex: 12, con: 14, int: 10, wis: 11, cha: 8 },
  savingThrowProficiencies: ["str", "con"],
  skillProficiencies: ["athletics", "intimidation"],
  combat: {
    maxHp: 28,
    currentHp: 28,
    armorClass: 16,
    speedFeet: 30,
    initiativeModifier: 1,
    deathSaves: { successes: 0, failures: 0 },
    spellSlots: {},
  },
  conditions: [{ condition: "prone", durationRounds: null }],
  inventory: [{ itemId: "longsword", quantity: 1 }],
};

describe("CharacterSheet", () => {
  it("parses a valid fixture and defaults tempHp", () => {
    const parsed = CharacterSheet.parse(validSheet);
    expect(parsed.combat.tempHp).toBe(0);
    expect(parsed.nameHebrew).toBe("אלרון");
  });

  it("rejects an ability score outside 1..30", () => {
    const bad = { ...validSheet, abilities: { ...validSheet.abilities, str: 31 } };
    expect(() => CharacterSheet.parse(bad)).toThrow();
  });

  it("rejects a speed that is not a multiple of 5", () => {
    const bad = { ...validSheet, combat: { ...validSheet.combat, speedFeet: 32 } };
    expect(() => CharacterSheet.parse(bad)).toThrow();
  });

  it("rejects an unknown condition", () => {
    const bad = { ...validSheet, conditions: [{ condition: "cursed", durationRounds: 1 }] };
    expect(() => CharacterSheet.parse(bad)).toThrow();
  });
});

describe("ExecuteTurn", () => {
  it("parses a move-and-attack proposal", () => {
    const turn = ExecuteTurn.parse({
      actorId: "pc-1",
      movement: [{ destinationTile: [4, 7], pathType: "flank" }],
      mainAction: { actionType: "attack", actionId: "longsword", targetIds: ["gob-2"] },
      tacticalRationaleEnglish: "Flank to deny cover, then strike the wounded goblin.",
    });
    expect(turn.movement?.[0]?.destinationTile).toStrictEqual([4, 7]);
  });

  it("requires an English rationale", () => {
    expect(() =>
      ExecuteTurn.parse({
        actorId: "pc-1",
        mainAction: { actionType: "dodge" },
      }),
    ).toThrow();
  });

  it("rejects a spell slot above level 9", () => {
    expect(() =>
      ExecuteTurn.parse({
        actorId: "pc-1",
        mainAction: { actionType: "cast_spell", actionId: "fireball", slotLevel: 10 },
        tacticalRationaleEnglish: "Overchannel.",
      }),
    ).toThrow();
  });

  it("exports a JSON schema usable as an LLM tool definition", () => {
    const jsonSchema = zodToJsonSchema(ExecuteTurn, "ExecuteTurn");
    expect(jsonSchema).toHaveProperty("$ref", "#/definitions/ExecuteTurn");
    expect(JSON.stringify(jsonSchema)).toContain("tacticalRationaleEnglish");
  });
});

describe("GameEvent", () => {
  it("parses a well-formed log entry", () => {
    const event = GameEvent.parse({
      eventId: "3f1a1c40-0f3e-4a1b-9d1e-2c9a7b6d5e4f",
      sessionId: "sess-1",
      sequence: 0,
      timestamp: "2026-08-17T09:00:00.000Z",
      type: "dice_rolled",
      payload: { notation: "1d20+5", total: 18 },
    });
    expect(event.sequence).toBe(0);
  });

  it("rejects a non-uuid eventId", () => {
    expect(() =>
      GameEvent.parse({
        eventId: "not-a-uuid",
        sessionId: "sess-1",
        sequence: 0,
        timestamp: "2026-08-17T09:00:00.000Z",
        type: "dice_rolled",
        payload: {},
      }),
    ).toThrow();
  });
});

describe("GridMap", () => {
  it("parses a small terrain matrix", () => {
    const map = GridMap.parse({
      width: 2,
      height: 2,
      tiles: [
        ["normal", "difficult"],
        ["blocking", "half_cover"],
      ],
    });
    expect(map.tiles[1]?.[0]).toBe("blocking");
  });
});
