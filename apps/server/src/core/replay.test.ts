// The four invariants the event-sourced design exists to buy. If any of these
// fails, the projection has forked from the log and no amount of passing unit
// tests makes the server correct. Per this task's brief: no production code
// here — a failing property means a bug in Tasks 6-10, not a weaker assertion.
import { describe, expect, it } from "vitest";
import { validateExecuteTurn } from "@ai-dm/rules-engine";
import type { TacticalAgent } from "@ai-dm/agents";
import { createDeterministicNarrative } from "@ai-dm/agents";
import { createInMemoryEventStore } from "@ai-dm/memory";
import type { EventStore } from "@ai-dm/memory";
import { fold } from "@ai-dm/schemas";
import type {
  ClientMessage,
  ExecuteTurn,
  GameEvent,
  ServerFrame,
  SessionState,
} from "@ai-dm/schemas";
import { SNAPSHOT_EVERY, handleCommand } from "./pipeline.js";
import type { TurnPorts } from "./pipeline.js";
import { createSession, loadSession } from "./session.js";
import type { Session } from "./session.js";

const CLOCK = (): string => "2026-08-19T10:00:00.000Z";
const ENCOUNTER_ID = "goblin-ambush";

function uuids(): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  };
}

/**
 * A tactical double that proposes a legal Dodge for whichever actor is
 * asked, mirroring `pipeline.test.ts`'s `defaultTactical` (C-15). Unlike a
 * `createFakePort` script, this never runs out and never risks proposing a
 * turn stamped with the wrong `actorId` (the brief's `dodgeFor("goblin-a")`
 * hardcoded a single actor into every scripted reply) — every property below
 * can run as many rounds as it needs.
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
        tacticalRationaleEnglish: "Replay fixture: always dodge.",
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

/**
 * Determinism is only assertable because `clock`, `uuid` and `seedFor` are
 * ports. `eventId` comes from `ports.uuid()` and `timestamp` from
 * `ports.clock()`, so both must be fixed for stream equality across two
 * independent runs to mean anything.
 */
function portsWith(store: EventStore): TurnPorts {
  return {
    store,
    tactical: defaultTactical(),
    narrative: createDeterministicNarrative(),
    clock: CLOCK,
    uuid: uuids(),
    seedFor: (rootSeed, sequence) => rootSeed * 1000 + sequence,
    turnTimeoutMs: 10_000,
    conditionNamesHebrew: new Map([["prone", "שרוע"]]),
  };
}

function dodgeCommand(actorId: string, clientMessageId: string): ClientMessage {
  const turn: ExecuteTurn = {
    actorId,
    mainAction: { actionType: "dodge" },
    tacticalRationaleEnglish: "Test fixture.",
  };
  return { type: "structured_action", clientMessageId, actorId, turn };
}

async function drain(stream: AsyncIterable<ServerFrame>): Promise<ServerFrame[]> {
  const frames: ServerFrame[] = [];
  for await (const frame of stream) frames.push(frame);
  return frames;
}

interface PlayOptions {
  sessionId?: string;
  rootSeed?: number;
}

/**
 * Plays `rounds` full rounds: one player Dodge from "hero", followed by
 * whatever `handleCommand`'s enemy sweep does in response (both goblins
 * dodge too, via `defaultTactical`, so nobody ever takes damage and the
 * fight never concludes on its own — C-38: nothing enforces a round cap, so
 * the bound here is this loop's own `rounds` argument, not the pipeline's).
 * Only the hero's turn is driven from the outside; the hostile turns are the
 * pipeline's own doing, exactly as they would be for a real client.
 */
async function playRounds(
  store: EventStore,
  rounds: number,
  options: PlayOptions = {},
): Promise<Session> {
  const sessionId = options.sessionId ?? "s1";
  const rootSeed = options.rootSeed ?? 42;
  const session = await createSession({
    sessionId,
    encounterId: ENCOUNTER_ID,
    rootSeed,
    store,
    clock: CLOCK,
    uuid: uuids(),
  });
  const ports = portsWith(store);

  for (let round = 0; round < rounds; round += 1) {
    await drain(handleCommand(session, dodgeCommand("hero", `c${String(round)}`), ports));
  }
  return session;
}

