import { describe, expect, it } from "vitest";
import { buildCapabilityCard, buildSnapshot } from "./snapshot.js";
import { combatant, parseGrid } from "./test-fixtures.js";

const grid = parseGrid(`
  .....
  ..~..
  ....#
`);

const goblin = combatant({ combatantId: "gob-1", faction: "hostile", position: [0, 0] });
const hero = combatant({ combatantId: "pc-1", faction: "party", position: [4, 0], currentHp: 9 });

function world(...combatants: ReturnType<typeof combatant>[]) {
  return { grid, combatants };
}

describe("buildSnapshot", () => {
  it("precomputes the distance from the actor to every other combatant", () => {
    const snapshot = buildSnapshot({ world: world(goblin, hero), actorId: "gob-1" });

    // 4 tiles apart on a 5 ft grid.
    expect(snapshot.others[0]?.combatantId).toBe("pc-1");
    expect(snapshot.others[0]?.distanceFeet).toBe(20);
  });

  it("leaves the actor out of its own others list", () => {
    const snapshot = buildSnapshot({ world: world(goblin, hero), actorId: "gob-1" });

    expect(snapshot.actor.combatantId).toBe("gob-1");
    expect(snapshot.others.map((other) => other.combatantId)).toStrictEqual(["pc-1"]);
  });

  it("omits combatants who are dead or have fled, since neither can be targeted", () => {
    const corpse = combatant({ combatantId: "gob-2", position: [1, 0], status: "dead" });
    const runaway = combatant({ combatantId: "gob-3", position: [2, 0], status: "fled" });
    const downed = combatant({ combatantId: "pc-2", position: [3, 0], status: "unconscious" });

    const snapshot = buildSnapshot({
      world: world(goblin, hero, corpse, runaway, downed),
      actorId: "gob-1",
    });

    expect(snapshot.others.map((other) => other.combatantId)).toStrictEqual(["pc-1", "pc-2"]);
  });

  it("emits only the non-normal terrain, not the whole matrix", () => {
    const snapshot = buildSnapshot({ world: world(goblin), actorId: "gob-1" });

    expect(snapshot.grid.width).toBe(5);
    expect(snapshot.grid.height).toBe(3);
    expect(snapshot.grid.terrain).toStrictEqual([
      { tile: [2, 1], terrain: "difficult" },
      { tile: [4, 2], terrain: "blocking" },
    ]);
  });

  it("carries the actor's action economy, which is what limits the turn", () => {
    const spent = combatant({
      combatantId: "gob-1",
      actionEconomy: {
        actionUsed: true,
        bonusActionUsed: false,
        reactionUsed: false,
        movementUsedFeet: 15,
        attacksMade: 1,
      },
    });

    const snapshot = buildSnapshot({ world: world(spent), actorId: "gob-1" });

    expect(snapshot.actor.actionEconomy.actionUsed).toBe(true);
    expect(snapshot.actor.actionEconomy.movementUsedFeet).toBe(15);
  });

  it("omits turnOrder entirely when the caller has none", () => {
    const snapshot = buildSnapshot({ world: world(goblin), actorId: "gob-1" });

    expect("turnOrder" in snapshot).toBe(false);
  });

  it("passes turnOrder through when the caller supplies one", () => {
    const snapshot = buildSnapshot({
      world: world(goblin, hero),
      actorId: "gob-1",
      turnOrder: ["pc-1", "gob-1"],
    });

    expect(snapshot.turnOrder).toStrictEqual(["pc-1", "gob-1"]);
  });

  it("throws when asked for a combatant that is not in the encounter", () => {
    expect(() => buildSnapshot({ world: world(goblin), actorId: "nobody" })).toThrow(
      /No combatant nobody/,
    );
  });
});

describe("buildCapabilityCard", () => {
  it("carries the actor's reach, speed and attack count with its actions", () => {
    const card = buildCapabilityCard(goblin, [
      { actionId: "scimitar", name: "Scimitar", rangeFeet: 5 },
      { actionId: "shortbow", name: "Shortbow", rangeFeet: 80 },
    ]);

    expect(card.combatantId).toBe("gob-1");
    expect(card.speedFeet).toBe(30);
    expect(card.reachFeet).toBe(5);
    expect(card.attacksPerAction).toBe(1);
    expect(card.actions.map((action) => action.actionId)).toStrictEqual(["scimitar", "shortbow"]);
  });
});
