import { describe, expect, it } from "vitest";
import { Combatant, GridMap } from "@ai-dm/schemas";
import { buildScenario } from "./build.js";
import { ALL_SCENARIO_IDS, SCENARIOS, scenarioById } from "./index.js";

describe("scenario registry", () => {
  it("registers four fixtures under matching ids", () => {
    expect(ALL_SCENARIO_IDS).toEqual([
      "melee-brawl",
      "ranged-approach",
      "cover-corridor",
      "ogre-charge",
    ]);
    for (const id of ALL_SCENARIO_IDS) {
      expect(scenarioById(id).scenarioId).toBe(id);
    }
  });

  it("throws on an unknown id rather than returning undefined", () => {
    expect(() => scenarioById("no-such-scenario")).toThrow("no-such-scenario");
  });

  it.each([...SCENARIOS.keys()])("%s builds into a schema-valid world", (id) => {
    const built = buildScenario(scenarioById(id));
    expect(() => GridMap.parse(built.world.grid)).not.toThrow();
    for (const combatant of built.world.combatants) {
      expect(() => Combatant.parse(combatant)).not.toThrow();
    }
  });

  it.each([...SCENARIOS.keys()])("%s gives every offered action a range", (id) => {
    const built = buildScenario(scenarioById(id));
    for (const actions of built.availableActions.values()) {
      for (const action of actions) {
        expect(built.world.actionRangesFeet?.[action.actionId]).toBeGreaterThan(0);
      }
    }
  });

  it.each([...SCENARIOS.keys()])("%s starts with both factions present and alive", (id) => {
    const built = buildScenario(scenarioById(id));
    const factions = new Set(built.world.combatants.map((each) => each.faction));
    expect(factions.has("hostile")).toBe(true);
    expect(factions.has("party")).toBe(true);
    expect(built.world.combatants.every((each) => each.status === "alive")).toBe(true);
  });

  it.each([...SCENARIOS.keys()])("%s spawns no two combatants on one tile", (id) => {
    const built = buildScenario(scenarioById(id));
    const tiles = built.world.combatants.map((each) => each.position.join(","));
    expect(new Set(tiles).size).toBe(tiles.length);
  });
});
