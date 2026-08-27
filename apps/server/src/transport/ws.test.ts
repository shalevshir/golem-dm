import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import {
  createAgentRuntime,
  createDeterministicNarrative,
  createFakePort,
  createTacticalAgent,
  DEFAULT_MODEL_ROUTING,
} from "@ai-dm/agents";
import type { NarrativePort } from "@ai-dm/agents";
import { createInMemoryEventStore } from "@ai-dm/memory";
import type { EventStore } from "@ai-dm/memory";
import { ServerFrame } from "@ai-dm/schemas";
import { buildApp } from "../app.js";
import type { TurnPorts } from "../core/pipeline.js";
import { encounterOf, loadCampaign } from "../core/campaign.js";
import { createCampaignRegistry } from "./http.js";
import type { FastifyInstance } from "fastify";

let running: FastifyInstance | null = null;

afterEach(async () => {
  await running?.close();
  running = null;
});

async function startServer(overrides?: { narrative?: NarrativePort }) {
  const store = createInMemoryEventStore();
  let n = 0;
  const uuid = (): string => {
    n += 1;
    return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  };
  // C-1/C-2: `ExecuteTurn.tacticalRationaleEnglish` has no `.optional()` and
  // `TokenUsage` is `{ promptTokens, completionTokens, totalTokens }`, not
  // `{ inputTokens, outputTokens }` — see `packages/agents/src/providers/
  // testing/fake-port.ts` and `packages/schemas/src/actions.ts`. Getting
  // either wrong here makes `ClientMessage.safeParse` (for the wire
  // literals below) or the compiler (for this typed script) reject, not the
  // assertions.
  const port = createFakePort({
    structured: Array.from({ length: 40 }, () => ({
      ok: true as const,
      value: {
        value: {
          actorId: "goblin-a",
          mainAction: { actionType: "dodge" },
          tacticalRationaleEnglish: "Fake tactical fixture: always dodge.",
        },
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      },
    })),
  });
  const ports: TurnPorts = {
    store,
    tactical: createTacticalAgent({
      runtime: createAgentRuntime({ routing: DEFAULT_MODEL_ROUTING, port }),
    }),
    narrative: overrides?.narrative ?? createDeterministicNarrative(),
    clock: () => "2026-08-19T10:00:00.000Z",
    uuid,
    seedFor: (rootSeed, sequence) => rootSeed * 1000 + sequence,
    turnTimeoutMs: 10_000,
    conditionNamesHebrew: new Map([["prone", "שרוע"]]),
  };
  const registry = createCampaignRegistry({
    store,
    uuid,
    clock: () => "2026-08-19T10:00:00.000Z",
    seed: () => 42,
  });

  const app = buildApp({ registry, ports });
  await app.listen({ port: 0, host: "127.0.0.1" });
  running = app;

  const address = app.server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return { app, url: `ws://127.0.0.1:${String(address.port)}/ws`, store };
}

function connect(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url);
  return new Promise((resolve, reject) => {
    socket.once("open", () => {
      resolve(socket);
    });
    socket.once("error", reject);
  });
}

// Below the default vitest `testTimeout` (5000ms, unconfigured in this repo)
// so a hung wait fails with THIS module's diagnostic message — which frame
// showed up, or none at all — rather than vitest's generic "test timed out
// in 5000ms", which was previously indistinguishable from every other way a
// test could hang (review finding, task 14 round 2).
const FRAME_TIMEOUT_MS = 3000;

/**
 * Collect frames until `stop` says we have what we came for. Cleans up its
 * own listeners and timer on every path — resolve, reject on timeout, and
 * reject on a socket error — not just the happy path: a leaked `message`
 * listener from an earlier test's socket would otherwise go on collecting
 * frames (and calling that test's now-resolved `stop`) for every socket
 * this file connects afterward.
 */
