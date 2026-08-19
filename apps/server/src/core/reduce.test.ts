import { describe, expect, it } from "vitest";
import { startTurn } from "@ai-dm/rules-engine";
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

function event(
  sequence: number,
  type: GameEvent["type"],
  payload: Record<string, unknown>,
): GameEvent {
  return {
    eventId: `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
    sessionId: "s1",
    sequence,
    timestamp: "2026-08-19T10:00:00.000Z",
    type,
    payload,
  };
}

// C-12: the brief's four-field `Combatant` fixture cannot parse — `Combatant`
// requires `speedFeet`, `maxHp`, `currentHp` and `armorClass` with no
// defaults, and defaults nine more fields that zod would materialise onto
// the output, breaking a `toEqual` against the bare input. This factory
// builds a complete fixture (shape copied from
// `packages/rules-engine/src/combat/test-fixtures.ts`); every assertion
// below that cares about shape compares against the *parsed* value
// (`Combatant.array().parse(...)`) rather than the raw literal.
function rawCombatant(
  overrides: Record<string, unknown> & { combatantId: string },
): Record<string, unknown> {
  return {
    faction: "hostile",
    position: [0, 0],
    size: "medium",
    speedFeet: 30,
    reachFeet: 5,
    maxHp: 10,
    currentHp: 10,
    tempHp: 0,
    armorClass: 12,
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
    status: "alive",
    ...overrides,
  };
}

const rawCombatants = [
  rawCombatant({
    combatantId: "hero",
    faction: "party",
    position: [1, 0],
    currentHp: 3,
    armorClass: 16,
  }),
];

describe("reduce", () => {
  it("records a player input's clientMessageId for idempotency", () => {
    const next = reduce(base, event(0, "player_input", { clientMessageId: "c1", actorId: "hero" }));
    expect(next.appliedClientMessageIds).toEqual(["c1"]);
  });

  it("throws on a player_input payload that fails to parse", () => {
    // No `.safeParse`-and-skip fallback: a payload this cares about that
    // does not parse is a bug in whoever wrote it, and a silent skip here is
    // a failure mode Task 11's replay properties structurally cannot catch —
    // both the live projection and any replay would skip the same malformed
    // event identically, so the two projections would still agree with each
    // other while both silently diverge from what the log actually recorded.
    const missingClientMessageId = event(1, "player_input", { actorId: "hero" });
    expect(() => reduce(base, missingClientMessageId)).toThrow();
  });

  it("replaces combatants from a state delta, round-tripping the full payload", () => {
    const withStaleCombatant: SessionState = {
      ...base,
      combatants: Combatant.array().parse([rawCombatant({ combatantId: "stale" })]),
    };
    const delta = event(2, "state_delta_applied", { combatants: rawCombatants });
    const next = reduce(withStaleCombatant, delta);
    // Starting from a *different* combatant than the delta carries: if
    // `reduce` merged or appended instead of replacing, "stale" would still
    // be present and this equality would fail.
    expect(next.combatants).toEqual(Combatant.array().parse(rawCombatants));
  });

  it("advances the actor index without wrapping the round mid-cycle", () => {
    const next = reduce(base, event(3, "scene_changed", { kind: "turn_advanced" }));
    expect(next.currentActorIndex).toBe(1);
    expect(next.round).toBe(1);
  });

  it("wraps to the next round when the turn order completes", () => {
    const atEnd = { ...base, currentActorIndex: 1 };
    const next = reduce(atEnd, event(4, "scene_changed", { kind: "turn_advanced" }));
    expect(next.currentActorIndex).toBe(0);
    expect(next.round).toBe(2);
  });

  // Regression for the defect Task 11's replay properties caught:
  // `applyTurn` sets `actionEconomy: plan.economyAfter` on whoever just
  // acted, spending it, and nothing used to clear it again — so a
  // combatant's second-ever turn was rejected `action_already_used`
  // forever, and no session could ever complete a second round (see this
  // task's report). `startTurn()` is the SRD's "fresh economy for a new
  // turn" — mirrors `tools/sim/src/engine/encounter.ts`'s reset at the same
  // logical moment.
  const SPENT_ECONOMY = {
    actionUsed: true,
    bonusActionUsed: true,
    reactionUsed: true,
    movementUsedFeet: 30,
    attacksMade: 1,
  };

  it("refreshes the action economy of whoever's turn is beginning", () => {
    const withSpentActors: SessionState = {
      ...base,
      combatants: Combatant.array().parse([
        rawCombatant({ combatantId: "hero", actionEconomy: SPENT_ECONOMY }),
        rawCombatant({ combatantId: "villain", actionEconomy: SPENT_ECONOMY }),
      ]),
    };
    // currentActorIndex 0 -> 1: villain's turn begins.
    const next = reduce(withSpentActors, event(10, "scene_changed", { kind: "turn_advanced" }));

    const villain = next.combatants.find((each) => each.combatantId === "villain");
    expect(villain?.actionEconomy).toEqual(startTurn());
    // hero's turn just ENDED, not begun — `turn_advanced` is not their cue
    // to refresh, and `state_delta_applied` (a separate event) already
    // recorded whatever they actually spent.
    const hero = next.combatants.find((each) => each.combatantId === "hero");
    expect(hero?.actionEconomy).toEqual(SPENT_ECONOMY);
  });

  it("refreshes the wrapped-to actor's economy when a round rolls over", () => {
    const atEndWithSpentActors: SessionState = {
      ...base,
      currentActorIndex: 1,
      combatants: Combatant.array().parse([
        rawCombatant({ combatantId: "hero", actionEconomy: SPENT_ECONOMY }),
        rawCombatant({ combatantId: "villain", actionEconomy: SPENT_ECONOMY }),
      ]),
    };
    // currentActorIndex 1 -> wraps to 0: hero's NEW round begins.
    const next = reduce(
      atEndWithSpentActors,
      event(11, "scene_changed", { kind: "turn_advanced" }),
    );

    expect(next.currentActorIndex).toBe(0);
    expect(next.round).toBe(2);
    const hero = next.combatants.find((each) => each.combatantId === "hero");
    expect(hero?.actionEconomy).toEqual(startTurn());
    const villain = next.combatants.find((each) => each.combatantId === "villain");
    expect(villain?.actionEconomy).toEqual(SPENT_ECONOMY);
  });

  it("ignores a scene_changed event that isn't a turn advance", () => {
    const next = reduce(base, event(5, "scene_changed", { kind: "narration_cue" }));
    expect(next).toEqual(base);
  });

  it("ignores events that change no projected state", () => {
    const next = reduce(base, event(6, "narrative_emitted", { text: "Goblin swings." }));
    expect(next).toEqual(base);
  });

  // Pinning purity per mutating branch: `reduce` is proven non-mutating by
  // inspection for every branch, but this is the property Task 11's replay
  // equivalence leans on hardest, so each of the three branches that builds
  // a new state gets its own regression test rather than sharing one.
  it("never mutates the state given to a player_input reduce", () => {
    const before = structuredClone(base);
    reduce(base, event(7, "player_input", { clientMessageId: "c9", actorId: "hero" }));
    expect(base).toEqual(before);
  });

  it("never mutates the state given to a state_delta_applied reduce", () => {
    const before = structuredClone(base);
    reduce(base, event(8, "state_delta_applied", { combatants: rawCombatants }));
    expect(base).toEqual(before);
  });

  it("never mutates the state given to a turn-advancing scene_changed reduce", () => {
    const before = structuredClone(base);
    reduce(base, event(9, "scene_changed", { kind: "turn_advanced" }));
    expect(base).toEqual(before);
  });

  // `base.combatants` is empty, so the test above never exercises the
  // economy-reset `.map` at all. With actual combatants present, this pins
  // that resetting the up-next actor's economy still builds a fresh
  // `combatants` array and fresh combatant objects rather than writing
  // through the ones the caller passed in.
  it("never mutates the combatants given to a turn-advancing scene_changed reduce", () => {
    const withActors: SessionState = {
      ...base,
      combatants: Combatant.array().parse([
        rawCombatant({ combatantId: "hero", actionEconomy: SPENT_ECONOMY }),
        rawCombatant({ combatantId: "villain", actionEconomy: SPENT_ECONOMY }),
      ]),
    };
    const before = structuredClone(withActors);
    reduce(withActors, event(12, "scene_changed", { kind: "turn_advanced" }));
    expect(withActors).toEqual(before);
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
