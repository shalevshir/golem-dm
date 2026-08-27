// Loads the authored world from `data/world/` (`PROJECT_PLAN.md` §4.7 step 2).
// Static content, hand-edited, validated on read. The mutable half of the
// world is a projection of the event log and lives in `packages/memory`, not
// here — §4.7 is explicit that static lore is a loader and world state is a
// projection.
//
// Mirrors `apps/server/src/encounters/`: the file I/O sits in this app
// because `@ai-dm/rules-engine` forbids I/O and `@ai-dm/schemas` is bundled
// for the browser by `apps/web`, so `node:fs` fits in neither.
//
// Nothing in the running pipeline calls this yet. §4.7's step 3 scene engine
// is the first consumer, and it takes the result injected — the way
// `buildEncounter` takes `statBlocks` and `characters` — rather than reaching
// for the filesystem itself.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  FactionDefinition,
  LocationDefinition,
  NpcDefinition,
  QuestNode,
  WorldManifest,
} from "@ai-dm/schemas";
import type { FactionBand, WorldEffect, WorldPredicate } from "@ai-dm/schemas";
import { dataDir } from "../encounters/srd.js";

const WORLD_DIR_RELATIVE = join("data", "world");

/**
 * Thrown by `loadWorld` when content parses but does not hang together — a
 * duplicate id, an id that resolves to nothing, a faction pair left
 * undeclared. Named and `instanceof`-able for the reason
 * `UnknownEncounterError` is: a caller distinguishing this from a `ZodError`
 * should not have to match on message text.
 *
 * It carries EVERY problem found rather than the first. An author fixing five
 * dangling ids should need one reload, not five.
 */
export class WorldContentError extends Error {
  readonly problems: readonly string[];

  constructor(dir: string, problems: readonly string[]) {
    super(`Invalid world content in ${dir}:\n  - ${problems.join("\n  - ")}`);
    this.name = "WorldContentError";
    this.problems = problems;
  }
}

/** Which collection an id has to resolve in. */
type ContentKind = "faction" | "location" | "quest node";

interface ContentRef {
  readonly kind: ContentKind;
  readonly id: string;
}

function indexBy<T>(
  items: readonly T[],
  idOf: (item: T) => string,
  what: string,
  problems: string[],
): Map<string, T> {
  const map = new Map<string, T>();
  for (const item of items) {
    const id = idOf(item);
    if (map.has(id)) {
      problems.push(`duplicate ${what} id "${id}"`);
      continue;
    }
    map.set(id, item);
  }
  return map;
}

/**
 * Every content id a predicate names. Written as a `return` from each branch
 * with no `default`, so adding a `WorldPredicate` kind fails to compile here
 * rather than silently skipping its cross-reference — the same exhaustiveness
 * discipline `packages/schemas/src/reduce.ts` relies on.
 */
function predicateRefs(predicate: WorldPredicate): readonly ContentRef[] {
  switch (predicate.kind) {
    case "node_completed":
      return [{ kind: "quest node", id: predicate.nodeId }];
    case "faction_band_at_least":
      return [
        { kind: "faction", id: predicate.factionA },
        { kind: "faction", id: predicate.factionB },
      ];
  }
}

/** Same exhaustiveness contract as `predicateRefs`. */
function effectRefs(effect: WorldEffect): readonly ContentRef[] {
  switch (effect.kind) {
    case "shift_faction_relation":
      return [
        { kind: "faction", id: effect.factionA },
        { kind: "faction", id: effect.factionB },
      ];
    case "advance_calendar":
      return [];
  }
}

/**
 * The authored world, indexed. `Map`s rather than arrays for the reason
 * `loadGear` returns them: every consumer looks content up by id.
 *
 * Declared here rather than in `@ai-dm/schemas` because it is neither a wire
 * shape nor a zod schema — it holds `Map`s. `SrdGear` is the identical case
 * and lives in `@ai-dm/rules-engine`, next to its consumer rather than in the
 * schema package. §4.7's step 3 scene engine takes this injected and can
 * rehome the type then.
 */
export interface AuthoredWorld {
  readonly worldId: string;
  readonly startingDay: number;
  readonly startingNodeId: string;
  readonly factions: ReadonlyMap<string, FactionDefinition>;
  readonly locations: ReadonlyMap<string, LocationDefinition>;
  readonly npcs: ReadonlyMap<string, NpcDefinition>;
  readonly questNodes: ReadonlyMap<string, QuestNode>;
  /** Keyed by `pairKey`, so a relation is an unordered pair. */
  readonly relations: ReadonlyMap<string, FactionBand>;
}

function readJson(dir: string, file: string): unknown {
  return JSON.parse(readFileSync(join(dir, file), "utf8"));
}

/**
 * Canonical key for an unordered faction pair, so declaring `A,B` and `B,A`
 * names one relation rather than two. `|` is safe as a delimiter because
 * `ContentId` forbids it.
 *
 * Exported because a `Map` keyed by a private convention is unusable by a
 * consumer. Step 3 may well want a `relationBetween(world, a, b)` wrapper
 * over it; that is one line and belongs with the code that needs it.
 */