function framesUntil(
  socket: WebSocket,
  stop: (frame: ServerFrame) => boolean,
): Promise<ServerFrame[]> {
  const frames: ServerFrame[] = [];
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out after ${String(frames.length)} frames`));
    }, FRAME_TIMEOUT_MS);
    function onMessage(data: Buffer | string): void {
      // Important 3: parsed against the real schema, not cast — the branch
      // exists to freeze this wire contract, so a frame that violates
      // `ServerFrame` must fail the test, not silently satisfy `.type`
      // checks the way `JSON.parse(...) as ServerFrame` would let it.
      const frame = ServerFrame.parse(JSON.parse(String(data)));
      frames.push(frame);
      if (stop(frame)) {
        cleanup();
        resolve(frames);
      }
    }
    function onError(error: Error): void {
      cleanup();
      reject(error);
    }
    function cleanup(): void {
      clearTimeout(timer);
      socket.off("message", onMessage);
      socket.off("error", onError);
    }
    socket.on("message", onMessage);
    socket.on("error", onError);
  });
}

/**
 * Send `join` and resolve once the server acks with its first reply.
 * Bounded and diagnostic (Minor 7, task 14 round 2): the ad hoc
 * `new Promise<void>((resolve) => socket.once("message", resolve))` this
 * replaces had no timeout and no reject path, so a regression here used to
 * surface as vitest's generic timeout instead of a message naming what
 * never arrived.
 */
function joinAndWaitForAck(socket: WebSocket, campaignId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("join was never acknowledged"));
    }, FRAME_TIMEOUT_MS);
    function onMessage(): void {
      cleanup();
      resolve();
    }
    function onError(error: Error): void {
      cleanup();
      reject(error);
    }
    function cleanup(): void {
      clearTimeout(timer);
      socket.off("message", onMessage);
      socket.off("error", onError);
    }
    socket.on("message", onMessage);
    socket.on("error", onError);
    socket.send(JSON.stringify({ type: "join", campaignId }));
  });
}

/**
 * Delays every stream by `delayMs` before handing off to the real
 * deterministic narrative — long enough to hold `handleCommand` suspended
 * inside `narrate()` (pipeline.ts) for the window a test needs to send a
 * second command while the first is still "in flight" for its campaign.
 */
function delayedNarrative(delayMs: number): NarrativePort {
  const real = createDeterministicNarrative();
  return {
    async *stream(input) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      yield* real.stream(input);
    },
  };
}

/**
 * Polls the server's own projection (mirrors `e2e.test.ts`'s
 * `waitForProjection`, kept local per the fix-wave instruction not to build
 * a shared test-support module) until a full round has resolved: either the
 * turn order is back to the hero, or one faction has been wiped out.
 */
async function waitForRoundSettled(store: EventStore, campaignId: string): Promise<void> {
  const deadline = Date.now() + FRAME_TIMEOUT_MS;
  for (;;) {
    const campaign = await loadCampaign({ campaignId, store });
    if (campaign === null) throw new Error(`Campaign ${campaignId} disappeared while polling.`);
    const alive = new Set(
      encounterOf(campaign)
        .combatants.filter((c) => c.status === "alive")
        .map((c) => c.faction),
    );
    const backToHero =
      encounterOf(campaign).turnOrder[encounterOf(campaign).currentActorIndex] === "hero";
    if (alive.size < 2 || backToHero) return;
    if (Date.now() > deadline) {
      throw new Error(`Round never settled within ${String(FRAME_TIMEOUT_MS)}ms.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function createCampaignOver(app: FastifyInstance): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/campaigns",
    payload: { encounterId: "goblin-ambush" },
  });
  return (JSON.parse(response.body) as { campaignId: string }).campaignId;
}

