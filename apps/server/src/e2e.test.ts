// Step 8's exit criterion: "full combat playable E2E vs scripted enemy",
// asserted once over the real socket with a mocked provider. If this passes,
// a human with a client can play the fight.
//
// This corrects four defects in the task brief that would otherwise make the
// test hang or pass for the wrong reason (task-corrections.md, "Task 15 —
// end-to-end" plus addendum C-31/C-37/C-38):
//
//   1. C-31 — `combatantFromStatBlock` never sets `characterId`
//      (packages/rules-engine/src/combat/statblock.ts), so
//      `resolve.ts:188`'s `diesAtZeroHp: target.characterId === undefined`
//      is true for every combatant in `goblin-ambush`, hero included — the
//      hero borrows the "guard" stat block because no PC data exists yet.
//      The hero therefore DIES at 0 HP rather than falling unconscious, and
//      that is exactly what makes the fight terminate at all. This file
//      asserts "one faction left standing", never a party win.
//   2. C-37 — once the hero dies, `runEnemyTurns` (pipeline.ts) returns at
//      its `livingFactions.size < 2` check with `currentActorIndex` still
//      pointing at a hostile. No terminal event is emitted, and the next
//      player `structured_action` comes back `not_your_turn`. Conclusion is
//      therefore read from the server's own projection (`loadSession`)
//      after every command, never inferred from a socket frame that would
//      never arrive.
//   3. C-38 — `EncounterDefinition.maxRounds` is data nothing reads; there
//      is no round cap anywhere in the pipeline. `MAX_HERO_COMMANDS` below
//      is this test's own bound, with a diagnostic failure message if it is
//      exceeded.
//   4. The join ack is awaited before the first action is sent —
//      `transport/ws.ts` claims its `busy` flag synchronously per message,
//      so a client that pipelines `join` and an action in the same tick
//      risks the action being dropped as `turn_in_progress`.
//
// The hero's own scripted turns (below) are always Dodge — it never attacks.
// That makes "one faction left standing" *structurally* the hostile faction,
// independent of dice luck: the party's HP can only go down over this fight,
// the goblins' never can.
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { FastifyInstance } from "fastify";
import {
  createAgentRuntime,
  createDeterministicNarrative,
  createFakePort,
  createTacticalAgent,
  DEFAULT_MODEL_ROUTING,
} from "@ai-dm/agents";
import { ServerFrame, fold } from "@ai-dm/schemas";
import type { GameEvent, SessionState } from "@ai-dm/schemas";
import { buildApp } from "./app.js";
import { createInMemoryEventStore } from "./core/event-store.js";
import type { EventStore } from "./core/event-store.js";
import type { TurnPorts } from "./core/pipeline.js";
import { loadSession } from "./core/session.js";
import type { Session } from "./core/session.js";
import { createSessionRegistry } from "./transport/http.js";

let running: FastifyInstance | null = null;
// Every socket this file opens, across both tests, so `afterEach` can force
// them closed even when a test throws mid-way — an unclosed WS otherwise
// keeps a listener (and the server's own connection handle) alive into the
// next test.
const openSockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of openSockets) {
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.close();
    }
  }
  openSockets.length = 0;
  await running?.close();
  running = null;
});

