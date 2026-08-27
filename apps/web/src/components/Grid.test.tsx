import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { EncounterState, TurnAffordances } from "@ai-dm/schemas";
import { combatant as buildCombatant } from "../state/combatant-fixture.js";
import { Grid } from "./Grid.js";

// Reuses the shared fixture from an earlier task (state/combatant-fixture.ts)
// rather than hand-building a third `Combatant` factory; it already covers
// this shape via `overrides`, it just doesn't default position from an arg.
function combatant(id: string, position: [number, number]) {
  return buildCombatant(id, id === "hero" ? "party" : "hostile", "alive", { position });
}

const snapshot: EncounterState = {
  encounterId: "goblin-ambush",
  grid: {
    width: 4,
    height: 4,
    tiles: Array.from({ length: 4 }, () => Array.from({ length: 4 }, () => "normal" as const)),
  },
  combatants: [combatant("hero", [1, 1]), combatant("goblin-a", [2, 1])],
  turnOrder: ["hero", "goblin-a"],
  currentActorIndex: 0,
  round: 1,
};

const catalogue = [
  {
    combatantId: "hero",
    nameEnglish: "Guard",
    nameHebrew: "שומר",
    maxHp: 11,
    faction: "party" as const,
  },
  {
    combatantId: "goblin-a",
    nameEnglish: "Goblin Warrior",
    nameHebrew: "גובלין לוחם",
    maxHp: 10,
    faction: "hostile" as const,
  },
];

const affordances: TurnAffordances = {
  actorId: "hero",
  reachableTiles: [
    [0, 1],
    [1, 2],
  ],
  actions: [],
};

describe("Grid", () => {
  it("offers exactly the reachable tiles the server sent and no others", () => {
    // The test that the client is not quietly computing reach: the hero at
    // [1,1] has neighbours the server did NOT list, and none of them may be
    // offered.
    render(
      <Grid
        snapshot={snapshot}
        affordances={affordances}
        catalogue={catalogue}
        selectedTile={null}
        onTileClick={() => undefined}
        onCombatantClick={() => undefined}
      />,
    );

    expect(screen.getByRole("button", { name: /\(0,1\)/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /\(1,2\)/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /\(0,0\)/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /\(2,2\)/ })).not.toBeInTheDocument();
  });

  it("offers no tiles at all when there are no affordances", () => {
    render(
      <Grid
        snapshot={snapshot}
        affordances={null}
        catalogue={catalogue}
        selectedTile={null}
        onTileClick={() => undefined}
        onCombatantClick={() => undefined}
      />,
    );
    expect(screen.queryByRole("button", { name: /\(0,1\)/ })).not.toBeInTheDocument();
  });

  it("reports a clicked tile back as a Tile", async () => {
    const onTileClick = vi.fn();
    render(
      <Grid
        snapshot={snapshot}
        affordances={affordances}
        catalogue={catalogue}
        selectedTile={null}
        onTileClick={onTileClick}
        onCombatantClick={() => undefined}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: /\(1,2\)/ }));
    expect(onTileClick).toHaveBeenCalledWith([1, 2]);
  });

  it("wraps every isolated fragment in <bdi> inside the RTL document", () => {
    // The mixed-direction rule from apps/web/CLAUDE.md: this component now
    // renders `nameHebrew`, matching the surrounding RTL document, so the
    // combatant name itself is no longer an LTR fragment -- but <bdi> stays
    // load-bearing around it because the `combatantId` fallback used when
    // the catalogue lookup misses (see "falls back to the combatant id"
    // below) is still Latin. Tile coordinates and the HP ratio are LTR
    // content regardless of catalogue data (digits with a "," / "/"
    // separator), so they need isolating on their own terms. Three distinct
    // fragment kinds get isolated: combatant names, tile coordinates, and HP
    // ratios — all three must appear as their own <bdi> node, not merely
    // somewhere in the rendered text.
    const { container } = render(
      <Grid
        snapshot={snapshot}
        affordances={affordances}
        catalogue={catalogue}
        selectedTile={null}
        onTileClick={() => undefined}
        onCombatantClick={() => undefined}
      />,
    );

    const isolated = Array.from(container.querySelectorAll("bdi"), (each) => each.textContent);
    expect(isolated).toContain("גובלין לוחם");
    expect(isolated).toContain("שומר");
    // Tile-coordinate fragments, e.g. "(0,1)" from the reachable-tile list.
    expect(isolated).toContain("(0,1)");
    expect(isolated).toContain("(1,2)");
    // The HP ratio fragment, e.g. "11/11", rendered beside each name.
    expect(isolated).toContain("11/11");
  });

  it("falls back to the combatant id when the catalogue has no entry", () => {
    const { container } = render(
      <Grid
        snapshot={snapshot}
        affordances={affordances}
        catalogue={[]}
        selectedTile={null}
        onTileClick={() => undefined}
        onCombatantClick={() => undefined}
      />,
    );
    const isolated = Array.from(container.querySelectorAll("bdi"), (each) => each.textContent);
    expect(isolated).toContain("hero");
  });

  it("renders the Hebrew name, not the English one", () => {
    render(
      <Grid
        snapshot={snapshot}
        affordances={affordances}
        catalogue={catalogue}
        selectedTile={null}
        onTileClick={() => undefined}
        onCombatantClick={() => undefined}
      />,
    );
    expect(screen.getByText(/גובלין לוחם/)).toBeInTheDocument();
    expect(screen.queryByText(/Goblin Warrior/)).not.toBeInTheDocument();
  });
});
