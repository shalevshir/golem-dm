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
import { DiceRolledPayload } from "@ai-dm/schemas";
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
import type { TacticalTurnMetrics, TurnPorts } from "./pipeline.js";
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

/**
 * A tactical port that never resolves on its own — it only settles once the
 * turn's `abortSignal` fires, the way a real provider call threads the
 * signal down to its own HTTP request and rejects when the request is
 * aborted. Used to pin `enemyTurn`'s `AbortController` timeout (`pipeline.ts`)
 * without a live model: every actor asked gets the same stalled call, and
 * every one is rescued by the same abort.
 */
function abortingTactical(): TacticalAgent {
  return {
    proposeTurn(input) {
      return new Promise((resolve) => {
        input.abortSignal?.addEventListener("abort", () => {
          resolve({ ok: false, kind: "aborted", rejections: [], usage: [] });
        });
      });
    },
  };
}

/**
 * Resolves with a legal dodge after `delayMs` — never aborted, just slow.
 * Used to prove `enemyTurn` shares ONE deadline between the tactical call
 * and the narration that follows it, rather than giving each its own fresh
 * `turnTimeoutMs` (the review's IMPORTANT finding): a tactical call that
 * eats most of the budget should leave the following narration almost none
 * of it, not a brand new window.
 */
function slowTactical(delayMs: number): TacticalAgent {
  return {
    proposeTurn(input) {
      return new Promise((resolve, reject) => {
        setTimeout(() => {
          const actor = input.world.combatants.find((each) => each.combatantId === input.actorId);
          if (actor === undefined) {
            reject(new Error(`No combatant ${input.actorId} in this encounter`));
            return;
          }
          const turn = {
            actorId: input.actorId,
            mainAction: { actionType: "dodge" as const },
            tacticalRationaleEnglish: "Test fixture: deliberately slow.",
          };
          const validation = validateExecuteTurn(turn, actor, input.world);
          if (!validation.valid) {
            reject(
              new Error(`Slow tactical double produced an illegal dodge for ${input.actorId}`),
            );
            return;
          }
          resolve({
            ok: true,
            turn,
            plan: validation.plan,
            source: "model",
            rejections: [],
            usage: [],
          });
        }, delayMs);
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

  // IMPORTANT-2: the previous version of this test ran `resumeFrom: 0`
  // against a log that was exactly the sequence-0 genesis event, so
  // `frames` was `[]` and the sole assertion — zero `session_state`
  // frames — passed vacuously: it would keep passing even if the branch
  // replayed nothing at all, or replayed from the wrong offset. Real
  // events past `resumeFrom`, with the exact returned sequences pinned,
  // is what actually exercises the replay.
  it("replays only the events after resumeFrom, in ascending sequence order", async () => {
    const store = createInMemoryEventStore();
    const session = await freshSession(store);
    await store.append("s1", [syntheticEvent(1), syntheticEvent(2), syntheticEvent(3)]);

    const frames = await drain(
      handleCommand(session, { type: "join", sessionId: "s1", resumeFrom: 1 }, portsWith(store)),
    );

    expect(frames.filter((each) => each.type === "session_state")).toHaveLength(0);
    const eventFrames = frames.filter((each) => each.type === "event");
    expect(eventFrames.map((each) => each.event.sequence)).toEqual([2, 3]);
  });

  // IMPORTANT-2: without this branch, a reconnecting client whose
  // `resumeFrom` is already the newest sequence — it missed nothing — got
  // zero frames back and could not tell "you're caught up" from "the
  // server dropped your join". `join` must have exactly one guaranteed
  // response; a `session_state` frame at the current projection is it,
  // the same shape a resumeFrom-less join gets (see `protocol.ts`'s
  // `JoinMessage` doc-comment, which spec #2 — the web client — builds
  // against).
  it("sends a session_state frame, not silence, when resumeFrom is already caught up", async () => {
    const store = createInMemoryEventStore();
    const session = await freshSession(store);

    const frames = await drain(
      handleCommand(session, { type: "join", sessionId: "s1", resumeFrom: 0 }, portsWith(store)),
    );

    // Task 4: this join lands on the hero's own turn, so a trailing
    // `turn_affordances` frame follows the `session_state` frame.
    expect(frames[0]).toEqual({ type: "session_state", sequence: 0, snapshot: session.state });
    expect(frames).toHaveLength(2);
    expect(frames[1]?.type).toBe("turn_affordances");
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

    // The type sequence alone can't tell three same-shaped turns apart — a
    // bug that ran the same actor's turn three times would produce this
    // exact list of types too. Pin *which* actor took each turn.
    const validated = (await store.readSince("s1", 0)).filter(
      (each) => each.type === "action_validated",
    );
    expect(validated.map((each) => each.payload["actorId"])).toEqual([
      "hero",
      "goblin-a",
      "goblin-b",
    ]);
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

  it("records movedFeet on the dice_rolled event for a turn that moved", async () => {
    const store = createInMemoryEventStore();
    const session = await freshSession(store);
    // Hero starts at [5, 4] in goblin-ambush. Move 2 tiles east (Chebyshev
    // distance 2, normal terrain) then dodge -- legal, and a clean 2 * 5ft
    // = 10ft to assert against.
    const moveAndDodge: ClientMessage = {
      type: "structured_action",
      clientMessageId: "c1",
      actorId: "hero",
      turn: {
        actorId: "hero",
        movement: [{ destinationTile: [7, 4], pathType: "direct" }],
        mainAction: { actionType: "dodge" },
        tacticalRationaleEnglish: "Test fixture: move then dodge.",
      },
    };

    await drain(handleCommand(session, moveAndDodge, portsWith(store)));
    const rolled = (await store.readSince("s1", 0)).find((each) => each.type === "dice_rolled");
    expect(rolled?.payload).toMatchObject({ movedFeet: 10 });
    // The real wire payload, not a hand-built fixture: proves DiceRolledPayload
    // actually describes what the server emits, not just what a test expects.
    expect(DiceRolledPayload.safeParse(rolled?.payload).success).toBe(true);
  });

  it("records movedFeet: 0 on a dice_rolled event for a turn with no movement", async () => {
    const store = createInMemoryEventStore();
    const session = await freshSession(store);
    await drain(handleCommand(session, dodge("hero"), portsWith(store)));
    const rolled = (await store.readSince("s1", 0)).find((each) => each.type === "dice_rolled");
    expect(rolled?.payload).toMatchObject({ movedFeet: 0 });
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

    // The error frame first, then a fresh affordance set. A failed append
    // does not advance the turn, so control is still the hero's, and the
    // client has already nulled its affordances against the frames `emit`
    // streamed before the throw — without the trailing frame the board goes
    // inert on the player's own turn (the C-1 soft-lock, rarer route).
    expect(frames[0]).toEqual({
      type: "error",
      clientMessageId: "c1",
      code: "internal_error",
      message: expect.any(String) as string,
    });
    const last = frames.at(-1);
    expect(last?.type).toBe("turn_affordances");
    expect(last?.type === "turn_affordances" && last.actorId).toBe("hero");
    expect(frames).toHaveLength(2);
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
    // hero + two goblins each had their proposal validated — and in that
    // exact order. `toHaveLength(3)` alone would still pass if the loop
    // revisited an actor and skipped another: 3 `action_validated`, 3
    // `narrative_emitted`, `currentActorIndex === 0` and `round === 2` are
    // all reachable that way too, since every path emits exactly one
    // `turn_advanced` regardless of which actor it was for.
    const validated = (await store.readSince("s1", 0)).filter(
      (each) => each.type === "action_validated",
    );
    expect(validated.map((each) => each.payload["actorId"])).toEqual([
      "hero",
      "goblin-a",
      "goblin-b",
    ]);
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

  // Pins the `combatant.status !== "alive"` skip in `runEnemyTurns`
  // (`pipeline.ts`), previously untested: a dead combatant is passed over
  // with a bare `turn_advanced` rather than asked for a turn.
  it("skips a dead or unconscious combatant instead of asking it for a turn", async () => {
    const store = createInMemoryEventStore();
    const session = await freshSession(store);
    session.state = {
      ...session.state,
      combatants: session.state.combatants.map((each) =>
        each.combatantId === "goblin-a" ? { ...each, status: "dead" as const } : each,
      ),
    };
    const ports: TurnPorts = {
      ...portsWith(store),
      // Only one script entry: if the dead goblin-a were asked for a turn
      // too, the fake port would reject with "script exhausted" instead of
      // this call ever completing.
      tactical: agentProposing([
        {
          actorId: "goblin-b",
          mainAction: { actionType: "dodge" },
          tacticalRationaleEnglish: "Test fixture.",
        },
      ]),
    };

    await drain(handleCommand(session, dodge("hero"), ports));

    const validated = (await store.readSince("s1", 0)).filter(
      (each) => each.type === "action_validated",
    );
    expect(validated.map((each) => each.payload["actorId"])).toEqual(["hero", "goblin-b"]);
    expect(session.state.currentActorIndex).toBe(0);
    expect(session.state.round).toBe(2);
  });

  // Regression for the defect Task 11's replay properties caught: `reduce`
  // never used to reset a combatant's action economy between their own
  // turns, so every combatant's SECOND-EVER action was rejected
  // `action_already_used` — no session could ever complete a second round.
  // Every other test in this describe block only ever sends the hero one
  // command (`dodge("hero")`'s hardcoded `clientMessageId: "c1"`), which is
  // exactly why ten tasks and 66 green tests never caught it: nothing here
  // exercised a second round before now. Fixed in `reduce.ts`'s
  // `scene_changed`/`turn_advanced` case.
  it("lets a combatant act again on their second round, not just their first", async () => {
    const store = createInMemoryEventStore();
    const session = await freshSession(store);
    const ports = portsWith(store);

    await drain(handleCommand(session, dodge("hero"), ports));
    expect(session.state.round).toBe(2);
    expect(session.state.currentActorIndex).toBe(0);

    const roundTwoHeroTurn: ClientMessage = {
      type: "structured_action",
      clientMessageId: "c2",
      actorId: "hero",
      turn: {
        actorId: "hero",
        mainAction: { actionType: "dodge" },
        tacticalRationaleEnglish: "Test fixture: round 2.",
      },
    };
    const frames = await drain(handleCommand(session, roundTwoHeroTurn, ports));

    // Before the fix, this is exactly where the engine answered
    // `action_already_used` and the round never advanced past hero again.
    expect(frames.filter((each) => each.type === "rejected")).toEqual([]);
    expect(session.state.round).toBe(3);
    expect(session.state.currentActorIndex).toBe(0);

    const heroValidations = (await store.readSince("s1", 0)).filter(
      (each) => each.type === "action_validated" && each.payload["actorId"] === "hero",
    );
    expect(heroValidations).toHaveLength(2);
  });
});

// Important 2 (task 14 review round 2): C-23's "must actually emit" had
// rested entirely on code reading — no test constructed a `TurnPorts` with
// `metrics` and drove a turn through it. A `reduce` that summed
// `promptTokens` into `completionTokens`, or a call site placed on a branch
// that never runs, would have shipped green.
describe("handleCommand — tactical metrics", () => {
  it("records one MetricsPort call per enemy turn, with correct summed token totals", async () => {
    const store = createInMemoryEventStore();
    const session = await freshSession(store);
    const recorded: TacticalTurnMetrics[] = [];
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
      metrics: {
        recordTacticalTurn(metrics) {
          recorded.push(metrics);
        },
      },
    };

    await drain(handleCommand(session, dodge("hero"), ports));

    // One call per enemy turn, in order — and NONE for the hero's own turn,
    // which makes no tactical call at all. A call recorded for "hero" (or
    // simply a length of 3) would mean the port fired on a player turn too;
    // a length of 0 would mean it never fired.
    expect(recorded.map((each) => each.actorId)).toEqual(["goblin-a", "goblin-b"]);

    for (const metrics of recorded) {
      // `agentProposing`'s fixture (C-2) scripts exactly this usage per
      // billed attempt, and each goblin's proposed dodge is legal on the
      // first try — one billed attempt, zero retries. Distinct
      // prompt/completion/total values (10/5/15) mean a transposition bug
      // (e.g. summing promptTokens into completionTokens) shows up as a
      // wrong number here rather than passing by coincidence.
      expect(metrics).toMatchObject({
        outcome: "ok",
        source: "model",
        billedAttempts: 1,
        retries: 0,
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
      });
      expect(metrics.latencyMs).toBeGreaterThanOrEqual(0);
    }
  });

  it("still resolves the turn normally when no MetricsPort is supplied", async () => {
    // `metrics` is optional on `TurnPorts` precisely so the ten other
    // describe blocks in this file need not supply one — pin that an enemy
    // turn works the same either way rather than assuming it from the
    // type alone.
    const store = createInMemoryEventStore();
    const session = await freshSession(store);
    const frames = await drain(handleCommand(session, dodge("hero"), portsWith(store)));
    expect(frames.some((each) => each.type === "error")).toBe(false);
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

  // Previously untested: both timeout tests above stall only the narrative
  // port, so the tactical `AbortController` at `enemyTurn`'s `:187-189` and
  // the "creature forfeits its turn rather than the pipeline stalling"
  // branch it feeds (`:210-215`) had no coverage — the exact resilience
  // behaviour the 10s cap exists to provide.
  it("aborts a stalled tactical proposal and forfeits that creature's turn", async () => {
    const store = createInMemoryEventStore();
    const session = await freshSession(store);
    const ports: TurnPorts = {
      ...portsWith(store),
      tactical: abortingTactical(),
      turnTimeoutMs: 50,
    };

    await drain(handleCommand(session, dodge("hero"), ports));

    // hero's own turn (no tactical call involved) completes normally; both
    // goblins' tactical calls stall until the abort fires, and each
    // forfeits with a bare turn_advanced — no action_validated,
    // dice_rolled, state_delta_applied or narrative_emitted for either.
    const types = (await store.readSince("s1", 0)).map((each) => each.type);
    expect(types).toEqual([
      "player_input",
      "action_validated",
      "dice_rolled",
      "state_delta_applied",
      "narrative_emitted",
      "scene_changed",
      "scene_changed",
      "scene_changed",
    ]);
    expect(session.state.currentActorIndex).toBe(0);
    expect(session.state.round).toBe(2);
  }, 10_000);

  // The review's IMPORTANT finding: the tactical call and the narration
  // that follows it must share ONE 10s budget, not each get their own —
  // apps/server/CLAUDE.md's "hard turn timeout 10s" and the spec's "A 10s
  // hard cap wraps the narrative stream and the tactical call" both read as
  // a single cap. Pinned here without mocking `Date.now()`: a tactical call
  // that is slow but never aborted (150ms, under a 200ms budget) should
  // leave the narration that follows almost none of that budget, not a
  // fresh 200ms window — so three actors' turns finish in about one
  // budget's worth of wall-clock time, not the ~1.5-2x a pair of
  // independent budgets per enemy turn would take.
  //
  // Review round 3: `turnTimeoutMs` and `slowTactical`'s delay were scaled
  // up 2.5x from the original 80ms/60ms (to 200ms/150ms), and the
  // threshold with them — not because the pipeline needs a bigger budget,
  // but because this is a wall-clock assertion and its discrimination is a
  // RATIO (shared band vs. doubled band), not an absolute gap. At 80ms the
  // shared band (~240ms) left only ~60ms — about 25% — of headroom below
  // the 300ms threshold, which a loaded machine or a parallel `pnpm test`
  // run eats easily: measured failing at 331ms under full-suite contention
  // while passing 5/5 alone. Scaling the whole experiment up does NOT keep
  // that same ~25% ratio: the measured shared band at these numbers is
  // 623-695ms, so the real headroom under the 750ms threshold is only
  // 8-17% (55-127ms). What the scaling actually buys is headroom against
  // the OTHER scenario this threshold has to discriminate from — the
  // measured two-independent-budgets floor is 1013-1045ms, and 750ms sits
  // 26-28% below that (26.0% against the 1013ms low end), so a run that
  // regresses to separate budgets still fails loudly. Do not "optimise" this back down
  // to a smaller budget — that reintroduces the exact fragility this round
  // exists to remove.
  it("shares one budget between the tactical call and the narration, not two", async () => {
    const store = createInMemoryEventStore();
    const session = await freshSession(store);
    const ports: TurnPorts = {
      ...portsWith(store),
      tactical: slowTactical(150),
      narrative: hangingNarrative(),
      turnTimeoutMs: 200,
    };

    // Review round 2: this used to time the whole `drain(...)`, but since
    // Task 4 that drain ends with a `turn_affordances` frame — pure
    // computation (`affordancesFor` probing ~143 candidate tiles through
    // `validateExecuteTurn`) that no deadline governs. Folding that fixed
    // ~100ms of real work into the budget-sharing assertion erased the
    // margin the comment above describes. Consuming the generator by hand
    // and stamping a timestamp only on frames the turn timeout actually
    // governs — i.e. everything except `turn_affordances` — excludes that
    // trailing computation by construction, so this keeps measuring the
    // deadline-governed stretch the test claims to measure.
    //
    // What this relies on is narrower than "the drain ends with
    // `turn_affordances`": it is that a `turn_affordances` frame, WHEREVER
    // it appears in the stream, is never deadline-governed — `playerAffordances`
    // is a pure synchronous generator with no `await` in it (see its doc
    // comment in pipeline.ts), at every one of the three points the pipeline
    // emits one, including the rejection path a rejected `structured_action`
    // now also ends on. This test only exercises a successful dodge, so it
    // never reaches that path — but the exclusion is correct there too, for
    // the same reason. Do not "simplify" this back to timing the whole
    // drain: that would silently reconflate pipeline throughput with
    // timeout-budget sharing.
    const start = Date.now();
    let lastGovernedFrameAt = start;
    for await (const frame of handleCommand(session, dodge("hero"), ports)) {
      if (frame.type !== "turn_affordances") lastGovernedFrameAt = Date.now();
    }
    const elapsed = lastGovernedFrameAt - start;

    // Shared deadline (theoretical): hero (~200ms, narration-only) +
    // goblin-a (~200ms: 150ms tactical + ~50ms remaining narration cap) +
    // goblin-b (~200ms) is roughly 600ms. Two independent budgets per enemy
    // turn would instead be hero (~200ms) + goblin-a (150 + 200 = 350ms) +
    // goblin-b (350ms), or roughly 900ms. Measured wall-clock reality runs
    // higher than either estimate (see the "Review round 3" comment above
    // for the actual figures and the real headroom the 750ms threshold
    // gives against each scenario).
    expect(elapsed).toBeLessThan(750);
    expect(session.state.round).toBe(2);
  }, 10_000);
});

describe("handleCommand — turn_affordances", () => {
  it("follows a join that lands on the player's turn", async () => {
    const store = createInMemoryEventStore();
    const session = await freshSession(store);
    const frames = await drain(
      handleCommand(session, { type: "join", sessionId: "s1" }, portsWith(store)),
    );

    const last = frames.at(-1);
    expect(last?.type).toBe("turn_affordances");
    expect(last?.type === "turn_affordances" && last.actorId).toBe("hero");
    expect(last?.type === "turn_affordances" && last.forSequence).toBe(session.nextSequence - 1);
  });

  it("offers the hero a reachable set and the spear against an adjacent goblin", async () => {
    const store = createInMemoryEventStore();
    const session = await freshSession(store);
    const frames = await drain(
      handleCommand(session, { type: "join", sessionId: "s1" }, portsWith(store)),
    );
    const affordances = frames.at(-1);

    if (affordances?.type !== "turn_affordances") throw new Error("expected affordances");
    expect(affordances.reachableTiles.length).toBeGreaterThan(0);

    const spear = affordances.actions.find((each) => each.actionId === "spear");
    expect(spear?.targetableCombatantIds).toContain("goblin-a");
  });

  it("does NOT follow a join that lands on a hostile's turn", async () => {
    const store = createInMemoryEventStore();
    const session = await freshSession(store);
    // Advance past the hero so a goblin is up.
    session.state = { ...session.state, currentActorIndex: 1 };

    const frames = await drain(
      handleCommand(session, { type: "join", sessionId: "s1" }, portsWith(store)),
    );
    expect(frames.some((each) => each.type === "turn_affordances")).toBe(false);
    // Review round 1, item 4: pin that the join still produced its normal
    // response — absence-only would also pass a join that yields nothing.
    expect(frames.at(-1)?.type).toBe("session_state");
  });

  // Review round 1, item 1: the original `if (index !== -1)` guard let this
  // test pass vacuously — deleting `yield* playerAffordances();` from the
  // `structured_action` case left the whole suite green, because nothing
  // else in this file drives a `structured_action` far enough to observe
  // the second yield point (the e2e reconnect test only covers `join`).
  // `defaultTactical` has both goblins dodge, so nobody dies and control
  // deterministically returns to the hero — the same fixture the
  // "runs every hostile turn before handing control back to the player"
  // test (above) already pins to `currentActorIndex === 0` / `round === 2`
  // after this identical command. The branch always fires here, so the
  // assertion is unconditional.
  it("follows a completed turn that returns control to the player", async () => {
    const store = createInMemoryEventStore();
    const session = await freshSession(store);
    const frames = await drain(handleCommand(session, dodge("hero"), portsWith(store)));

    const last = frames.at(-1);
    expect(last?.type).toBe("turn_affordances");
    expect(last?.type === "turn_affordances" && last.actorId).toBe("hero");
    expect(frames.findIndex((each) => each.type === "turn_affordances")).toBe(frames.length - 1);
  });

  // A rejection does not advance the turn, so control is still the
  // player's — the pipeline treats it as a third affordance point alongside
  // `join` and a completed turn (see `playerAffordances`'s doc comment).
  // Without a trailing affordance frame here, the client's fold (which
  // clears affordances on every event frame, including `action_rejected`)
  // is left with no way to recover: the action bar stays unmounted and the
  // board stays inert for the rest of the player's own turn.
  it("follows a rejected action, which does not advance the turn, with a fresh affordance frame", async () => {
    const store = createInMemoryEventStore();
    const session = await freshSession(store);
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

    const last = frames.at(-1);
    expect(last?.type).toBe("turn_affordances");
    expect(last?.type === "turn_affordances" && last.actorId).toBe("hero");
    expect(frames.findIndex((each) => each.type === "turn_affordances")).toBe(frames.length - 1);
  });
});
