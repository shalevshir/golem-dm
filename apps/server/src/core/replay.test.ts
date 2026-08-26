// The four invariants the event-sourced design exists to buy. If any of these
// fails, the projection has forked from the log and no amount of passing unit
// tests makes the server correct. Per this task's brief: no production code
// here — a failing property means a bug in Tasks 6-10, not a weaker assertion.
import { afterAll, describe, expect, it } from "vitest";
import { validateExecuteTurn } from "@ai-dm/rules-engine";
import type { TacticalAgent } from "@ai-dm/agents";
import { createDeterministicNarrative } from "@ai-dm/agents";
import { connectPostgresEventStore, createInMemoryEventStore } from "@ai-dm/memory";
import type { EventStore } from "@ai-dm/memory";
import { fold } from "@ai-dm/schemas";
import type {
  ClientMessage,
  ExecuteTurn,
  GameEvent,
  ServerFrame,
  CampaignState,
} from "@ai-dm/schemas";
import { SNAPSHOT_EVERY, handleCommand } from "./pipeline.js";
import type { TurnPorts } from "./pipeline.js";
import { createCampaign, loadCampaign, resolveEncounter, startEncounter } from "./campaign.js";
import type { Campaign } from "./campaign.js";

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
  campaignId?: string;
  rootSeed?: number;
}

/**
 * Plays `rounds` full rounds against an EXISTING campaign: one player Dodge
 * from "hero", followed by whatever `handleCommand`'s enemy sweep does in
 * response (both goblins dodge too, via `defaultTactical`, so nobody ever
 * takes damage and the fight never concludes on its own — C-38: nothing
 * enforces a round cap, so the bound here is this loop's own `rounds`
 * argument, not the pipeline's). Only the hero's turn is driven from the
 * outside; the hostile turns are the pipeline's own doing, exactly as they
 * would be for a real client.
 *
 * Factored out of `playRounds` below (Task 7): seed-determinism-across-a-
 * boundary needs to keep playing on the SAME campaign after a
 * resolveEncounter/startEncounter pair reopens it on a second encounter,
 * not spin up a fresh one each time. `startAt` is what lets two calls on one
 * campaign use disjoint `clientMessageId`s — reusing "c0", "c1", ... across a
 * resolve/restart boundary would silently dedupe the second encounter's own
 * first move against the idempotency set carried over from the first
 * (world-scoped, campaign.test.ts's own boundary test).
 */
async function playRoundsOn(
  campaign: Campaign,
  store: EventStore,
  rounds: number,
  startAt = 0,
): Promise<Campaign> {
  const ports = portsWith(store);
  for (let round = 0; round < rounds; round += 1) {
    await drain(
      handleCommand(campaign, dodgeCommand("hero", `c${String(startAt + round)}`), ports),
    );
  }
  return campaign;
}

/** `playRoundsOn`, against a freshly started campaign — what every property
 * below that only cares about one encounter wants. */
async function playRounds(
  store: EventStore,
  rounds: number,
  options: PlayOptions = {},
): Promise<Campaign> {
  const campaign = await startedCampaign(store, options);
  return playRoundsOn(campaign, store, rounds);
}

/**
 * A campaign with its first encounter open: `createCampaign` then
 * `startEncounter`, sequences 0 and 1, the pair `POST /campaigns` writes.
 */
async function startedCampaign(store: EventStore, options: PlayOptions = {}): Promise<Campaign> {
  const ports = { store, clock: CLOCK, uuid: uuids() };
  const campaign = await createCampaign({
    campaignId: options.campaignId ?? "s1",
    rootSeed: options.rootSeed ?? 42,
    ...ports,
  });
  return startEncounter({ campaign, encounterId: ENCOUNTER_ID, ...ports });
}