/**
 * The genesis `SessionState` a client must fold from — built from its own
 * throwaway store and its own uuid counter, so it never shares an object
 * reference with anything `playRounds` produced.
 *
 * C-26 / C-35: `reduce` never writes `sessionId`, `rootSeed`, `encounterId`,
 * `grid` or `turnOrder`, and Task 8 removed the `state` field that used to
 * ride along in the sequence-0 payload (keeping it aliased live session
 * state into the store by reference). The only remaining correct source for
 * "the state `fold` starts from" is the session API itself: `createSession`
 * builds exactly that state, the same way `loadSession` rebuilds it before
 * folding the rest of a log on top.
 */
async function genesisStateFor(options: PlayOptions = {}): Promise<SessionState> {
  const scratch = createInMemoryEventStore();
  const session = await createSession({
    sessionId: options.sessionId ?? "s1",
    encounterId: ENCOUNTER_ID,
    rootSeed: options.rootSeed ?? 42,
    store: scratch,
    clock: CLOCK,
    uuid: uuids(),
  });
  return session.state;
}

describe("replay properties", () => {
  it("folding the log from zero equals the live projection", async () => {
    const store = createInMemoryEventStore();
    const live = await playRounds(store, 3);
    const reloaded = await loadSession({ sessionId: "s1", store });
    expect(reloaded?.state).toEqual(live.state);
  });

  it("a reconnect at any sequence leaves the client's fold equal to the server's", async () => {
    // C-21 (blocking): the brief's version obtained "the client's state" by
    // calling `loadSession` — which always folds the WHOLE log regardless
    // of `cut` — then folded a no-op empty array, then folded the tail on
    // top of a state that already included it. That double-application is
    // idempotent for the one field the test checked (`combatants`, a full
    // overwrite each `state_delta_applied`), so the loop could not detect a
    // fork no matter what `cut` was.
    //
    // This instead implements the spec's property (3) directly: build a
    // *client* state by folding, from an independently-constructed genesis,
    // only the events up to sequence k; then apply the events after k; and
    // compare the FULL projection (not a subset) against the server's own
    // `live.state`. Because the two states never share an object reference
    // until this comparison, an aliasing or non-idempotent-`reduce` bug
    // (exactly what C-26 required Task 8 to design around) would show up
    // here as a genuine mismatch, at whichever `cut` first exposed it.
    const store = createInMemoryEventStore();
    const live = await playRounds(store, 3);
    const events = await store.readSince("s1", -1); // ascending, includes sequence 0
    // Loop-invariant: every cut folds from the same genesis, and rebuilding
    // it per iteration means 81 redundant `buildEncounterById` calls (each
    // one a `readFileSync`) for no benefit — hoisted out once instead.
    const genesis = await genesisStateFor();

    for (const cutEvent of events) {
      const k = cutEvent.sequence;
      const cached = fold(
        genesis,
        events.filter((each) => each.sequence > 0 && each.sequence <= k),
      );
      const tail = events.filter((each) => each.sequence > k);
      const replayed = fold(cached, tail);
      expect(replayed).toEqual(live.state);
    }
  });

  it("the same rootSeed and the same commands produce the same event stream", async () => {
    const first = createInMemoryEventStore();
    const second = createInMemoryEventStore();
    await playRounds(first, 3, { rootSeed: 42 });
    await playRounds(second, 3, { rootSeed: 42 });

    const a = await first.readSince("s1", -1);
    const b = await second.readSince("s1", -1);
    expect(a).toEqual(b);
  });

  it("a different rootSeed produces a different event stream for the same commands", async () => {
    // C-21 (blocking): the brief's version asserted only
    // `session.state.rootSeed === 99` right after passing `rootSeed: 99`
    // in — a tautology about the input that cannot fail regardless of what
    // the pipeline does with it.
    //
    // My first replacement for it was ALSO non-discriminating, for a
    // different reason (review caught it): it compared the full event
    // arrays from `readSince`, which include sequence 0 — whose payload is
    // `{ encounterId, rootSeed }` (`session.ts`). With rootSeed 42 vs. 99,
    // that one event already differs before a single turn plays, so
    // `.not.toEqual` on the whole array passes even if `rootSeed` never
    // reaches `seedFor` at all (e.g. a regression hardcoding
    // `ports.seedFor(42, sequence)` in the pipeline) — exactly the bug this
    // property exists to catch.
    //
    // So instead this compares only the recorded `dice_rolled` seeds —
    // `ports.seedFor(rootSeed, sequence)`'s literal output
    // (`pipeline.ts`'s `enemyTurn`/`structured_action` handling) — which
    // has no sequence-0 freebie to hide behind: it only differs if
    // `session.state.rootSeed` actually reached `seedFor` for every one of
    // these turns. Verified by injecting the regression this comment used
    // to only assume: hardcoding `seedFor` in `portsWith` to
    // `(_rootSeed, sequence) => 42 * 1000 + sequence` (ignoring its
    // `rootSeed` argument entirely) makes this assertion fail, as it
    // should — see this task's report.
    const seed42 = createInMemoryEventStore();
    const seed99 = createInMemoryEventStore();
    await playRounds(seed42, 3, { rootSeed: 42 });
    await playRounds(seed99, 3, { rootSeed: 99 });

    const seedsOf = (events: readonly GameEvent[]): unknown[] =>
      events.filter((each) => each.type === "dice_rolled").map((each) => each.payload["seed"]);

    const a = seedsOf(await seed42.readSince("s1", -1));
    const b = seedsOf(await seed99.readSince("s1", -1));
    expect(a).not.toEqual(b);
  });
});

