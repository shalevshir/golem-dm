// A wall of blocking terrain spanning nearly the full height, with a
// three-quarters-cover tile immediately before the single passable gap.
// `coverBetween` only counts terrain that lies *between* attacker and target,
// and cover tiles are impassable — no creature can ever stand on one. A
// sightline traced through the wall draws target_behind_full_cover; a
// combatant who maneuvers down into the gap is on plain open ground with no
// cover at all. Discriminates line-of-sight and cover-aware target selection.
import type { ScenarioDefinition, TerrainOverride } from "./types.js";

/**
 * A vertical wall at x = 8. Blocking from y = 0..9, three-quarters cover at
 * y = 10, blocking again at y = 12. y = 11 is left unlisted (normal terrain)
 * — the one gap a creature can actually walk through.
 */
const WALL: readonly TerrainOverride[] = [
  ...Array.from({ length: 10 }, (_, y): TerrainOverride => ({ tile: [8, y], terrain: "blocking" })),
  { tile: [8, 10], terrain: "three_quarters_cover" },
  { tile: [8, 12], terrain: "blocking" },
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