async function startServer(): Promise<{ app: FastifyInstance; url: string; store: EventStore }> {
  const store = createInMemoryEventStore();
  let n = 0;
  const uuid = (): string => {
    n += 1;
    return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  };

  // Always attack the hero — from both goblins. `goblin-a`'s calls read this
  // script directly and get a legal scimitar attack on turn 1 (C-14: the
  // corrected `goblin-ambush` geometry puts it in melee reach). `goblin-b`'s
  // calls also read this same script, whose `actorId: "goblin-a"` mismatches
  // its own combatantId — `validate-turn.ts`'s `actor_mismatch` rejects both
  // of its attempts (C-1's agent burns exactly two before falling back), and
  // `deterministicFallback` (packages/agents/src/tactical/fallback.ts)
  // attacks the nearest legal target, which is also the hero. Either path
  // damages only the hero, which is what makes the outcome deterministic
  // regardless of dice: the hero cannot possibly win this fight because it
  // never fights back (see the header comment).
  const port = createFakePort({
    structured: Array.from({ length: 200 }, () => ({
      ok: true as const,
      value: {
        value: {
          actorId: "goblin-a",
          mainAction: { actionType: "attack" as const, actionId: "scimitar", targetIds: ["hero"] },
          tacticalRationaleEnglish: "Fixture: always press the attack on the hero.",
        },
        // C-2: TokenUsage is { promptTokens, completionTokens, totalTokens }
        // (packages/agents/src/providers/usage.ts), not the plan's
        // { inputTokens, outputTokens }.
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      },
    })),
  });

  const ports: TurnPorts = {
    store,
    tactical: createTacticalAgent({
      runtime: createAgentRuntime({ routing: DEFAULT_MODEL_ROUTING, port }),
    }),
    narrative: createDeterministicNarrative(),
    clock: () => "2026-08-19T10:00:00.000Z",
    uuid,
    seedFor: (rootSeed, sequence) => rootSeed * 1000 + sequence,
    turnTimeoutMs: 10_000,
  };
  const registry = createSessionRegistry({
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

async function createSessionOver(app: FastifyInstance): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/sessions",
    payload: { encounterId: "goblin-ambush" },
  });
  return (JSON.parse(response.body) as { sessionId: string }).sessionId;
}

function connect(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url);
  openSockets.push(socket);
  return new Promise((resolve, reject) => {
    socket.once("open", () => {
      resolve(socket);
    });
    socket.once("error", reject);
  });
}

function send(socket: WebSocket, message: unknown): void {
  socket.send(JSON.stringify(message));
}

/** Every `event`-type frame in `frames`, in the order received. A plain
 * `.filter` predicate does not narrow `ServerFrame`'s discriminated union
 * through `.map`, so this is a loop rather than a filter+map chain. */
function eventFrames(frames: readonly ServerFrame[]): GameEvent[] {
  const events: GameEvent[] = [];
  for (const frame of frames) if (frame.type === "event") events.push(frame.event);
  return events;
}

// Below vitest's unconfigured 5000ms default (apps/server/src/transport/
// ws.test.ts's `FRAME_TIMEOUT_MS` comment applies verbatim here) so a hang
// fails with this file's own diagnostic — how many frames arrived, or what
// the server's projection actually was — rather than vitest's generic
// "test timed out in 5000ms", which is indistinguishable from every other
// way a test can hang.
const WAIT_TIMEOUT_MS = 3000;

/**
 * Accumulates every frame a socket receives for the rest of the test (needed
 * for this file's content assertions — "did a dice_rolled event arrive over
 * THIS socket", "what did the reconnecting client actually get") and exposes
 * a bounded, diagnostic wait over that accumulated log. Same shape as
 * ws.test.ts's `framesUntil`/`joinAndWaitForAck`, generalized to keep the
 * whole log rather than discard it once one predicate resolves — this file
 * needs both.
 */
class FrameLog {
  readonly frames: ServerFrame[] = [];
  private readonly waiters: {
    predicate: (frames: readonly ServerFrame[]) => boolean;
    settle: () => void;
  }[] = [];

  constructor(socket: WebSocket) {
    socket.on("message", (data: Buffer | string) => {
      // Important 3: parsed against the real schema, not cast — see
      // `ws.test.ts`'s identical fix for the full rationale.
      const frame = ServerFrame.parse(JSON.parse(String(data)));
      this.frames.push(frame);
      for (const waiter of [...this.waiters]) {
        if (waiter.predicate(this.frames)) waiter.settle();
      }
    });
  }

