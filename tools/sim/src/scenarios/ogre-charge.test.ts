// Geometry regression: without this, the mud band could sit off the optimal
// route (cheaper to walk around than through) and difficult-terrain doubling
// would never bind. Uses the rules engine's own `findPath`, which already
// knows footprint size and difficult-terrain cost, rather than a hand-rolled
// copy of that arithmetic.
import { describe, expect, it } from "vitest";
import { findPath } from "@ai-dm/rules-engine";
import type { Combatant } from "@ai-dm/schemas";
import { buildScenario } from "./build.js";
import { OGRE_CHARGE } from "./ogre-charge.js";

function requireCombatant(combatants: readonly Combatant[], combatantId: string): Combatant {
  const found = combatants.find((each) => each.combatantId === combatantId);
  if (found === undefined) {
    throw new Error(`Expected combatant ${combatantId} in fixture`);
  }
  return found;
}

describe("ogre-charge geometry", () => {
  it("forces the ogre's shortest path through difficult terrain, costing more than its speed", () => {
    const built = buildScenario(OGRE_CHARGE);
    const ogre = requireCombatant(built.world.combatants, "ogre_1");
    const guard = requireCombatant(built.world.combatants, "guard_1");

    const path = findPath(built.world.grid, ogre.position, guard.position, { size: ogre.size });
    expect(path).not.toBeNull();
    expect(path?.costFeet).toBeGreaterThan(ogre.speedFeet);
    expect(path?.path.some(([x, y]) => built.world.grid.tiles[y]?.[x] === "difficult")).toBe(true);
  });
});
