import { describe, expect, it } from "vitest";
import { validateExecuteTurn } from "@ai-dm/rules-engine";
import type { ExecuteTurn } from "@ai-dm/schemas";
import { buildScenario } from "../scenarios/build.js";
import { MELEE_BRAWL } from "../scenarios/melee-brawl.js";
import { d20Exactly, scripted } from "../rng.js";
import { applyTurn } from "./resolve.js";

const built = buildScenario(MELEE_BRAWL);

function attack(actorId: string, targetId: string, actionId: string): ExecuteTurn {
  return {
    actorId,
    mainAction: { actionType: "attack", actionId, targetIds: [targetId] },
    tacticalRationaleEnglish: "Test fixture.",
  };
}

function resolve(turn: ExecuteTurn, rolls: readonly number[]) {
  const actor = built.world.combatants.find((each) => each.combatantId === turn.actorId);
  if (actor === undefined) throw new Error("no actor");
  const validation = validateExecuteTurn(turn, actor, built.world);
  if (!validation.valid) {
    throw new Error(
      `fixture turn is illegal: ${validation.rejections.map((r) => r.reason).join()}`,
    );
  }
  return applyTurn({
    world: built.world,
    actorId: turn.actorId,
    turn,
    plan: validation.plan,
    context: { statBlocks: built.statBlocks },
    rng: scripted(rolls),
  });
}

describe("applyTurn", () => {
  it("applies damage on a hit and leaves the input world untouched", () => {
    // Guard AC 16; scimitar +4 needs a 12. Roll 18, then 1d6 -> 4 (+2 = 6).
    const { world, effect } = resolve(attack("goblin_1", "guard_1", "scimitar"), [
      d20Exactly(18),
      0.5,
    ]);

    expect(effect.attacks).toHaveLength(1);
    expect(effect.attacks[0]?.outcome).toBe("hit");
    expect(effect.damageDealt).toBe(6);

    const after = world.combatants.find((each) => each.combatantId === "guard_1");
    const before = built.world.combatants.find((each) => each.combatantId === "guard_1");
    expect(after?.currentHp).toBe((before?.currentHp ?? 0) - 6);
    expect(before?.currentHp).toBe(before?.maxHp);
  });

  it("deals no damage on a miss", () => {
    const { effect } = resolve(attack("goblin_1", "guard_1", "scimitar"), [d20Exactly(3)]);

    expect(effect.attacks[0]?.outcome).toBe("miss");
    expect(effect.damageDealt).toBe(0);
  });

  it("doubles only the damage dice on a critical hit", () => {
    // Natural 20, then two d6 at 0.5 -> 4 each, plus the +2 modifier once.
    const { effect } = resolve(attack("goblin_1", "guard_1", "scimitar"), [
      d20Exactly(20),
      0.5,
      0.5,
    ]);

    expect(effect.attacks[0]?.outcome).toBe("critical_hit");
    expect(effect.damageDealt).toBe(10);
  });

  it("kills a monster outright at 0 HP rather than downing it", () => {
    const wounded = {
      ...built.world,
      combatants: built.world.combatants.map((each) =>
        each.combatantId === "guard_1" ? { ...each, currentHp: 3 } : each,
      ),
    };
    const turn = attack("goblin_1", "guard_1", "scimitar");
    const actor = wounded.combatants.find((each) => each.combatantId === "goblin_1");
    if (actor === undefined) throw new Error("no actor");
    const validation = validateExecuteTurn(turn, actor, wounded);
    if (!validation.valid) throw new Error("fixture turn is illegal");

    const { world, effect } = applyTurn({
      world: wounded,
      actorId: "goblin_1",
      turn,
      plan: validation.plan,
      context: { statBlocks: built.statBlocks },
      rng: scripted([d20Exactly(18), 0.5]),
    });

    expect(effect.killed).toEqual(["guard_1"]);
    expect(world.combatants.find((each) => each.combatantId === "guard_1")?.status).toBe("dead");
  });

  it("flags a non-attack action as mechanically inert", () => {
    const dodge: ExecuteTurn = {
      actorId: "goblin_1",
      mainAction: { actionType: "dodge" },
      tacticalRationaleEnglish: "Test fixture.",
    };
    const { effect } = resolve(dodge, []);

    expect(effect.nonAttackAction).toBe(true);
    expect(effect.attacks).toHaveLength(0);
  });

  it("records an action the actor does not own instead of throwing", () => {
    // The validator resolves ranges from a world-wide map and never checks that
    // an actionId belongs to the actor, so this turn is legal but unresolvable.
    const foreign = attack("goblin_1", "guard_1", "greatclub");
    const actor = built.world.combatants.find((each) => each.combatantId === "goblin_1");
    if (actor === undefined) throw new Error("no actor");
    const validation = validateExecuteTurn(foreign, actor, built.world);
    if (!validation.valid) throw new Error("expected the engine to accept a foreign actionId");

    const { effect } = applyTurn({
      world: built.world,
      actorId: "goblin_1",
      turn: foreign,
      plan: validation.plan,
      context: { statBlocks: built.statBlocks },
      rng: scripted([]),
    });

    expect(effect.unresolvedActionIds).toEqual(["greatclub"]);
    expect(effect.attacks).toHaveLength(0);
  });

  it("moves the actor to the last segment's destination", () => {
    const move: ExecuteTurn = {
      actorId: "goblin_2",
      movement: [{ destinationTile: [4, 8], pathType: "direct" }],
      mainAction: { actionType: "dodge" },
      tacticalRationaleEnglish: "Test fixture.",
    };
    const { world, effect } = resolve(move, []);

    expect(world.combatants.find((each) => each.combatantId === "goblin_2")?.position).toEqual([
      4, 8,
    ]);
    expect(effect.movedFeet).toBe(5);
  });
});
