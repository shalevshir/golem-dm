// Step 8's exit criterion: "full combat playable E2E vs scripted enemy",
// asserted once over the real socket with a mocked provider. If this passes,
// a human with a client can play the fight.
//
// Four properties of the system shape this test; a version that ignored any
// of them would hang or pass for the wrong reason:
//
//   1. `applyTurn`'s `applyDamage` call in
//      packages/rules-engine/src/encounter/resolve.ts reads `diesAtZeroHp`
//      off `characterId` presence (death-saves-persistent-hp spec), so
//      `goblin-ambush`'s hero — a real character spawn with a real
//      `characterId` — falls Unconscious at 0 HP and rolls death saves,
//      driven automatically by the encounter pipeline (`runEnemyTurns`'s
//      party-unconscious branch) rather than dying outright. The hero never
//      attacks (Dodge only, below), so the goblins never die; the fight
//      still terminates because a death save resolves within at most 5
//      rolls (`rollDeathSave` moves one of two counters toward 3 on every
//      roll), and "revived"/"stable" only postpone the outcome — the hero
//      keeps taking hits and re-rolling until the tally finally reaches
//      "dead". This file asserts "one faction left standing", never a party
//      win.
//   2. Once the hero dies, `runEnemyTurns` (pipeline.ts) returns at
//      its `livingFactions.size < 2` check with `currentActorIndex` still
//      pointing at a hostile. No terminal event is emitted, and the next
//      player `structured_action` comes back `not_your_turn`. Conclusion is
//      therefore read from the server's own projection (`loadCampaign`)
//      after every command, never inferred from a socket frame that would
//      never arrive.
//   3. For a combat-only campaign (this file's first test, below),
//      `EncounterDefinition.maxRounds` is data nothing reads; there is no
//      round cap anywhere in the pipeline for it. `playToConclusion`'s
//      `MAX_HERO_COMMANDS` is this test's own bound in that case, with a
//      diagnostic failure message if it is exceeded. §4.7 step 5's
//      `resolveIfConcluded` DOES enforce `maxRounds` for a bridged (scene)
//      campaign — `playToConclusion` is shared between both tests below, and
//      `MAX_HERO_COMMANDS` is a backstop against a genuine hang either way,
//      not proof that no cap exists.
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
  createDeterministicSceneNarrative,
  createDeterministicSceneSummary,
  createFakeEmbeddingPort,
  createFakePort,
  createTacticalAgent,
  DEFAULT_MODEL_ROUTING,
} from "@ai-dm/agents";
import type { IntentAgent, IntentResult } from "@ai-dm/agents";
import { createInMemoryEpisodicStore, createInMemoryEventStore } from "@ai-dm/memory";
import type { EventStore } from "@ai-dm/memory";
import { CampaignCreated, ServerFrame, fold } from "@ai-dm/schemas";
import type { GameEvent, CampaignState, IntentClassification } from "@ai-dm/schemas";
import { buildApp } from "./app.js";
import type { TurnPorts } from "./core/pipeline.js";
import { createCampaign, encounterOf, loadCampaign } from "./core/campaign.js";
import type { Campaign } from "./core/campaign.js";
import { createCampaignRegistry } from "./transport/http.js";

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
  // script directly and get a legal scimitar attack on turn 1 (`goblin-ambush`
  // spawns it within melee reach of the hero). `goblin-b`'s
  // calls also read this same script, whose `actorId: "goblin-a"` mismatches
  // its own combatantId — `validate-turn.ts`'s `actor_mismatch` rejects both
  // of its attempts (the agent's retry-once loop burns exactly two before
  // falling back), and
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
        // TokenUsage is { promptTokens, completionTokens, totalTokens }
        // (packages/agents/src/providers/usage.ts) — there are no
        // inputTokens/outputTokens fields to use instead.
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
    intent: walkingIntentAgent(),
    sceneNarrative: createDeterministicSceneNarrative(),
    episodic: createInMemoryEpisodicStore(),
    embedding: createFakeEmbeddingPort(),
    summary: createDeterministicSceneSummary(),
    clock: () => "2026-08-19T10:00:00.000Z",
    uuid,
    seedFor: (rootSeed, sequence) => rootSeed * 1000 + sequence,
    turnTimeoutMs: 10_000,
    conditionNamesHebrew: new Map([["prone", "שרוע"]]),
    skillAbilities: new Map(),
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

