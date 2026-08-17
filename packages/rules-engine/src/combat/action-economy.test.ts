import { describe, expect, it } from "vitest";
import type { ActionEconomy, Combatant } from "@ai-dm/schemas";
import {
  effectiveSpeedFeet,
  isIncapacitated,
  movementBudgetFeet,
  spendAction,
  spendAttack,
  spendBonusAction,
  spendMovement,
  spendReaction,
  startTurn,
} from "./action-economy.js";
import { combatant } from "./test-fixtures.js";

const FRESH: ActionEconomy = {
  actionUsed: false,
  bonusActionUsed: false,
  reactionUsed: false,
  movementUsedFeet: 0,
  attacksMade: 0,
};

describe("startTurn", () => {
  it("opens the turn with nothing spent, including a refreshed reaction", () => {
    expect(startTurn()).toStrictEqual(FRESH);
  });
});

describe("spendAction", () => {
  it("marks the action as used", () => {
    const result = spendAction(FRESH);
    expect(result.ok).toBe(true);
    expect(result.ok && result.economy.actionUsed).toBe(true);
  });

  it("refuses a second action in the same turn", () => {
    const result = spendAction({ ...FRESH, actionUsed: true });
    expect(result.ok).toBe(false);
    expect(result.ok || result.reason).toBe("action_already_used");
  });
});

describe("spendBonusAction", () => {
  it("marks the bonus action as used", () => {
    const result = spendBonusAction(FRESH);
    expect(result.ok && result.economy.bonusActionUsed).toBe(true);
  });

  it("refuses a second bonus action in the same turn", () => {
    const result = spendBonusAction({ ...FRESH, bonusActionUsed: true });
    expect(result.ok || result.reason).toBe("bonus_action_already_used");
  });

  it("does not consume the action", () => {
    const result = spendBonusAction(FRESH);
    expect(result.ok && result.economy.actionUsed).toBe(false);
  });
});

describe("spendReaction", () => {
  it("marks the reaction as used", () => {
    const result = spendReaction(FRESH);
    expect(result.ok && result.economy.reactionUsed).toBe(true);
  });

  it("refuses a second reaction before the turn refreshes", () => {
    const result = spendReaction({ ...FRESH, reactionUsed: true });
    expect(result.ok || result.reason).toBe("reaction_already_used");
  });
});

describe("spendMovement", () => {
  it("accumulates feet against the budget", () => {
    const result = spendMovement(FRESH, 15, 30);
    expect(result.ok && result.economy.movementUsedFeet).toBe(15);
  });

  it("counts movement already spent earlier in the turn", () => {
    const result = spendMovement({ ...FRESH, movementUsedFeet: 25 }, 10, 30);
    expect(result.ok || result.reason).toBe("movement_exceeds_speed");
  });

  it("allows spending the budget exactly", () => {
    expect(spendMovement(FRESH, 30, 30).ok).toBe(true);
  });

  it("refuses a single step beyond the budget", () => {
    expect(spendMovement(FRESH, 35, 30).ok).toBe(false);
  });
});

describe("spendAttack", () => {
  it("counts an attack against the actor's attack budget", () => {
    const result = spendAttack(FRESH, 2);
    expect(result.ok && result.economy.attacksMade).toBe(1);
  });

  it("refuses more attacks than the Attack action grants", () => {
    const result = spendAttack({ ...FRESH, attacksMade: 1 }, 1);
    expect(result.ok || result.reason).toBe("extra_attacks_exceed_budget");
  });

  it("allows a second attack when the actor has Extra Attack", () => {
    expect(spendAttack({ ...FRESH, attacksMade: 1 }, 2).ok).toBe(true);
  });
});

describe("effectiveSpeedFeet", () => {
  it("is the base speed for an unencumbered creature", () => {
    expect(effectiveSpeedFeet(combatant({ combatantId: "a", speedFeet: 30 }))).toBe(30);
  });

  it("subtracts 5 ft per level of 2024 exhaustion", () => {
    const actor = combatant({ combatantId: "a", speedFeet: 30, exhaustionLevel: 2 });
    expect(effectiveSpeedFeet(actor)).toBe(20);
  });

  it("never drops below zero", () => {
    const actor = combatant({ combatantId: "a", speedFeet: 10, exhaustionLevel: 5 });
    expect(effectiveSpeedFeet(actor)).toBe(0);
  });

  it.each(["grappled", "restrained", "paralyzed", "stunned", "unconscious", "petrified"] as const)(
    "is zero while %s",
    (condition) => {
      const actor = combatant({
        combatantId: "a",
        speedFeet: 30,
        conditions: [{ condition, durationRounds: null }],
      });
      expect(effectiveSpeedFeet(actor)).toBe(0);
    },
  );
});

describe("movementBudgetFeet", () => {
  it("is the effective speed on an ordinary turn", () => {
    expect(movementBudgetFeet(combatant({ combatantId: "a", speedFeet: 30 }))).toBe(30);
  });

  it("doubles when the actor takes the Dash action", () => {
    const actor = combatant({ combatantId: "a", speedFeet: 30 });
    expect(movementBudgetFeet(actor, { dashed: true })).toBe(60);
  });

  it("doubles the exhaustion-reduced speed, not the base speed", () => {
    const actor = combatant({ combatantId: "a", speedFeet: 30, exhaustionLevel: 1 });
    expect(movementBudgetFeet(actor, { dashed: true })).toBe(50);
  });
});

describe("isIncapacitated", () => {
  it.each(["incapacitated", "paralyzed", "petrified", "stunned", "unconscious"] as const)(
    "is true while %s",
    (condition) => {
      const actor: Combatant = combatant({
        combatantId: "a",
        conditions: [{ condition, durationRounds: null }],
      });
      expect(isIncapacitated(actor)).toBe(true);
    },
  );

  it.each(["prone", "grappled", "restrained", "poisoned", "frightened"] as const)(
    "is false while merely %s",
    (condition) => {
      const actor = combatant({
        combatantId: "a",
        conditions: [{ condition, durationRounds: null }],
      });
      expect(isIncapacitated(actor)).toBe(false);
    },
  );

  it("is false for an unafflicted creature", () => {
    expect(isIncapacitated(combatant({ combatantId: "a" }))).toBe(false);
  });
});
