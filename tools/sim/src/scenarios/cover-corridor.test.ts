// Geometry regression: without this, the wall could be inert (no LoS-blocking
// tiles between any starting pair) and the whole suite would stay green while
// the fixture discriminated nothing. Uses the rules engine's own `coverBetween`
// rather than hand-rolled line tracing.
import { describe, expect, it } from "vitest";
import { coverBetween } from "@ai-dm/rules-engine";
import type { Combatant } from "@ai-dm/schemas";
import { buildScenario } from "./build.js";
import { COVER_CORRIDOR } from "./cover-corridor.js";

function requireCombatant(combatants: readonly Combatant[], combatantId: string): Combatant {
  const found = combatants.find((each) => each.combatantId === combatantId);
  if (found === undefined) {
    throw new Error(`Expected combatant ${combatantId} in fixture`);
  }
  return found;
}

describe("cover-corridor geometry", () => {
  it("puts every cross-faction starting pair behind full cover", () => {
    const built = buildScenario(COVER_CORRIDOR);
    const wolves = ["wolf_1", "wolf_2"].map((id) => requireCombatant(built.world.combatants, id));
    const guards = ["guard_1", "guard_2"].map((id) => requireCombatant(built.world.combatants, id));

    for (const wolf of wolves) {
      for (const guard of guards) {
        expect(coverBetween(built.world.grid, wolf.position, guard.position)).toBe("full");
      }
    }
  });
});
