// The floor: everyone starts in or near reach on open ground. A model that
// cannot score here has a problem with the tool schema, not with geometry.
import type { ScenarioDefinition } from "./types.js";

export const MELEE_BRAWL: ScenarioDefinition = {
  scenarioId: "melee-brawl",
  descriptionEnglish:
    "Two goblin warriors meet two guards at close quarters on an empty 12x12 field. " +
    "Baseline legality with no spatial reasoning required.",
  sceneEnglish: "A featureless benchmark arena. No terrain features worth describing.",
  width: 12,
  height: 12,
  spawns: [
    { combatantId: "goblin_1", monsterId: "goblin_warrior", faction: "hostile", position: [4, 5] },
    { combatantId: "goblin_2", monsterId: "goblin_warrior", faction: "hostile", position: [4, 7] },
    { combatantId: "guard_1", monsterId: "guard", faction: "party", position: [5, 5] },
    { combatantId: "guard_2", monsterId: "guard", faction: "party", position: [5, 7] },
  ],
  turnOrder: ["goblin_1", "guard_1", "goblin_2", "guard_2"],
  maxRounds: 15,
};