describe("websocket transport", () => {
  // Break scenario: `registerWebSocketRoute` returning nothing but a bare
  // `campaign_state` echo (or never wiring `join` to the registry at all)
  // still needs SOME response for this to fail — this asserts the frame
  // is specifically `campaign_state`, so a handler that answered every
  // message with a generic `error` frame, or that hung and never replied,
  // both turn this red rather than green.
  it("answers a join with a campaign_state snapshot", async () => {
    const { app, url } = await startServer();
    const campaignId = await createCampaignOver(app);
    const socket = await connect(url);
    const pending = framesUntil(socket, (frame) => frame.type === "campaign_state");
    socket.send(JSON.stringify({ type: "join", campaignId }));
    const frames = await pending;
    expect(frames[0]).toMatchObject({ type: "campaign_state" });
    socket.close();
  });

  // Break scenario: a handler that let an unknown campaignId fall through to
  // `handleCommand` (which assumes a bound `Campaign`) would throw or hang
  // instead of answering `unknown_campaign` — this fails red either way,
  // rather than passing on any non-empty response.
  it("errors on an unknown campaign rather than closing the socket", async () => {
    const { url } = await startServer();
    const socket = await connect(url);
    const pending = framesUntil(socket, (frame) => frame.type === "error");
    socket.send(JSON.stringify({ type: "join", campaignId: "nope" }));
    expect((await pending)[0]).toMatchObject({ code: "unknown_campaign" });
    socket.close();
  });

  // Break scenario: a handler that let `JSON.parse` throw uncaught (instead
  // of catching it and answering `malformed_message`) would crash the
  // message handler and this promise would time out rather than resolve.
  it("errors on a malformed message rather than crashing", async () => {
    const { url } = await startServer();
    const socket = await connect(url);
    const pending = framesUntil(socket, (frame) => frame.type === "error");
    socket.send("not json at all");
    expect((await pending)[0]).toMatchObject({ code: "malformed_message" });
    socket.close();
  });

  // Break scenario: a handler that only guarded against invalid JSON, not
  // against JSON that parses but fails `ClientMessage.safeParse` (an
  // unrecognized `type`), would pass this a `command` typed as `never` and
  // either throw inside `handleCommand`'s exhaustiveness guard or silently
  // drop the message — both leave this pending forever instead of getting
  // `malformed_message`.
  it("errors on a message that parses but is not a ClientMessage", async () => {
    const { url } = await startServer();
    const socket = await connect(url);
    const pending = framesUntil(socket, (frame) => frame.type === "error");
    socket.send(JSON.stringify({ type: "shout", text: "hi" }));
    expect((await pending)[0]).toMatchObject({ code: "malformed_message" });
    socket.close();
  });

  // Break scenario: this is the one test that would go red if the transport
  // merely echoed frames without actually driving `handleCommand`'s turn
  // pipeline, or if it stopped at the first frame instead of streaming both
  // `narrative_token` and `event` frames — asserting on frame *types*
  // (not `frames.length > 0`) is what a `malformed_message` error frame
  // cannot satisfy by accident.
  it("plays a turn and streams its events and narrative", async () => {
    const { app, url } = await startServer();
    const campaignId = await createCampaignOver(app);
    const socket = await connect(url);

    await joinAndWaitForAck(socket, campaignId);

    const pending = framesUntil(
      socket,
      (frame) => frame.type === "event" && frame.event.type === "scene_changed",
    );
    socket.send(
      JSON.stringify({
        type: "structured_action",
        clientMessageId: "c1",
        actorId: "hero",
        turn: {
          actorId: "hero",
          mainAction: { actionType: "dodge" },
          tacticalRationaleEnglish: "Test fixture: hero dodges.",
        },
      }),
    );

    const frames = await pending;
    expect(frames.some((each) => each.type === "narrative_token")).toBe(true);
    expect(frames.some((each) => each.type === "event")).toBe(true);
    socket.close();
  });

  // Important 1 (task 14 review round 2): C-36a requires the transport to
  // DRAIN `handleCommand` to completion, never abandon it mid-turn. Every
  // test above passes even under the exact violation C-36a forbids:
  //
  //   for await (const frame of handleCommand(...)) {
  //     send(frame);
  //     if (frame.type === "event" && frame.event.type === "scene_changed") break;
  //   }
  //
  // because the FIRST `scene_changed` on the `structured_action` path is
  // the PLAYER's OWN turn-advance (pipeline.ts), emitted before
  // `runEnemyTurns()` is even called — so a `break` there stops before a
  // single enemy turn has run while still satisfying every frame-type
  // assertion above. Proof has to come from the server's own event log,
  // not from the socket: once the client closes there is nothing left to
  // receive frames on, but a compliant handler keeps the generator running
  // and keeps appending regardless.
  it("keeps appending the enemy sweep after the client closes mid-turn (C-36a)", async () => {
    const { app, url, store } = await startServer();
    const campaignId = await createCampaignOver(app);
    const socket = await connect(url);

    await joinAndWaitForAck(socket, campaignId);

    // Close the instant the player's OWN scene_changed arrives — strictly
    // before goblin-a's turn starts.
    const closedAfterOwnTurn = framesUntil(socket, (frame) => {
      const isOwnTurnAdvance = frame.type === "event" && frame.event.type === "scene_changed";
      if (isOwnTurnAdvance) socket.close();
      return isOwnTurnAdvance;
    });
    socket.send(
      JSON.stringify({
        type: "structured_action",
        clientMessageId: "c1",
        actorId: "hero",
        turn: {
          actorId: "hero",
          mainAction: { actionType: "dodge" },
          tacticalRationaleEnglish: "Test fixture: hero dodges.",
        },
      }),
    );
    await closedAfterOwnTurn;

    // `goblin-a` is the first hostile in goblin-ambush's turn order
    // (apps/server/src/encounters/index.ts) — its `action_validated` event
    // can only exist in the log if `runEnemyTurns` actually ran, which only
    // happens if the handler kept draining after the socket above closed.
    // Polled rather than awaited once: the drain finishes in well under a
    // second in this in-memory setup, but nothing here should assume a
    // fixed delay.
    const sawEnemyTurn = async (): Promise<boolean> => {
      const events = await store.readSince(campaignId, -1);
      return events.some(
        (event) => event.type === "action_validated" && event.payload["actorId"] === "goblin-a",
      );
    };
    const deadline = Date.now() + 2000;
    for (;;) {
      if (await sawEnemyTurn()) break;
      if (Date.now() > deadline) {
        throw new Error(
          "goblin-a's action_validated was never appended after the socket closed " +
            "— the handler abandoned handleCommand instead of draining it (C-36a)",
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  });

  // CRITICAL-1: the in-flight guard must be scoped to the CAMPAIGN, not the
  // socket. Campaigns are shared across sockets on purpose (`http.ts`'s
  // `live` cache — two WS connections onto the same campaign, Task 14), and
  // `nextSequence`/`campaign.state` live on that one shared `Campaign` object,
  // advanced in place. A guard that lives per-socket (a `let busy = false`
  // closed over inside `app.get("/ws", ...)`) cannot see a second socket's
  // in-flight command at all, so two sockets bound to the same campaign can
  // each pass their own turn-order check while the first turn is still
  // resolving — playing the same actor's turn twice and running two enemy
  // sweeps for one round, all at valid, distinct sequences, so nothing ever
  // throws. It is a silently corrupt append-only log.
  //
  // `narrative: delayedNarrative(...)` holds socket A's own `structured_action`
  // suspended inside `narrate()` (pipeline.ts) well after `player_input` and
  // `action_validated`/`dice_rolled`/`state_delta_applied` have already been
  // appended and `currentActorIndex` still points at the hero (turn_advanced
  // is the LAST event of a turn) — exactly the window the finding describes.
  // Socket B, joined to the SAME campaign, sends its own hero action inside
  // that window.
  //
  // Break scenario: against the per-socket `busy` flag this branch replaces,
  // socket B's `busy` is `false` (it is its own connection), so its action
  // sails through the same `currentActorId !== command.actorId` check socket
  // A already passed — it gets played as a real turn instead of
  // `turn_in_progress`, and the log ends up with two `player_input` events
  // for "hero" in the same round.
  it("rejects a same-campaign command from a SECOND socket while the first is mid-turn, without duplicating the turn in the log (CRITICAL-1)", async () => {
    const { app, url, store } = await startServer({ narrative: delayedNarrative(400) });
    const campaignId = await createCampaignOver(app);

    const socketA = await connect(url);
    await joinAndWaitForAck(socketA, campaignId);
    const socketB = await connect(url);
    await joinAndWaitForAck(socketB, campaignId);

    // Socket A starts a hero turn. Wait for ITS OWN player_input event before
    // sending B's command — proof that A is now committed mid-turn (past
    // validation, on its way into the deliberately slow `narrate()`) rather
    // than racing on an unstarted request.
    const aPlayerInput = framesUntil(
      socketA,
      (frame) => frame.type === "event" && frame.event.type === "player_input",
    );
    socketA.send(
      JSON.stringify({
        type: "structured_action",
        clientMessageId: "a1",
        actorId: "hero",
        turn: {
          actorId: "hero",
          mainAction: { actionType: "dodge" },
          tacticalRationaleEnglish: "Test fixture: socket A's hero turn.",
        },
      }),
    );
    await aPlayerInput;

    // Socket B, bound to the SAME campaign, tries to play a hero turn of its
    // own while A's is still resolving (A is inside the 400ms narrate delay).
    const bRejection = framesUntil(socketB, (frame) => frame.type === "error");
    socketB.send(
      JSON.stringify({
        type: "structured_action",
        clientMessageId: "b1",
        actorId: "hero",
        turn: {
          actorId: "hero",
          mainAction: { actionType: "dodge" },
          tacticalRationaleEnglish: "Test fixture: socket B tries to play hero too.",
        },
      }),
    );
    const bFrames = await bRejection;
    expect(bFrames.at(-1)).toMatchObject({ code: "turn_in_progress", clientMessageId: "b1" });

    // Let A's turn (and the enemy sweep it triggers) finish appending before
    // inspecting the log.
    await waitForRoundSettled(store, campaignId);

    const events = await store.readSince(campaignId, -1);
    const heroPlayerInputs = events.filter(
      (event) => event.type === "player_input" && event.payload["actorId"] === "hero",
    );
    // Exactly A's own turn — never duplicated, and never B's.
    expect(heroPlayerInputs).toHaveLength(1);
    expect(heroPlayerInputs[0]?.payload["clientMessageId"]).toBe("a1");
    expect(events.some((event) => event.payload["clientMessageId"] === "b1")).toBe(false);

    socketA.close();
    socketB.close();
  });

  // General coverage for `turn_in_progress` (finding 8: it was the only
  // `ServerErrorCode` with zero tests) on the simpler, same-socket path: a
  // second message on the SAME connection while the first is still
  // resolving is also rejected, not queued (spec §Concurrency — a queued
  // stale click would land against a changed board).
  it("rejects a second command on the SAME socket while the first is still resolving", async () => {
    const { app, url } = await startServer({ narrative: delayedNarrative(400) });
    const campaignId = await createCampaignOver(app);
    const socket = await connect(url);
    await joinAndWaitForAck(socket, campaignId);

    const playerInput = framesUntil(
      socket,
      (frame) => frame.type === "event" && frame.event.type === "player_input",
    );
    socket.send(
      JSON.stringify({
        type: "structured_action",
        clientMessageId: "first",
        actorId: "hero",
        turn: {
          actorId: "hero",
          mainAction: { actionType: "dodge" },
          tacticalRationaleEnglish: "Test fixture: first command.",
        },
      }),
    );
    await playerInput;

    const rejection = framesUntil(socket, (frame) => frame.type === "error");
    socket.send(
      JSON.stringify({
        type: "structured_action",
        clientMessageId: "second",
        actorId: "hero",
        turn: {
          actorId: "hero",
          mainAction: { actionType: "dodge" },
          tacticalRationaleEnglish: "Test fixture: second command, same socket.",
        },
      }),
    );
    // `.at(-1)`, not `[0]`: this socket already has frames from the FIRST
    // command's own pipeline in flight (action_validated/dice_rolled/
    // state_delta_applied all fire synchronously, before narrate()'s
    // deliberate delay), so this listener — registered after `player_input`
    // — can catch one of those as its first frame. `framesUntil` only
    // resolves once `stop` matches, so the frame that satisfied it is
    // always the last one pushed.
    const frames = await rejection;
    expect(frames.at(-1)).toMatchObject({
      code: "turn_in_progress",
      clientMessageId: "second",
    });

    socket.close();
  });

  // Post-review regression fix: `join` must NOT compete for the per-campaign
  // lock. `join` (pipeline.ts) is read-only — latestSnapshot/readSince,
  // yielding campaign_state/event frames, never `emit` — so it cannot itself
  // duplicate a turn, the only hazard CRITICAL-1's lock exists to prevent.
  // Claiming the lock for `join` regressed the spec's own §Reconnect
  // requirement: C-36a keeps a turn's `handleCommand` draining — lock held —
  // for the whole hero turn plus the entire enemy sweep even after the
  // originating socket is gone, so a client that drops mid-turn and
  // reconnects would have its OWN `join` rejected with `turn_in_progress`
  // instead of getting the `campaign_state` restore `protocol.ts`'s
  // `JoinMessage` doc-comment promises.
  //
  // Break scenario: a handler that still claims the campaign lock for `join`
  // answers socket B's join with `error { code: "turn_in_progress" }`
  // instead of `campaign_state` while socket A's turn is still resolving.
  it("lets a SECOND socket join and get its campaign_state restore while a turn is in flight on the first socket", async () => {
    const { app, url, store } = await startServer({ narrative: delayedNarrative(400) });
    const campaignId = await createCampaignOver(app);

    const socketA = await connect(url);
    await joinAndWaitForAck(socketA, campaignId);

    // Socket A starts a hero turn and gets stuck in narrate()'s 400ms delay.
    // Wait for A's own player_input event first — proof the lock (if `join`
    // still contended for it) would already be held.
    const aPlayerInput = framesUntil(
      socketA,
      (frame) => frame.type === "event" && frame.event.type === "player_input",
    );
    socketA.send(
      JSON.stringify({
        type: "structured_action",
        clientMessageId: "a1",
        actorId: "hero",
        turn: {
          actorId: "hero",
          mainAction: { actionType: "dodge" },
          tacticalRationaleEnglish: "Test fixture: socket A's hero turn.",
        },
      }),
    );
    await aPlayerInput;

    // A SECOND, brand-new socket joins the SAME campaign while A's turn is
    // still in flight.
    const socketB = await connect(url);
    const bJoinReply = framesUntil(
      socketB,
      (frame) => frame.type === "campaign_state" || frame.type === "error",
    );
    socketB.send(JSON.stringify({ type: "join", campaignId }));
    const bFrames = await bJoinReply;

    // Must be the campaign_state restore, not turn_in_progress.
    expect(bFrames.at(-1)).toMatchObject({ type: "campaign_state" });

    // Let A's turn (and the enemy sweep) finish before the test ends, so
    // nothing keeps writing to the store after the sockets close.
    await waitForRoundSettled(store, campaignId);

    socketA.close();
    socketB.close();
  });
});
