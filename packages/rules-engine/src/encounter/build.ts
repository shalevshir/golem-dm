// Turns an `EncounterDefinition` into the state the agents and the resolver
// need. Pure and total: it either produces a fully valid world or throws.
//
// Stat blocks are injected rather than loaded. This package's boundary forbids
// I/O, so whoever owns the files (`tools/sim/src/scenarios/srd.ts`,
// `apps/server/src/encounters/srd.ts`) parses them and hands them in.
import type {
  Combatant,
  Faction,
  GridMap,
  MonsterStatBlock,
  Tile,
  TerrainType,
} from "@ai-dm/schemas";
import { GridMap as GridMapSchema } from "@ai-dm/schemas";
import { actionRangesFeetFrom, combatantFromStatBlock } from "../combat/index.js";
import type { CombatWorld } from "../combat/index.js";

export interface TerrainOverride {
  tile: Tile;
  terrain: TerrainType;
}

export interface SpawnSpec {
  combatantId: string;
  /** Key into the caller's stat-block map. */
  monsterId: string;
  faction: Faction;
  position: Tile;
}

export interface EncounterDefinition {
  encounterId: string;
  /** English. Says what this encounter is. */
  descriptionEnglish: string;
  width: number;
  height: number;
  /** Sparse: every unlisted tile is "normal". */
  terrain?: readonly TerrainOverride[];
  spawns: readonly SpawnSpec[];
  /** Declared, never rolled. Initiative rolling is not implemented. */
  turnOrder: readonly string[];
  maxRounds: number;
}

export interface BuiltEncounter {
  encounterId: string;
  world: CombatWorld;
  /** By `combatantId` — the resolver needs attack bonuses, which `Combatant` lacks. */
  statBlocks: ReadonlyMap<string, MonsterStatBlock>;
  turnOrder: readonly string[];
  maxRounds: number;
}

export interface BuildEncounterInput {
  definition: EncounterDefinition;
  /** By `monsterId`, already parsed against `MonsterStatBlock`. */
  statBlocks: ReadonlyMap<string, MonsterStatBlock>;
}

function buildGrid(definition: EncounterDefinition): GridMap {
  const tiles: TerrainType[][] = Array.from({ length: definition.height }, () =>
    Array.from({ length: definition.width }, (): TerrainType => "normal"),
  );

  for (const override of definition.terrain ?? []) {
    const [x, y] = override.tile;
    const row = tiles[y];
    if (row === undefined || x < 0 || x >= definition.width) {
      throw new Error(`Terrain override ${JSON.stringify(override.tile)} is off the grid`);
    }
    row[x] = override.terrain;
  }

  // Parse rather than trust: a definition is data, and data gets validated.
  return GridMapSchema.parse({ width: definition.width, height: definition.height, tiles });
}

export function buildEncounter(input: BuildEncounterInput): BuiltEncounter {
  const { definition } = input;
  const statBlocks = new Map<string, MonsterStatBlock>();
  const combatants: Combatant[] = [];
  const seenCombatantIds = new Set<string>();
  // Anchor-tile collisions only, not full footprints: a Large creature's real
  // occupancy is `occupiedTiles`'s authority, and reimplementing it here would
  // duplicate it. This still catches the realistic typo of two spawns sharing
  // a tile.
  const claimedTiles = new Set<string>();

  for (const spawn of definition.spawns) {
    const [x, y] = spawn.position;
    if (x < 0 || x >= definition.width || y < 0 || y >= definition.height) {
      throw new Error(
        `Spawn ${spawn.combatantId} at ${JSON.stringify(spawn.position)} is off the grid`,
      );
    }
    if (seenCombatantIds.has(spawn.combatantId)) {
      throw new Error(`Duplicate combatantId in spawns: ${spawn.combatantId}`);
    }
    seenCombatantIds.add(spawn.combatantId);

    const tileKey = `${String(x)},${String(y)}`;
    if (claimedTiles.has(tileKey)) {
      throw new Error(
        `Spawn ${spawn.combatantId} at ${JSON.stringify(spawn.position)} collides with another spawn's tile`,
      );
    }
    claimedTiles.add(tileKey);

    const statBlock = input.statBlocks.get(spawn.monsterId);
    if (statBlock === undefined) {
      throw new Error(`No stat block supplied for monsterId ${spawn.monsterId}`);
    }
    statBlocks.set(spawn.combatantId, statBlock);
    combatants.push(
      combatantFromStatBlock(statBlock, {
        combatantId: spawn.combatantId,
        faction: spawn.faction,
        position: spawn.position,
      }),
    );
  }

  const declared = new Set(definition.turnOrder);
  for (const spawn of definition.spawns) {
    if (!declared.has(spawn.combatantId)) {
      throw new Error(`${spawn.combatantId} is spawned but missing from turnOrder`);
    }
  }
  if (definition.turnOrder.length !== definition.spawns.length) {
    throw new Error(
      `turnOrder names ${String(definition.turnOrder.length)} of ${String(definition.spawns.length)} combatants`,
    );
  }

  return {
    encounterId: definition.encounterId,
    world: {
      grid: buildGrid(definition),
      combatants,
      // Load-bearing: derived from the same stat blocks the validator will
      // enforce against, so offered ranges and enforced ranges cannot disagree.
      actionRangesFeet: actionRangesFeetFrom([...statBlocks.values()]),
    },
    statBlocks,
    turnOrder: definition.turnOrder,
    maxRounds: definition.maxRounds,
  };
}
