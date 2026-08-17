// Reads SRD 5.2.1 stat blocks from `data/srd/monsters/`. Content is CC-BY-4.0;
// see NOTICE.md. Parsing goes through `@ai-dm/schemas` so a malformed file
// fails here rather than as a mysterious rejection thirty turns into a run.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MonsterStatBlock } from "@ai-dm/schemas";

const MONSTER_DIR_RELATIVE = join("data", "srd", "monsters");

/**
 * Walk up from this file until `data/srd/monsters` appears. Searching beats a
 * fixed `../../../..`, which would be wrong for `dist/` after `pnpm build`.
 */
function monsterDir(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = join(dir, MONSTER_DIR_RELATIVE);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`Could not find ${MONSTER_DIR_RELATIVE} above this file`);
    dir = parent;
  }
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
