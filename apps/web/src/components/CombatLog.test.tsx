import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { CatalogueCombatant } from "../net/api.js";
import type { CombatLogTurn } from "../state/store.js";
import { CombatLog } from "./CombatLog.js";
import { he } from "../i18n.js";

const catalogue: CatalogueCombatant[] = [
  { combatantId: "hero", nameEnglish: "Guard", maxHp: 11, faction: "party" },
  { combatantId: "goblin-a", nameEnglish: "Goblin Warrior", maxHp: 10, faction: "hostile" },
];

describe("CombatLog", () => {
  it("renders nothing when there are no turns yet", () => {
    const { container } = render(<CombatLog turns={[]} catalogue={catalogue} />);
    expect(container.querySelector(".log-entry")).toBeNull();
  });

  it("renders a turn header naming the actor via the catalogue", () => {
    const turns: CombatLogTurn[] = [
      { actorId: "hero", actionType: "dodge", movedFeet: 0, attacks: [], forfeited: false },
    ];
    render(<CombatLog turns={turns} catalogue={catalogue} />);
    expect(screen.getByText(/Guard/)).toBeInTheDocument();
    expect(screen.getByText(new RegExp(he.log.turnOf))).toBeInTheDocument();
  });

  it("renders a non-attack action's label", () => {
    const turns: CombatLogTurn[] = [
      { actorId: "hero", actionType: "dodge", movedFeet: 0, attacks: [], forfeited: false },
    ];
    render(<CombatLog turns={turns} catalogue={catalogue} />);
    expect(screen.getByText(he.actions.dodge)).toBeInTheDocument();
  });

  it("renders a movement line when movedFeet is greater than zero", () => {
    const turns: CombatLogTurn[] = [
      { actorId: "hero", actionType: "dash", movedFeet: 30, attacks: [], forfeited: false },
    ];
    render(<CombatLog turns={turns} catalogue={catalogue} />);
    expect(screen.getByText(/30/)).toBeInTheDocument();
    expect(screen.getByText(new RegExp(he.log.feet))).toBeInTheDocument();
  });

  it("renders an attack line with the roll, target AC, outcome and damage", () => {
    const turns: CombatLogTurn[] = [
      {
        actorId: "goblin-a",
        actionType: "attack",
        movedFeet: 0,
        forfeited: false,
        attacks: [
          {
            attackerId: "goblin-a",
            targetId: "hero",
            actionId: "scimitar",
            outcome: "critical_hit",
            damage: 10,
            targetStatusAfter: "alive",
            attackRoll: { naturalRoll: 20, rolls: [20], total: 24, targetArmorClass: 16 },
            damageRolls: [
              { kind: "dice", notation: "1d6+2", rolls: [4, 4], modifier: 2, total: 10 },
            ],
          },
        ],
      },
    ];
    render(<CombatLog turns={turns} catalogue={catalogue} />);
    expect(screen.getByText(he.log.criticalHit)).toBeInTheDocument();
    expect(screen.getByText(/20/)).toBeInTheDocument(); // natural roll
    expect(screen.getByText(/24/)).toBeInTheDocument(); // total
    expect(screen.getByText(/16/)).toBeInTheDocument(); // target AC
    expect(screen.getByText(/10/)).toBeInTheDocument(); // damage total
  });

  it("renders a miss with no damage line", () => {
    const turns: CombatLogTurn[] = [
      {
        actorId: "goblin-a",
        actionType: "attack",
        movedFeet: 0,
        forfeited: false,
        attacks: [
          {
            attackerId: "goblin-a",
            targetId: "hero",
            actionId: "scimitar",
            outcome: "miss",
            damage: 0,
            targetStatusAfter: "alive",
            attackRoll: { naturalRoll: 3, rolls: [3], total: 7, targetArmorClass: 16 },
            damageRolls: [],
          },
        ],
      },
    ];
    render(<CombatLog turns={turns} catalogue={catalogue} />);
    expect(screen.getByText(he.log.miss)).toBeInTheDocument();
    expect(screen.queryByText(he.log.damage)).not.toBeInTheDocument();
  });

  it("renders a flat damage roll without dice notation", () => {
    const turns: CombatLogTurn[] = [
      {
        actorId: "goblin-a",
        actionType: "attack",
        movedFeet: 0,
        forfeited: false,
        attacks: [
          {
            attackerId: "goblin-a",
            targetId: "hero",
            actionId: "dagger",
            outcome: "hit",
            damage: 1,
            targetStatusAfter: "alive",
            attackRoll: { naturalRoll: 15, rolls: [15], total: 18, targetArmorClass: 12 },
            damageRolls: [{ kind: "flat", total: 1 }],
          },
        ],
      },
    ];
    render(<CombatLog turns={turns} catalogue={catalogue} />);
    expect(screen.getByText(he.log.hit)).toBeInTheDocument();
  });

  it("renders the forfeited line and no action label for a timed-out turn", () => {
    const turns: CombatLogTurn[] = [
      { actorId: "goblin-a", actionType: undefined, movedFeet: 0, attacks: [], forfeited: true },
    ];
    render(<CombatLog turns={turns} catalogue={catalogue} />);
    expect(screen.getByText(he.log.forfeited)).toBeInTheDocument();
  });

  it("falls back to the raw actorId when the catalogue has no matching entry", () => {
    const turns: CombatLogTurn[] = [
      { actorId: "unknown-id", actionType: "dodge", movedFeet: 0, attacks: [], forfeited: false },
    ];
    render(<CombatLog turns={turns} catalogue={catalogue} />);
    expect(screen.getByText(/unknown-id/)).toBeInTheDocument();
  });
});
