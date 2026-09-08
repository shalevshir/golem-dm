// The encounters a campaign can be created from. Data, not logic: a definition
// is validated by `buildEncounter`, which throws rather than producing a
// half-valid world.
import { buildEncounter } from "@ai-dm/rules-engine";
import type { BuiltEncounter, EncounterDefinition } from "@ai-dm/rules-engine";
import type { DerivedCharacter, EncounterCatalogue, MonsterStatBlock } from "@ai-dm/schemas";
import { loadCharacter } from "./characters.js";
import { loadConditions } from "./conditions.js";
import { loadMonster } from "./srd.js";

export { loadCharacter, loadConditions, loadMonster };

// Geometry is load-bearing. Spawns ~45 ft apart (say hero [1,4], goblins
// [10,3]/[10,5]) put every combatant beyond the 5 ft melee reach of a
// scimitar or spear, so every melee proposal is rejected
// `target_out_of_reach` forever and the fight can never conclude.
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
  sceneEnglish:
    "Late afternoon on a rocky hillside track. The ground is dry, broken stone " +
    "and loose scree. The light is flat and orange, the air still, and sound " +
    "carries.",
  width: 12,
  height: 12,
  spawns: [
    // The hero is a real CharacterSheet in data/characters/, not the `guard`
    // stat block standing in for one.
    { combatantId: "hero", characterId: "hero", faction: "party", position: [5, 4] },
    { combatantId: "goblin-a", monsterId: "goblin_warrior", faction: "hostile", position: [6, 3] },
    { combatantId: "goblin-b", monsterId: "goblin_warrior", faction: "hostile", position: [6, 5] },
  ],
  turnOrder: ["hero", "goblin-a", "goblin-b"],
  maxRounds: 20,
};

// The three encounters below follow GOBLIN_AMBUSH's geometry rule for the
// reason its comment gives — everyone starts within melee reach — plus a
// second one it did not have to state: the hero (`data/characters/hero.json`)
// carries a longsword and nothing else, so a hostile spawned out of reach can
// only be answered by closing the distance. A player can do that; the arc
// harness (`tools/sim/src/arc/`) picks from the affordances frame and never
// moves, so a fight that opens at range would stall it for `maxRounds`.
//
// They also do NOT escalate in raw power, which is deliberate and worth
// stating once. A level-3 fighter with 28 HP, AC 16 and no Extra Attack deals
// about 5 damage a round; GOBLIN_AMBUSH already deals about 5 back, so the
// shipped baseline is a knife-edge fight and there is no XP or levelling
// anywhere to grow out of it. Escalating totals would just produce an arc that
// always ends in a corpse at the same node. These vary in SHAPE instead —
// creature type, count, AC band, speed, terrain — which is what actually
// exercises the tactical agent and the narrator.

/** Two wolves: low AC, fast, beasts rather than people. Easier than the baseline. */
const FORD_WOLVES: EncounterDefinition = {
  encounterId: "ford-wolves",
  descriptionEnglish:
    "Two wolves, driven downstream by the ash, take the hero at the ford's shallow bank " +
    "on a 12x12 field with a band of difficult ground along the water.",
  sceneEnglish:
    "The shallow end of a river ford at grey noon. Loose shingle underfoot, ankle-deep " +
    "water two paces off, and a low ash haze that flattens every sound to nothing.",
  width: 12,
  height: 12,
  // The water: crossable, costly, and off the line between the spawns, so it
  // is a choice the tactical agent can make rather than a wall in the way.
  terrain: [
    { tile: [2, 4], terrain: "difficult" },
    { tile: [2, 5], terrain: "difficult" },
    { tile: [2, 6], terrain: "difficult" },
    { tile: [2, 7], terrain: "difficult" },
  ],
  spawns: [
    { combatantId: "hero", characterId: "hero", faction: "party", position: [6, 6] },
    { combatantId: "wolf-a", monsterId: "wolf", faction: "hostile", position: [7, 5] },
    { combatantId: "wolf-b", monsterId: "wolf", faction: "hostile", position: [7, 7] },
  ],
  turnOrder: ["hero", "wolf-a", "wolf-b"],
  maxRounds: 20,
};

