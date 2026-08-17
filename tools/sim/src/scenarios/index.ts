// The scenario registry. Ordered, because report tables read better in a fixed
// order and `--scenarios` defaults to all of them.
export * from "./types.js";
export * from "./build.js";
export * from "./srd.js";

import { COVER_CORRIDOR } from "./cover-corridor.js";
import { MELEE_BRAWL } from "./melee-brawl.js";
import { OGRE_CHARGE } from "./ogre-charge.js";
import { RANGED_APPROACH } from "./ranged-approach.js";
import type { ScenarioDefinition } from "./types.js";

export { COVER_CORRIDOR, MELEE_BRAWL, OGRE_CHARGE, RANGED_APPROACH };

const ORDERED: readonly ScenarioDefinition[] = [
  MELEE_BRAWL,
  RANGED_APPROACH,
  COVER_CORRIDOR,
  OGRE_CHARGE,
];

export const SCENARIOS: ReadonlyMap<string, ScenarioDefinition> = new Map(
  ORDERED.map((scenario) => [scenario.scenarioId, scenario]),
);

export const ALL_SCENARIO_IDS: readonly string[] = ORDERED.map((each) => each.scenarioId);

/** Throws on an unknown id: a typo in `--scenarios` should stop the run, not skip it. */
export function scenarioById(scenarioId: string): ScenarioDefinition {
  const found = SCENARIOS.get(scenarioId);
  if (found === undefined) {
    throw new Error(`Unknown scenario ${scenarioId}; known: ${ALL_SCENARIO_IDS.join(", ")}`);
  }
  return found;
}
