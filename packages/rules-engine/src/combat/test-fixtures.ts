// Test scaffolding shared by the combat specs. Not part of the package API —
// deliberately absent from ./index.ts.
import type { Combatant, GridMap, TerrainType } from "@ai-dm/schemas";

const BASE: Combatant = {
  combatantId: "unnamed",
  faction: "hostile",
  position: [0, 0],
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
};

export function combatant(overrides: Partial<Combatant> & { combatantId: string }): Combatant {
  return { ...BASE, ...overrides };
}

/**
 * Builds a grid from ASCII art so the fixtures stay readable.
 * `.` normal · `~` difficult · `#` blocking · `h` half cover · `q` three-quarters cover
 */
const LEGEND: Record<string, TerrainType | undefined> = {
  ".": "normal",
  "~": "difficult",
  "#": "blocking",
  h: "half_cover",
  q: "three_quarters_cover",
};

export function parseGrid(art: string): GridMap {
  const rows = art
    .trim()
    .split("\n")
    .map((row) => row.trim());

  const tiles = rows.map((row) =>
    Array.from(row, (char) => {
      const terrain = LEGEND[char];
      if (terrain === undefined) throw new Error(`Unknown terrain char: ${char}`);
      return terrain;
    }),
  );

  return { width: tiles[0]?.length ?? 0, height: tiles.length, tiles };
}
