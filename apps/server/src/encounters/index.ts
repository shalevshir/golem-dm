// The encounters a session can be created from. Data, not logic: a definition
// is validated by `buildEncounter`, which throws rather than producing a
// half-valid world.
import { buildEncounter } from "@ai-dm/rules-engine";
import type { BuiltEncounter, EncounterDefinition } from "@ai-dm/rules-engine";
import type { DerivedCharacter, EncounterCatalogue, MonsterStatBlock } from "@ai-dm/schemas";
import { loadCharacter } from "./characters.js";
import { loadConditions } from "./conditions.js";
import { loadMonster } from "./srd.js";

export { loadCharacter, loadConditions, loadMonster };

// Geometry per task-corrections.md C-14: the brief's original spawns (hero
// [1,4], goblins [10,3]/[10,5], ~45 ft apart) put every combatant beyond the
// 5 ft melee reach of a scimitar or spear, so every melee proposal is
// rejected `target_out_of_reach` forever and the fight can never conclude.
// Instead, mirror `tools/sim/src/scenarios/melee-brawl.ts`: everyone starts
// within reach of each other on a 12x12 field. The hero sits between the two
// goblins, each diagonally adjacent (Chebyshev distance 1 tile = 5 ft,
// ADR-0003), so a scimitar or longsword attack is legal for either side from
// round 1 — proven by the "melee attack is legal on turn 1" test below.
const GOBLIN_AMBUSH: EncounterDefinition = {
  encounterId: "goblin-ambush",
  descriptionEnglish:
    "A lone adventurer is ambushed by two goblin warriors in melee range on an " +
    "open 12x12 field.",
  width: 12,
  height: 12,
  spawns: [
    // C-13 is closed: the hero is a real CharacterSheet in data/characters/,
    // no longer the `guard` stat block standing in for one.
    { combatantId: "hero", characterId: "hero", faction: "party", position: [5, 4] },
    { combatantId: "goblin-a", monsterId: "goblin_warrior", faction: "hostile", position: [6, 3] },
    { combatantId: "goblin-b", monsterId: "goblin_warrior", faction: "hostile", position: [6, 5] },
  ],
  turnOrder: ["hero", "goblin-a", "goblin-b"],
  maxRounds: 20,
};

const CATALOGUE = new Map<string, EncounterDefinition>([
  [GOBLIN_AMBUSH.encounterId, GOBLIN_AMBUSH],
]);

/**
 * Thrown by `encounterById`/`buildEncounterById` for an id the catalogue does
 * not know. Named so a caller (Task 13's HTTP layer) can `instanceof` it to
 * answer 404 rather than 500 — `buildEncounterById` can also throw a bare
 * `Error` from a missing monster file, a `ZodError` from a malformed stat
 * block, or any of `buildEncounter`'s own errors, none of which are a 404.
 */
export class UnknownEncounterError extends Error {
  readonly encounterId: string;

  constructor(encounterId: string) {
    super(`Unknown encounter ${encounterId}`);
    this.name = "UnknownEncounterError";
    this.encounterId = encounterId;
  }
}

export function encounterById(encounterId: string): EncounterDefinition {
  const definition = CATALOGUE.get(encounterId);
  if (definition === undefined) throw new UnknownEncounterError(encounterId);
  return definition;
}

export function buildEncounterById(encounterId: string): BuiltEncounter {
  const definition = encounterById(encounterId);
  const statBlocks = new Map<string, MonsterStatBlock>();
  const characters = new Map<string, DerivedCharacter>();

  for (const spawn of definition.spawns) {
    if ("characterId" in spawn) {
      if (!characters.has(spawn.characterId)) {
        characters.set(spawn.characterId, loadCharacter(spawn.characterId));
      }
      continue;
    }
    if (!statBlocks.has(spawn.monsterId)) {
      statBlocks.set(spawn.monsterId, loadMonster(spawn.monsterId));
    }
  }

  return buildEncounter({ definition, statBlocks, characters });
}

/**
 * The static per-encounter facts a client needs to label what it draws:
 * display names, max HP and faction. Static is the point — this is fetched
 * once over HTTP and cached, rather than re-sent on a socket that already
 * carries a `SessionState` growing without bound (C-30). The shape itself
 * lives in `@ai-dm/schemas` (`EncounterCatalogue`), not here — it is the one
 * response body a browser client also parses, so invariant 4 puts it in the
 * shared package rather than a hand-rolled interface duplicated on each end.
 */
export function encounterCatalogue(encounterId: string): EncounterCatalogue {
  const built = buildEncounterById(encounterId);

  const combatants = built.world.combatants.map((combatant) => {
    const statBlock = built.statBlocks.get(combatant.combatantId);
    return {
      combatantId: combatant.combatantId,
      // A combatant with no stat block cannot occur — `buildEncounter` refuses
      // to produce one — but the map lookup is still `T | undefined` under
      // `noUncheckedIndexedAccess`, and the id is a better label than a crash.
      nameEnglish: statBlock?.nameEnglish ?? combatant.combatantId,
      nameHebrew: statBlock?.nameHebrew ?? combatant.combatantId,
      maxHp: combatant.maxHp,
      faction: combatant.faction,
    };
  });

  // Flattened across every stat block and deduped by `actionId`, first
  // occurrence winning. This is NOT speculative: `built.statBlocks` is keyed
  // by `combatantId`, not `monsterId`, so `goblin_warrior` appears twice in
  // `.values()` here (once for `goblin-a`, once for `goblin-b`) even though
  // the *input* map to `buildEncounter` only had one entry for it. Without
  // the dedupe, `goblin-ambush` today flattens to `[longsword, unarmed_strike,
  // scimitar, shortbow, scimitar, shortbow]`. These are display labels only,
  // so first-wins is harmless even when the underlying attack bonuses differ
  // — legality still comes from affordances, never from this list.
  const actions = new Map<string, { nameEnglish: string; nameHebrew: string }>();
  for (const statBlock of built.statBlocks.values()) {
    for (const action of statBlock.actions) {
      if (!actions.has(action.actionId)) {
        actions.set(action.actionId, {
          nameEnglish: action.nameEnglish,
          nameHebrew: action.nameHebrew,
        });
      }
    }
  }

  // By characterId, not combatantId: a monster combatant leaves
  // `characterId` undefined (Task 14), so this is exactly the party's
  // character spawns, never the full combatant list. Unlike the action map
  // above, this list is not deduped: ADR-0002 scopes the POC to exactly one
  // human-controlled character, so two spawns naming the same characterId
  // cannot occur, and a dedupe branch nothing can reach would be untested
  // defensive code rather than a real guard.
  const characters = built.world.combatants
    .map((combatant) => combatant.characterId)
    .filter((characterId): characterId is string => characterId !== undefined)
    .map((characterId) => loadCharacter(characterId));

  return {
    encounterId,
    combatants,
    actions: [...actions].map(([actionId, names]) => ({ actionId, ...names })),
    characters,
  };
}
