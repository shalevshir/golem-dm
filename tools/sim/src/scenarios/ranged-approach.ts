// Goblins hold both a scimitar (5 ft reach) and a shortbow (80 ft range) and
// start well out of melee. This is the fixture `actionRangesFeet` exists for:
// a model that reaches for the scimitar at 60 ft earns target_out_of_reach,
// and one that never closes the distance wastes the turn.
import type { ScenarioDefinition } from "./types.js";

export const RANGED_APPROACH: ScenarioDefinition = {
  scenarioId: "ranged-approach",
  descriptionEnglish:
    "Two goblin warriors face two guards across 60 feet of open ground, holding a " +
    "melee and a ranged option. Discriminates action-range selection.",
  sceneEnglish: "A featureless benchmark arena. No terrain features worth describing.",
  width: 20,
  height: 12,
  spawns: [
    { combatantId: "goblin_1", monsterId: "goblin_warrior", faction: "hostile", position: [2, 5] },
    { combatantId: "goblin_2", monsterId: "goblin_warrior", faction: "hostile", position: [2, 7] },
    { combatantId: "guard_1", monsterId: "guard", faction: "party", position: [14, 5] },
    { combatantId: "guard_2", monsterId: "guard", faction: "party", position: [14, 7] },
  ],
  turnOrder: ["goblin_1", "guard_1", "goblin_2", "guard_2"],
  maxRounds: 20,
};