/**
 * The `CampaignState` a client must fold from, and the sequence it is the
 * state *after* — built from its own throwaway store and its own uuid
 * counter, so it never shares an object reference with anything `playRounds`
 * produced.
 *
 * C-26 / C-35: `reduce` never writes `campaignId`, `rootSeed`, `encounterId`,
 * `grid` or `turnOrder`, and Task 8 removed the `state` field that used to
 * ride along in the sequence-0 payload (keeping it aliased live campaign
 * state into the store by reference). The only remaining correct source for
 * "the state `fold` starts from" is the campaign API itself: `createCampaign`
 * plus `startEncounter` build exactly that state, the same way
 * `loadCampaign` rebuilds it before folding the rest of a log on top.
 *
 * `sequence` is returned rather than assumed because that starting point is
 * no longer sequence 0. Genesis is two events, and the second of them —
 * `encounter_started` — is one `fold` cannot apply: the initial board comes
 * from the encounter catalogue, which `@ai-dm/schemas` may never import
 * (invariant 5), so `reduce` deliberately leaves it as a guard-only no-op
 * and `campaign.ts` substitutes the board. Every fold below therefore starts
 * from *after* this sequence, not after sequence 0.
 */
async function genesisStateFor(
  options: PlayOptions = {},
): Promise<{ state: CampaignState; sequence: number }> {
  const campaign = await startedCampaign(createInMemoryEventStore(), options);
  return { state: campaign.state, sequence: campaign.nextSequence - 1 };
}

