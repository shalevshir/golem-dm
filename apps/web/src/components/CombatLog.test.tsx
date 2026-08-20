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
    const { container } = render(<CombatLog turns={turns} catalogue={catalogue} />);
    expect(screen.getByText(he.log.miss)).toBeInTheDocument();
    // queryByText(he.log.damage) would be a vacuous check here: the
    // he.log.damage string sits as a bare text-node sibling to <bdi>
    // elements and other text fragments inside AttackLine's <p> (same
    // structural situation the outcome label was in before it got wrapped
    // in <span> -- see the comment at CombatLog.tsx's AttackLine), so
    // getNodeText's direct-text-node-only reconstruction never isolates the
    // he.log.damage string as its own queryable node even when it DOES
    // render. An exact-string queryByText for it is therefore always null,
    // regardless of whether the guard at CombatLog.tsx:65 actually
    // suppressed the fragment -- it can't fail. A container-text substring
    // check has no such blind spot.
    expect(container.textContent).not.toContain(he.log.damage);
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

  it("wraps every English name in <bdi> inside the RTL document", () => {
    // Pins the mixed-direction convention (apps/web/CLAUDE.md) the same way
    // Grid.test.tsx and ActionBar.test.tsx pin it for their own English
    // fragments: not merely that an English name appears somewhere in the
    // rendered text, but that it appears as its own <bdi> node. A turn with
    // an attack exercises both the turn header's actor name and the attack
    // line's attacker/target names.
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
            outcome: "hit",
            damage: 6,
            targetStatusAfter: "alive",
            attackRoll: { naturalRoll: 15, rolls: [15], total: 18, targetArmorClass: 12 },
            damageRolls: [{ kind: "dice", notation: "1d6+2", rolls: [4], modifier: 2, total: 6 }],
          },
        ],
      },
    ];
    const { container } = render(<CombatLog turns={turns} catalogue={catalogue} />);

    const isolated = Array.from(container.querySelectorAll("bdi"), (each) => each.textContent);
    expect(isolated).toContain("Goblin Warrior");
    expect(isolated).toContain("Guard");
  });
});
