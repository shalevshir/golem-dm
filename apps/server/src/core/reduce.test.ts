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
