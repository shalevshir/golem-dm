import { describe, expect, it } from "vitest";
import { fold, reduce } from "./reduce.js";
import { ActionEconomy, Combatant } from "./world.js";
import type { GameEvent } from "./events.js";
import type { CampaignState, EncounterState } from "./protocol.js";

const baseEncounter: EncounterState = {
  encounterId: "e1",
  grid: { width: 2, height: 1, tiles: [["normal", "normal"]] },
  combatants: [],
  turnOrder: ["hero", "villain"],
  currentActorIndex: 0,
  round: 1,
};

const base: CampaignState = {
  world: { campaignId: "s1", rootSeed: 7, appliedClientMessageIds: [] },
  encounter: baseEncounter,
};

/** `base` with the board overridden. Every case here folds combat events, so
 * every one of them has a bracket open. */
function withBoard(patch: Partial<EncounterState>): CampaignState {
  return { ...base, encounter: { ...baseEncounter, ...patch } };
}

/** The projected board, or a failure. Combat events cannot be folded without
 * one, so a null here is the assertion failing rather than a case to handle. */
function boardOf(state: CampaignState): EncounterState {
  const { encounter } = state;
  if (encounter === null) throw new Error("expected an open encounter");
  return encounter;
}

function event(
  sequence: number,
  type: GameEvent["type"],
  payload: Record<string, unknown>,
): GameEvent {
  return {
    eventId: `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
    campaignId: "s1",
    sequence,
    timestamp: "2026-08-19T10:00:00.000Z",
    type,
    payload,
  };
}

// A partial `Combatant` fixture cannot parse: `Combatant` requires
// `speedFeet`, `maxHp`, `currentHp` and `armorClass` with no defaults, and
// defaults nine more fields that zod materialises onto the output, breaking
// a `toEqual` against the bare input. This factory
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
    expect(next.world.appliedClientMessageIds).toEqual(["c1"]);
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
    const withStaleCombatant = withBoard({
      combatants: Combatant.array().parse([rawCombatant({ combatantId: "stale" })]),
    });
    const delta = event(2, "state_delta_applied", { combatants: rawCombatants });
    const next = reduce(withStaleCombatant, delta);
    // Starting from a *different* combatant than the delta carries: if
    // `reduce` merged or appended instead of replacing, "stale" would still
    // be present and this equality would fail.
    expect(boardOf(next).combatants).toEqual(Combatant.array().parse(rawCombatants));
  });

  it("advances the actor index without wrapping the round mid-cycle", () => {
    const next = reduce(base, event(3, "scene_changed", { kind: "turn_advanced" }));
    expect(boardOf(next).currentActorIndex).toBe(1);
    expect(boardOf(next).round).toBe(1);
  });

  it("wraps to the next round when the turn order completes", () => {
    const atEnd = withBoard({ currentActorIndex: 1 });
    const next = reduce(atEnd, event(4, "scene_changed", { kind: "turn_advanced" }));
    expect(boardOf(next).currentActorIndex).toBe(0);
    expect(boardOf(next).round).toBe(2);
  });

  // Regression guard: `applyTurn` sets `actionEconomy: plan.economyAfter` on
  // whoever just acted, spending it. Without something clearing it again a
  // combatant's second-ever turn is rejected `action_already_used` forever,
  // and no campaign can complete a second round.
  // `startTurn()` is the SRD's "fresh economy for a new
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
    const withSpentActors = withBoard({
      combatants: Combatant.array().parse([
        rawCombatant({ combatantId: "hero", actionEconomy: SPENT_ECONOMY }),
        rawCombatant({ combatantId: "villain", actionEconomy: SPENT_ECONOMY }),
      ]),
    });
    // currentActorIndex 0 -> 1: villain's turn begins.
    const next = reduce(withSpentActors, event(10, "scene_changed", { kind: "turn_advanced" }));

    const villain = boardOf(next).combatants.find((each) => each.combatantId === "villain");
    expect(villain?.actionEconomy).toEqual(ActionEconomy.parse({}));
    // hero's turn just ENDED, not begun — `turn_advanced` is not their cue
    // to refresh, and `state_delta_applied` (a separate event) already
    // recorded whatever they actually spent.
    const hero = boardOf(next).combatants.find((each) => each.combatantId === "hero");
    expect(hero?.actionEconomy).toEqual(SPENT_ECONOMY);
  });

  it("refreshes the wrapped-to actor's economy when a round rolls over", () => {
    const atEndWithSpentActors = withBoard({
      currentActorIndex: 1,
      combatants: Combatant.array().parse([
        rawCombatant({ combatantId: "hero", actionEconomy: SPENT_ECONOMY }),
        rawCombatant({ combatantId: "villain", actionEconomy: SPENT_ECONOMY }),
      ]),
    });
    // currentActorIndex 1 -> wraps to 0: hero's NEW round begins.
    const next = reduce(
      atEndWithSpentActors,
      event(11, "scene_changed", { kind: "turn_advanced" }),
    );

    expect(boardOf(next).currentActorIndex).toBe(0);
    expect(boardOf(next).round).toBe(2);
    const hero = boardOf(next).combatants.find((each) => each.combatantId === "hero");
    expect(hero?.actionEconomy).toEqual(ActionEconomy.parse({}));
    const villain = boardOf(next).combatants.find((each) => each.combatantId === "villain");
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

  // `base`'s board carries no combatants, so the test above never exercises the
  // economy-reset `.map` at all. With actual combatants present, this pins
  // that resetting the up-next actor's economy still builds a fresh
  // `combatants` array and fresh combatant objects rather than writing
  // through the ones the caller passed in.
  it("never mutates the combatants given to a turn-advancing scene_changed reduce", () => {
    const withActors = withBoard({
      combatants: Combatant.array().parse([
        rawCombatant({ combatantId: "hero", actionEconomy: SPENT_ECONOMY }),
        rawCombatant({ combatantId: "villain", actionEconomy: SPENT_ECONOMY }),
      ]),
    });
    const before = structuredClone(withActors);
    reduce(withActors, event(12, "scene_changed", { kind: "turn_advanced" }));
    expect(withActors).toEqual(before);
  });

  // The two bracket-id refusals, plus the payload parse each bracket case
  // runs.
  it("throws when encounter_resolved names a different encounter than the one open", () => {
    // `base`'s open encounter is "e1"; this event closes "e2" instead — the
    // same corrupt-log class `resolveEncounter` itself cannot produce (it
    // takes `encounterId` from the open bracket, never from a caller), which
    // is why this needs its own coverage at the `reduce` level.
    const mismatched = event(13, "encounter_resolved", {
      encounterId: "e2",
      outcome: "victory",
      survivorIds: [],
    });
    expect(() => reduce(base, mismatched)).toThrow(/e2.*e1 is the one open/);
  });

  it("throws on an encounter_started payload that fails to parse", () => {
    // Deliberately NOT `base`: `base` already has a bracket open, and
    // `encounter_started`'s already-open guard throws unconditionally
    // whenever one is — so a bare `.toThrow()` against `base` would pass
    // even with the `.parse()` call deleted outright, discriminating
    // nothing (verified: stubbing out the parse call and rerunning left
    // this test green). Only a state where that guard does NOT fire
    // isolates what this test claims to pin.
    const noBracketOpen: CampaignState = { ...base, encounter: null };
    const missingEncounterId = event(14, "encounter_started", {});
    expect(() => reduce(noBracketOpen, missingEncounterId)).toThrow();
  });

  it("throws on an encounter_resolved payload that fails to parse", () => {
    const missingFields = event(15, "encounter_resolved", { encounterId: "e1" });
    expect(() => reduce(base, missingFields)).toThrow();
  });

  // The broader bracket-invariant coverage promised above: a combat event
  // with no bracket open, a second bracket opened over one already open,
  // and a resolve that closes the bracket without disturbing the world.

  it("throws when state_delta_applied is folded with no encounter open", () => {
    // Same corrupt-log reasoning as every bracket guard: a combat event
    // with nothing open would otherwise project a plausible-looking board
    // out of an impossible history, so this throws instead of returning
    // `state` unchanged.
    const noBracketOpen: CampaignState = { ...base, encounter: null };
    const delta = event(16, "state_delta_applied", { combatants: rawCombatants });
    expect(() => reduce(noBracketOpen, delta)).toThrow(
      /state_delta_applied at sequence 16 with no encounter open/,
    );
  });

  it("throws when a turn-advancing scene_changed is folded with no encounter open", () => {
    // `turn_advanced` is the one `scene_changed` kind that is actually a
    // combat signal, so it is held to the same no-bracket-no-fold rule as
    // `state_delta_applied` above.
    const noBracketOpen: CampaignState = { ...base, encounter: null };
    const turnAdvanced = event(17, "scene_changed", { kind: "turn_advanced" });
    expect(() => reduce(noBracketOpen, turnAdvanced)).toThrow(
      /scene_changed at sequence 17 with no encounter open/,
    );
  });

  it("ignores a non-turn-advancing scene_changed even with no encounter open", () => {
    // The counterpart the plan's own wording omits: the `kind` gate runs
    // BEFORE the bracket guard, on purpose, so a non-combat scene change —
    // the kind §4.7's step 4 will emit for exploration and social scenes —
    // can arrive with no fight open at all. Guarding the whole event type
    // instead would make that future, legitimate event throw.
    const noBracketOpen: CampaignState = { ...base, encounter: null };
    const narrationCue = event(20, "scene_changed", { kind: "narration_cue" });
    const next = reduce(noBracketOpen, narrationCue);
    expect(next).toEqual(noBracketOpen);
  });

  it("throws when a second encounter_started arrives while one is already open", () => {
    // Non-overlap is what makes `encounter: EncounterState | null` correct
    // rather than a map keyed by encounter id: at most one bracket runs at
    // a time, so a second `encounter_started` while one is open is a
    // corrupt log, not a second fight starting. The payload here is valid,
    // unlike the malformed-payload cases above, so the already-open guard is
    // the only thing that can throw.
    const secondStart = event(18, "encounter_started", { encounterId: "e2" });
    expect(() => reduce(base, secondStart)).toThrow(
      /names encounter e2, but encounter e1 is already open/,
    );
  });

  it("clears the bracket on encounter_resolved while leaving world untouched", () => {
    // Built explicitly rather than from `base`: `base`'s
    // `appliedClientMessageIds` is `[]`, and a branch that accidentally
    // reset the field to `[]` instead of preserving it would still look
    // right against an already-empty array. A non-empty one actually
    // discriminates.
    const midEncounter: CampaignState = {
      world: { campaignId: "s1", rootSeed: 7, appliedClientMessageIds: ["c1", "c2"] },
      encounter: { ...baseEncounter, round: 3, currentActorIndex: 1 },
    };
    const before = structuredClone(midEncounter);
    const resolved = event(19, "encounter_resolved", {
      encounterId: "e1",
      outcome: "victory",
      survivorIds: [],
    });

    const next = reduce(midEncounter, resolved);
    expect(next.encounter).toBeNull();
    expect(next.world).toEqual(midEncounter.world);
    expect(next.world.appliedClientMessageIds).toEqual(["c1", "c2"]);
    // Matches the purity tests already in the file: `reduce` must not
    // mutate what it's given even on the branch that clears a field.
    expect(midEncounter).toEqual(before);
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
    expect(folded.world.appliedClientMessageIds).toEqual(["c1", "c2"]);
    expect(boardOf(folded).currentActorIndex).toBe(1);
  });

  it("is order-sensitive, so a shuffled log is a different projection", () => {
    const a = event(0, "scene_changed", { kind: "turn_advanced" });
    const b = event(1, "scene_changed", { kind: "turn_advanced" });
    expect(boardOf(fold(base, [a, b])).round).toBe(2);
    expect(boardOf(fold(base, [a])).round).toBe(1);
  });
});
