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
import { join } from "node:path";
import {
  FactionDefinition,
  LocationDefinition,
  NpcDefinition,
  QuestNode,
  WorldManifest,
} from "@ai-dm/schemas";
import type { FactionBand } from "@ai-dm/schemas";
import { dataDir } from "../encounters/srd.js";

const WORLD_DIR_RELATIVE = join("data", "world");

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
  const hit = cache.get(dir);
  if (hit !== undefined) return hit;

  const manifest = WorldManifest.parse(readJson(dir, "world.json"));
  const factionList = FactionDefinition.array().parse(readJson(dir, "factions.json"));
  const locationList = LocationDefinition.array().parse(readJson(dir, "locations.json"));
  const npcList = NpcDefinition.array().parse(readJson(dir, "npcs.json"));
  const nodeList = QuestNode.array().parse(readJson(dir, "arc.json"));

  const world: AuthoredWorld = {
    worldId: manifest.worldId,
    startingDay: manifest.startingDay,
    startingNodeId: manifest.startingNodeId,
    factions: new Map(factionList.map((each) => [each.factionId, each])),
    locations: new Map(locationList.map((each) => [each.locationId, each])),
    npcs: new Map(npcList.map((each) => [each.npcId, each])),
    questNodes: new Map(nodeList.map((each) => [each.nodeId, each])),
    relations: new Map(
      manifest.factionRelations.map((each) => [
        pairKey(each.factionA, each.factionB),
        each.band,
      ]),
    ),
  };

  cache.set(dir, world);
  return world;
}
