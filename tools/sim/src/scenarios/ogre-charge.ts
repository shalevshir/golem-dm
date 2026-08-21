// A Large creature (2x2 footprint, 5 ft reach) crossing difficult terrain,
// which costs double. The mud spans the full grid height so there is no way
// around it. Discriminates movement-budget arithmetic and whether the model
// accounts for a footprint bigger than one square.
import type { ScenarioDefinition, TerrainOverride } from "./types.js";

/** A band of mud spanning the full grid height; the ogre must cross it. */
const MUD: readonly TerrainOverride[] = [6, 7].flatMap((x) =>
  Array.from({ length: 12 }, (_, y): TerrainOverride => ({ tile: [x, y], terrain: "difficult" })),
);

export const OGRE_CHARGE: ScenarioDefinition = {
  scenarioId: "ogre-charge",
  descriptionEnglish:
    "One ogre crosses a band of difficult terrain to reach three guards. " +
    "Discriminates movement budgeting and large-creature footprint handling.",
  sceneEnglish: "A featureless benchmark arena. No terrain features worth describing.",
  width: 16,
  height: 12,
  terrain: MUD,
  spawns: [
    { combatantId: "ogre_1", monsterId: "ogre", faction: "hostile", position: [2, 5] },
    { combatantId: "guard_1", monsterId: "guard", faction: "party", position: [12, 4] },
    { combatantId: "guard_2", monsterId: "guard", faction: "party", position: [12, 6] },
    { combatantId: "guard_3", monsterId: "guard", faction: "party", position: [13, 5] },
  ],
  turnOrder: ["ogre_1", "guard_1", "guard_2", "guard_3"],
  maxRounds: 20,
};
