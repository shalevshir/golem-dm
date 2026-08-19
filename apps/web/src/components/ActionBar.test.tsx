import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ActionAffordance } from "@ai-dm/schemas";
import { ActionBar } from "./ActionBar.js";

const spear: ActionAffordance = {
  actionType: "attack",
  actionId: "spear",
  requiresTarget: true,
  targetableCombatantIds: ["goblin-a"],
};

const unreachableSpear: ActionAffordance = { ...spear, targetableCombatantIds: [] };

const dodge: ActionAffordance = {
  actionType: "dodge",
  requiresTarget: false,
  targetableCombatantIds: [],
};

const catalogue = [{ actionId: "spear", nameEnglish: "Spear" }];
const combatants = [
  {
    combatantId: "goblin-a",
    nameEnglish: "Goblin Warrior",
    maxHp: 10,
    faction: "hostile" as const,
  },
];

describe("ActionBar", () => {
  it("commits a no-target action immediately", async () => {
    const onCommit = vi.fn();
    render(
      <ActionBar
        actions={[dodge]}
        catalogue={catalogue}
        combatants={combatants}
        disabled={false}
        onCommit={onCommit}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: /התחמקות/ }));
    expect(onCommit).toHaveBeenCalledWith(dodge, undefined);
  });

  it("asks for a target before committing a targeted action", async () => {
    const onCommit = vi.fn();
    render(
      <ActionBar
        actions={[spear]}
        catalogue={catalogue}
        combatants={combatants}
        disabled={false}
        onCommit={onCommit}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: /Spear/ }));
    expect(onCommit).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: /Goblin Warrior/ }));
    expect(onCommit).toHaveBeenCalledWith(spear, "goblin-a");
  });

  it("disables an action that requires a target when none is in range", () => {
    // `requiresTarget: true` with an empty target list is exactly the case an
    // empty list alone could not express — it renders disabled, not missing,
    // so the player can see the option exists and is simply out of reach.
    render(
      <ActionBar
        actions={[unreachableSpear]}
        catalogue={catalogue}
        combatants={combatants}
        disabled={false}
        onCommit={() => undefined}
      />,
    );
    expect(screen.getByRole("button", { name: /Spear/ })).toBeDisabled();
  });

  it("disables everything while a turn is resolving", () => {
    render(
      <ActionBar
        actions={[dodge]}
        catalogue={catalogue}
        combatants={combatants}
        disabled
        onCommit={() => undefined}
      />,
    );
    expect(screen.getByRole("button", { name: /התחמקות/ })).toBeDisabled();
  });

  it("wraps the English action name in <bdi>", () => {
    const { container } = render(
      <ActionBar
        actions={[spear]}
        catalogue={catalogue}
        combatants={combatants}
        disabled={false}
        onCommit={() => undefined}
      />,
    );
    expect(Array.from(container.querySelectorAll("bdi"), (each) => each.textContent)).toContain(
      "Spear",
    );
  });
});
