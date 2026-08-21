import { describe, expect, it } from "vitest";
import type { Combatant, Condition, CreatureStatBlock } from "@ai-dm/schemas";
import type { TurnEffect } from "@ai-dm/rules-engine";
import { buildNarrationBrief, healthBandFor, severityFor } from "./brief.js";

const GOBLIN: CreatureStatBlock = {
  nameEnglish: "Goblin Warrior",
  nameHebrew: "גובלין לוחם",
  grammaticalGender: "masculine",
  size: "small",
  armorClass: 13,
  hitPoints: { average: 8, diceNotation: "2d6+1" },
  speedFeet: 30,
  attacksPerAction: 1,
  actions: [
    {
      actionId: "scimitar",
      nameEnglish: "Scimitar",
      nameHebrew: "חרב מעוקלת",
      attackBonus: 4,
      reachFeet: 5,
      damage: { diceNotation: "1d6+2", averageDamage: 5, damageType: "slashing" },
      extraDamage: [],
    },
  ],
};

const HERO: CreatureStatBlock = { ...GOBLIN, nameEnglish: "hero", nameHebrew: "אלדד", hitPoints: { average: 28, diceNotation: "3d10+6" } };

function combatant(overrides: Partial<Combatant> & Pick<Combatant, "combatantId">): Combatant {
  return {
    faction: "hostile", position: [0, 0], size: "medium", speedFeet: 30, reachFeet: 5,
    maxHp: 8, currentHp: 8, tempHp: 0, armorClass: 13, conditions: [], exhaustionLevel: 0,
    attacksPerAction: 1, spellSlots: {},
    actionEconomy: { actionUsed: false, bonusActionUsed: false, reactionUsed: false, movementUsedFeet: 0, attacksMade: 0 },
    status: "alive", ...overrides,
  };
}

const EMPTY_EFFECT: TurnEffect = {
  attacks: [], damageDealt: 0, killed: [], movedFeet: 0,
  nonAttackAction: false, unresolvedActionIds: [],
};

const CONDITION_NAMES = new Map<Condition, string>([["prone", "שרוע"]]);

function briefInput(effect: TurnEffect, combatants: Combatant[]) {
  return {
    actorId: "hero",
    effect,
    combatants,
    statBlocks: new Map<string, CreatureStatBlock>([["hero", HERO], ["goblin-a", GOBLIN]]),
    conditionNamesHebrew: CONDITION_NAMES,
    sceneEnglish: "A dry hillside track.",
    recentNarrations: [],
  };
}

describe("severityFor", () => {
  it("bands by status before it bands by damage", () => {
    expect(severityFor(1, 100, "dead")).toBe("felling");
    expect(severityFor(1, 100, "unconscious")).toBe("felling");
    // "fled" is a legal member of the full status union `severityFor` takes,
    // even though no attack beat actually produces it (see `narrowStatus`).
    // It must NOT be read as a takedown the way "dead"/"unconscious" are.
    expect(severityFor(1, 100, "fled")).toBe("graze");
  });

  it("bands a surviving target at the quarter and half thresholds", () => {
    expect(severityFor(1, 8, "alive")).toBe("graze");
    expect(severityFor(2, 8, "alive")).toBe("solid");
    expect(severityFor(3, 8, "alive")).toBe("solid");
    expect(severityFor(4, 8, "alive")).toBe("severe");
  });

  it("bands a hit that dealt zero as a graze, never as a miss", () => {
    expect(severityFor(0, 8, "alive")).toBe("graze");
  });
});

describe("healthBandFor", () => {
  it("calls half bloodied and a quarter critical", () => {
    expect(healthBandFor(28, 28)).toBe("healthy");
    expect(healthBandFor(15, 28)).toBe("healthy");
    expect(healthBandFor(14, 28)).toBe("bloodied");
    expect(healthBandFor(8, 28)).toBe("bloodied");
    expect(healthBandFor(7, 28)).toBe("critical");
  });
});

