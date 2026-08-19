// Turns a `ScenarioDefinition` into the state the agent and the resolver need.
// The world-building half now lives in `@ai-dm/rules-engine` (step 8's server
// needs it too); this file loads the SRD files the engine may not touch, and
// adds the `availableActions` the engine may not name.
import { availableActionsFor } from "@ai-dm/agents";
import type { AvailableAction } from "@ai-dm/agents";
import { buildEncounter } from "@ai-dm/rules-engine";
import type { MonsterStatBlock } from "@ai-dm/schemas";
import { loadMonster } from "./srd.js";
import type { BuiltScenario, ScenarioDefinition } from "./types.js";

export function buildScenario(definition: ScenarioDefinition): BuiltScenario {
  const byMonsterId = new Map<string, MonsterStatBlock>();
  for (const spawn of definition.spawns) {
    if (!byMonsterId.has(spawn.monsterId))
      byMonsterId.set(spawn.monsterId, loadMonster(spawn.monsterId));
  }

  const built = buildEncounter({
    definition: { ...definition, encounterId: definition.scenarioId },
    statBlocks: byMonsterId,
  });

  const availableActions = new Map<string, readonly AvailableAction[]>();
  for (const [combatantId, statBlock] of built.statBlocks) {
    availableActions.set(combatantId, availableActionsFor(statBlock));
  }

  return {
    scenarioId: built.encounterId,
    world: built.world,
    statBlocks: built.statBlocks,
    availableActions,
    turnOrder: built.turnOrder,
    maxRounds: built.maxRounds,
  };
}