/** Three cultists: the first fight where the hero must choose a target. */
const SLAG_PIT_CULTISTS: EncounterDefinition = {
  encounterId: "slag-pit-cultists",
  descriptionEnglish:
    "Three cultists working a slag pit turn on the hero in melee range on a 14x14 " +
    "terrace, with spoil heaps offering half cover away from the opening exchange.",
  sceneEnglish:
    "A kiln terrace at dusk, cut into the hillside. The ground is warm slag and grit, the " +
    "light is low and red off the pit, and the air carries a dry mineral burn.",
  width: 14,
  height: 14,
  // Spoil heaps, placed off the hero-to-cultist line so round one stays a
  // clean melee exchange and the cover is something to manoeuvre toward.
  terrain: [
    { tile: [4, 4], terrain: "half_cover" },
    { tile: [4, 5], terrain: "half_cover" },
    { tile: [4, 9], terrain: "half_cover" },
    { tile: [10, 11], terrain: "difficult" },
    { tile: [11, 11], terrain: "difficult" },
  ],
  spawns: [
    { combatantId: "hero", characterId: "hero", faction: "party", position: [7, 7] },
    { combatantId: "cultist-a", monsterId: "cultist", faction: "hostile", position: [8, 6] },
    { combatantId: "cultist-b", monsterId: "cultist", faction: "hostile", position: [8, 7] },
    { combatantId: "cultist-c", monsterId: "cultist", faction: "hostile", position: [8, 8] },
  ],
  turnOrder: ["hero", "cultist-a", "cultist-b", "cultist-c"],
  maxRounds: 20,
};

/**
 * Two guards on a barge deck. AC 16 against the hero's +5 is the point: this
 * is the one fight where the hero misses about as often as they hit, so the
 * narrator has to make a run of misses read as something other than a stall.
 */
const BARGE_HOLD: EncounterDefinition = {
  encounterId: "barge-hold",
  descriptionEnglish:
    "Two hired guards defend a moored barge's hold in melee range on a cramped 10x10 " +
    "deck, with stacked cargo blocking the corners.",
  sceneEnglish:
    "The open hold of a moored barge, after dark. Wet planking underfoot, one shuttered " +
    "lamp throwing hard shadows off the cargo, and the hull knocking against the piles.",
  width: 10,
  height: 10,
  // Cargo. Blocking rather than cover: on a deck this size it is the only
  // thing that makes position mean anything at all.
  terrain: [
    { tile: [1, 1], terrain: "blocking" },
    { tile: [1, 2], terrain: "blocking" },
    { tile: [8, 8], terrain: "blocking" },
    { tile: [8, 7], terrain: "blocking" },
  ],
  spawns: [
    { combatantId: "hero", characterId: "hero", faction: "party", position: [5, 5] },
    { combatantId: "guard-a", monsterId: "guard", faction: "hostile", position: [6, 4] },
    { combatantId: "guard-b", monsterId: "guard", faction: "hostile", position: [6, 6] },
  ],
  turnOrder: ["hero", "guard-a", "guard-b"],
  maxRounds: 25,
};

const CATALOGUE = new Map<string, EncounterDefinition>([
  [GOBLIN_AMBUSH.encounterId, GOBLIN_AMBUSH],
  [FORD_WOLVES.encounterId, FORD_WOLVES],
  [SLAG_PIT_CULTISTS.encounterId, SLAG_PIT_CULTISTS],
  [BARGE_HOLD.encounterId, BARGE_HOLD],
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

/**
 * Whether the catalogue knows this id, without building the encounter or
 * throwing. `loadWorld` needs the question answered for every node in a world
 * file, and `buildEncounterById` would be both far more expensive and the
 * wrong shape — a dangling reference is a problem to collect, not an
 * exception to catch.
 */
export function hasEncounter(encounterId: string): boolean {
  return CATALOGUE.has(encounterId);
}

/**
 * `heroCurrentHp`, when given, overrides the spawned character's HP below
 * their sheet's own value — the seam `resolveSpawn` (`rules-engine/encounter/
 * build.ts`) already has for "a character can join below full health." Used
 * to carry the hero's HP forward across encounters (death-saves-persistent-
 * hp spec, Decision 7); absent for a combat-only campaign, which spawns
 * exactly as it does today.
 *
 * Floored at 1 here, once, rather than by every caller: a persisted
 * `scene.heroHp` of 0 (a hero who last won only by stabilizing) must never
 * spawn an already-unconscious combatant, and the one function that actually
 * writes `currentHp` onto the spawn is the one place that invariant can't be
 * forgotten by a future caller.
 */
export function buildEncounterById(encounterId: string, heroCurrentHp?: number): BuiltEncounter {
  const definition = encounterById(encounterId);
  const statBlocks = new Map<string, MonsterStatBlock>();
  const characters = new Map<string, DerivedCharacter>();
  const flooredHeroHp = heroCurrentHp === undefined ? undefined : Math.max(1, heroCurrentHp);

  for (const spawn of definition.spawns) {
    if ("characterId" in spawn) {
      if (!characters.has(spawn.characterId)) {
        const derived = loadCharacter(spawn.characterId);
        characters.set(
          spawn.characterId,
          flooredHeroHp === undefined ? derived : { ...derived, currentHp: flooredHeroHp },
        );
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
 * carries a `CampaignState` growing without bound. The shape itself
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