export function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

// Parsed once per directory. The files never change at runtime, and the
// reason to cache is concrete rather than habitual: the moment §4.7's step 3
// wires this in, an uncached whole-world reread per deliberation is exactly
// the O(encounters) blocking cold-load I/O that step 1's review flagged in
// `loadCampaign` as a pattern not to repeat.
const cache = new Map<string, AuthoredWorld>();

export function loadWorld(dir: string = dataDir(WORLD_DIR_RELATIVE)): AuthoredWorld {
  const cacheKey = resolve(dir);
  const hit = cache.get(cacheKey);
  if (hit !== undefined) return hit;

  const manifest = WorldManifest.parse(readJson(dir, "world.json"));
  const factionList = FactionDefinition.array().parse(readJson(dir, "factions.json"));
  const locationList = LocationDefinition.array().parse(readJson(dir, "locations.json"));
  const npcList = NpcDefinition.array().parse(readJson(dir, "npcs.json"));
  const nodeList = QuestNode.array().parse(readJson(dir, "arc.json"));

  const problems: string[] = [];

  const factions = indexBy(factionList, (each) => each.factionId, "faction", problems);
  const locations = indexBy(locationList, (each) => each.locationId, "location", problems);
  const npcs = indexBy(npcList, (each) => each.npcId, "npc", problems);
  const questNodes = indexBy(nodeList, (each) => each.nodeId, "quest node", problems);

  const collections: Record<ContentKind, ReadonlyMap<string, unknown>> = {
    faction: factions,
    location: locations,
    "quest node": questNodes,
  };

  const checkRef = (ref: ContentRef, where: string): void => {
    if (!collections[ref.kind].has(ref.id)) {
      problems.push(`${where} references unknown ${ref.kind} "${ref.id}"`);
    }
  };

  const relations = new Map<string, FactionBand>();
  for (const entry of manifest.factionRelations) {
    const where = `faction relation ${entry.factionA}/${entry.factionB}`;
    checkRef({ kind: "faction", id: entry.factionA }, where);
    checkRef({ kind: "faction", id: entry.factionB }, where);
    if (entry.factionA === entry.factionB) {
      problems.push(`${where} relates a faction to itself`);
      continue;
    }
    const key = pairKey(entry.factionA, entry.factionB);
    if (relations.has(key)) {
      problems.push(
        `duplicate faction relation for "${entry.factionA}" and "${entry.factionB}"`,
      );
      continue;
    }
    relations.set(key, entry.band);
  }

  // Every unordered pair of distinct factions must be declared, so "what is
  // the standing between X and Y" is always answerable from the file and
  // there is no default rule for the step 3 engine to invent. Exhaustive
  // declaration is one line at two factions and untenable somewhere around
  // eight, at which point an undeclared pair should default to `neutral` and
  // this should become a warning rather than a refusal.
  const factionIds = Array.from(factions.keys()).sort();
  for (const [index, a] of factionIds.entries()) {
    for (const b of factionIds.slice(index + 1)) {
      if (!relations.has(pairKey(a, b))) {
        problems.push(`no faction relation declared for "${a}" and "${b}"`);
      }
    }
  }

  checkRef({ kind: "quest node", id: manifest.startingNodeId }, "world.json startingNodeId");

  // Iterating the indexed maps rather than the parsed lists: an entry dropped
  // as a duplicate is already reported, and cross-referencing it too would
  // report the same defect twice under one id.
  for (const npc of npcs.values()) {
    const where = `npc ${npc.npcId}`;
    checkRef({ kind: "location", id: npc.locationId }, where);
    if (npc.factionId !== undefined) checkRef({ kind: "faction", id: npc.factionId }, where);
  }

  for (const node of questNodes.values()) {
    const where = `quest node ${node.nodeId}`;
    checkRef({ kind: "location", id: node.locationId }, where);
    for (const edge of node.edges) {
      checkRef({ kind: "quest node", id: edge.to }, `${where} edge`);
    }
    for (const predicate of node.preconditions) {
      for (const ref of predicateRefs(predicate)) checkRef(ref, `${where} precondition`);
      if (predicate.kind === "faction_band_at_least" && predicate.factionA === predicate.factionB) {
        problems.push(
          `${where} precondition ${predicate.factionA}/${predicate.factionB} relates a faction to itself`,
        );
      }
    }
    for (const effect of node.effects) {
      for (const ref of effectRefs(effect)) checkRef(ref, `${where} effect`);
      if (effect.kind === "shift_faction_relation" && effect.factionA === effect.factionB) {
        problems.push(
          `${where} effect ${effect.factionA}/${effect.factionB} relates a faction to itself`,
        );
      }
    }
  }

  if (problems.length > 0) throw new WorldContentError(dir, problems);

  const world: AuthoredWorld = {
    worldId: manifest.worldId,
    startingDay: manifest.startingDay,
    startingNodeId: manifest.startingNodeId,
    factions,
    locations,
    npcs,
    questNodes,
    relations,
  };

  cache.set(cacheKey, world);
  return world;
}
