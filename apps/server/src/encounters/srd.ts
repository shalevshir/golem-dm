// Reads SRD 5.2.1 stat blocks from `data/srd/monsters/`. Content is CC-BY-4.0;
// see NOTICE.md.
//
// Duplicated from `tools/sim/src/scenarios/srd.ts` on purpose: there is no
// shared home for it. `@ai-dm/rules-engine` forbids I/O, and `@ai-dm/schemas`
// is bundled for the browser by `apps/web`, so `node:fs` cannot go in either.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MonsterStatBlock } from "@ai-dm/schemas";

const MONSTER_DIR_RELATIVE = join("data", "srd", "monsters");

/** Walk up until `relativePath` appears — a fixed relative path would be
 * wrong for `dist/` after `pnpm build`. Shared by every loader in this app
 * (`gear.ts`, `characters.ts`, `../world/index.ts`) so the walk-up itself is
 * written once. */
export function dataDir(relativePath: string): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = join(dir, relativePath);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`Could not find ${relativePath} above this file`);
    dir = parent;
  }
}

function monsterDir(): string {
  return dataDir(MONSTER_DIR_RELATIVE);
}

const cache = new Map<string, MonsterStatBlock>();

/** Parsed and validated. Cached — stat blocks are immutable data. */
export function loadMonster(monsterId: string): MonsterStatBlock {
  const hit = cache.get(monsterId);
  if (hit !== undefined) return hit;

  const path = join(monsterDir(), `${monsterId}.json`);
  const parsed = MonsterStatBlock.parse(JSON.parse(readFileSync(path, "utf8")));
  cache.set(monsterId, parsed);
  return parsed;
}
