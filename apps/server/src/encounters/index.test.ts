import { describe, expect, it, vi } from "vitest";
import type { ExecuteTurn } from "@ai-dm/schemas";
import { DerivedCharacter } from "@ai-dm/schemas";
import { validateExecuteTurn } from "@ai-dm/rules-engine";
import {
  buildEncounterById,
  encounterById,
  loadCharacter,
  UnknownEncounterError,
} from "./index.js";

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

  it("carries the scene card onto the built encounter", () => {
    const built = buildEncounterById("goblin-ambush");
    expect(built.sceneEnglish).toContain("hillside");
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
      // Longsword, not the borrowed guard's spear: the hero is a real
      // CharacterSheet as of Task 14 (C-13 is closed).
      mainAction: { actionType: "attack", actionId: "longsword", targetIds: ["goblin-a"] },
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

describe("the goblin-ambush hero", () => {
  it("is a real character, not a borrowed guard stat block", () => {
    const built = buildEncounterById("goblin-ambush");
    const hero = built.world.combatants.find((each) => each.combatantId === "hero");
    expect(hero?.characterId).toBe("hero");
    expect(hero?.maxHp).toBe(28);
    // Chain Mail, matching the guard's AC so C-14's reach geometry is
    // unaffected by the swap.
    expect(hero?.armorClass).toBe(16);
  });

  it("wields a longsword and can always punch", () => {
    const built = buildEncounterById("goblin-ambush");
    const actions = built.statBlocks.get("hero")?.actions.map((each) => each.actionId);
    expect(actions).toEqual(["longsword", "unarmed_strike"]);
  });

  // The "legal melee attack on turn 1" case for the hero is already covered
  // by "makes a scripted melee attack from the hero legal on turn 1" above
  // (same encounter, validator, actor and target, and the fuller C-14
  // comment on why the geometry is tested at all) — not repeated here.

  it("refuses to load a sheet whose stored values disagree with the derivation", () => {
    // Guards the cross-check being wired into loadCharacter at all, not just
    // existing in the rules engine.
    expect(() => loadCharacter("inconsistent-fixture")).toThrow(/proficiencyBonus|armorClass/);
  });
});

describe("loadCharacter", () => {
  it("parses the derivation against DerivedCharacter at the server boundary", () => {
    // No legal CharacterSheet can make `deriveCharacter`'s own output fail
    // `DerivedCharacter.parse` today — every derived field is either a
    // pass-through of an already-bounded sheet field or provably in range —
    // so this guards the wiring itself, the same way the consistency test
    // above does for `assertSheetConsistent`. "second-fixture" is used by no
    // other test, so a pass cannot be explained by an earlier test having
    // already cached "hero" through this code path.
    const parseSpy = vi.spyOn(DerivedCharacter, "parse");
    try {
      loadCharacter("second-fixture");
      expect(parseSpy).toHaveBeenCalled();
    } finally {
      parseSpy.mockRestore();
    }
  });

  it("refuses a file whose characterId disagrees with the id it was requested under", () => {
    // "mislabeled-fixture.json" is a copy of hero.json whose own
    // characterId still says "hero" — a file renamed without updating its
    // contents. Without this check it would cache under "mislabeled-fixture"
    // while everything it produces (including characterStatBlock's
    // nameEnglish) still says "hero".
    expect(() => loadCharacter("mislabeled-fixture")).toThrow(/characterId/);
  });
});
