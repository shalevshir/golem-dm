import { describe, expect, it } from "vitest";
import type { GameEvent, SessionState } from "@ai-dm/schemas";
import { Combatant } from "@ai-dm/schemas";
import { fold, reduce } from "./reduce.js";

const base: SessionState = {
  sessionId: "s1",
  rootSeed: 7,
  encounterId: "e1",
  grid: { width: 2, height: 1, tiles: [["normal", "normal"]] },
  combatants: [],
  turnOrder: ["hero", "villain"],
  currentActorIndex: 0,
  round: 1,
  appliedClientMessageIds: [],
};

function event(sequence: number, type: GameEvent["type"], payload: Record<string, unknown>): GameEvent {
  return {
    eventId: `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
    sessionId: "s1",
    sequence,
    timestamp: "2026-08-19T10:00:00.000Z",
    type,
    payload,
  };
}

// C-12: the brief's four-field fixture cannot parse — `Combatant` requires
// `speedFeet`, `maxHp`, `currentHp` and `armorClass`, and defaults nine more
// fields that zod would materialise onto the output, breaking a `toEqual`
// against the bare input. This fixture is complete (shape copied from
// `packages/rules-engine/src/combat/test-fixtures.ts`), and the assertion
// below compares against the *parsed* value rather than the raw literal.
const rawCombatants = [
  {
    combatantId: "hero",
    faction: "party" as const,
    position: [1, 0] as [number, number],
    size: "medium" as const,
    speedFeet: 30,
    reachFeet: 5,
    maxHp: 10,
    currentHp: 3,
    tempHp: 0,
    armorClass: 16,
    conditions: [],
    exhaustionLevel: 0,
    attacksPerAction: 1,
    spellSlots: {},
    actionEconomy: {
      actionUsed: false,
      bonusActionUsed: false,
      reactionUsed: false,
      movementUsedFeet: 0,
      attacksMade: 0,
    },
    status: "alive" as const,
  },
];

describe("reduce", () => {
  it("records a player input's clientMessageId for idempotency", () => {
    const next = reduce(base, event(0, "player_input", { clientMessageId: "c1", actorId: "hero" }));
    expect(next.appliedClientMessageIds).toEqual(["c1"]);
  });

  it("replaces combatants from a state delta, round-tripping the full payload", () => {
    const next = reduce(base, event(1, "state_delta_applied", { combatants: rawCombatants }));
    expect(next.combatants).toEqual(Combatant.array().parse(rawCombatants));
  });

  it("advances the actor index without wrapping the round mid-cycle", () => {
    const next = reduce(base, event(2, "scene_changed", { kind: "turn_advanced" }));
    expect(next.currentActorIndex).toBe(1);
    expect(next.round).toBe(1);
  });

  it("wraps to the next round when the turn order completes", () => {
    const atEnd = { ...base, currentActorIndex: 1 };
    const next = reduce(atEnd, event(3, "scene_changed", { kind: "turn_advanced" }));
    expect(next.currentActorIndex).toBe(0);
    expect(next.round).toBe(2);
  });

  it("ignores events that change no projected state", () => {
    const next = reduce(base, event(4, "narrative_emitted", { text: "Goblin swings." }));
    expect(next).toEqual(base);
  });

  it("never mutates the state it was given", () => {
    const before = structuredClone(base);
    reduce(base, event(5, "player_input", { clientMessageId: "c9", actorId: "hero" }));
    expect(base).toEqual(before);
  });
});

describe("fold", () => {
  it("is reduce applied in order", () => {
    const events = [
      event(0, "player_input", { clientMessageId: "c1", actorId: "hero" }),
      event(1, "scene_changed", { kind: "turn_advanced" }),
      event(2, "player_input", { clientMessageId: "c2", actorId: "villain" }),
    ];
    const folded = fold(base, events);
    expect(folded.appliedClientMessageIds).toEqual(["c1", "c2"]);
    expect(folded.currentActorIndex).toBe(1);
  });

  it("is order-sensitive, so a shuffled log is a different projection", () => {
    const a = event(0, "scene_changed", { kind: "turn_advanced" });
    const b = event(1, "scene_changed", { kind: "turn_advanced" });
    expect(fold(base, [a, b]).round).toBe(2);
    expect(fold(base, [a]).round).toBe(1);
  });
});
