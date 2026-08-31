import { describe, expect, it } from "vitest";
import { conclusionOf } from "./conclusion.js";
import { Combatant } from "./world.js";
import type { EncounterState } from "./protocol.js";

function rawCombatant(
  overrides: Record<string, unknown> & { combatantId: string },
): Record<string, unknown> {
  return {
    faction: "hostile",
    position: [0, 0],
    size: "medium",
    speedFeet: 30,
    reachFeet: 5,
    maxHp: 10,
    currentHp: 10,
    tempHp: 0,
    armorClass: 12,
    conditions: [],
    exhaustionLevel: 0,
    attacksPerAction: 1,
    spellSlots: {},
    actionEconomy: {
      actionUsed: false,
      bonusActionUsed: false,
      reactionUsed: false,
      movementUsedFeet: 0,
      attacksMade: 0,
    },
    status: "alive",
    ...overrides,
  };
}

function stateWith(raw: Record<string, unknown>[]): EncounterState {
  const combatants = Combatant.array().parse(raw);
  return {
    encounterId: "goblin-ambush",
    grid: { width: 1, height: 1, tiles: [["normal"]] },
    combatants,
    turnOrder: combatants.map((each) => each.combatantId),
    currentActorIndex: 0,
    round: 1,
  };
}

describe("conclusionOf", () => {
  it("is ongoing while both factions have someone alive", () => {
    expect(
      conclusionOf(
        stateWith([
          rawCombatant({ combatantId: "hero", faction: "party" }),
          rawCombatant({ combatantId: "goblin", faction: "hostile" }),
        ]),
      ),
    ).toBe("ongoing");
  });

  it("is victory when only the party is left standing", () => {
    expect(
      conclusionOf(
        stateWith([
          rawCombatant({ combatantId: "hero", faction: "party" }),
          rawCombatant({ combatantId: "goblin", faction: "hostile", status: "dead", currentHp: 0 }),
        ]),
      ),
    ).toBe("victory");
  });

  it("is defeat when only hostiles are left standing", () => {
    expect(
      conclusionOf(
        stateWith([
          rawCombatant({ combatantId: "hero", faction: "party", status: "dead", currentHp: 0 }),
          rawCombatant({ combatantId: "goblin", faction: "hostile" }),
        ]),
      ),
    ).toBe("defeat");
  });

  it("is defeat when nobody is left standing on a board that had combatants", () => {
    expect(
      conclusionOf(
        stateWith([
          rawCombatant({ combatantId: "hero", faction: "party", status: "dead", currentHp: 0 }),
          rawCombatant({ combatantId: "goblin", faction: "hostile", status: "dead", currentHp: 0 }),
        ]),
      ),
    ).toBe("defeat");
  });

  it("is ongoing on an empty board — not started, not finished", () => {
    expect(conclusionOf(stateWith([]))).toBe("ongoing");
  });

  it("stays ongoing while a party member's death save is still pending, even with no hostile left", () => {
    expect(
      conclusionOf(
        stateWith([
          rawCombatant({
            combatantId: "hero",
            faction: "party",
            status: "unconscious",
            currentHp: 0,
          }),
          rawCombatant({ combatantId: "goblin", faction: "hostile", status: "dead", currentHp: 0 }),
        ]),
      ),
    ).toBe("ongoing");
  });

  it("is victory when the only party member is unconscious but Stable, and no hostile is left", () => {
    expect(
      conclusionOf(
        stateWith([
          rawCombatant({
            combatantId: "hero",
            faction: "party",
            status: "unconscious",
            currentHp: 0,
            deathSaves: { successes: 3, failures: 1 },
          }),
          rawCombatant({ combatantId: "goblin", faction: "hostile", status: "dead", currentHp: 0 }),
        ]),
      ),
    ).toBe("victory");
  });

  it("is a stalemate when the hero is Stable but a hostile is still up — nothing can end it from here", () => {
    expect(
      conclusionOf(
        stateWith([
          rawCombatant({
            combatantId: "hero",
            faction: "party",
            status: "unconscious",
            currentHp: 0,
            deathSaves: { successes: 3, failures: 0 },
          }),
          rawCombatant({ combatantId: "goblin", faction: "hostile" }),
        ]),
      ),
    ).toBe("stalemate");
  });

  it("stays ongoing when one party member is Stable but another can still act", () => {
    expect(
      conclusionOf(
        stateWith([
          rawCombatant({
            combatantId: "hero",
            faction: "party",
            status: "unconscious",
            currentHp: 0,
            deathSaves: { successes: 3, failures: 0 },
          }),
          rawCombatant({ combatantId: "ally", faction: "party" }),
          rawCombatant({ combatantId: "goblin", faction: "hostile" }),
        ]),
      ),
    ).toBe("ongoing");
  });

  it("is defeat once the hero's status has resolved to dead", () => {
    expect(
      conclusionOf(
        stateWith([
          rawCombatant({ combatantId: "hero", faction: "party", status: "dead", currentHp: 0 }),
          rawCombatant({ combatantId: "goblin", faction: "hostile", status: "dead", currentHp: 0 }),
        ]),
      ),
    ).toBe("defeat");
  });
});