async function createCampaignOver(app: FastifyInstance): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/campaigns",
    payload: { encounterId: "goblin-ambush" },
  });
  return (JSON.parse(response.body) as { campaignId: string }).campaignId;
}

// Mirrors `createCampaignOver` exactly, with §4.7 step 5's alternative body.
// Kept separate so the combat path's own helper (and every combat test that
// depends on it staying exactly as it is) is untouched.
async function createWorldCampaignOver(app: FastifyInstance): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/campaigns",
    payload: { worldId: "emberfall" },
  });
  return CampaignCreated.parse(response.json()).campaignId;
}

// The real intent agent is not available in this harness (`startServer`'s
// `ports.intent` used to just reject, since no test before this one ever
// sent `free_text`). This stub classifies by exact text match, mirroring
// the harness's `tactical` stub above: a fixed, known response per input
// rather than anything that reads the Hebrew content. Keyed on the three
// Hebrew strings the walk test below sends, one traversal per shipped edge
// in `data/world/arc.json` (arrival -> guild-offer -> the-weir -> saboteurs).
function walkingIntentAgent(): IntentAgent {
  const classifications: Record<string, IntentClassification> = {
    "לשמוע את סוכנת הגילדה": { category: "exploration", targetNodeId: "guild-offer" },
    "ללכת אל הסכר": { category: "exploration", targetNodeId: "the-weir" },
    "לבדוק את מנגנון השער": { category: "exploration", targetNodeId: "saboteurs" },
    "להביא את מה שמצאנו לפונדק": { category: "exploration", targetNodeId: "reckoning" },
  };
  return {
    classify: ({ text }) => {
      const classification = classifications[text];
      if (classification === undefined) {
        return Promise.reject(new Error(`intent.classify not stubbed for text: ${text}`));
      }
      return Promise.resolve({
        ok: true,
        classification,
        provider: "test-provider",
        modelId: "test-model",
        usage: [{ promptTokens: 10, completionTokens: 5, totalTokens: 15 }],
      } satisfies IntentResult);
    },
  };
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
      // Parsed against the real schema, not cast — see `ws.test.ts`'s
      // identical parse for the full rationale.
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
  campaignId: string,
  resumeFrom?: number,
): Promise<ServerFrame> {
  const before = log.frames.length;
  send(socket, { type: "join", campaignId, ...(resumeFrom === undefined ? {} : { resumeFrom }) });
  await log.waitFor((frames) => frames.length > before, "the join acknowledgement");
  const ack = log.frames[before];
  if (ack === undefined) throw new Error("join ack vanished immediately after resolving");
  return ack;
}

function livingFactions(state: CampaignState): ReadonlySet<string> {
  return new Set(
    (state.encounter?.combatants ?? [])
      .filter((combatant) => combatant.status === "alive")
      .map((c) => c.faction),
  );
}

/**
 * Polls the server's own projection (`loadCampaign`, folding the real event
 * log) until `predicate` holds. After the hero dies the pipeline
 * wedges without emitting a terminal event, so conclusion has to be read
 * from the store, never inferred from a socket frame that will not arrive.
 *
 * `predicate` must itself check for progress (e.g. `nextSequence` past some
 * baseline) — this only polls, it does not know what "before" looked like.
 * A predicate that describes a state the campaign can already be resting in
 * (e.g. "it is the hero's turn", which is also true of the untouched
 * initial state) resolves immediately without ever confirming a command was
 * even processed.
 */
