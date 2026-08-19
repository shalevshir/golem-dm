import { describe, expect, it } from "vitest";
import { ActionEconomy } from "@ai-dm/schemas";
import type { Combatant, MonsterStatBlock } from "@ai-dm/schemas";
import { affordancesFor } from "./affordances.js";
import { validateExecuteTurn } from "./validate-turn.js";
import type { CombatWorld } from "./validate-turn.js";

const goblinStatBlock: MonsterStatBlock = {
  monsterId: "goblin_warrior",
  nameEnglish: "Goblin Warrior",
  size: "small",
  creatureType: "Fey (Goblinoid)",
  alignment: "Chaotic Neutral",
  armorClass: 15,
  hitPoints: { average: 10, diceNotation: "3d6" },
  speedFeet: 30,
  abilities: { str: 8, dex: 15, con: 10, int: 10, wis: 8, cha: 8 },
  challengeRating: "1/4",
  proficiencyBonus: 2,
  attacksPerAction: 1,
  actions: [
    {
      actionId: "scimitar",
      nameEnglish: "Scimitar",
      attackBonus: 4,
      reachFeet: 5,
      damage: { diceNotation: "1d6+2", averageDamage: 5, damageType: "slashing" },
      extraDamage: [],
    },
  ],
};

function combatant(overrides: Partial<Combatant> & Pick<Combatant, "combatantId">): Combatant {
  return {
    faction: "hostile",
    position: [5, 5],
    size: "small",
    speedFeet: 30,
    reachFeet: 5,
    maxHp: 10,
    currentHp: 10,
    tempHp: 0,
    armorClass: 15,
    conditions: [],
    exhaustionLevel: 0,
    attacksPerAction: 1,
    spellSlots: {},
    actionEconomy: ActionEconomy.parse({}),
    status: "alive",
    ...overrides,
  };
}

/** An open field with no terrain, so exclusions come only from what we place. */
function openWorld(combatants: readonly Combatant[], size = 12): CombatWorld {
  return {
    grid: {
      width: size,
      height: size,
      tiles: Array.from({ length: size }, () =>
        Array.from({ length: size }, () => "normal" as const),
      ),
    },
    combatants,
  };
}

