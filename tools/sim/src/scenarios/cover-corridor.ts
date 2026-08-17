// A wall of blocking terrain with a gap, and three-quarters cover either side
// of it. Targets behind the wall draw target_behind_full_cover; targets in the
// gap are legal but harder to hit. Discriminates line-of-sight reasoning.
import type { ScenarioDefinition, TerrainOverride } from "./types.js";

/** A vertical wall at x = 8, open at y = 6 so the encounter can resolve. */
const WALL: readonly TerrainOverride[] = [
  { tile: [8, 2], terrain: "blocking" },
  { tile: [8, 3], terrain: "blocking" },
  { tile: [8, 4], terrain: "blocking" },
  { tile: [8, 5], terrain: "three_quarters_cover" },
  { tile: [8, 7], terrain: "three_quarters_cover" },
  { tile: [8, 8], terrain: "blocking" },
  { tile: [8, 9], terrain: "blocking" },
  { tile: [8, 10], terrain: "blocking" },
];

export const COVER_CORRIDOR: ScenarioDefinition = {
  scenarioId: "cover-corridor",
  descriptionEnglish:
    "Wolves and guards separated by a wall with a single gap and cover at its edges. " +
    "Discriminates line-of-sight and cover-aware target selection.",
  width: 16,
  height: 13,
  terrain: WALL,
  spawns: [
    { combatantId: "wolf_1", monsterId: "wolf", faction: "hostile", position: [4, 5] },
    { combatantId: "wolf_2", monsterId: "wolf", faction: "hostile", position: [4, 7] },
    { combatantId: "guard_1", monsterId: "guard", faction: "party", position: [12, 5] },
    { combatantId: "guard_2", monsterId: "guard", faction: "party", position: [12, 7] },
  ],
  turnOrder: ["wolf_1", "guard_1", "wolf_2", "guard_2"],
  maxRounds: 20,
};
