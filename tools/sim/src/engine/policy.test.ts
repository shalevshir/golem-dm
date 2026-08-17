import { describe, expect, it } from "vitest";
import { footprintDistanceFeet } from "@ai-dm/rules-engine";
import { buildScenario } from "../scenarios/build.js";
import { COVER_CORRIDOR } from "../scenarios/cover-corridor.js";
import { MELEE_BRAWL } from "../scenarios/melee-brawl.js";
import { RANGED_APPROACH } from "../scenarios/ranged-approach.js";
import { scriptedTurn } from "./policy.js";

describe("scriptedTurn", () => {
  it("attacks an adjacent enemy without moving", () => {
    const built = buildScenario(MELEE_BRAWL);
    const decided = scriptedTurn({
      world: built.world,
      actorId: "goblin_1",
      availableActions: built.availableActions.get("goblin_1") ?? [],
    });

    expect(decided?.turn.mainAction.actionType).toBe("attack");
    expect(decided?.turn.mainAction.targetIds).toEqual(["guard_1"]);
    expect(decided?.turn.movement ?? []).toHaveLength(0);
  });

  it("uses a ranged action when the enemy is far away", () => {
    const built = buildScenario(RANGED_APPROACH);
    const decided = scriptedTurn({
      world: built.world,
      actorId: "goblin_1",
      availableActions: built.availableActions.get("goblin_1") ?? [],
    });

    expect(decided?.turn.mainAction.actionType).toBe("attack");
    expect(decided?.turn.mainAction.actionId).toBe("shortbow");
  });

  it("moves into contact when no action reaches from where it stands", () => {
    const built = buildScenario(RANGED_APPROACH);
    // Melee only: the goblin must close the distance to act at all.
    const decided = scriptedTurn({
      world: built.world,
      actorId: "goblin_1",
      availableActions: [{ actionId: "scimitar", name: "Scimitar" }],
    });

    expect(decided?.turn.movement?.length).toBeGreaterThan(0);
    expect(decided?.plan.totalMovementFeet).toBeGreaterThan(0);
  });

  it("is deterministic — the same board yields the same turn", () => {
    const built = buildScenario(RANGED_APPROACH);
    const input = {
      world: built.world,
      actorId: "goblin_1",
      availableActions: built.availableActions.get("goblin_1") ?? [],
    };

    expect(scriptedTurn(input)?.turn).toEqual(scriptedTurn(input)?.turn);
  });

  it("returns a plan the engine validated, never an unchecked turn", () => {
    const built = buildScenario(MELEE_BRAWL);
    const decided = scriptedTurn({
      world: built.world,
      actorId: "goblin_1",
      availableActions: built.availableActions.get("goblin_1") ?? [],
    });

    expect(decided?.plan.economyAfter.actionUsed).toBe(true);
  });

  it("advances toward a far enemy instead of dodging in place when nothing is in range", () => {
    // Guard's spear reaches 20 ft; goblin_1 starts 60 ft away and the guard's
    // 30 ft speed cannot close that gap in one turn. Without the partial-advance
    // step the baseline would Dodge here every round, forever.
    const built = buildScenario(RANGED_APPROACH);
    const actor = built.world.combatants.find((each) => each.combatantId === "guard_1");
    if (actor === undefined) throw new Error("fixture missing guard_1");
    const goblin1 = built.world.combatants.find((each) => each.combatantId === "goblin_1");
    if (goblin1 === undefined) throw new Error("fixture missing goblin_1");

    const startDistanceFeet = footprintDistanceFeet(
      { anchor: actor.position, size: actor.size },
      { anchor: goblin1.position, size: goblin1.size },
    );

    const decided = scriptedTurn({
      world: built.world,
      actorId: "guard_1",
      availableActions: built.availableActions.get("guard_1") ?? [],
    });

    expect(decided).not.toBeNull();
    expect(decided?.turn.movement?.length).toBeGreaterThan(0);
    expect(decided?.plan.totalMovementFeet).toBeGreaterThan(0);
    // Open ground, no obstacles: the guard should spend its whole 30 ft budget.
    expect(decided?.plan.totalMovementFeet).toBe(30);

    const destination = decided?.turn.movement?.[0]?.destinationTile;
    expect(destination).toBeDefined();
    if (destination === undefined) throw new Error("unreachable");
    const endDistanceFeet = footprintDistanceFeet(
      { anchor: destination, size: actor.size },
      { anchor: goblin1.position, size: goblin1.size },
    );
    expect(endDistanceFeet).toBeLessThan(startDistanceFeet);
  });

  it("threads the one gap in a wall it cannot yet fully cross", () => {
    // wolf_1 must detour ~55 ft through the single passable gap at (8, 11) to
    // reach guard_1, well beyond its 40 ft speed. It should still make partial
    // progress rather than stall on Dodge for the whole encounter.
    const built = buildScenario(COVER_CORRIDOR);
    const actor = built.world.combatants.find((each) => each.combatantId === "wolf_1");
    if (actor === undefined) throw new Error("fixture missing wolf_1");
    const guard1 = built.world.combatants.find((each) => each.combatantId === "guard_1");
    if (guard1 === undefined) throw new Error("fixture missing guard_1");

    const startDistanceFeet = footprintDistanceFeet(
      { anchor: actor.position, size: actor.size },
      { anchor: guard1.position, size: guard1.size },
    );

    const decided = scriptedTurn({
      world: built.world,
      actorId: "wolf_1",
      availableActions: built.availableActions.get("wolf_1") ?? [],
    });

    expect(decided).not.toBeNull();
    expect(decided?.turn.mainAction.actionType).toBe("dodge");
    expect(decided?.turn.movement?.length).toBeGreaterThan(0);
    expect(decided?.plan.totalMovementFeet).toBeGreaterThan(0);
    expect(decided?.plan.totalMovementFeet).toBeLessThanOrEqual(40);

    const destination = decided?.turn.movement?.[0]?.destinationTile;
    expect(destination).toBeDefined();
    if (destination === undefined) throw new Error("unreachable");
    const endDistanceFeet = footprintDistanceFeet(
      { anchor: destination, size: actor.size },
      { anchor: guard1.position, size: guard1.size },
    );
    expect(endDistanceFeet).toBeLessThan(startDistanceFeet);
  });
});