async function waitForProjection(
  store: EventStore,
  campaignId: string,
  predicate: (campaign: Campaign) => boolean,
  label: string,
): Promise<Campaign> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  for (;;) {
    const campaign = await loadCampaign({ campaignId, store });
    if (campaign === null)
      throw new Error(`Campaign ${campaignId} disappeared while waiting for ${label}.`);
    if (predicate(campaign)) return campaign;
    if (Date.now() > deadline) {
      const combatants = encounterOf(campaign)
        .combatants.map((c) => `${c.combatantId}=${String(c.currentHp)}hp/${c.status}`)
        .join(", ");
      const actor =
        encounterOf(campaign).turnOrder[encounterOf(campaign).currentActorIndex] ?? "none";
      throw new Error(
        `Timed out after ${String(WAIT_TIMEOUT_MS)}ms waiting for ${label}. ` +
          `Last projection: round ${String(encounterOf(campaign).round)}, up next ${actor}, ` +
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

function heroAttack(clientMessageId: string, targetId: string): unknown {
  return {
    type: "structured_action",
    clientMessageId,
    actorId: "hero",
    turn: {
      actorId: "hero",
      mainAction: { actionType: "attack", actionId: "longsword", targetIds: [targetId] },
      tacticalRationaleEnglish: "Test fixture: press the attack to win the fight.",
    },
  };
}

/** `heroAttack` against whichever hostile is still standing — read off the
 * last-known projection rather than a hardcoded id, so it keeps targeting a
 * live combatant once the first goblin falls. */
function heroAttackTurn(clientMessageId: string, campaign: Campaign): unknown {
  const target = encounterOf(campaign).combatants.find(
    (each) => each.faction === "hostile" && each.status === "alive",
  );
  if (target === undefined) throw new Error("heroAttackTurn: no living hostile left to attack");
  return heroAttack(clientMessageId, target.combatantId);
}

/**
 * Drives hero commands, one per round, until one faction is left standing —
 * polling the server's own projection between each, exactly the way
 * `waitForProjection`'s own doc comment requires: the pipeline wedges
 * silently once a side is wiped out (file header, point 2), so there is
 * never a terminal frame to wait on instead.
 *
 * `turnCommand` decides what the hero does each round. The combat-only test
 * below always dodges, which is what makes ITS outcome a deterministic
 * defeat regardless of dice (file header, point 1) — the hero never fights
 * back, so the hostile faction cannot help but be the one left standing. The
 * end-to-end scene walk needs the opposite: only a victory advances the arc
 * (`resolveIfConcluded`, pipeline.ts), so it presses the attack instead.
 *
 * Extracted from the combat-only test's own loop (unchanged in every
 * observable way) so both tests share one poll-and-bound implementation
 * rather than two copies of it.
 */
async function playToConclusion(
  socket: WebSocket,
  store: EventStore,
  campaignId: string,
  turnCommand: (turn: number, campaign: Campaign) => unknown,
): Promise<Campaign> {
  // Shared by both tests below. For the combat-only one, nothing under
  // apps/server/src or packages/rules-engine/src enforces
  // EncounterDefinition.maxRounds, so this constant is the ONLY bound on how
  // many hero commands this helper will send before giving up. For the scene
  // walk, `resolveIfConcluded` (pipeline.ts) DOES enforce maxRounds — a
  // stalemate there closes the bracket well before this loop would exhaust
  // its own bound — but the bound stays here regardless, as a genuine-hang
  // backstop shared by both callers rather than a round cap either relies on.
  const MAX_HERO_COMMANDS = 20;
  let tracked = await loadCampaign({ campaignId, store });
  if (tracked === null) throw new Error(`Campaign ${campaignId} not found right after creation`);

  for (let turn = 0; turn < MAX_HERO_COMMANDS; turn += 1) {
    const beforeSequence = tracked.nextSequence;
    send(socket, turnCommand(turn, tracked));

    // One hero command triggers the hero's own turn plus the full enemy
    // sweep (pipeline.ts's `runEnemyTurns`, called once per successful
    // player turn) before the WS handler's drain loop returns — so waiting
    // for "back to the hero, or nobody left to fight" here is waiting for
    // exactly one round, never a partial one. The `nextSequence >
    // beforeSequence` guard is required, not cosmetic: the campaign is
    // already resting at "it's the hero's turn" before any command lands
    // (currentActorIndex starts at 0), so without it this would resolve
    // instantly on turn 0, before the command was even processed.
    const campaign = await waitForProjection(
      store,
      campaignId,
      (candidate) => {
        if (candidate.nextSequence <= beforeSequence) return false;
        // A scene-owned bracket nulls `state.encounter` the instant the
        // fight concludes, win or lose (reduce.ts's `encounter_resolved`
        // case) — `encounterOf` below would throw on that, so a closed
        // bracket is checked, and settled on, before touching it.
        if (candidate.state.encounter === null) return true;
        const alive = livingFactions(candidate.state);
        const backToHero =
          encounterOf(candidate).turnOrder[encounterOf(candidate).currentActorIndex] === "hero";
        return alive.size < 2 || backToHero;
      },
      `hero command ${String(turn)} to resolve`,
    );
    tracked = campaign;

    if (campaign.state.encounter === null || livingFactions(campaign.state).size < 2) {
      return campaign;
    }
  }

  throw new Error(
    `Combat did not conclude within ${String(MAX_HERO_COMMANDS)} hero commands. ` +
      "For a combat-only campaign, EncounterDefinition.maxRounds is inert data " +
      "and nothing in the pipeline enforces a round cap; for a bridged (scene) " +
      "campaign, resolveIfConcluded does, so reaching this throw there points at " +
      "that enforcement itself, not just a slow fight. Either way, this bound is " +
      "what stands between a genuinely wedged pipeline and a test that hangs forever.",
  );
}

describe("end to end", () => {
  // Break scenario, assertion by assertion (all below the `waitFor`/
  // `waitForProjection` loop, which itself goes red on any hang or on a
  // pipeline that never lets one faction win — see the loop's own comment):
  //   - `ack.type !== "campaign_state"`: join not wired to the registry, or
  //     answering everything with a generic error.
  //   - `hero.status !== "dead"` / `hero.currentHp !== 0`: the death-vs-
  //     unconscious branch regressed, or damage stopped clamping at 0.
  //   - `livingFactions(...)` not exactly `{"hostile"}`: the party won (this
  //     encounter structurally cannot let that happen — the hero only
  //     dodges — so this would mean `reduce`/`applyTurn` broke faction or
  //     status bookkeeping), or both sides died, or neither did.
  //   - no `dice_rolled` event: the goblins never actually attacked (a
  //     silent regression to spawns too far apart to reach, or the
  //     tactical fallback broke).
  //   - `log.frames.some(error)`: a malformed message, a rejected turn, or a
  //     `not_your_turn` leaked into a run that should never produce one —
  //     this is the guard against the failure mode where a stream of
  //     `error` frames would satisfy a bare `frames.length > N`.
  //   - non-monotonic or duplicate `event` sequences: the transport
  //     reordered or double-delivered frames.
  it("plays a full combat to a conclusion over the socket", async () => {
    const { app, url, store } = await startServer();
    const campaignId = await createCampaignOver(app);

    const socket = await connect(url);
    const log = new FrameLog(socket);
    const ack = await joinAndAck(socket, log, campaignId);
    expect(ack.type).toBe("campaign_state");

    // 20 hero commands (`playToConclusion`'s own bound) is generous: two
    // scimitars at +4 vs the hero's AC 16 (Chain Mail — same AC the guard it
    // replaced had) hit ~45% of the time for an average of 5, so ~4.5
    // expected damage per round against the hero's 28 HP concludes in
    // roughly 6-7 rounds; 20 still gives about 3x headroom without letting a
    // genuinely wedged pipeline spin unbounded. The hero only ever dodges
    // here, so the goblins never die and the eventual "hostile faction
    // wins" outcome is structural — but exactly when it arrives (a death
    // save resolves within at most 5 rolls, not on the first hit) is dice-
    // dependent (file header, point 1).
    const concluded = await playToConclusion(socket, store, campaignId, (turn) =>
      heroDodge(`hero-turn-${String(turn)}`),
    );

    // The final projection: one faction left standing, and necessarily the
    // hostile one, since the hero (scripted to only dodge) never dealt
    // damage. Never asserted as a party win.
    expect(livingFactions(concluded.state)).toEqual(new Set(["hostile"]));

    const hero = encounterOf(concluded).combatants.find((c) => c.combatantId === "hero");
    if (hero === undefined) throw new Error("hero missing from the final projection");
    expect(hero.currentHp).toBe(0);
    // The hero fell Unconscious at 0 HP (`diesAtZeroHp` reads off its real
    // `characterId`) and the encounter pipeline auto-drove its death saves
    // on every subsequent turn (`runEnemyTurns`'s party-unconscious branch)
    // until the tally finally reached three failures. Not the first hit,
    // and not guaranteed by any single roll — a `"stable"` or `"revived"`
    // result along the way only postpones this, since the hero (Dodge-only)
    // never stops taking hits until the goblins run out of turns to give,
    // which they don't. This assertion is therefore about the eventual,
    // dice-dependent outcome of that loop, not a deterministic single roll.
    expect(hero.status).toBe("dead");

    // Real combat happened — not merely 20+ frames of any kind (dice_rolled
    // fires on every turn including a Dodge, so
    // a bare event count proves nothing; length alone would also pass on a
    // stream of nothing but `error` frames).
    const events = await store.readSince(campaignId, -1);
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

    // An explicit timeout, well above vitest's 5s default, because this test
    // plays a whole fight over a real socket and polls the store every 10ms
    // for each of up to `MAX_HERO_COMMANDS` rounds. How long that takes is
    // set by the dice, not by anything under test: the campaign state split
    // moved every turn's seed by one sequence (genesis became two events, so
    // `seedFor(rootSeed, nextSequence)` is evaluated one higher throughout),
    // and this fight went from 6 rounds to 10 as a result. Deterministic
    // either way, but 5s no longer fits it under a parallel `pnpm test`.
    //
    // 5s was never a bound anyone chose for this test; it only ever fit by
    // accident. It also made `waitForProjection`'s own diagnostic — the one
    // that names the round, the actor and every combatant's HP —
    // unreachable past the first round or two, since vitest's timer would
    // fire first and report nothing but a line number.
  }, 30_000);

  // Two obvious reconnect assertions cannot fail regardless of what the
  // transport does: `live.length > cut` (a length always exceeds a sequence
  // index) and `folded.combatants.length === clientState.combatants.length`
  // (the combatant count never changes over this fight). This proves the
  // stronger, spec-required property instead: fold the FIRST client's own snapshot plus every event
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
    const campaignId = await createCampaignOver(app);

    const firstSocket = await connect(url);
    const firstLog = new FrameLog(firstSocket);
    const ack = await joinAndAck(firstSocket, firstLog, campaignId);
    if (ack.type !== "campaign_state") throw new Error(`Expected campaign_state, got ${ack.type}`);
    const clientState: CampaignState = ack.snapshot;

    const beforeRound = await loadCampaign({ campaignId, store });
    if (beforeRound === null)
      throw new Error(`Campaign ${campaignId} not found right after creation`);
    const beforeSequence = beforeRound.nextSequence;
    send(firstSocket, heroDodge("t1"));

    // Close the instant the hero's OWN turn_advance arrives — strictly
    // before the enemy sweep starts (same technique as ws.test.ts's
    // drain-after-close test). That leaves a genuine gap: `handleCommand`
    // drains to completion regardless of the socket (proven there — this
    // file relies on it rather than re-proving it), so both goblins' turns keep
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
      campaignId,
      (candidate) => {
        if (candidate.nextSequence <= cut + 1) return false;
        const alive = livingFactions(candidate.state);
        const backToHero =
          encounterOf(candidate).turnOrder[encounterOf(candidate).currentActorIndex] === "hero";
        return alive.size < 2 || backToHero;
      },
      "the rest of the round to finish appending after the first socket closed",
    );
    const roundEndSequence = afterRound.nextSequence - 1;

    // Whether the reconnecting join also gets a
    // trailing `turn_affordances` frame is keyed on the exact same
    // condition `waitForProjection`'s predicate above just used to decide
    // the round was over — not re-derived, and not assumed. If the hero
    // ever dies mid-round (a seed or HP change), `waitForProjection` above
    // would have stopped on `alive.size < 2` with control left on whichever
    // hostile was mid-turn, `backToHero` false, and this flag correctly
    // predicts no trailing frame — keeping this assertion from failing for
    // a reason that has nothing to do with reconnect.
    const roundEndAlive = livingFactions(afterRound.state);
    const roundEndBackToHero =
      encounterOf(afterRound).turnOrder[encounterOf(afterRound).currentActorIndex] === "hero";
    const expectAffordances = roundEndAlive.size < 2 || roundEndBackToHero;

    // A second client resumes from what the first one had.
    const secondSocket = await connect(url);
    const secondLog = new FrameLog(secondSocket);
    send(secondSocket, { type: "join", campaignId, resumeFrom: cut });

    // Proves the second socket received real content, not merely SOME
    // frame: its highest event sequence must reach the exact point the
    // round actually ended at, which is strictly past `cut` by construction
    // (the enemy sweep alone is several events).
    //
    // When a trailing `turn_affordances` frame is
    // expected, the wait does not settle on the last `event` frame alone —
    // it also waits for that trailing frame to actually arrive. Settling
    // early relied on the trailing frame reaching this socket in the same
    // read as the last event, which `FrameLog` resolving inside the
    // `message` handler with the `await` resuming on a later microtask does
    // not guarantee (true on loopback, not guaranteed in general).
    await secondLog.waitFor(
      (frames) => {
        const sequences = eventFrames(frames).map((event) => event.sequence);
        const caughtUp = sequences.length > 0 && Math.max(...sequences) >= roundEndSequence;
        if (!caughtUp) return false;
        if (!expectAffordances) return true;
        return frames.some((frame) => frame.type === "turn_affordances");
      },
      `the second socket to catch up to sequence ${String(roundEndSequence)}` +
        (expectAffordances ? " and its trailing turn_affordances frame" : ""),
    );

    // No snapshot exists yet (SNAPSHOT_EVERY is 50; one round is nowhere
    // close), so `join`'s snapshot-fallback branch does not fire —
    // every frame the second client gets back is a plain `event` replay of
    // exactly what it missed, never a resent campaign_state or an error.
    // When the round this join catches up on ends back on the
    // hero's own turn (with the hero alive), `join` also pushes one
    // trailing `turn_affordances` frame after the replayed events — the one
    // frame in this log that is not an `event`.
    if (expectAffordances) {
      expect(secondLog.frames.slice(0, -1).every((frame) => frame.type === "event")).toBe(true);
      expect(secondLog.frames.at(-1)?.type).toBe("turn_affordances");
    } else {
      expect(secondLog.frames.every((frame) => frame.type === "event")).toBe(true);
    }

    const secondEvents = eventFrames(secondLog.frames);
    const secondSequences = secondEvents.map((event) => event.sequence);
    expect(Math.min(...secondSequences)).toBe(cut + 1);
    expect(secondSequences).toEqual([...secondSequences].sort((a, b) => a - b));
    expect(new Set(secondSequences).size).toBe(secondSequences.length);

    // The real property: the first client's own snapshot, folded with every
    // event either socket actually delivered, reproduces the server's own
    // projection exactly.
    const reconstructed = fold(clientState, [...firstEvents, ...secondEvents]);
    const serverProjection = await loadCampaign({ campaignId, store });
    if (serverProjection === null) throw new Error("campaign disappeared from the store");
    expect(reconstructed).toEqual(serverProjection.state);

    secondSocket.close();
  });

  // Task 7, step 4 (§4.7): a campaign that exists but has never entered a
  // fight. `POST /campaigns` always calls `createCampaign` then
  // `startEncounter` back to back (`transport/http.ts`), so no HTTP route
  // can produce this campaign — it is built directly against the harness's
  // own store instead. `campaign.test.ts`'s "rebuilds an identical
  // projection from a log of exactly one event" already pins the
  // projection itself (`encounter: null` survives a reload); what is new
  // here is the wire frame: that `join` on such a campaign still answers
  // with a valid `campaign_state`, not a schema violation or a silent
  // placeholder.
  it("joins an encounter-less campaign to a valid campaign_state frame with a null encounter", async () => {
    const { url, store } = await startServer();

    let n = 0;
    const campaign = await createCampaign({
      campaignId: "no-encounter-yet",
      rootSeed: 7,
      store,
      clock: () => "2026-08-19T10:00:00.000Z",
      uuid: () => {
        n += 1;
        return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
      },
    });

    const socket = await connect(url);
    const log = new FrameLog(socket);
    // Never registered in-process (only the store was written to directly),
    // so this exercises `registry.get`'s fall-through to `loadCampaign` on a
    // miss (`transport/http.ts`), not the in-memory cache.
    const ack = await joinAndAck(socket, log, campaign.state.world.campaignId);

    // No separate parse here: `FrameLog`'s own message handler already runs
    // `ServerFrame.parse` on every inbound frame (see that class above), so
    // `ack` arriving at all — the protocol.ts frame schema is
    // `{ type: "campaign_state", sequence, snapshot: CampaignState }`, and
    // `CampaignState.encounter` is nullable — is already the proof this
    // frame, snapshot.encounter included, is schema-*valid*, not merely
    // tolerated by a cast.
    if (ack.type !== "campaign_state") {
      throw new Error(`Expected campaign_state, got ${ack.type}`);
    }
    expect(ack.snapshot.encounter).toBeNull();

    socket.close();
  });

  // §4.7 step 5's exit criterion, over the real socket: a `worldId` campaign
  // walks Hebrew free text down the shipped Emberfall arc
  // (`data/world/arc.json`: arrival -> guild-offer -> the-weir -> saboteurs),
  // the bridge opens a bracket the instant `saboteurs` is entered
  // (`encounter_started` alongside the scene-entry events), the fight plays
  // out over the socket, the bracket resolves, the node completes, and a
  // cold `loadCampaign` reload folds to exactly the live state.
  //
  // Unlike the combat-only test above, this walk needs the party to WIN:
  // `resolveIfConcluded` (pipeline.ts) only advances the arc — completing
  // "saboteurs" and clearing the bracket into "back out to narration" — on a
  // victory. `heroDodge`'s guaranteed-defeat script exists precisely so the
  // combat-only test never needs to reach that branch; this test presses the
  // attack instead, via `playToConclusion`'s `heroAttackTurn`.
  //
  // Break scenario, assertion by assertion:
  //   - `ack.type !== "campaign_state"`: `join` not wired to a `worldId`
  //     campaign.
  //   - the walk's own `waitForProjection` calls time out: a traversal was
  //     refused (bad edge id in this test's intent stub, or a precondition
  //     the real content does not satisfy) or free text never reached the
  //     scene engine at all.
  //   - no `encounter_started` frame: `saboteurs`'s `encounterId` stopped
  //     bridging into a bracket (Task 5's own regression surface).
  //   - `resolved?.payload` not a `"victory"`: `heroAttackTurn` stopped
  //     targeting a living hostile, or the rules engine's attack resolution
  //     broke.
  //   - `quest_node_completed` for `"saboteurs"` missing or duplicated:
  //     Task 6's end-of-combat detector regressed.
  //   - the walk onward to `reckoning` times out: the scene engine cannot
  //     accept a traversal once a bracket has closed under it — the one
  //     regression surface this whole feature actually introduces.
  //   - `fold(clientState, eventFrames(log.frames))` disagrees with the
  //     fresh `reloaded` projection: the client-visible event stream and
  //     the server's own log have forked.
  it("walks a scene campaign into combat and back out to narration", async () => {
    const { app, url, store } = await startServer();
    const campaignId = await createWorldCampaignOver(app);

    const socket = await connect(url);
    const log = new FrameLog(socket);
    const ack = await joinAndAck(socket, log, campaignId);
    // Narrows for `ack.snapshot` below (`expect(...).toBe(...)` does not
    // narrow the type), the same idiom the reconnect test above this one
    // uses for its own `clientState`.
    if (ack.type !== "campaign_state") throw new Error(`Expected campaign_state, got ${ack.type}`);
    const clientState: CampaignState = ack.snapshot;

    // Down the arc, one traversal at a time. Each is awaited before the next
    // is sent: `transport/ws.ts` holds one in-flight-command slot per
    // campaign (file header, point 4), and `free_text`'s own
    // `intent.classify` call is async, so pipelining these risks the later
    // ones being dropped as `turn_in_progress`.
    send(socket, { type: "free_text", clientMessageId: "w1", text: "לשמוע את סוכנת הגילדה" });
    await waitForProjection(
      store,
      campaignId,
      (candidate) => candidate.state.world.scene?.currentNodeId === "guild-offer",
      "the walk to reach guild-offer",
    );

    send(socket, { type: "free_text", clientMessageId: "w2", text: "ללכת אל הסכר" });
    await waitForProjection(
      store,
      campaignId,
      (candidate) => candidate.state.world.scene?.currentNodeId === "the-weir",
      "the walk to reach the-weir",
    );

    // Entering `saboteurs` is what opens the bracket (pipeline.ts's bridge,
    // atomically with the scene-entry events). Waited on the frame log
    // itself, not `waitForProjection` on the store: `emitAll` (ws.ts,
    // ~line 161-162) appends to the store before it yields frames to the
    // socket, so the store already showing `state.encounter !== null` does
    // not mean this socket has received the `encounter_started` frame yet —
    // the same race the later `reckoning` wait below documents and closes
    // for its own anchor.
    send(socket, { type: "free_text", clientMessageId: "w3", text: "לבדוק את מנגנון השער" });
    await log.waitFor(
      (frames) => eventFrames(frames).some((each) => each.type === "encounter_started"),
      "the bracket to open on entering saboteurs",
    );
    expect(eventFrames(log.frames).map((each) => each.type)).toContain("encounter_started");

    const concluded = await playToConclusion(socket, store, campaignId, (turn, campaign) =>
      heroAttackTurn(`walk-attack-${String(turn)}`, campaign),
    );
    // A scene-owned bracket nulls `encounter` the instant the fight
    // concludes (reduce.ts's `encounter_resolved` case), win or lose —
    // `playToConclusion` only returns once that has already happened here.
    expect(concluded.state.encounter).toBeNull();

    const events = await store.readSince(campaignId, -1);
    const resolved = events.find((each) => each.type === "encounter_resolved");
    expect(resolved?.payload).toMatchObject({ outcome: "victory" });
    expect(
      events.filter(
        (each) => each.type === "quest_node_completed" && each.payload["nodeId"] === "saboteurs",
      ),
    ).toHaveLength(1);

    // "Back out to narration" (the exit criterion's own wording) is not just
    // the bracket closing — the scene engine must still accept a further
    // traversal past it. `saboteurs` is complete but stays the current node
    // (`completeCurrentNode` marks completion without moving `currentNodeId`
    // on its own), so reaching `reckoning` needs this one more `free_text`.
    send(socket, { type: "free_text", clientMessageId: "w4", text: "להביא את מה שמצאנו לפונדק" });
    await waitForProjection(
      store,
      campaignId,
      (candidate) => candidate.state.world.scene?.currentNodeId === "reckoning",
      "the walk onward to reckoning after the bracket closes",
    );

    // `emitAll` (ws.ts, ~line 161-162) appends to the store before it yields
    // frames to the socket, so polling the store via `waitForProjection` (as
    // every step of this walk does above) can race ahead of `log`'s own
    // frame delivery — the store already reflecting `reckoning` does not
    // mean this socket has received the frame that proves it yet. Waiting on
    // the frame log itself for the anchor that closes the walk (the same
    // `log.waitFor` idiom the reconnect test above this one uses) removes
    // that race before the fold comparison below reads `log.frames`.
    await log.waitFor(
      (frames) =>
        eventFrames(frames).some(
          (event) => event.type === "quest_node_entered" && event.payload["nodeId"] === "reckoning",
        ),
      "the quest_node_entered frame for reckoning, closing the walk",
    );

    // The exit criterion's last clause, proven against the LIVE server
    // projection, not against another cold fold of the same log: the first
    // client's own join snapshot, folded with every event frame this one
    // continuous socket actually received, must reproduce a fresh
    // `loadCampaign` exactly — board included, not merely "an
    // `encounter_started` of some kind arrived" (the file-header idiom the
    // reconnect test above this one already uses).
    const reloaded = await loadCampaign({ campaignId, store });
    if (reloaded === null) throw new Error(`Campaign ${campaignId} disappeared from the store`);
    expect(reloaded.state.world.scene?.completedNodeIds).toContain("saboteurs");
    expect(reloaded.state.world.scene?.currentNodeId).toBe("reckoning");
    expect(reloaded.state.world.scene?.day).toBe(2);
    expect(reloaded.state.world.scene?.relations).toEqual([
      { factionA: "ashen-guild", factionB: "river-wardens", band: "hostile" },
    ]);
    expect(reloaded.state.world.scene?.npcAffinities).toEqual([
      { npcId: "old-tobin", band: "cordial", facts: [] },
    ]);
    expect(reloaded.state.encounter).toBeNull();
    expect(fold(clientState, eventFrames(log.frames))).toEqual(reloaded.state);

    socket.close();
  }, 30_000);
});