describe("affordancesFor", () => {
  it("reaches every tile inside a 30 ft budget and none outside it", () => {
    const actor = combatant({ combatantId: "goblin-a", position: [5, 5] });
    const result = affordancesFor(openWorld([actor]), "goblin-a", goblinStatBlock);

    // 30 ft on a 5 ft grid is 6 tiles of Chebyshev distance (ADR-0003), so the
    // reachable set is the 13x13 square around the actor minus its own tile,
    // clipped to the 12x12 grid.
    expect(result.reachableTiles).toContainEqual([11, 11]);
    expect(result.reachableTiles).not.toContainEqual([5, 5]);
    expect(result.reachableTiles.every(([x, y]) => x >= 0 && x < 12 && y >= 0 && y < 12)).toBe(
      true,
    );
    for (const [x, y] of result.reachableTiles) {
      expect(Math.max(Math.abs(x - 5), Math.abs(y - 5))).toBeLessThanOrEqual(6);
    }
  });

  it("narrows reachability after partial movement", () => {
    const fresh = combatant({ combatantId: "goblin-a", position: [5, 5] });
    const moved = combatant({
      combatantId: "goblin-a",
      position: [5, 5],
      actionEconomy: ActionEconomy.parse({ movementUsedFeet: 25 }),
    });

    const freshTiles = affordancesFor(
      openWorld([fresh]),
      "goblin-a",
      goblinStatBlock,
    ).reachableTiles;
    const movedTiles = affordancesFor(
      openWorld([moved]),
      "goblin-a",
      goblinStatBlock,
    ).reachableTiles;

    expect(movedTiles.length).toBeLessThan(freshTiles.length);
    // 5 ft left is exactly one tile in any direction.
    for (const [x, y] of movedTiles) {
      expect(Math.max(Math.abs(x - 5), Math.abs(y - 5))).toBe(1);
    }
  });

  it("reports no reachable tiles once the movement budget is spent", () => {
    const spent = combatant({
      combatantId: "goblin-a",
      actionEconomy: ActionEconomy.parse({ movementUsedFeet: 30 }),
    });
    expect(affordancesFor(openWorld([spent]), "goblin-a", goblinStatBlock).reachableTiles).toEqual(
      [],
    );
  });

  it("excludes a tile another combatant occupies", () => {
    const actor = combatant({ combatantId: "goblin-a", position: [5, 5] });
    const blocker = combatant({ combatantId: "hero", faction: "party", position: [6, 5] });
    const result = affordancesFor(openWorld([actor, blocker]), "goblin-a", goblinStatBlock);

    expect(result.reachableTiles).not.toContainEqual([6, 5]);
    expect(result.reachableTiles).toContainEqual([6, 6]);
  });

  it("excludes tiles walled off by blocking terrain", () => {
    const actor = combatant({ combatantId: "goblin-a", position: [1, 1] });
    const world = openWorld([actor], 5);
    // A full-height wall on column 2 seals the actor into columns 0-1.
    // `TerrainType` is ["normal", "difficult", "blocking", "half_cover",
    // "three_quarters_cover"] — "blocking" is the impassable one; there is no
    // "wall" member.
    for (let y = 0; y < 5; y += 1) {
      const row = world.grid.tiles[y];
      // `noUncheckedIndexedAccess` makes this `T | undefined`; a non-null
      // assertion would fail `@typescript-eslint/no-non-null-assertion`.
      if (row !== undefined) row[2] = "blocking";
    }

    const result = affordancesFor(world, "goblin-a", goblinStatBlock);
    expect(result.reachableTiles.every(([x]) => x < 2)).toBe(true);
    expect(result.reachableTiles).not.toContainEqual([3, 1]);
  });

  it("offers a stat-block attack against a target in reach and no one else", () => {
    const actor = combatant({ combatantId: "goblin-a", position: [5, 5] });
    const adjacent = combatant({ combatantId: "hero", faction: "party", position: [6, 5] });
    const distant = combatant({ combatantId: "far", faction: "party", position: [11, 11] });

    const result = affordancesFor(
      openWorld([actor, adjacent, distant]),
      "goblin-a",
      goblinStatBlock,
    );
    const scimitar = result.actions.find((each) => each.actionId === "scimitar");

    expect(scimitar).toBeDefined();
    expect(scimitar?.requiresTarget).toBe(true);
    expect(scimitar?.targetableCombatantIds).toEqual(["hero"]);
  });

  it("offers the universal no-target actions with no targets", () => {
    const actor = combatant({ combatantId: "goblin-a" });
    const result = affordancesFor(openWorld([actor]), "goblin-a", goblinStatBlock);
    const dodge = result.actions.find((each) => each.actionType === "dodge");

    expect(dodge).toBeDefined();
    expect(dodge?.requiresTarget).toBe(false);
    expect(dodge?.targetableCombatantIds).toEqual([]);
    expect(dodge?.actionId).toBeUndefined();
  });

  it("offers no actions at all once the action is spent", () => {
    const acted = combatant({
      combatantId: "goblin-a",
      actionEconomy: ActionEconomy.parse({ actionUsed: true }),
    });
    expect(affordancesFor(openWorld([acted]), "goblin-a", goblinStatBlock).actions).toEqual([]);
  });

  it("offers nothing to a dead actor", () => {
    const dead = combatant({ combatantId: "goblin-a", currentHp: 0, status: "dead" });
    const result = affordancesFor(openWorld([dead]), "goblin-a", goblinStatBlock);
    expect(result).toEqual({ actorId: "goblin-a", reachableTiles: [], actions: [] });
  });

  it("agrees with validateExecuteTurn on a destination the validator rejects", () => {
    // The guard that this is the validator and not a parallel implementation:
    // take a tile affordances excluded, and confirm the validator excludes it
    // too — for a movement reason, not an incidental one.
    const actor = combatant({ combatantId: "goblin-a", position: [5, 5] });
    const blocker = combatant({ combatantId: "hero", faction: "party", position: [6, 5] });
    const world = openWorld([actor, blocker]);

    expect(affordancesFor(world, "goblin-a", goblinStatBlock).reachableTiles).not.toContainEqual([
      6, 5,
    ]);

    const verdict = validateExecuteTurn(
      {
        actorId: "goblin-a",
        movement: [{ destinationTile: [6, 5], pathType: "direct" }],
        mainAction: { actionType: "dodge" },
        tacticalRationaleEnglish: "Cross-check fixture.",
      },
      actor,
      world,
    );

    expect(verdict.valid).toBe(false);
    expect(!verdict.valid && verdict.rejections.map((each) => each.reason)).toContain(
      "destination_occupied",
    );
  });

  it("agrees with validateExecuteTurn on every tile it does offer", () => {
    // The other direction: nothing affordances offers may be refused.
    const actor = combatant({ combatantId: "goblin-a", position: [5, 5] });
    const world = openWorld([actor]);

    for (const tile of affordancesFor(world, "goblin-a", goblinStatBlock).reachableTiles) {
      const verdict = validateExecuteTurn(
        {
          actorId: "goblin-a",
          movement: [{ destinationTile: tile, pathType: "direct" }],
          mainAction: { actionType: "dodge" },
          tacticalRationaleEnglish: "Cross-check fixture.",
        },
        actor,
        world,
      );
      expect(verdict.valid).toBe(true);
    }
  });
});
