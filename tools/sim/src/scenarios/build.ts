// Turns a `ScenarioDefinition` into the state the agent and the resolver need.
// Pure and total: it either produces a fully valid world or throws.
import type { AvailableAction } from "@ai-dm/agents";
import { actionRangesFeetFrom, combatantFromStatBlock } from "@ai-dm/rules-engine";
import type { Combatant, GridMap, MonsterStatBlock, TerrainType } from "@ai-dm/schemas";
import { GridMap as GridMapSchema } from "@ai-dm/schemas";
import { loadMonster } from "./srd.js";
import type { BuiltScenario, ScenarioDefinition } from "./types.js";

function buildGrid(definition: ScenarioDefinition): GridMap {
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

  // Parse rather than trust: a fixture is data, and data gets validated.
  return GridMapSchema.parse({ width: definition.width, height: definition.height, tiles });
}

export function buildScenario(definition: ScenarioDefinition): BuiltScenario {
  const statBlocks = new Map<string, MonsterStatBlock>();
  const availableActions = new Map<string, readonly AvailableAction[]>();
  const combatants: Combatant[] = [];

  const seenCombatantIds = new Set<string>();
  // Anchor-tile collisions only, not full footprints: a Large creature's real
  // occupancy is the rules engine's authority (see `occupiedTiles`), and
  // reimplementing that here would duplicate it. This still catches the
  // realistic fixture typo of two spawns sharing a tile.
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

    const statBlock = loadMonster(spawn.monsterId);
    statBlocks.set(spawn.combatantId, statBlock);
    availableActions.set(
      spawn.combatantId,
      statBlock.actions.map((action) => ({
        actionId: action.actionId,
        name: action.nameEnglish,
      })),
    );
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
    scenarioId: definition.scenarioId,
    world: {
      grid: buildGrid(definition),
      combatants,
      // Load-bearing. Derived from the same stat blocks that produced
      // availableActions, so what the model is offered and what the validator
      // will enforce cannot disagree.
      actionRangesFeet: actionRangesFeetFrom([...statBlocks.values()]),
    },
    statBlocks,
    availableActions,
    turnOrder: definition.turnOrder,
    maxRounds: definition.maxRounds,
  };
}
