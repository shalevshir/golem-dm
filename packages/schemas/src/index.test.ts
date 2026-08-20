import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  ActionRejectedPayload,
  ActionValidatedPayload,
  AttackOutcome,
  AttackRollTrace,
  AttackTrace,
  CharacterSheet,
  Combatant,
  DamageRollTrace,
  DiceRolledPayload,
  ExecuteTurn,
  GameEvent,
  GridMap,
} from "./index.js";

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

const validCombatant = {
  combatantId: "gob-2",
  faction: "hostile",
  position: [4, 7],
  speedFeet: 30,
  maxHp: 7,
  currentHp: 7,
  armorClass: 15,
};

describe("Combatant", () => {
  it("parses a minimal fixture and defaults the optional state", () => {
    const parsed = Combatant.parse(validCombatant);
    expect(parsed.position).toStrictEqual([4, 7]);
    expect(parsed.tempHp).toBe(0);
    expect(parsed.reachFeet).toBe(5);
    expect(parsed.exhaustionLevel).toBe(0);
    expect(parsed.attacksPerAction).toBe(1);
    expect(parsed.size).toBe("medium");
    expect(parsed.conditions).toStrictEqual([]);
    expect(parsed.spellSlots).toStrictEqual({});
    expect(parsed.status).toBe("alive");
  });

  it("defaults an untouched action economy to nothing spent", () => {
    expect(Combatant.parse(validCombatant).actionEconomy).toStrictEqual({
      actionUsed: false,
      bonusActionUsed: false,
      reactionUsed: false,
      movementUsedFeet: 0,
      attacksMade: 0,
    });
  });

  it("parses a fully specified combatant", () => {
    const parsed = Combatant.parse({
      ...validCombatant,
      characterId: "pc-1",
      faction: "party",
      reachFeet: 10,
      tempHp: 4,
      conditions: [{ condition: "restrained", durationRounds: 2 }],
      exhaustionLevel: 2,
      attacksPerAction: 2,
      spellSlots: { "1": { max: 4, current: 3 } },
      actionEconomy: { actionUsed: true, movementUsedFeet: 15 },
      status: "alive",
    });
    expect(parsed.conditions[0]?.condition).toBe("restrained");
    expect(parsed.spellSlots["1"]?.current).toBe(3);
    expect(parsed.actionEconomy.actionUsed).toBe(true);
    expect(parsed.actionEconomy.bonusActionUsed).toBe(false);
  });

  it("rejects a speed that is not a multiple of 5", () => {
    expect(() => Combatant.parse({ ...validCombatant, speedFeet: 32 })).toThrow(ZodError);
  });

  it("rejects an exhaustion level above the 2024 six-level track", () => {
    expect(() => Combatant.parse({ ...validCombatant, exhaustionLevel: 7 })).toThrow(ZodError);
  });

  it("rejects an unknown condition", () => {
    const bad = { ...validCombatant, conditions: [{ condition: "cursed", durationRounds: 1 }] };
    expect(() => Combatant.parse(bad)).toThrow(ZodError);
  });

  it("rejects a fractional grid position", () => {
    expect(() => Combatant.parse({ ...validCombatant, position: [1.5, 2] })).toThrow(ZodError);
  });

  it("rejects an unknown faction", () => {
    expect(() => Combatant.parse({ ...validCombatant, faction: "chaotic" })).toThrow(ZodError);
  });

  it.each(["tiny", "small", "medium", "large", "huge", "gargantuan"] as const)(
    "parses the %s creature size",
    (size) => {
      expect(Combatant.parse({ ...validCombatant, size }).size).toBe(size);
    },
  );

  it("rejects a size outside the SRD table", () => {
    expect(() => Combatant.parse({ ...validCombatant, size: "colossal" })).toThrow(ZodError);
  });

  it("exports a JSON schema usable as an LLM tool definition", () => {
    const jsonSchema = zodToJsonSchema(Combatant, "Combatant");
    expect(jsonSchema).toHaveProperty("$ref", "#/definitions/Combatant");
    expect(JSON.stringify(jsonSchema)).toContain("actionEconomy");
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

describe("ActionRejectedPayload", () => {
  it("parses an engine rejection with its machine-readable reasons", () => {
    const payload = ActionRejectedPayload.parse({
      actorId: "gob-1",
      attempt: 1,
      stage: "engine",
      reasons: ["target_out_of_reach"],
      messages: ["pc-1 is 30 ft away, beyond the 5 ft reach of this action"],
      provider: "google",
      modelId: "gemini-3-flash",
    });

    expect(payload.reasons).toStrictEqual(["target_out_of_reach"]);
    expect(payload.stage).toBe("engine");
  });

  it("parses an adapter rejection, which has a code instead of reasons", () => {
    const payload = ActionRejectedPayload.parse({
      actorId: "gob-1",
      attempt: 2,
      stage: "adapter",
      adapterErrorCode: "no_tool_call",
      messages: ["The model answered in prose."],
      provider: "google",
      modelId: "gemini-3-flash",
    });

    expect(payload.adapterErrorCode).toBe("no_tool_call");
    expect(payload.reasons).toBeUndefined();
  });

  it("rejects a third attempt, because the loop only ever makes two", () => {
    const result = ActionRejectedPayload.safeParse({
      actorId: "gob-1",
      attempt: 3,
      stage: "engine",
      messages: [],
      provider: "google",
      modelId: "gemini-3-flash",
    });

    if (result.success) throw new Error("expected the parse to fail");
    expect(result.error.issues[0]?.path).toStrictEqual(["attempt"]);
  });
});

describe("AttackOutcome", () => {
  it("is a closed enum of the four outcomes", () => {
    expect(AttackOutcome.options).toStrictEqual(["hit", "miss", "critical_hit", "critical_miss"]);
  });
});

describe("AttackRollTrace", () => {
  it("rejects a naturalRoll outside 1-20", () => {
    const result = AttackRollTrace.safeParse({
      naturalRoll: 21,
      rolls: [21],
      total: 25,
      targetArmorClass: 15,
    });

    if (result.success) throw new Error("expected the parse to fail");
    expect(result.error.issues[0]?.path).toStrictEqual(["naturalRoll"]);
  });
});

describe("DamageRollTrace", () => {
  it("rejects an unknown kind", () => {
    const result = DamageRollTrace.safeParse({ kind: "average", total: 1 });

    if (result.success) throw new Error("expected the parse to fail");
    expect(result.error.issues[0]?.path).toStrictEqual(["kind"]);
  });
});

describe("AttackTrace", () => {
  it("parses a hit with a single damage roll", () => {
    const trace = AttackTrace.parse({
      attackerId: "goblin-a",
      targetId: "hero",
      actionId: "scimitar",
      outcome: "hit",
      damage: 6,
      targetStatusAfter: "alive",
      attackRoll: { naturalRoll: 18, rolls: [18], total: 22, targetArmorClass: 16 },
      damageRolls: [{ kind: "dice", notation: "1d6+2", rolls: [4], modifier: 2, total: 6 }],
    });

    expect(trace.outcome).toBe("hit");
    expect(trace.damageRolls).toHaveLength(1);
  });

  it("parses a miss with an empty damageRolls array", () => {
    const trace = AttackTrace.parse({
      attackerId: "goblin-a",
      targetId: "hero",
      actionId: "scimitar",
      outcome: "miss",
      damage: 0,
      targetStatusAfter: "alive",
      attackRoll: { naturalRoll: 3, rolls: [3], total: 7, targetArmorClass: 16 },
      damageRolls: [],
    });

    expect(trace.damageRolls).toEqual([]);
  });

  it("parses flat (non-dice) damage", () => {
    const trace = AttackTrace.parse({
      attackerId: "cultist",
      targetId: "hero",
      actionId: "dagger",
      outcome: "hit",
      damage: 1,
      targetStatusAfter: "alive",
      attackRoll: { naturalRoll: 15, rolls: [15], total: 18, targetArmorClass: 12 },
      damageRolls: [{ kind: "flat", total: 1 }],
    });

    expect(trace.damageRolls).toEqual([{ kind: "flat", total: 1 }]);
  });

  it("rejects an outcome outside the closed AttackOutcome enum", () => {
    const result = AttackTrace.safeParse({
      attackerId: "goblin-a",
      targetId: "hero",
      actionId: "scimitar",
      outcome: "grazed", // not a real AttackOutcome
      damage: 0,
      targetStatusAfter: "alive",
      attackRoll: { naturalRoll: 3, rolls: [3], total: 7, targetArmorClass: 16 },
      damageRolls: [],
    });

    if (result.success) throw new Error("expected the parse to fail");
    expect(result.error.issues[0]?.path).toStrictEqual(["outcome"]);
  });
});

describe("DiceRolledPayload", () => {
  it("parses a turn with one attack and movement", () => {
    const payload = DiceRolledPayload.parse({
      actorId: "goblin-a",
      movedFeet: 10,
      seed: 42,
      attacks: [
        {
          attackerId: "goblin-a",
          targetId: "hero",
          actionId: "scimitar",
          outcome: "critical_hit",
          damage: 10,
          targetStatusAfter: "alive",
          attackRoll: { naturalRoll: 20, rolls: [20], total: 24, targetArmorClass: 16 },
          damageRolls: [{ kind: "dice", notation: "1d6+2", rolls: [4, 4], modifier: 2, total: 10 }],
        },
      ],
    });

    expect(payload.movedFeet).toBe(10);
    expect(payload.attacks[0]?.outcome).toBe("critical_hit");
  });

  it("parses a turn with no attacks, movement only", () => {
    const payload = DiceRolledPayload.parse({
      actorId: "hero",
      movedFeet: 15,
      seed: 7,
      attacks: [],
    });
    expect(payload.attacks).toEqual([]);
  });

  it("rejects a payload missing movedFeet, the pre-migration shape", () => {
    // A `dice_rolled` event persisted before this feature shipped has no
    // `movedFeet` field at all. The web client must treat this as a parse
    // failure (see store.ts's defensive handling in Task 5), not a crash —
    // this test only pins that the schema itself is strict about it.
    const result = DiceRolledPayload.safeParse({ actorId: "hero", attacks: [] });
    if (result.success) throw new Error("expected the parse to fail");
    expect(result.error.issues[0]?.path).toStrictEqual(["movedFeet"]);
  });

  it("rejects a negative movedFeet", () => {
    const result = DiceRolledPayload.safeParse({ actorId: "hero", movedFeet: -5, attacks: [] });
    if (result.success) throw new Error("expected the parse to fail");
    expect(result.error.issues[0]?.path).toStrictEqual(["movedFeet"]);
  });
});

describe("ActionValidatedPayload", () => {
  it("parses actorId, a full ExecuteTurn, and source", () => {
    const payload = ActionValidatedPayload.parse({
      actorId: "hero",
      turn: {
        actorId: "hero",
        mainAction: { actionType: "dodge" },
        tacticalRationaleEnglish: "Test fixture.",
      },
      source: "human",
    });

    expect(payload.turn.mainAction.actionType).toBe("dodge");
    expect(payload.source).toBe("human");
  });
});