describe("snapshots", () => {
  it("is a cache that agrees exactly with the fold at its own sequence", async () => {
    const store = createInMemoryEventStore();
    // 5 full rounds of genuine play (16 events each: hero + both goblins,
    // all legal) comfortably crosses the SNAPSHOT_EVERY=50 boundary, which
    // lands partway through round 4. This used to need 40 rounds' worth of
    // mostly-rejected turns to reach the same boundary, because `reduce`
    // never refreshed a combatant's action economy between their own
    // turns — every `structured_action` past round 1 was rejected
    // `action_already_used`, and only the rejection's 2 events
    // (`player_input`, `action_rejected`) landed per attempt instead of a
    // full turn's ~5-6. Fixed in `reduce.ts`'s `scene_changed` /
    // `turn_advanced` case (see this task's report); this asserts what the
    // property should actually exercise now that a session can play more
    // than one round.
    await playRounds(store, 5);

    const snapshot = await store.latestSnapshot("s1");
    const events = await store.readSince("s1", -1);
    if (snapshot === null) {
      throw new Error(
        `No snapshot after ${String(events.length)} events; ` +
          `expected one every ${String(SNAPSHOT_EVERY)}`,
      );
    }

    expect(snapshot.sequence % SNAPSHOT_EVERY).toBe(0);
    // At 5 rounds (81 events total), sequence SNAPSHOT_EVERY (50) is the
    // ONLY boundary crossed, so `latestSnapshot` and "every snapshot point"
    // coincide today — but `latestSnapshot` only ever returns the newest
    // one (`event-store.ts`), so nothing else pins that coincidence. Pin it
    // explicitly rather than let a later round-count change silently narrow
    // this test to whatever the last boundary happens to be, unnoticed.
    expect(snapshot.sequence).toBe(SNAPSHOT_EVERY);

    // C-22 / C-35: get the fold's starting state from the session API, not
    // from a cast on the genesis event's payload — sequence 0 no longer
    // carries a `state` field (Task 8 removed it to kill the aliasing
    // hazard; see `session.ts`'s `GenesisPayload`). Reintroducing that field
    // to make a cast like `(genesis.payload as { state: unknown }).state`
    // work would undo that fix, so this drops the cast entirely.
    const initial = await genesisStateFor();
    const upToSnapshot = events.filter(
      (each) => each.sequence > 0 && each.sequence <= snapshot.sequence,
    );

    // The load-bearing assertion: fold the log up to the snapshot's sequence
    // and you must get the snapshot, byte for byte. A snapshot that
    // disagrees with the log is a fork, and reconnect would hand a client a
    // false world.
    expect(fold(initial, upToSnapshot)).toEqual(snapshot.state);
  });
});
