import { describe, expect, it } from "vitest";
import { validateExecuteTurn } from "@ai-dm/rules-engine";
import type { NarrativePort, TacticalAgent } from "@ai-dm/agents";
import {
  createAgentRuntime,
  createDeterministicNarrative,
  createFakePort,
  createTacticalAgent,
  DEFAULT_MODEL_ROUTING,
} from "@ai-dm/agents";
import type {
  ClientMessage,
  ExecuteTurn,
  GameEvent,
  ServerFrame,
  SessionState,
} from "@ai-dm/schemas";
import { createInMemoryEventStore } from "./event-store.js";
import type { EventStore } from "./event-store.js";
import { SNAPSHOT_EVERY, handleCommand } from "./pipeline.js";
import type { TurnPorts } from "./pipeline.js";
import { createSession } from "./session.js";
import type { Session } from "./session.js";

function uuids(): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  };
}

/**
 * A tactical double good enough for Task 10 to build on: it proposes a legal
 * Dodge for whichever actor it is asked about. C-15: the plan's original
 * `portsWith` set `tactical` to a stub that always rejects, on the theory
 * that nothing in Task 9's cases reaches it — true today, but the moment
 * Task 10 appends the enemy loop after every successful player turn, every
 * one of those cases reaches this port. A working default means Task 10
 * does not have to revisit every Task 9 test to fix `portsWith`.
 */
function defaultTactical(): TacticalAgent {
  return {
    proposeTurn({ world, actorId }) {
      const actor = world.combatants.find((each) => each.combatantId === actorId);
      if (actor === undefined) {
        return Promise.reject(new Error(`No combatant ${actorId} in this encounter`));
      }
      const turn = {
        actorId,
        mainAction: { actionType: "dodge" as const },
        tacticalRationaleEnglish: "Default test double: always dodge.",
      };
      const validation = validateExecuteTurn(turn, actor, world);
      if (!validation.valid) {
        return Promise.reject(
          new Error(`Default tactical double produced an illegal dodge for ${actorId}`),
        );
      }
      return Promise.resolve({
        ok: true as const,
        turn,
        plan: validation.plan,
        source: "model" as const,
        rejections: [],
        usage: [],
      });
    },
  };
}

function portsWith(store: EventStore, tactical: TacticalAgent = defaultTactical()): TurnPorts {
  return {
    store,
    tactical,
    narrative: createDeterministicNarrative(),
    clock: () => "2026-08-19T10:00:00.000Z",
    uuid: uuids(),
    seedFor: (rootSeed, sequence) => rootSeed * 1000 + sequence,
    turnTimeoutMs: 10_000,
  };
}

async function drain(stream: AsyncIterable<ServerFrame>): Promise<ServerFrame[]> {
  const frames: ServerFrame[] = [];
  for await (const frame of stream) frames.push(frame);
  return frames;
}

async function freshSession(store: EventStore): Promise<Session> {
  return createSession({
    sessionId: "s1",
    encounterId: "goblin-ambush",
    rootSeed: 42,
    store,
    clock: () => "2026-08-19T10:00:00.000Z",
    uuid: uuids(),
  });
}

const dodge = (actorId: string): ClientMessage => ({
  type: "structured_action",
  clientMessageId: "c1",
  actorId,
  turn: {
    actorId,
    mainAction: { actionType: "dodge" },
    tacticalRationaleEnglish: "Test fixture.",
  },
});

