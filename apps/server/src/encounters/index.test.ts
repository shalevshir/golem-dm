import { describe, expect, it } from "vitest";
import type { ExecuteTurn } from "@ai-dm/schemas";
import { validateExecuteTurn } from "@ai-dm/rules-engine";
import { buildEncounterById, encounterById, UnknownEncounterError } from "./index.js";

describe("encounter catalogue", () => {
  it("knows the starter encounter", () => {
    expect(encounterById("goblin-ambush").encounterId).toBe("goblin-ambush");
  });

  it("throws a named, instanceof-able error for an unknown id", () => {
    expect(() => encounterById("nope")).toThrow(/Unknown encounter nope/);
    expect(() => encounterById("nope")).toThrow(UnknownEncounterError);
  });

  it("builds a world from real SRD stat blocks", () => {
    const built = buildEncounterById("goblin-ambush");
    expect(built.world.combatants.length).toBeGreaterThan(1);
    expect(built.turnOrder).toEqual(built.world.combatants.map((each) => each.combatantId));
    for (const combatant of built.world.combatants) {
      expect(built.statBlocks.get(combatant.combatantId)).toBeDefined();
    }
  });

  it("puts the party and the hostiles on opposite sides", () => {
    const built = buildEncounterById("goblin-ambush");
    const factions = new Set(built.world.combatants.map((each) => each.faction));
    expect(factions).toEqual(new Set(["party", "hostile"]));
  });

  // C-14: the brief's original geometry (hero and goblins ~45 ft apart) makes
  // every melee proposal illegal forever. Prove the corrected geometry does
  // not have that problem by actually running a scripted melee attack through
  // the real validator, from both sides, rather than assuming the tile math
  // works out.
  it("makes a scripted melee attack from the hero legal on turn 1", () => {
    const built = buildEncounterById("goblin-ambush");
    const hero = built.world.combatants.find((each) => each.combatantId === "hero");
    if (hero === undefined) throw new Error("no hero in the built world");

    const turn: ExecuteTurn = {
      actorId: "hero",
      mainAction: { actionType: "attack", actionId: "spear", targetIds: ["goblin-a"] },
      tacticalRationaleEnglish: "Test fixture.",
    };
    const validation = validateExecuteTurn(turn, hero, built.world);

    expect(validation.valid).toBe(true);
  });

  it("makes a scripted melee attack from a goblin legal on turn 1", () => {
    const built = buildEncounterById("goblin-ambush");
    const goblinB = built.world.combatants.find((each) => each.combatantId === "goblin-b");
    if (goblinB === undefined) throw new Error("no goblin-b in the built world");

    const turn: ExecuteTurn = {
      actorId: "goblin-b",
      mainAction: { actionType: "attack", actionId: "scimitar", targetIds: ["hero"] },
      tacticalRationaleEnglish: "Test fixture.",
    };
    const validation = validateExecuteTurn(turn, goblinB, built.world);

    expect(validation.valid).toBe(true);
  });
});
