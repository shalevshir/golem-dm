// A scenario is a fixture: a map, a cast, and a fixed turn order. Everything
// here is data. `buildScenario` is the only thing that turns it into state.
import type { CombatWorld } from "@ai-dm/rules-engine";
import type { AvailableAction } from "@ai-dm/agents";
import type { Faction, MonsterStatBlock, TerrainType, Tile } from "@ai-dm/schemas";

export interface SpawnSpec {
  combatantId: string;
  /** Basename of a file in `data/srd/monsters/`, without the extension. */
  monsterId: string;
  faction: Faction;
  position: Tile;
}

export interface TerrainOverride {
  tile: Tile;
  terrain: TerrainType;
}

export interface ScenarioDefinition {
  scenarioId: string;
  /** English. Says what this fixture is meant to discriminate. */
  descriptionEnglish: string;
  width: number;
  height: number;
  /** Sparse: every unlisted tile is "normal". */
  terrain?: readonly TerrainOverride[];
  spawns: readonly SpawnSpec[];
  /**
   * Declared, never rolled. Initiative is not what the benchmark measures, and
   * rolling it would spend RNG draws that shift every later roll.
   */
  turnOrder: readonly string[];
  maxRounds: number;
}

export interface BuiltScenario {
  scenarioId: string;
  world: CombatWorld;
  /** By `combatantId` — the resolver needs attack bonuses, which `Combatant` lacks. */
  statBlocks: ReadonlyMap<string, MonsterStatBlock>;
  /** By `combatantId`. What that creature may propose this turn. */
  availableActions: ReadonlyMap<string, readonly AvailableAction[]>;
  turnOrder: readonly string[];
  maxRounds: number;
}
