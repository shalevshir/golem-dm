// Turns SRD stat blocks into the shapes the turn validator consumes. Pure —
// the caller does the file reading and hands the parsed data in.
import type { Combatant, CreatureStatBlock, Faction, Tile } from "@ai-dm/schemas";
import { startTurn } from "./action-economy.js";

export interface SpawnOptions {
  combatantId: string;
  faction: Faction;
  position: Tile;
  /** Set when this combatant is driven by a `CharacterSheet`. */
  characterId?: string;
  /** Defaults to the stat block's average hit points. */
  currentHp?: number;
}

/**
 * Build a fresh `Combatant` from a stat block. Hit points default to the
 * printed average rather than a roll, so spawning stays deterministic; roll
 * `hitPoints.diceNotation` through the dice module and pass `currentHp` when
 * variety is wanted.
 */
export function combatantFromStatBlock(
  statBlock: CreatureStatBlock,
  options: SpawnOptions,
): Combatant {
  const maxHp = statBlock.hitPoints.average;
  return {
    combatantId: options.combatantId,
    ...(options.characterId === undefined ? {} : { characterId: options.characterId }),
    faction: options.faction,
    position: options.position,
    size: statBlock.size,
    speedFeet: statBlock.speedFeet,
    reachFeet: meleeReachFeet(statBlock),
    maxHp,
    currentHp: options.currentHp ?? maxHp,
    tempHp: 0,
    armorClass: statBlock.armorClass,
    conditions: [],
    exhaustionLevel: 0,
    attacksPerAction: statBlock.attacksPerAction,
    spellSlots: {},
    actionEconomy: startTurn(),
    status: "alive",
  };
}

/** The longest melee reach the stat block has; 5 ft when it is ranged-only. */
export function meleeReachFeet(statBlock: CreatureStatBlock): number {
  const reaches = statBlock.actions
    .map((action) => action.reachFeet)
    .filter((reach): reach is number => reach !== undefined);
  return reaches.length === 0 ? 5 : Math.max(...reaches);
}

/**
 * Build the `CombatWorld.actionRangesFeet` lookup from stat blocks. An attack
 * that can be thrown or fired uses its normal range; a purely melee attack uses
 * its reach. Long range is not used — it only imposes Disadvantage, so it
 * belongs to resolution, not legality.
 */
export function actionRangesFeetFrom(
  statBlocks: readonly CreatureStatBlock[],
): Record<string, number> {
  const ranges: Record<string, number> = {};
  for (const statBlock of statBlocks) {
    for (const action of statBlock.actions) {
      const reach = action.rangeFeet ?? action.reachFeet;
      if (reach === undefined) continue;
      // Two stat blocks can share a weapon; keep the longer reach so a legal
      // proposal is never rejected on another creature's shorter version.
      ranges[action.actionId] = Math.max(ranges[action.actionId] ?? 0, reach);
    }
  }
  return ranges;
}
