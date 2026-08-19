import { describe, expect, it } from "vitest";
import { fold } from "@ai-dm/schemas";
import type { GameEvent, ServerFrame, SessionState } from "@ai-dm/schemas";
import { applyFrame, initialClientState } from "./store.js";
import type { ClientState } from "./store.js";
import { combatant } from "./combatant-fixture.js";

// Two real combatants, not an empty roster: the parity guard below needs a
// `state_delta_applied` event to have HP and action-economy fields to
// actually change, and `reduce`'s `scene_changed` branch resets the up-next
// actor's `actionEconomy` — a reset that is a silent no-op against an empty
// `combatants` array.
const genesis: SessionState = {
  sessionId: "s1",
  rootSeed: 3,
  encounterId: "goblin-ambush",
  grid: { width: 2, height: 1, tiles: [["normal", "normal"]] },
  combatants: [combatant("hero", "party", "alive"), combatant("goblin-a", "hostile", "alive")],
  turnOrder: ["hero", "goblin-a"],
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

// deep-freezes an arbitrary fixture value in place so a mutation on any
// nested object throws (strict-mode ESM) instead of silently succeeding —
// the only thing that makes the purity tests below a real assertion rather
// than a tautology.
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

describe("applyFrame", () => {
  it("folds an event log to exactly the server's projection", () => {
    // The parity guard. If `reduce` ever behaves differently on this side —
    // which the Task 1 move is precisely the risk of — this fails loudly.
    // The log below exercises fields the grid and `conclusionOf` actually
    // read (HP, action economy), not just turn bookkeeping: a hand-rolled
    // fold that got turn sequencing right and combatants wrong would still
    // fail this.
    const log = [
      event(1, "player_input", { clientMessageId: "m1" }),
      // Hero moves and attacks, spending its economy; goblin-a takes an
      // opportunity-attack reaction against the movement, spending its own.
      event(2, "state_delta_applied", {
        combatants: [
          combatant("hero", "party", "alive", {
            actionEconomy: {
              actionUsed: true,
              bonusActionUsed: false,
              reactionUsed: false,
              movementUsedFeet: 10,
              attacksMade: 1,
            },
          }),
          combatant("goblin-a", "hostile", "alive", {
            currentHp: 4,
            actionEconomy: {
              actionUsed: false,
              bonusActionUsed: false,
              reactionUsed: true,
              movementUsedFeet: 0,
              attacksMade: 0,
            },
          }),
        ],
      }),
      // Turn passes to goblin-a: its spent reaction resets (reactions
      // refresh at the start of the creature's own turn), so the up-next
      // reset in `reduce` has something real to do here, not a default
      // overwriting a default.
      event(3, "scene_changed", { kind: "turn_advanced" }),
      event(4, "player_input", { clientMessageId: "m2" }),
      // Turn wraps back to hero for round 2: hero's spent economy from its
      // first turn resets the same way.
      event(5, "scene_changed", { kind: "turn_advanced" }),
    ];

    let client = applyFrame(initialClientState, {
      type: "session_state",
      sequence: 0,
      snapshot: genesis,
    });
    for (const each of log) client = applyFrame(client, { type: "event", event: each });

    expect(client.snapshot).toEqual(fold(genesis, log));
    expect(client.sequence).toBe(5);
    // Sanity check that the log actually moved the projection — otherwise
    // this test could silently degrade back into a no-op comparison.
    expect(client.snapshot?.combatants).not.toEqual(genesis.combatants);
    expect(
      client.snapshot?.combatants.find((each) => each.combatantId === "goblin-a")?.currentHp,
    ).toBe(4);
    expect(client.snapshot?.round).toBe(2);
  });

  it("treats a session_state frame as authoritative and replaces state wholesale", () => {
    let client = applyFrame(initialClientState, {
      type: "session_state",
      sequence: 0,
      snapshot: genesis,
    });
    client = applyFrame(client, {
      type: "event",
      event: event(1, "player_input", { clientMessageId: "m1" }),
    });
    expect(client.snapshot?.appliedClientMessageIds).toEqual(["m1"]);

    // A rejection recorded before the resync is a moment that predates the
    // authoritative snapshot; it must not survive to render afterward.
    client = applyFrame(client, {
      type: "rejected",
      clientMessageId: "m1",
      reasons: ["target_out_of_reach"],
      messages: ["too far"],
    });
    expect(client.lastRejection).not.toBeNull();

    const authoritative: SessionState = { ...genesis, round: 9, appliedClientMessageIds: ["x"] };
    client = applyFrame(client, { type: "session_state", sequence: 12, snapshot: authoritative });

    expect(client.snapshot).toEqual(authoritative);
    expect(client.sequence).toBe(12);
    expect(client.lastRejection).toBeNull();
  });

  it("keeps the newest affordances and discards a stale one", () => {
    let client = applyFrame(initialClientState, {
      type: "session_state",
      sequence: 10,
      snapshot: genesis,
    });
    client = applyFrame(client, {
      type: "turn_affordances",
      forSequence: 10,
      actorId: "hero",
      reachableTiles: [[1, 0]],
      actions: [],
    });
    expect(client.affordances?.reachableTiles).toEqual([[1, 0]]);

    client = applyFrame(client, {
      type: "turn_affordances",
      forSequence: 9,
      actorId: "hero",
      reachableTiles: [[0, 0]],
      actions: [],
    });
    expect(client.affordances?.reachableTiles).toEqual([[1, 0]]);
  });

  it("clears affordances when a new event moves the board past them", () => {
    let client = applyFrame(initialClientState, {
      type: "session_state",
      sequence: 1,
      snapshot: genesis,
    });
    client = applyFrame(client, {
      type: "turn_affordances",
      forSequence: 1,
      actorId: "hero",
      reachableTiles: [[1, 0]],
      actions: [],
    });
    client = applyFrame(client, {
      type: "event",
      event: event(2, "scene_changed", { kind: "turn_advanced" }),
    });

    expect(client.affordances).toBeNull();
  });

  it("accumulates narrative tokens and resets them on a new turn", () => {
    let client = applyFrame(initialClientState, {
      type: "session_state",
      sequence: 0,
      snapshot: genesis,
    });
    client = applyFrame(client, { type: "narrative_token", streamId: "n1", text: "החרב " });
    client = applyFrame(client, { type: "narrative_token", streamId: "n1", text: "נוחתת." });
    expect(client.narrative).toBe("החרב נוחתת.");

    client = applyFrame(client, { type: "narrative_token", streamId: "n2", text: "הגובלין " });
    expect(client.narrative).toBe("הגובלין ");
  });

  it("records an error and a rejection without disturbing the projection", () => {
    let client = applyFrame(initialClientState, {
      type: "session_state",
      sequence: 5,
      snapshot: genesis,
    });
    const { snapshot, sequence, affordances } = client;

    client = applyFrame(client, { type: "error", code: "internal_error", message: "boom" });
    expect(client.lastError).toEqual({ code: "internal_error", message: "boom" });
    expect(client.snapshot).toBe(snapshot);
    expect(client.sequence).toBe(sequence);
    expect(client.affordances).toBe(affordances);

    client = applyFrame(client, {
      type: "rejected",
      clientMessageId: "m1",
      reasons: ["target_out_of_reach"],
      messages: ["too far"],
    });
    expect(client.lastRejection?.reasons).toEqual(["target_out_of_reach"]);
    expect(client.snapshot).toBe(snapshot);
    expect(client.sequence).toBe(sequence);
    expect(client.affordances).toBe(affordances);
  });

  it("ignores an event frame before any snapshot has arrived", () => {
    let result: ClientState | undefined;
    expect(() => {
      result = applyFrame(initialClientState, {
        type: "event",
        event: event(1, "player_input", { clientMessageId: "m1" }),
      });
    }).not.toThrow();
    expect(result).toEqual(initialClientState);
  });

  describe("purity", () => {
    it("does not mutate a frozen state or its snapshot when folding an event", () => {
      const snapshot = deepFreeze(structuredClone(genesis));
      const frozen: ClientState = deepFreeze({ ...initialClientState, snapshot, sequence: 3 });
      const frame: ServerFrame = {
        type: "event",
        event: event(4, "player_input", { clientMessageId: "m1" }),
      };

      let result: ClientState | undefined;
      expect(() => {
        result = applyFrame(frozen, frame);
      }).not.toThrow();

      // The input is untouched...
      expect(frozen.snapshot?.appliedClientMessageIds).toEqual([]);
      expect(frozen.sequence).toBe(3);
      // ...and the fold still happened, against a new object.
      expect(result?.snapshot?.appliedClientMessageIds).toEqual(["m1"]);
      expect(result?.sequence).toBe(4);
    });

    it("does not mutate a frozen state when applying a session_state frame", () => {
      const frozen: ClientState = deepFreeze({ ...initialClientState });
      const authoritative = deepFreeze(structuredClone(genesis));
      const frame: ServerFrame = { type: "session_state", sequence: 7, snapshot: authoritative };

      let result: ClientState | undefined;
      expect(() => {
        result = applyFrame(frozen, frame);
      }).not.toThrow();

      expect(frozen.snapshot).toBeNull();
      expect(frozen.sequence).toBe(0);
      expect(result?.snapshot).toEqual(authoritative);
      expect(result?.sequence).toBe(7);
    });
  });
});