  async waitFor(
    predicate: (frames: readonly ServerFrame[]) => boolean,
    label: string,
  ): Promise<readonly ServerFrame[]> {
    if (predicate(this.frames)) return this.frames;
    return new Promise((resolve, reject) => {
      let remove = (): void => {
        // Replaced below before this can run — placeholder keeps the
        // closure's own reference stable for the timer callback.
      };
      const timer = setTimeout(() => {
        remove();
        reject(
          new Error(`Timed out after ${String(this.frames.length)} frames waiting for ${label}.`),
        );
      }, WAIT_TIMEOUT_MS);
      const entry = {
        predicate,
        settle: () => {
          clearTimeout(timer);
          remove();
          resolve(this.frames);
        },
      };
      remove = () => {
        const index = this.waiters.indexOf(entry);
        if (index >= 0) this.waiters.splice(index, 1);
      };
      this.waiters.push(entry);
    });
  }
}

/**
 * Send `join` and wait for the server's first reply. Required before sending
 * anything else — see the file header, point 4.
 */
async function joinAndAck(
  socket: WebSocket,
  log: FrameLog,
  sessionId: string,
  resumeFrom?: number,
): Promise<ServerFrame> {
  const before = log.frames.length;
  send(socket, { type: "join", sessionId, ...(resumeFrom === undefined ? {} : { resumeFrom }) });
  await log.waitFor((frames) => frames.length > before, "the join acknowledgement");
  const ack = log.frames[before];
  if (ack === undefined) throw new Error("join ack vanished immediately after resolving");
  return ack;
}

function livingFactions(state: SessionState): ReadonlySet<string> {
  return new Set(
    state.combatants.filter((combatant) => combatant.status === "alive").map((c) => c.faction),
  );
}

/**
 * Polls the server's own projection (`loadSession`, folding the real event
 * log) until `predicate` holds. C-37: after the hero dies the pipeline
 * wedges without emitting a terminal event, so conclusion has to be read
 * from the store, never inferred from a socket frame that will not arrive.
 *
 * `predicate` must itself check for progress (e.g. `nextSequence` past some
 * baseline) — this only polls, it does not know what "before" looked like.
 * A predicate that describes a state the session can already be resting in
 * (e.g. "it is the hero's turn", which is also true of the untouched
 * initial state) resolves immediately without ever confirming a command was
 * even processed.
 */
