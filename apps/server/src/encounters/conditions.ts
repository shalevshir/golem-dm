// Reads `data/srd/conditions.json`. Content is CC-BY-4.0; see NOTICE.md.
//
// This file is the first runtime consumer of that data — before it, only
// `packages/schemas/src/srd.test.ts` read it. File I/O lives here for the
// same reason it lives in `srd.ts` and `gear.ts`: `@ai-dm/rules-engine`
// forbids I/O and `@ai-dm/schemas` is bundled for the browser.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ConditionDefinition } from "@ai-dm/schemas";
import type { Condition } from "@ai-dm/schemas";
import { dataDir } from "./srd.js";

const SRD_DIR_RELATIVE = join("data", "srd");

let cached: ReadonlyMap<Condition, ConditionDefinition> | undefined;

/** Parsed once — the file never changes at runtime. */
export function loadConditions(): ReadonlyMap<Condition, ConditionDefinition> {
  if (cached !== undefined) return cached;

  const path = join(dataDir(SRD_DIR_RELATIVE), "conditions.json");
  const rows = ConditionDefinition.array().parse(JSON.parse(readFileSync(path, "utf8")));
  cached = new Map(rows.map((each) => [each.condition, each]));
  return cached;
}
