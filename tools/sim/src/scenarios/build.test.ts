import { describe, expect, it } from "vitest";
import { Combatant, GridMap } from "@ai-dm/schemas";
import { buildScenario } from "./build.js";
import { MELEE_BRAWL } from "./melee-brawl.js";

describe("buildScenario", () => {
  const built = buildScenario(MELEE_BRAWL);

  it("produces a world whose grid and combatants satisfy the schemas", () => {
    expect(() => GridMap.parse(built.world.grid)).not.toThrow();
    for (const combatant of built.world.combatants) {
      expect(() => Combatant.parse(combatant)).not.toThrow();
    }
  });

  it("spawns one combatant per spawn spec, at its declared position", () => {
    expect(built.world.combatants).toHaveLength(MELEE_BRAWL.spawns.length);
    for (const spawn of MELEE_BRAWL.spawns) {
      const found = built.world.combatants.find((each) => each.combatantId === spawn.combatantId);
      expect(found?.position).toEqual(spawn.position);
      expect(found?.faction).toBe(spawn.faction);
    }
  });

  // The guard against the failure mode that would corrupt every measurement:
  // an action the model is offered but the validator cannot find a range for.
  it("gives every offered action an entry in actionRangesFeet", () => {
    for (const [combatantId, actions] of built.availableActions) {
      expect(actions.length).toBeGreaterThan(0);
      for (const action of actions) {
        expect(built.world.actionRangesFeet?.[action.actionId]).toBeGreaterThan(0);
      }
      expect(built.statBlocks.get(combatantId)).toBeDefined();
    }
  });

  it("lists a turn order naming only combatants that exist", () => {
    const ids = new Set(built.world.combatants.map((each) => each.combatantId));
    expect(built.turnOrder.length).toBe(built.world.combatants.length);
    for (const id of built.turnOrder) expect(ids.has(id)).toBe(true);
  });

  it("is pure — two builds produce equal worlds", () => {
    expect(buildScenario(MELEE_BRAWL).world).toEqual(buildScenario(MELEE_BRAWL).world);
  });
});