async function waitForProjection(
  store: EventStore,
  sessionId: string,
  predicate: (session: Session) => boolean,
  label: string,
): Promise<Session> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  for (;;) {
    const session = await loadSession({ sessionId, store });
    if (session === null)
      throw new Error(`Session ${sessionId} disappeared while waiting for ${label}.`);
    if (predicate(session)) return session;
    if (Date.now() > deadline) {
      const combatants = session.state.combatants
        .map((c) => `${c.combatantId}=${String(c.currentHp)}hp/${c.status}`)
        .join(", ");
      const actor = session.state.turnOrder[session.state.currentActorIndex] ?? "none";
      throw new Error(
        `Timed out after ${String(WAIT_TIMEOUT_MS)}ms waiting for ${label}. ` +
          `Last projection: round ${String(session.state.round)}, up next ${actor}, ` +
          `combatants [${combatants}].`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function heroDodge(clientMessageId: string): unknown {
  return {
    type: "structured_action",
    clientMessageId,
    actorId: "hero",
    turn: {
      actorId: "hero",
      mainAction: { actionType: "dodge" },
      tacticalRationaleEnglish: "Test fixture: the hero only dodges.",
    },
  };
}

describe("end to end", () => {
  // Break scenario, assertion by assertion (all below the `waitFor`/
  // `waitForProjection` loop, which itself goes red on any hang or on a
  // pipeline that never lets one faction win — see the loop's own comment):
  //   - `ack.type !== "session_state"`: join not wired to the registry, or
  //     answering everything with a generic error.
  //   - `hero.status !== "dead"` / `hero.currentHp !== 0`: the death-vs-
  //     unconscious branch (C-31) regressed, or damage stopped clamping at 0.
  //   - `livingFactions(...)` not exactly `{"hostile"}`: the party won (this
  //     encounter structurally cannot let that happen — the hero only
  //     dodges — so this would mean `reduce`/`applyTurn` broke faction or
  //     status bookkeeping), or both sides died, or neither did.
  //   - no `dice_rolled` event: the goblins never actually attacked (a
  //     silent regression back to C-14's un-fightable geometry, or the
  //     tactical fallback broke).
  //   - `log.frames.some(error)`: a malformed message, a rejected turn, or a
  //     `not_your_turn` leaked into a run that should never produce one —
  //     this is the guard against C-24's failure mode, where a stream of
  //     `error` frames would satisfy a bare `frames.length > N`.
  //   - non-monotonic or duplicate `event` sequences: the transport
  //     reordered or double-delivered frames.
  it("plays a full combat to a conclusion over the socket", async () => {
    const { app, url, store } = await startServer();
    const sessionId = await createSessionOver(app);

    const socket = await connect(url);
    const log = new FrameLog(socket);
    const ack = await joinAndAck(socket, log, sessionId);
    expect(ack.type).toBe("session_state");

    // C-38: nothing under apps/server/src or packages/rules-engine/src
    // enforces EncounterDefinition.maxRounds — this constant is the ONLY
    // bound on how many hero commands this test will send. 20 is generous:
    // two scimitars at +4 vs the guard's AC 16 hit ~45% of the time for an
    // average of 5, so ~4.5 expected damage per round against 11 HP
    // concludes in 3-5 rounds; 20 gives wide headroom without letting a
    // genuinely wedged pipeline spin unbounded.
    const MAX_HERO_COMMANDS = 20;
    let concluded: Session | undefined;
    let tracked = await loadSession({ sessionId, store });
    if (tracked === null) throw new Error(`Session ${sessionId} not found right after creation`);

    for (let turn = 0; turn < MAX_HERO_COMMANDS; turn += 1) {
      const beforeSequence = tracked.nextSequence;
      send(socket, heroDodge(`hero-turn-${String(turn)}`));

      // One hero command triggers the hero's own turn plus the full enemy
      // sweep (pipeline.ts's `runEnemyTurns`, called once per successful
      // player turn) before the WS handler's drain loop returns — so
      // waiting for "back to the hero, or nobody left to fight" here is
      // waiting for exactly one round, never a partial one. The
      // `nextSequence > beforeSequence` guard is required, not cosmetic: the
      // session is already resting at "it's the hero's turn" before any
      // command lands (currentActorIndex starts at 0), so without it this
      // would resolve instantly on turn 0, before the command was even
      // processed.
      const session = await waitForProjection(
        store,
        sessionId,
        (candidate) => {
          if (candidate.nextSequence <= beforeSequence) return false;
          const alive = livingFactions(candidate.state);
          const backToHero =
            candidate.state.turnOrder[candidate.state.currentActorIndex] === "hero";
          return alive.size < 2 || backToHero;
        },
        `hero command ${String(turn)} to resolve`,
      );
      tracked = session;

      if (livingFactions(session.state).size < 2) {
        concluded = session;
        break;
      }
    }

    if (concluded === undefined) {
      throw new Error(
        `Combat did not conclude within ${String(MAX_HERO_COMMANDS)} hero commands. ` +
          "EncounterDefinition.maxRounds is inert data (C-38) — nothing in the pipeline " +
          "enforces a round cap, so this bound is the only thing standing between a " +
          "genuinely wedged pipeline and a test that hangs forever.",
      );
    }

    // The final projection: one faction left standing, and — per C-31 — it
    // is necessarily the hostile one, since the hero (scripted to only
    // dodge) never dealt damage. Never asserted as a party win.
    expect(livingFactions(concluded.state)).toEqual(new Set(["hostile"]));

    const hero = concluded.state.combatants.find((c) => c.combatantId === "hero");
    if (hero === undefined) throw new Error("hero missing from the final projection");
    expect(hero.currentHp).toBe(0);
    // C-31: combatantFromStatBlock never sets characterId, so
    // resolve.ts:188's diesAtZeroHp is true for the hero — it dies rather
    // than falling unconscious. That is a real, load-bearing property of
    // this encounter (an unconscious hero with no death saves implemented
    // would leave the pipeline with nothing to conclude on), not an
    // incidental detail.
    expect(hero.status).toBe("dead");

    // Real combat happened — not merely 20+ frames of any kind (C-24's
    // failure mode: dice_rolled fires on every turn including a Dodge, so
    // a bare event count proves nothing; length alone would also pass on a
    // stream of nothing but `error` frames).
    const events = await store.readSince(sessionId, -1);
    expect(events.some((event) => event.type === "dice_rolled")).toBe(true);
    expect(events.some((event) => event.type === "state_delta_applied")).toBe(true);

    // What actually arrived over THIS socket, not just what the store
    // holds — proves the transport streamed real content, not silence or
    // errors dressed up as activity.
    expect(log.frames.some((frame) => frame.type === "narrative_token")).toBe(true);
    expect(eventFrames(log.frames).some((event) => event.type === "dice_rolled")).toBe(true);
    expect(log.frames.some((frame) => frame.type === "error")).toBe(false);

    // Every event the client saw, it saw exactly once and in order.
    const seen = eventFrames(log.frames).map((event) => event.sequence);
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
    expect(new Set(seen).size).toBe(seen.length);

    socket.close();
  });

  // C-25: the brief's two reconnect assertions
  // (`live.length > cut` — a length always exceeds a sequence index — and
  // `folded.combatants.length === clientState.combatants.length` — the
  // combatant count never changes over this fight) cannot fail regardless
  // of what the transport does. This proves the stronger, spec-required
  // property instead: fold the FIRST client's own snapshot plus every event
  // frame either socket actually received, and assert that reproduces the
  // server's own projection exactly — not a count, the whole state — and
  // separately proves the second socket received real content by requiring
  // its highest received sequence to reach the exact point the first client
  // was cut off at.
  //
  // Break scenario per assertion:
  //   - a resumeFrom off-by-one (missing or duplicating one event): the
  //     `toEqual(serverProjection.state)` fold fails, since a
  //     missing/duplicated event diverges the projection.
  //   - the second client silently receiving nothing (e.g. `join` with
  //     `resumeFrom` wired wrong): `waitFor` below times out with a
  //     diagnostic instead of the test hanging or a vacuous `length > 0`.
  //   - a gap or overlap at the reconnect boundary: the monotonic/no-dup
  //     sequence checks and the exact `min(secondSeqs) === cut + 1` check.
  it("resumes a mid-fight reconnect identically to the server's own projection", async () => {
    const { app, url, store } = await startServer();
    const sessionId = await createSessionOver(app);

    const firstSocket = await connect(url);
    const firstLog = new FrameLog(firstSocket);
    const ack = await joinAndAck(firstSocket, firstLog, sessionId);
    if (ack.type !== "session_state") throw new Error(`Expected session_state, got ${ack.type}`);
    const clientState: SessionState = ack.snapshot;

    const beforeRound = await loadSession({ sessionId, store });
    if (beforeRound === null)
      throw new Error(`Session ${sessionId} not found right after creation`);
    const beforeSequence = beforeRound.nextSequence;
    send(firstSocket, heroDodge("t1"));

    // Close the instant the hero's OWN turn_advance arrives — strictly
    // before the enemy sweep starts (same technique as ws.test.ts's C-36a
    // test). That leaves a genuine gap: `handleCommand` drains to
    // completion regardless of the socket (C-36a, proven there — this file
    // relies on it rather than re-proving it), so both goblins' turns keep
    // appending to the store while this client is gone. Cutting off only
    // after the whole round had already finished — this file's first draft
    // did exactly that, using the round's own end as `cut` — leaves the
    // second client with nothing after `resumeFrom` to catch up on: it
    // vacuously receives zero frames, and every assertion below it would
    // pass on an empty array. Disconnecting mid-round is what makes this a
    // real test of catching up on missed content.
    await firstLog.waitFor((frames) => {
      const ownTurnAdvance = eventFrames(frames).some(
        (event) => event.sequence > beforeSequence && event.type === "scene_changed",
      );
      if (ownTurnAdvance) firstSocket.close();
      return ownTurnAdvance;
    }, "the hero's own turn to advance, before the enemy sweep starts");

    const ownTurnAdvance = eventFrames(firstLog.frames).find(
      (event) => event.sequence > beforeSequence && event.type === "scene_changed",
    );
    if (ownTurnAdvance === undefined) throw new Error("lost the hero's own turn_advance event");
    const cut = ownTurnAdvance.sequence;
    // Trimmed to <= cut, not "whatever arrived before we noticed the
    // close": `socket.close()` above is not synchronous, so a frame or two
    // already in flight could still land in `firstLog.frames` afterward.
    // The client's declared resumeFrom is `cut`, so its declared view of
    // "what it already has" is capped there too — otherwise a stray
    // straggler frame could double-count an event in both `firstEvents` and
    // `secondEvents` below and break the fold.
    const firstEvents = eventFrames(firstLog.frames).filter((event) => event.sequence <= cut);

    // Wait, from the STORE (not the now-closed socket), for the rest of the
    // round — both goblins' turns — to finish appending.
    const afterRound = await waitForProjection(
      store,
      sessionId,
      (candidate) => {
        if (candidate.nextSequence <= cut + 1) return false;
        const alive = livingFactions(candidate.state);
        const backToHero = candidate.state.turnOrder[candidate.state.currentActorIndex] === "hero";
        return alive.size < 2 || backToHero;
      },
      "the rest of the round to finish appending after the first socket closed",
    );
    const roundEndSequence = afterRound.nextSequence - 1;

    // A second client resumes from what the first one had.
    const secondSocket = await connect(url);
    const secondLog = new FrameLog(secondSocket);
    send(secondSocket, { type: "join", sessionId, resumeFrom: cut });

    // Proves the second socket received real content, not merely SOME
    // frame: its highest event sequence must reach the exact point the
    // round actually ended at, which is strictly past `cut` by construction
    // (the enemy sweep alone is several events).
    await secondLog.waitFor(
      (frames) => {
        const sequences = eventFrames(frames).map((event) => event.sequence);
        return sequences.length > 0 && Math.max(...sequences) >= roundEndSequence;
      },
      `the second socket to catch up to sequence ${String(roundEndSequence)}`,
    );

    // No snapshot exists yet (SNAPSHOT_EVERY is 50; one round is nowhere
    // close), so `join`'s snapshot-fallback branch (C-16) does not fire —
    // every frame the second client gets back is a plain `event` replay of
    // exactly what it missed, never a resent session_state or an error.
    // Task 4: the round this join catches up on ends back on the hero's own
    // turn, so `join` also pushes one trailing `turn_affordances` frame
    // after the replayed events — the one frame in this log that is not an
    // `event`.
    expect(secondLog.frames.slice(0, -1).every((frame) => frame.type === "event")).toBe(true);
    expect(secondLog.frames.at(-1)?.type).toBe("turn_affordances");

    const secondEvents = eventFrames(secondLog.frames);
    const secondSequences = secondEvents.map((event) => event.sequence);
    expect(Math.min(...secondSequences)).toBe(cut + 1);
    expect(secondSequences).toEqual([...secondSequences].sort((a, b) => a - b));
    expect(new Set(secondSequences).size).toBe(secondSequences.length);

    // The real property: the first client's own snapshot, folded with every
    // event either socket actually delivered, reproduces the server's own
    // projection exactly.
    const reconstructed = fold(clientState, [...firstEvents, ...secondEvents]);
    const serverProjection = await loadSession({ sessionId, store });
    if (serverProjection === null) throw new Error("session disappeared from the store");
    expect(reconstructed).toEqual(serverProjection.state);

    secondSocket.close();
  });
});
