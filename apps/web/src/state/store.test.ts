import { describe, expect, it } from "vitest";
import { fold } from "@ai-dm/schemas";
import type { GameEvent, SessionState } from "@ai-dm/schemas";
import { applyFrame, initialClientState } from "./store.js";

const genesis: SessionState = {
  sessionId: "s1",
  rootSeed: 3,
  encounterId: "goblin-ambush",
  grid: { width: 2, height: 1, tiles: [["normal", "normal"]] },
  combatants: [],
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

describe("applyFrame", () => {
  it("folds an event log to exactly the server's projection", () => {
    // The parity guard. If `reduce` ever behaves differently on this side —
    // which the Task 1 move is precisely the risk of — this fails loudly.
    const log = [
      event(1, "player_input", { clientMessageId: "m1" }),
      event(2, "scene_changed", { kind: "turn_advanced" }),
      event(3, "player_input", { clientMessageId: "m2" }),
      event(4, "scene_changed", { kind: "turn_advanced" }),
    ];

    let client = applyFrame(initialClientState, {
      type: "session_state",
      sequence: 0,
      snapshot: genesis,
    });
    for (const each of log) client = applyFrame(client, { type: "event", event: each });

    expect(client.snapshot).toEqual(fold(genesis, log));
    expect(client.sequence).toBe(4);
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

    const authoritative: SessionState = { ...genesis, round: 9, appliedClientMessageIds: ["x"] };
    client = applyFrame(client, { type: "session_state", sequence: 12, snapshot: authoritative });

    expect(client.snapshot).toEqual(authoritative);
    expect(client.sequence).toBe(12);
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

  it("records an error frame and a rejection frame", () => {
    let client = applyFrame(initialClientState, {
      type: "error",
      code: "internal_error",
      message: "boom",
    });
    expect(client.lastError).toEqual({ code: "internal_error", message: "boom" });

    client = applyFrame(client, {
      type: "rejected",
      clientMessageId: "m1",
      reasons: ["target_out_of_reach"],
      messages: ["too far"],
    });
    expect(client.lastRejection?.reasons).toEqual(["target_out_of_reach"]);
  });
});