describe("replay properties", () => {
  it("folding the log from zero equals the live projection", async () => {
    const store = createInMemoryEventStore();
    const live = await playRounds(store, 3);
    const reloaded = await loadCampaign({ campaignId: "s1", store });
    expect(reloaded?.state).toEqual(live.state);
  });

  it("a reconnect at any sequence leaves the client's fold equal to the server's", async () => {
    // C-21 (blocking): the brief's version obtained "the client's state" by
    // calling `loadCampaign` — which always folds the WHOLE log regardless
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

    // Cuts start at `genesis.sequence`, not at 0. The two events at or below
    // it are the campaign's own genesis pair, which `genesis.state` already
    // accounts for — folding either of them onto it would be applying them
    // twice, and `encounter_started` says so out loud by throwing on an
    // already-open bracket.
    for (const cutEvent of events.filter((each) => each.sequence >= genesis.sequence)) {
      const k = cutEvent.sequence;
      const cached = fold(
        genesis.state,
        events.filter((each) => each.sequence > genesis.sequence && each.sequence <= k),
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
    // `campaign.state.world.rootSeed === 99` right after passing `rootSeed: 99`
    // in — a tautology about the input that cannot fail regardless of what
    // the pipeline does with it.
    //
    // My first replacement for it was ALSO non-discriminating, for a
    // different reason (review caught it): it compared the full event
    // arrays from `readSince`, which include sequence 0 — whose payload is
    // `{ rootSeed }` (`CampaignStartedPayload`, `@ai-dm/schemas`). With
    // rootSeed 42 vs. 99, that one event already differs before a single
    // turn plays, so
    // `.not.toEqual` on the whole array passes even if `rootSeed` never
    // reaches `seedFor` at all (e.g. a regression hardcoding
    // `ports.seedFor(42, sequence)` in the pipeline) — exactly the bug this
    // property exists to catch.
    //
    // So instead this compares only the recorded `dice_rolled` seeds —
    // `ports.seedFor(rootSeed, sequence)`'s literal output
    // (`pipeline.ts`'s `enemyTurn`/`structured_action` handling) — which
    // has no sequence-0 freebie to hide behind: it only differs if
    // `campaign.state.world.rootSeed` actually reached `seedFor` for every one of
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
    // property should actually exercise now that a campaign can play more
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
    // one (guaranteed by `@ai-dm/memory`'s conformance suite,
    // `event-store/contract.ts`), so nothing else pins that coincidence.
    // Pin it explicitly rather than let a later round-count change silently
    // narrow this test to whatever the last boundary happens to be,
    // unnoticed.
    expect(snapshot.sequence).toBe(SNAPSHOT_EVERY);

    // C-22 / C-35: get the fold's starting state from the campaign API, not
    // from a cast on the genesis event's payload — sequence 0 no longer
    // carries a `state` field (Task 8 removed it to kill the aliasing
    // hazard; see `@ai-dm/schemas`' `CampaignStartedPayload`, which replaced
    // the old `GenesisPayload` this comment used to name). Reintroducing a
    // `state` field to make a cast like
    // `(genesis.payload as { state: unknown }).state` work would undo that
    // fix, so this drops the cast entirely.
    const initial = await genesisStateFor();
    const upToSnapshot = events.filter(
      (each) => each.sequence > initial.sequence && each.sequence <= snapshot.sequence,
    );

    // The load-bearing assertion: fold the log up to the snapshot's sequence
    // and you must get the snapshot, byte for byte. A snapshot that
    // disagrees with the log is a fork, and reconnect would hand a client a
    // false world.
    expect(fold(initial.state, upToSnapshot)).toEqual(snapshot.state);
  });
});

// Task 7, step 3 (§4.7): seed determinism must hold ACROSS a bracket, not
// merely within one. The "replay properties" tests above already own "same
// commands, same seed" and "different rootSeed, different seeds" for a
// single encounter; this is the property those cannot express, because
// `campaign.nextSequence` — what `seedFor` is keyed on — is campaign-scoped
// and keeps climbing across a resolveEncounter/startEncounter boundary
// rather than resetting.
describe("seed determinism across a bracket", () => {
  /** Every `dice_rolled` seed recorded with `sequence` in `[from, to)`, in log
   * order — the same shape the "a different rootSeed..." test's `seedsOf`
   * uses above, restricted to one encounter's own span so encounter A's and
   * encounter B's rolls can be compared separately, without a
   * `campaign_started` payload (which carries `rootSeed` and would make a
   * whole-array comparison differ for free — see that test's own comment)
   * anywhere near either side. */
  function seedsIn(events: readonly GameEvent[], from: number, to: number): unknown[] {
    return events
      .filter((each) => each.sequence >= from && each.sequence < to && each.type === "dice_rolled")
      .map((each) => each.payload["seed"]);
  }

  /** Plays a two-encounter campaign — rounds in A, resolve, start B (the only
   * encounter the catalogue has, so B is A's own id reused), rounds in B —
   * and returns its full log plus the sequence B's span starts at. */
  async function playAcrossABoundary(
    store: EventStore,
  ): Promise<{ events: GameEvent[]; boundary: number }> {
    const campaign = await startedCampaign(store, { rootSeed: 42 });
    await playRoundsOn(campaign, store, 2);

    await resolveEncounter({
      campaign,
      outcome: "victory",
      survivorIds: ["hero"],
      store,
      clock: CLOCK,
      uuid: uuids(),
    });
    await startEncounter({
      campaign,
      encounterId: ENCOUNTER_ID,
      store,
      clock: CLOCK,
      uuid: uuids(),
    });
    const boundary = campaign.nextSequence;

    await playRoundsOn(campaign, store, 2, 2);

    return { events: await store.readSince("s1", -1), boundary };
  }

  it("reproduces encounter B's dice_rolled seeds across independent stores, distinct from encounter A's own", async () => {
    const a = await playAcrossABoundary(createInMemoryEventStore());
    const b = await playAcrossABoundary(createInMemoryEventStore());
    const lastSequence = (events: readonly GameEvent[]): number =>
      (events.at(-1)?.sequence ?? -1) + 1;

    const bSpanA = seedsIn(a.events, a.boundary, lastSequence(a.events));
    const bSpanB = seedsIn(b.events, b.boundary, lastSequence(b.events));

    // 1. Determinism: two independent stores, the same rootSeed, and the
    // same command sequence spanning the boundary produce identical
    // dice_rolled seeds in encounter B's own span. Guarded non-empty first:
    // `playRoundsOn(..., 2, ...)` rolls dice every round, so `bSpanA` is
    // never actually empty here, but without this line a regression that
    // silently stopped `dice_rolled` from firing at all would make the
    // `toEqual` below pass vacuously on two empty arrays instead of failing.
    expect(bSpanA.length).toBeGreaterThan(0);
    expect(bSpanA).toEqual(bSpanB);

    // 2. Continuity — the assertion that makes the first one mean something
    // (per this task's brief): encounter B's seeds must NOT equal encounter
    // A's own. Seeds derive from `campaign.nextSequence`, campaign-scoped and
    // still climbing after the boundary, never reset per encounter. Without
    // this second check, a regression that reset the sequence counter (or
    // `seedFor`'s own notion of "sequence") back to the same range for every
    // encounter — exactly what §4.7 forbids with "an encounter's `rootSeed`
    // derives from the campaign seed and sequence, never fresh randomness" —
    // would reproduce identically across the two independent stores
    // (satisfying assertion 1) while silently replaying encounter A's own
    // seeds for encounter B, and every existing test would still pass.
    // Verified by injecting exactly that regression — see this task's report.
    //
    // `aSpanA` is guarded non-empty too, the same way and for the same
    // reason as `bSpanA` above: without it, a regression that emptied
    // encounter A's OWN span (rather than reusing it for B) would satisfy
    // `not.toEqual` against an empty array for free, while assertion 1 still
    // held — indistinguishable, from this test's point of view, from the
    // real property holding.
    const aSpanA = seedsIn(a.events, 0, a.boundary);
    expect(aSpanA).toHaveLength(bSpanA.length);
    expect(bSpanA).not.toEqual(aSpanA);
  });
});

// Task 7, step 2 (projection half): the charter's append -> replay ->
// identical-projection round-trip, over a campaign spanning two encounters —
// a log a single `fold` provably cannot handle (`encounter_started` is a
// guard-only no-op without the catalogue substitution `loadCampaign`
// performs; see this task's report for the verified throw). Lives here,
// not in `packages/memory`, because building a real second board needs
// `startEncounter`/`buildEncounterById`, which live in `apps/server` and
// which `@ai-dm/memory` may never import (dependency direction).
const DATABASE_URL = process.env.DATABASE_URL;

// A blank `DATABASE_URL=` must skip exactly like an absent one — matching
// `packages/memory/src/event-store/replay.test.ts`'s identical guard:
// `postgres("")` does not reject, it silently falls back to localhost.
describe.skipIf(DATABASE_URL === undefined || DATABASE_URL === "")(
  "replay across a bracket, over Postgres",
  () => {
    const handle = connectPostgresEventStore(DATABASE_URL ?? "");

    afterAll(async () => {
      await handle.close();
    });

    it("folds an identical projection across two encounters via loadCampaign", async () => {
      // Unique per run: the scratch database retains rows from earlier
      // verification passes, so a fixed id could collide with them.
      const campaignId = `bracket-${String(Date.now())}`;
      const store = handle.store;
      const ports = { store, clock: CLOCK, uuid: uuids() };

      const created = await createCampaign({ campaignId, rootSeed: 42, ...ports });
      const campaign = await startEncounter({
        campaign: created,
        encounterId: ENCOUNTER_ID,
        ...ports,
      });
      await playRoundsOn(campaign, store, 2);

      await resolveEncounter({ campaign, outcome: "victory", survivorIds: ["hero"], ...ports });
      await startEncounter({ campaign, encounterId: ENCOUNTER_ID, ...ports });
      await playRoundsOn(campaign, store, 2, 2);

      const loaded = await loadCampaign({ campaignId, store });
      // `built` and `nextSequence` too, not just `state`: a load that
      // silently dropped either would still pass a `state`-only comparison.
      expect(loaded?.state).toEqual(campaign.state);
      expect(loaded?.built).toEqual(campaign.built);
      expect(loaded?.nextSequence).toBe(campaign.nextSequence);
    });
  },
);
