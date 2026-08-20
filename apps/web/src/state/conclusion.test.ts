import { describe, expect, it } from "vitest";
import type { Combatant, SessionState } from "@ai-dm/schemas";
import { conclusionOf } from "./conclusion.js";
import { combatant } from "./combatant-fixture.js";

function stateWith(combatants: Combatant[]): SessionState {
  return {
    sessionId: "s1",
    rootSeed: 1,
    encounterId: "goblin-ambush",
    grid: { width: 1, height: 1, tiles: [["normal"]] },
    combatants,
    turnOrder: combatants.map((each) => each.combatantId),
    currentActorIndex: 0,
    round: 1,
    appliedClientMessageIds: [],
  };
}

describe("conclusionOf", () => {
  it("is ongoing while both factions have someone alive", () => {
    expect(
      conclusionOf(
        stateWith([combatant("hero", "party", "alive"), combatant("goblin-a", "hostile", "alive")]),
      ),
    ).toBe("ongoing");
  });

  it("is defeat when the party is wiped out", () => {
    // The expected outcome (C-31): `diesAtZeroHp` is pinned true
    // unconditionally, so the hero dies at 0 HP rather than falling
    // Unconscious, and two goblins out-damage one level-3 fighter. No
    // terminal frame is ever emitted (C-37) — the pipeline simply stops
    // answering — so this must be read from the projection and rendered as
    // a normal ending, not an error.
    expect(
      conclusionOf(
        stateWith([combatant("hero", "party", "dead"), combatant("goblin-a", "hostile", "alive")]),
      ),
    ).toBe("defeat");
  });

  it("is victory when no hostile is left alive", () => {
    expect(
      conclusionOf(
        stateWith([combatant("hero", "party", "alive"), combatant("goblin-a", "hostile", "dead")]),
      ),
    ).toBe("victory");
  });

  it("is ongoing before any combatant exists", () => {
    expect(conclusionOf(stateWith([]))).toBe("ongoing");
  });
});