function syntheticEvent(sequence: number): GameEvent {
  return {
    eventId: `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
    sessionId: "s1",
    sequence,
    timestamp: "2026-08-19T10:00:00.000Z",
    type: "scene_changed",
    payload: { kind: "turn_advanced" },
  };
}

/**
 * A tactical port that proposes exactly the given turns, one per call to
 * `proposeTurn`, in order. Every element must be a full `ExecuteTurn` — C-1:
 * `tacticalRationaleEnglish` is required, not optional, so an untyped
 * fixture would fail at runtime and a typed one fails `pnpm typecheck`.
 *
 * C-2: `TokenUsage` is `{ promptTokens, completionTokens, totalTokens }`
 * (`packages/agents/src/providers/usage.ts`), not `{ inputTokens,
 * outputTokens }`.
 */
function agentProposing(turns: readonly ExecuteTurn[]): TacticalAgent {
  const port = createFakePort({
    structured: turns.map((turn) => ({
      ok: true as const,
      value: {
        value: turn,
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      },
    })),
  });
  return createTacticalAgent({
    runtime: createAgentRuntime({ routing: DEFAULT_MODEL_ROUTING, port }),
  });
}

/**
 * goblin-a's first proposal moves to an off-grid tile — illegal on any
 * geometry, unlike the brief's original "attack a target 45 ft away"
 * fixture, which stopped being illegal once C-14 moved goblin-ambush's
 * combatants into melee range of each other. The agent's own retry-once
 * loop (step 7a, `packages/agents/src/tactical/index.ts`) recovers with a
 * legal dodge; goblin-b then dodges cleanly on the first attempt.
 */
function agentRejectingThenRecovering(): TacticalAgent {
  const port = createFakePort({
    structured: [
      {
        ok: true as const,
        value: {
          value: {
            actorId: "goblin-a",
            movement: [{ destinationTile: [-1, -1], pathType: "direct" }],
            mainAction: { actionType: "dodge" },
            tacticalRationaleEnglish: "Test fixture: deliberately illegal.",
          },
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        },
      },
      {
        ok: true as const,
        value: {
          value: {
            actorId: "goblin-a",
            mainAction: { actionType: "dodge" },
            tacticalRationaleEnglish: "Retry: legal dodge.",
          },
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        },
      },
      {
        ok: true as const,
        value: {
          value: {
            actorId: "goblin-b",
            mainAction: { actionType: "dodge" },
            tacticalRationaleEnglish: "Test fixture.",
          },
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        },
      },
    ],
  });
  return createTacticalAgent({
    runtime: createAgentRuntime({ routing: DEFAULT_MODEL_ROUTING, port }),
  });
}

/** Yields one token, then never resolves. What a wedged provider looks like. */
function hangingNarrative(): NarrativePort {
  return {
    // eslint-disable-next-line require-yield
    async *stream() {
      await new Promise(() => {
        // never resolves
      });
    },
  };
}

describe("handleCommand — join", () => {
  it("sends a snapshot when the client has nothing", async () => {
    const store = createInMemoryEventStore();
    const session = await freshSession(store);
    const frames = await drain(
      handleCommand(session, { type: "join", sessionId: "s1" }, portsWith(store)),
    );
    expect(frames[0]).toMatchObject({ type: "session_state" });
  });

  it("replays only the events after resumeFrom", async () => {
    const store = createInMemoryEventStore();
    const session = await freshSession(store);
    const frames = await drain(
      handleCommand(session, { type: "join", sessionId: "s1", resumeFrom: 0 }, portsWith(store)),
    );
    expect(frames.filter((each) => each.type === "session_state")).toHaveLength(0);
  });

  // C-16: the spec's §Reconnect says "without resumeFrom, OR when it predates
  // the retained log: session_state at the newest snapshot, then the events
  // since [the snapshot]". This is the second branch — it is what makes the
  // schema's own claim about reconnect behaviour true. Simulated by writing
  // straight to the store (bypassing handleCommand) so the test can pin exact
  // sequence numbers rather than depending on how many events one dodge turn
  // produces.
  it("falls back to the newest snapshot when resumeFrom predates the log (C-16)", async () => {
    const store = createInMemoryEventStore();
    const session = await freshSession(store);

    const upToSnapshot = Array.from({ length: 50 }, (_, index) => syntheticEvent(index + 1));
    await store.append("s1", upToSnapshot);

    const snapshotState: SessionState = { ...session.state, round: 99 };
    await store.putSnapshot("s1", 50, snapshotState);

    const tail = [syntheticEvent(51), syntheticEvent(52)];
    await store.append("s1", tail);

    const frames = await drain(
      handleCommand(session, { type: "join", sessionId: "s1", resumeFrom: 0 }, portsWith(store)),
    );

    expect(frames[0]).toEqual({
      type: "session_state",
      sequence: 50,
      snapshot: snapshotState,
    });
    const eventFrames = frames.filter((each) => each.type === "event");
    expect(eventFrames.map((each) => each.event.sequence)).toEqual([51, 52]);
  });
});

describe("handleCommand — free text", () => {
  it("is refused with a stable code rather than reaching a model", async () => {
    const store = createInMemoryEventStore();
    const session = await freshSession(store);
    const frames = await drain(
      handleCommand(
        session,
        { type: "free_text", clientMessageId: "c1", text: "I swing at the goblin" },
        portsWith(store),
      ),
    );
    expect(frames).toEqual([
      {
        type: "error",
        clientMessageId: "c1",
        code: "free_text_not_supported",
        message: expect.any(String) as string,
      },
    ]);
  });

  it("writes nothing to the log", async () => {
    const store = createInMemoryEventStore();
    const session = await freshSession(store);
    await drain(
      handleCommand(
        session,
        { type: "free_text", clientMessageId: "c1", text: "hello" },
        portsWith(store),
      ),
    );
    expect(await store.readSince("s1", 0)).toEqual([]);
  });
});

describe("handleCommand — structured action", () => {
  it("refuses an action from someone whose turn it is not", async () => {
    const store = createInMemoryEventStore();
    const session = await freshSession(store);
    const frames = await drain(handleCommand(session, dodge("goblin-a"), portsWith(store)));
    expect(frames[0]).toMatchObject({ type: "error", code: "not_your_turn" });
  });

  // The full, exact appended type sequence for a successful turn — not just
  // a `slice(0, 4)` prefix. Both `clock`/`uuid`/`seedFor` are fixed by
  // `portsWith`, so nothing about a successful dodge is nondeterministic;
  // there is no excuse for a weaker assertion here.
  //
  // C-18: a "successful turn" now cascades — the hero's own six events are
  // immediately followed by the hostile sweep (Task 10's `runEnemyTurns`),
  // so the exact sequence is hero's six plus five each for goblin-a and
  // goblin-b (no `player_input`; only a human client sends that). This test
  // predates the enemy loop; its assertion is widened to match, not
  // weakened — it is still the full sequence, not a prefix.
  it("appends the exact event type sequence for a successful turn", async () => {
    const store = createInMemoryEventStore();
    const session = await freshSession(store);
    await drain(handleCommand(session, dodge("hero"), portsWith(store)));
    const types = (await store.readSince("s1", 0)).map((each) => each.type);
    const oneActorsTurn = [
      "action_validated",
      "dice_rolled",
      "state_delta_applied",
      "narrative_emitted",
      "scene_changed",
    ];
    expect(types).toEqual(["player_input", ...oneActorsTurn, ...oneActorsTurn, ...oneActorsTurn]);
  });

  // Frame/event *identity*, not just matching counts: a frame carrying the
  // wrong event, or events out of order relative to their frames, would
  // still pass a `toHaveLength` check but fails this one.
  it("yields event frames that are exactly the events appended, in order", async () => {
    const store = createInMemoryEventStore();
    const session = await freshSession(store);
    const frames = await drain(handleCommand(session, dodge("hero"), portsWith(store)));
    const appended = await store.readSince("s1", 0);
    const framedEvents = frames.filter((each) => each.type === "event").map((each) => each.event);
    expect(framedEvents).toEqual(appended);
  });

  it("records the dice seed in the event so replay does not re-derive it", async () => {
    const store = createInMemoryEventStore();
    const session = await freshSession(store);
    await drain(handleCommand(session, dodge("hero"), portsWith(store)));
    const rolled = (await store.readSince("s1", 0)).find((each) => each.type === "dice_rolled");
    expect(rolled?.payload).toMatchObject({ seed: expect.any(Number) as number });
  });

  it("streams narrative tokens and closes with narrative_emitted", async () => {
    const store = createInMemoryEventStore();
    const session = await freshSession(store);
    const frames = await drain(handleCommand(session, dodge("hero"), portsWith(store)));
    expect(frames.some((each) => each.type === "narrative_token")).toBe(true);
    const types = (await store.readSince("s1", 0)).map((each) => each.type);
    expect(types).toContain("narrative_emitted");
  });

  // The other half of Task 5's own guarantee: the narrative port's streamed
  // chunks concatenate to its completed text. This is where that text lands
  // permanently — if the pipeline trims or otherwise alters it in transit, a
  // client that rendered the streamed chunks optimistically would diverge
  // from what replay produces, silently. The deterministic stand-in used by
  // `portsWith` happens to need no trimming, so this only catches a real
  // regression here, not a quirk of that one port.
  //
  // C-18: one hero dodge now yields three `narrative_emitted` events (the
  // hero's own, then each hostile's), each with its own `streamId`. The
  // guarantee is per-stream, so this checks every one of them against only
  // its own `narrative_token` frames rather than the whole turn's tokens.
  it("narrative_emitted carries exactly the concatenation of its streamed tokens", async () => {
    const store = createInMemoryEventStore();
    const session = await freshSession(store);
    const frames = await drain(handleCommand(session, dodge("hero"), portsWith(store)));
    const emitted = (await store.readSince("s1", 0)).filter(
      (each) => each.type === "narrative_emitted",
    );
    expect(emitted.length).toBeGreaterThan(0);
    for (const event of emitted) {
      const streamId = event.payload["streamId"];
      const streamed = frames
        .filter((each) => each.type === "narrative_token" && each.streamId === streamId)
        .map((each) => (each.type === "narrative_token" ? each.text : ""))
        .join("");
      expect(event.payload).toMatchObject({ text: streamed });
    }
  });

  it("drops a duplicate clientMessageId without applying it twice", async () => {
    const store = createInMemoryEventStore();
    const session = await freshSession(store);
    await drain(handleCommand(session, dodge("hero"), portsWith(store)));
    const afterFirst = (await store.readSince("s1", 0)).length;

    const frames = await drain(handleCommand(session, dodge("hero"), portsWith(store)));
    expect(frames).toEqual([]);
    expect((await store.readSince("s1", 0)).length).toBe(afterFirst);
  });

  // The brief's original illegal-turn fixture (an "attack" on goblin-a) relied
  // on goblin-ambush's old geometry, ~45 ft apart, so target_out_of_reach
  // always fired. Task 8's C-14 fix moved the goblins to melee range of the
  // hero so the encounter is actually fightable — which means that same
  // attack is now legal. Per the brief's own fallback note, use an
  // unambiguously illegal turn instead: a movement segment to an off-grid
  // tile, which is illegal on any geometry.
  it("rejects an illegal turn without advancing the turn", async () => {
    const store = createInMemoryEventStore();
    const session = await freshSession(store);
    const before = session.state.currentActorIndex;
    const frames = await drain(
      handleCommand(
        session,
        {
          type: "structured_action",
          clientMessageId: "c2",
          actorId: "hero",
          turn: {
            actorId: "hero",
            movement: [{ destinationTile: [-1, -1], pathType: "direct" }],
            mainAction: { actionType: "dodge" },
            tacticalRationaleEnglish: "Test fixture: deliberately illegal.",
          },
        },
        portsWith(store),
      ),
    );
    const rejected = frames.find((each) => each.type === "rejected");
    if (rejected === undefined) throw new Error("Expected a rejected frame");
    // Pinned to the real engine reason, not just "some rejection happened":
    // an off-grid tile is illegal on any geometry, so unlike the brief's
    // original out-of-reach fixture, C-14 cannot silently un-break this by
    // making the proposed turn legal again.
    expect(rejected.reasons).toEqual(["destination_off_grid"]);
    expect(session.state.currentActorIndex).toBe(before);
    const types = (await store.readSince("s1", 0)).map((each) => each.type);
    expect(types).toContain("action_rejected");
  });

  // C-29: the store throws two error classes on a bad append, neither with a
  // dedicated ServerErrorCode — both must fold onto internal_error. Simulated
  // by pre-occupying the sequence the turn's own player_input event would
  // take, the way a concurrent writer on the same session would.
  it("turns a SequenceConflictError from the store into an internal_error frame", async () => {
    const store = createInMemoryEventStore();
    const session = await freshSession(store);
    await store.append("s1", [syntheticEvent(1)]);

    const frames = await drain(handleCommand(session, dodge("hero"), portsWith(store)));

    expect(frames).toEqual([
      {
        type: "error",
        clientMessageId: "c1",
        code: "internal_error",
        message: expect.any(String) as string,
      },
    ]);
    // Append-and-yield stayed one operation: the failed append never bumped
    // nextSequence or added anything beyond the one rogue event already there.
    expect(session.nextSequence).toBe(1);
    expect((await store.readSince("s1", 0)).map((each) => each.sequence)).toEqual([1]);
  });
});

describe("handleCommand — snapshot cadence", () => {
  // `SNAPSHOT_EVERY`'s only production use is inside `emit`; the C-16 test
  // above writes its snapshot by hand via `store.putSnapshot` and proves
  // nothing about the pipeline actually calling it. Fast-forward the
  // session's own sequence counter so the hero's dodge turn's six events
  // land on 45..50 and the last one crosses the boundary.
  // `EventStore.append`'s only invariant is "no duplicate sequence for this
  // session" (event-store.ts) — it does not require a contiguous log — so
  // this is a legitimate way to reach the boundary without a 44-turn setup.
  //
  // C-18: the hero's turn is immediately followed by the hostile sweep
  // (Task 10), which keeps advancing `session.state` past sequence 50
  // within this same `handleCommand` call — by the time `drain` resolves,
  // `session.state` reflects the whole cascade, not just the moment the
  // snapshot was taken. So the expected state is captured live, the instant
  // the sequence-50 event frame is seen, rather than read back off
  // `session.state` afterwards. `reduce` never mutates in place
  // (`session.ts`'s doc comment), so that captured reference stays exactly
  // what it was at sequence 50 even as later turns replace `session.state`
  // with newer objects.
  it("writes a snapshot via the store once the running sequence crosses SNAPSHOT_EVERY", async () => {
    const store = createInMemoryEventStore();
    const session = await freshSession(store);
    session.nextSequence = SNAPSHOT_EVERY - 5;

    expect(await store.latestSnapshot("s1")).toBeNull();

    let stateAtSnapshot: SessionState | undefined;
    for await (const frame of handleCommand(session, dodge("hero"), portsWith(store))) {
      if (frame.type === "event" && frame.event.sequence === SNAPSHOT_EVERY) {
        stateAtSnapshot = session.state;
      }
    }

    const snapshot = await store.latestSnapshot("s1");
    expect(snapshot).toEqual({ sequence: SNAPSHOT_EVERY, state: stateAtSnapshot });
  });
});

describe("handleCommand — enemy turns", () => {
  it("runs every hostile turn before handing control back to the player", async () => {
    const store = createInMemoryEventStore();
    const session = await freshSession(store);
    const ports: TurnPorts = {
      ...portsWith(store),
      tactical: agentProposing([
        {
          actorId: "goblin-a",
          mainAction: { actionType: "dodge" },
          tacticalRationaleEnglish: "Test fixture.",
        },
        {
          actorId: "goblin-b",
          mainAction: { actionType: "dodge" },
          tacticalRationaleEnglish: "Test fixture.",
        },
      ]),
    };

    await drain(handleCommand(session, dodge("hero"), ports));

    // Back to the top of the order, one round later.
    expect(session.state.currentActorIndex).toBe(0);
    expect(session.state.round).toBe(2);
    // hero + two goblins each had their proposal validated.
    const validated = (await store.readSince("s1", 0)).filter(
      (each) => each.type === "action_validated",
    );
    expect(validated).toHaveLength(3);
  });

  it("logs the tactical agent's rejections as action_rejected events", async () => {
    const store = createInMemoryEventStore();
    const session = await freshSession(store);
    const ports: TurnPorts = {
      ...portsWith(store),
      tactical: agentRejectingThenRecovering(),
    };

    await drain(handleCommand(session, dodge("hero"), ports));

    const rejected = (await store.readSince("s1", 0)).filter(
      (each) => each.type === "action_rejected",
    );
    expect(rejected.length).toBeGreaterThan(0);
    expect(rejected[0]?.payload).toMatchObject({ actorId: "goblin-a", stage: "engine" });
  });

  // C-20: the brief's original version of this test asserted only
  // `validated.toHaveLength(3)` against a scenario that produced no
  // rejections at all — it checked nothing about stamping. This drives a
  // real rejection (goblin-a's first proposal is an off-grid move, illegal
  // on any geometry) and asserts the resulting `action_rejected` payload
  // names the model that actually produced it, read from the routing the
  // ports were configured with rather than a hardcoded literal —
  // `DEFAULT_MODEL_ROUTING.tactical` is a placeholder step 7b's benchmark
  // will change.
  it("stamps action_rejected events with the model that produced them", async () => {
    const store = createInMemoryEventStore();
    const session = await freshSession(store);
    const ports: TurnPorts = {
      ...portsWith(store),
      tactical: agentRejectingThenRecovering(),
    };

    await drain(handleCommand(session, dodge("hero"), ports));

    const rejected = (await store.readSince("s1", 0)).filter(
      (each) => each.type === "action_rejected",
    );
    expect(rejected.length).toBeGreaterThan(0);
    const spec = DEFAULT_MODEL_ROUTING.tactical;
    expect(rejected[0]?.payload).toMatchObject({
      provider: spec.provider,
      modelId: spec.modelId,
    });
  });

  it("narrates each enemy turn", async () => {
    const store = createInMemoryEventStore();
    const session = await freshSession(store);
    const ports: TurnPorts = {
      ...portsWith(store),
      tactical: agentProposing([
        {
          actorId: "goblin-a",
          mainAction: { actionType: "dodge" },
          tacticalRationaleEnglish: "Test fixture.",
        },
        {
          actorId: "goblin-b",
          mainAction: { actionType: "dodge" },
          tacticalRationaleEnglish: "Test fixture.",
        },
      ]),
    };
    await drain(handleCommand(session, dodge("hero"), ports));
    const narrated = (await store.readSince("s1", 0)).filter(
      (each) => each.type === "narrative_emitted",
    );
    expect(narrated).toHaveLength(3);
  });
});

describe("handleCommand — turn timeout", () => {
  it("falls back to terse narration when the narrative stream hangs", async () => {
    const store = createInMemoryEventStore();
    const session = await freshSession(store);
    const ports: TurnPorts = {
      ...portsWith(store),
      tactical: agentProposing([
        {
          actorId: "goblin-a",
          mainAction: { actionType: "dodge" },
          tacticalRationaleEnglish: "Test fixture.",
        },
        {
          actorId: "goblin-b",
          mainAction: { actionType: "dodge" },
          tacticalRationaleEnglish: "Test fixture.",
        },
      ]),
      narrative: hangingNarrative(),
      turnTimeoutMs: 50,
    };

    const frames = await drain(handleCommand(session, dodge("hero"), ports));

    // The turn completed rather than hanging, and it still produced prose.
    const emitted = (await store.readSince("s1", 0)).filter(
      (each) => each.type === "narrative_emitted",
    );
    expect(emitted.length).toBeGreaterThan(0);
    // "Guard": goblin-ambush's hero borrows the "guard" stat block (C-13).
    expect(emitted[0]?.payload).toMatchObject({
      text: expect.stringContaining("Guard") as string,
    });
    expect(frames.some((each) => each.type === "event")).toBe(true);
  }, 10_000);

  it("still advances the turn after a narrative timeout", async () => {
    const store = createInMemoryEventStore();
    const session = await freshSession(store);
    const ports: TurnPorts = {
      ...portsWith(store),
      tactical: agentProposing([
        {
          actorId: "goblin-a",
          mainAction: { actionType: "dodge" },
          tacticalRationaleEnglish: "Test fixture.",
        },
        {
          actorId: "goblin-b",
          mainAction: { actionType: "dodge" },
          tacticalRationaleEnglish: "Test fixture.",
        },
      ]),
      narrative: hangingNarrative(),
      turnTimeoutMs: 50,
    };
    await drain(handleCommand(session, dodge("hero"), ports));
    expect(session.state.round).toBe(2);
  }, 10_000);
});