describe("buildNarrationBrief", () => {
  it("names the actor in Hebrew with its grammatical gender", () => {
    const brief = buildNarrationBrief(briefInput(EMPTY_EFFECT, [combatant({ combatantId: "hero", faction: "party", maxHp: 28, currentHp: 28 })]));
    expect(brief.actor).toEqual({ nameHebrew: "אלדד", gender: "masculine", conditionsHebrew: [] });
    expect(brief.actorSide).toBe("party");
  });

  it("emits a hold beat for a turn that did nothing", () => {
    const brief = buildNarrationBrief(briefInput(EMPTY_EFFECT, [combatant({ combatantId: "hero", faction: "party" })]));
    expect(brief.beats).toEqual([{ kind: "hold" }]);
  });

  it("puts movement before the swings", () => {
    const effect: TurnEffect = {
      ...EMPTY_EFFECT,
      movedFeet: 10,
      attacks: [{
        attackerId: "hero", targetId: "goblin-a", actionId: "scimitar", outcome: "hit",
        damage: 4, targetStatusAfter: "alive",
        attackRoll: { naturalRoll: 15, rolls: [15], total: 20, targetArmorClass: 13 },
        damageRolls: [],
      }],
    };
    const brief = buildNarrationBrief(briefInput(effect, [
      combatant({ combatantId: "hero", faction: "party" }),
      combatant({ combatantId: "goblin-a" }),
    ]));
    expect(brief.beats[0]).toEqual({ kind: "move", feet: 10 });
    expect(brief.beats[1]).toMatchObject({ kind: "attack", actionNameHebrew: "חרב מעוקלת", severity: "severe" });
  });

  it("omits severity on a miss", () => {
    const effect: TurnEffect = {
      ...EMPTY_EFFECT,
      attacks: [{
        attackerId: "hero", targetId: "goblin-a", actionId: "scimitar", outcome: "miss",
        damage: 0, targetStatusAfter: "alive",
        attackRoll: { naturalRoll: 3, rolls: [3], total: 8, targetArmorClass: 13 },
        damageRolls: [],
      }],
    };
    const [beat] = buildNarrationBrief(briefInput(effect, [
      combatant({ combatantId: "hero", faction: "party" }),
      combatant({ combatantId: "goblin-a" }),
    ])).beats;
    expect(beat).not.toHaveProperty("severity");
  });

  it("keeps severity on a hit that dealt zero damage — landed is by outcome, not by damage", () => {
    const effect: TurnEffect = {
      ...EMPTY_EFFECT,
      attacks: [{
        attackerId: "hero", targetId: "goblin-a", actionId: "scimitar", outcome: "hit",
        damage: 0, targetStatusAfter: "alive",
        attackRoll: { naturalRoll: 15, rolls: [15], total: 20, targetArmorClass: 13 },
        damageRolls: [],
      }],
    };
    const [beat] = buildNarrationBrief(briefInput(effect, [
      combatant({ combatantId: "hero", faction: "party" }),
      combatant({ combatantId: "goblin-a" }),
    ])).beats;
    expect(beat).toMatchObject({ kind: "attack", outcome: "hit", severity: "graze" });
  });

  it("keeps severity and the outcome label on a critical hit", () => {
    const effect: TurnEffect = {
      ...EMPTY_EFFECT,
      attacks: [{
        attackerId: "hero", targetId: "goblin-a", actionId: "scimitar", outcome: "critical_hit",
        damage: 6, targetStatusAfter: "alive",
        attackRoll: { naturalRoll: 20, rolls: [20], total: 25, targetArmorClass: 13 },
        damageRolls: [],
      }],
    };
    const [beat] = buildNarrationBrief(briefInput(effect, [
      combatant({ combatantId: "hero", faction: "party" }),
      combatant({ combatantId: "goblin-a" }),
    ])).beats;
    expect(beat).toMatchObject({ kind: "attack", outcome: "critical_hit", severity: "severe" });
  });

  it("labels a target's conditions in Hebrew from the supplied map", () => {
    const effect: TurnEffect = {
      ...EMPTY_EFFECT,
      attacks: [{
        attackerId: "hero", targetId: "goblin-a", actionId: "scimitar", outcome: "hit",
        damage: 1, targetStatusAfter: "alive",
        attackRoll: { naturalRoll: 15, rolls: [15], total: 20, targetArmorClass: 13 },
        damageRolls: [],
      }],
    };
    const [beat] = buildNarrationBrief(briefInput(effect, [
      combatant({ combatantId: "hero", faction: "party" }),
      combatant({ combatantId: "goblin-a", conditions: [{ condition: "prone", durationRounds: null }] }),
    ])).beats;
    expect(beat).toMatchObject({ kind: "attack", target: { conditionsHebrew: ["שרוע"] } });
  });

  it("counts only living hostiles in the pulse and bands the party member", () => {
    const brief = buildNarrationBrief(briefInput(EMPTY_EFFECT, [
      combatant({ combatantId: "hero", faction: "party", maxHp: 28, currentHp: 10 }),
      combatant({ combatantId: "goblin-a" }),
      combatant({ combatantId: "goblin-b", status: "dead", currentHp: 0 }),
    ]));
    expect(brief.pulse).toEqual({ hostilesStanding: 1, heroBand: "bloodied" });
  });
});
