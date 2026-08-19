// The encounters a session can be created from. Data, not logic: a definition
// is validated by `buildEncounter`, which throws rather than producing a
// half-valid world.
import { buildEncounter } from "@ai-dm/rules-engine";
import type { BuiltEncounter, EncounterDefinition } from "@ai-dm/rules-engine";
import type { MonsterStatBlock } from "@ai-dm/schemas";
import { loadMonster } from "./srd.js";

export { loadMonster };

// Geometry per task-corrections.md C-14: the brief's original spawns (hero
// [1,4], goblins [10,3]/[10,5], ~45 ft apart) put every combatant beyond the
// 5 ft melee reach of a scimitar or spear, so every melee proposal is
// rejected `target_out_of_reach` forever and the fight can never conclude.
// Instead, mirror `tools/sim/src/scenarios/melee-brawl.ts`: everyone starts
// within reach of each other on a 12x12 field. The hero sits between the two
// goblins, each diagonally adjacent (Chebyshev distance 1 tile = 5 ft,
// ADR-0003), so a scimitar or spear attack is legal for either side from
// round 1 — proven by the "melee attack is legal on turn 1" test below.
const GOBLIN_AMBUSH: EncounterDefinition = {
  encounterId: "goblin-ambush",
  descriptionEnglish:
    "A lone guard is ambushed by two goblin warriors in melee range on an " +
    "open 12x12 field.",
  width: 12,
  height: 12,
  spawns: [
    // C-13: "goblin" is not a real monsterId. `data/srd/monsters/` has no
    // player-character data, so the hero borrows the "guard" stat block for
    // now (RULES_REFERENCE.md §8) rather than inventing un-sourced numbers.
    { combatantId: "hero", monsterId: "guard", faction: "party", position: [5, 4] },
    { combatantId: "goblin-a", monsterId: "goblin_warrior", faction: "hostile", position: [6, 3] },
    { combatantId: "goblin-b", monsterId: "goblin_warrior", faction: "hostile", position: [6, 5] },
  ],
  turnOrder: ["hero", "goblin-a", "goblin-b"],
  maxRounds: 20,
};

const CATALOGUE = new Map<string, EncounterDefinition>([
  [GOBLIN_AMBUSH.encounterId, GOBLIN_AMBUSH],
]);

export function encounterById(encounterId: string): EncounterDefinition {
  const definition = CATALOGUE.get(encounterId);
  if (definition === undefined) throw new Error(`Unknown encounter ${encounterId}`);
  return definition;
}

export function buildEncounterById(encounterId: string): BuiltEncounter {
  const definition = encounterById(encounterId);
  const statBlocks = new Map<string, MonsterStatBlock>();
  for (const spawn of definition.spawns) {
    if (!statBlocks.has(spawn.monsterId)) {
      statBlocks.set(spawn.monsterId, loadMonster(spawn.monsterId));
    }
  }
  return buildEncounter({ definition, statBlocks });
}
