import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ActionAffordance } from "@ai-dm/schemas";
import { he } from "../i18n.js";
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

const catalogue = [{ actionId: "spear", nameEnglish: "Spear", nameHebrew: "חנית" }];
const combatants = [
  {
    combatantId: "goblin-a",
    nameEnglish: "Goblin Warrior",
    nameHebrew: "גובלין לוחם",
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

    await userEvent.click(screen.getByRole("button", { name: he.actions.dodge }));
    expect(onCommit).toHaveBeenCalledWith(dodge, undefined);
  });

  it("asks for a target before committing a targeted action", async () => {
    const onCommit = vi.fn();
    const { container } = render(
      <ActionBar
        actions={[spear]}
        catalogue={catalogue}
        combatants={combatants}
        disabled={false}
        onCommit={onCommit}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "חנית" }));
    expect(onCommit).not.toHaveBeenCalled();

    // The combatant name in the target picker still needs <bdi>: it's
    // Hebrew now, same direction as the surrounding document, but the
    // `targetId` fallback used when the catalogue lookup misses is Latin
    // (see the comment inside `labelFor` in ActionBar.tsx). Pinned here the
    // same way `Grid.tsx` pins its own combatant-name <bdi> (98857bd), since
    // swapping it for a <span> leaves every other assertion in this file
    // green.
    expect(Array.from(container.querySelectorAll("bdi"), (each) => each.textContent)).toContain(
      "גובלין לוחם",
    );

    await userEvent.click(screen.getByRole("button", { name: "גובלין לוחם" }));
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
    expect(screen.getByRole("button", { name: "חנית" })).toBeDisabled();
  });

  it("disables the action list while a turn is resolving", () => {
    render(
      <ActionBar
        actions={[dodge]}
        catalogue={catalogue}
        combatants={combatants}
        disabled
        onCommit={() => undefined}
      />,
    );
    expect(screen.getByRole("button", { name: he.actions.dodge })).toBeDisabled();
  });

  it("disables the target picker's buttons too, not just the action list", async () => {
    // `disabled` is applied in two places in this component: the top-level
    // action list, and the target-picker buttons rendered once a targeted
    // action is pending. Only the first was covered above.
    const { rerender } = render(
      <ActionBar
        actions={[spear]}
        catalogue={catalogue}
        combatants={combatants}
        disabled={false}
        onCommit={() => undefined}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "חנית" }));
    expect(screen.getByRole("button", { name: "גובלין לוחם" })).not.toBeDisabled();

    rerender(
      <ActionBar
        actions={[spear]}
        catalogue={catalogue}
        combatants={combatants}
        disabled
        onCommit={() => undefined}
      />,
    );
    expect(screen.getByRole("button", { name: "גובלין לוחם" })).toBeDisabled();
  });

  it("closes the target picker when a new affordance frame drops the pending action", async () => {
    // A fresh `turn_affordances` frame can arrive while a target pick is in
    // progress. If the pending action isn't re-derived against the current
    // `actions` prop, the picker keeps showing the previous frame's target
    // list, and a click would commit a stale `ActionAffordance` the server
    // may no longer permit.
    const onCommit = vi.fn();
    const { rerender } = render(
      <ActionBar
        actions={[spear]}
        catalogue={catalogue}
        combatants={combatants}
        disabled={false}
        onCommit={onCommit}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "חנית" }));
    expect(screen.getByRole("button", { name: "גובלין לוחם" })).toBeInTheDocument();

    rerender(
      <ActionBar
        actions={[dodge]}
        catalogue={catalogue}
        combatants={combatants}
        disabled={false}
        onCommit={onCommit}
      />,
    );

    expect(screen.queryByRole("button", { name: "גובלין לוחם" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: he.actions.dodge })).toBeInTheDocument();
  });

  it("wraps the Hebrew action name in <bdi>", () => {
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
      "חנית",
    );
  });

  it("renders the Hebrew action name, not the English one", () => {
    render(
      <ActionBar
        actions={[spear]}
        catalogue={catalogue}
        combatants={combatants}
        disabled={false}
        onCommit={() => undefined}
      />,
    );
    expect(screen.getByText("חנית")).toBeInTheDocument();
    expect(screen.queryByText("Spear")).not.toBeInTheDocument();
  });
});
