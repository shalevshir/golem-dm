import { describe, expect, it } from "vitest";
import {
  abilityCheck,
  DC_BY_DIFFICULTY,
  seeded,
  sceneStateFrom,
  snapshotOf,
  traverseEdge,
  validateExecuteTurn,
} from "@ai-dm/rules-engine";
import type { SceneState, SceneTransition } from "@ai-dm/rules-engine";
import type {
  AdapterError,
  IntentAgent,
  IntentResult,
  NarrativeFinish,
  NarrativePort,
  SceneNarrationInput,
  SceneNarrativePort,
  TacticalAgent,
} from "@ai-dm/agents";
import {
  createAgentRuntime,
  createDeterministicNarrative,
  createDeterministicSceneNarrative,
  createFakePort,
  createHebrewNarrative,
  createTacticalAgent,
  DEFAULT_MODEL_ROUTING,
  INTENT_PROMPT_VERSION,
  NARRATIVE_PROMPT_VERSION,
  SCENE_PROMPT_VERSION,
} from "@ai-dm/agents";
import { createInMemoryEventStore, EventStoreUnavailableError } from "@ai-dm/memory";
import type { EventStore } from "@ai-dm/memory";
import { CheckRolledPayload, DiceRolledPayload, NarrativeEmittedPayload } from "@ai-dm/schemas";
import type {
  AbilityKey,
  ClientMessage,
  Combatant,
  ExecuteTurn,
  GameEvent,
  IntentClassification,
  SceneSnapshot,
  ServerFrame,
  Skill,
  CampaignState,
} from "@ai-dm/schemas";
import { SNAPSHOT_EVERY, handleCommand } from "./pipeline.js";
import type {
  NarrativeTurnMetrics,
  SnapshotFailureRecord,
  TacticalTurnMetrics,
  TurnPorts,
} from "./pipeline.js";
import { createCampaign, encounterOf, loadCampaign, startEncounter } from "./campaign.js";
import type { Campaign, SceneStatics } from "./campaign.js";
import { loadCharacter } from "../encounters/index.js";
import { loadGear } from "../encounters/gear.js";
import { loadWorld } from "../world/index.js";

/** `main.ts`'s own `skillAbilities` construction, mirrored here so a check
 *  test can name a real skill and get its real governing ability rather than
 *  an empty map (`portsWith`'s default, adequate for every test that never
 *  proposes a `check` with a skill). */
function skillAbilities(): ReadonlyMap<Skill, AbilityKey> {
  return new Map(
    Array.from(loadGear().skills, ([skill, definition]) => [skill, definition.ability] as const),
  );
}

function uuids(): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  };
}

/**
 * A tactical double that proposes a legal Dodge for whichever actor it is
 * asked about. Deliberately a working default rather than an always-rejecting
 * stub: `runEnemyTurns` fires after every successful player turn, so every
 * test that plays a turn reaches this port — including the ones that care
 * about nothing but the player's own half of the turn.
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

/**
 * `ports.intent.classify` should never be reached by a combat test — every
 * `free_text` test below supplies its own `intent`. Throwing rather than
 * resolving is what makes an accidental call to this default loud instead of
 * silently returning a plausible-looking classification.
 */
function unreachableIntent(): IntentAgent {
  return {
    classify() {
      throw new Error("ports.intent.classify was not expected to be called in this test");
    },
  };
}

function portsWith(store: EventStore, tactical: TacticalAgent = defaultTactical()): TurnPorts {
  return {
    store,
    tactical,
    narrative: createDeterministicNarrative(),
    intent: unreachableIntent(),
    // Mirrors `narrative` above: the deterministic renderer stands in as the
    // "primary" port for every test that does not care about the scene
    // narration ladder specifically, exactly the way `createDeterministicNarrative()`
    // already does for combat.
    sceneNarrative: createDeterministicSceneNarrative(),
    clock: () => "2026-08-19T10:00:00.000Z",
    uuid: uuids(),
    seedFor: (rootSeed, sequence) => rootSeed * 1000 + sequence,
    turnTimeoutMs: 10_000,
    conditionNamesHebrew: new Map([["prone", "שרוע"]]),
    skillAbilities: new Map(),
  };
}

async function drain(stream: AsyncIterable<ServerFrame>): Promise<ServerFrame[]> {
  const frames: ServerFrame[] = [];
  for await (const frame of stream) frames.push(frame);
  return frames;
}

/**
 * The sequence of the last event `freshCampaign` writes. Genesis is two
 * events now — `campaign_started` at 0, `encounter_started` at 1 — so the
 * first event any turn appends lands at 2, and a test that wants "the log
 * the pipeline wrote" reads from here rather than from 0.
 */
const GENESIS_SEQUENCE = 1;

async function freshCampaign(store: EventStore): Promise<Campaign> {
  // Two events, not one: `createCampaign` opens the stream and
  // `startEncounter` opens the bracket. Every test below wants a board, so
  // they arrive together here, exactly as `POST /campaigns` does them.
  const ports = { store, clock: () => "2026-08-19T10:00:00.000Z", uuid: uuids() };
  const campaign = await createCampaign({ campaignId: "s1", rootSeed: 42, ...ports });
  return startEncounter({ campaign, encounterId: "goblin-ambush", ...ports });
}

/** Just `createCampaign` — a campaign with a world and no board. */
async function encounterlessCampaign(store: EventStore): Promise<Campaign> {
  return createCampaign({
    campaignId: "s1",
    rootSeed: 42,
    store,
    clock: () => "2026-08-19T10:00:00.000Z",
    uuid: uuids(),
  });
}

/**
 * The real `emberfall` world and the real `hero` character — mirrors
 * `campaign.test.ts`'s `heroSceneStatics`. Real content rather than a
 * synthetic fixture, for the same "real stat blocks" reasoning `runOneTurn`'s
 * doc comment gives for combat: the `free_text` tests below read Hebrew
 * fields (`nameHebrew`, NPC names) off it, and a Latin placeholder would put
 * the wrong kind of character into a Hebrew-only assertion for the wrong
 * reason.
 */
function heroSceneStatics(): SceneStatics {
  return { authored: loadWorld(), character: loadCharacter("hero") };
}

/**
 * A scene campaign (no board, `world.scene` set from `emberfall`'s genesis).
 * `overrides` replaces fields of the starting `SceneSnapshot` directly —
 * `arrival`, the authored starting node, has no effects and a single-hop
 * traversal from it can never show a faction/day delta, so several tests
 * below need to start further into the arc than a real playthrough would put
 * them without chaining several `free_text` turns just to get there.
 */
async function sceneCampaign(
  store: EventStore,
  overrides?: Partial<SceneSnapshot>,
): Promise<Campaign> {
  const campaign = await createCampaign({
    campaignId: "s1",
    rootSeed: 42,
    store,
    clock: () => "2026-08-19T10:00:00.000Z",
    uuid: uuids(),
    scene: heroSceneStatics(),
  });
  if (overrides === undefined) return campaign;

  const { scene } = campaign.state.world;
  if (scene === null) throw new Error("sceneCampaign: genesis produced no scene");
  campaign.state = {
    ...campaign.state,
    world: { ...campaign.state.world, scene: { ...scene, ...overrides } },
  };
  return campaign;
}

/** A classifier double that resolves to exactly this classification. */
function classifiedAs(classification: IntentClassification): IntentAgent {
  return {
    classify() {
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

/** A classifier double that resolves to exactly this failure. */
function intentFailingWith(error: AdapterError): IntentAgent {
  return {
    classify() {
      return Promise.resolve({ ok: false, error, usage: [] } satisfies IntentResult);
    },
  };
}

/** A scene narrative port that yields exactly these chunks, mirroring `scriptedNarrative`. */
function scriptedSceneNarrative(chunks: string[]): SceneNarrativePort {
  return {
    stream(): AsyncIterable<string> {
      return {
        [Symbol.asyncIterator](): AsyncIterator<string> {
          const iterator = chunks[Symbol.iterator]();
          return {
            next(): Promise<IteratorResult<string>> {
              return Promise.resolve(iterator.next());
            },
          };
        },
      };
    },
  };
}

/**
 * A scene narrative port that records every `input` it is given (so a test
 * can inspect the `SceneBeat` the pipeline actually built) and otherwise
 * behaves like `scriptedSceneNarrative([])` — an empty stream, the fallback
 * rung the deterministic renderer picks up from.
 */
function recordingSceneNarrative(sink: SceneNarrationInput[]): SceneNarrativePort {
  return {
    stream(input: SceneNarrationInput): AsyncIterable<string> {
      sink.push(input);
      return scriptedSceneNarrative([]).stream(input);
    },
  };
}

/** Sorts a `SceneSnapshot`'s array fields the same way `snapshotOf` promises to emit them —
 *  mirrors `packages/rules-engine/src/scene/snapshot.test.ts`'s own `sorted` helper. */
function sortedSnapshot(snapshot: SceneSnapshot): SceneSnapshot {
  return {
    ...snapshot,
    completedNodeIds: [...snapshot.completedNodeIds].sort(),
    relations: [...snapshot.relations].sort(
      (a, b) => a.factionA.localeCompare(b.factionA) || a.factionB.localeCompare(b.factionB),
    ),
  };
}

/** The state from a transition, or a loud failure — a broken fixture should fail loudly. */
function stateOf(transition: SceneTransition): SceneState {
  if (!transition.valid) {
    throw new Error(
      `test fixture expected a valid transition: ${transition.rejections
        .map((each) => each.reason)
        .join(", ")}`,
    );
  }
  return transition.state;
}

function eventTypesOf(frames: ServerFrame[]): string[] {
  return frames
    .filter((each): each is Extract<ServerFrame, { type: "event" }> => each.type === "event")
    .map((each) => each.event.type);
}

// `clientMessageId` defaults to "c1" for every existing call site; the
// degradation-ladder tests below pass distinct ids to send several dodges
// from the same actor across a campaign without tripping the idempotency
// guard (`appliedClientMessageIds`).
const dodge = (actorId: string, clientMessageId = "c1"): ClientMessage => ({
  type: "structured_action",
  clientMessageId,
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
    campaignId: "s1",
    sequence,
    timestamp: "2026-08-19T10:00:00.000Z",
    type: "scene_changed",
    payload: { kind: "turn_advanced" },
  };
}

/**
 * A tactical port that proposes exactly the given turns, one per call to
 * `proposeTurn`, in order. Every element must be a full `ExecuteTurn`:
 * `tacticalRationaleEnglish` is required, not optional, so an untyped
 * fixture would fail at runtime and a typed one fails `pnpm typecheck`.
 *
 * `TokenUsage` is `{ promptTokens, completionTokens, totalTokens }`
 * (`packages/agents/src/providers/usage.ts`) — there are no `inputTokens` /
 * `outputTokens` fields.
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
 * geometry. An "attack a target out of reach" fixture would not be:
 * `goblin-ambush` spawns its combatants within melee reach of one another,
 * so such an attack is legal there. The agent's own retry-once
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
 * A port that yields exactly these chunks and then stops. Written as a plain
 * (non-`async`) generator wrapped by hand, mirroring `deterministic.ts`'s own
 * `toAsyncIterable` — an `async function*` here never actually awaits
 * anything, which `@typescript-eslint/require-await` correctly flags.
 */
function scriptedNarrative(chunks: string[]): NarrativePort {
  return {
    stream(): AsyncIterable<string> {
      return {
        [Symbol.asyncIterator](): AsyncIterator<string> {
          const iterator = chunks[Symbol.iterator]();
          return {
            next(): Promise<IteratorResult<string>> {
              return Promise.resolve(iterator.next());
            },
          };
        },
      };
    },
  };
}

/**
 * The turn's `narrative_emitted` event payload — parsed against the real
 * schema rather than cast, so a payload missing `source`/`promptVersion`
 * fails here rather than silently satisfying a narrower check — plus every
 * `narrative_token` frame's text FOR THAT SAME STREAM, in the order
 * streamed.
 *
 * Scoped by `streamId`, not every `narrative_token` frame in `frames`:
 * `runOneTurn` drives a real `goblin-ambush` turn, so a successful hero dodge
 * cascades into the hostile sweep (`pipeline.ts`'s `runEnemyTurns`), and
 * every one of those also narrates through the same scripted port under test
 * — with its own `streamId`. An unscoped collection would fold the
 * goblins' tokens in too and never equal the hero's own `emitted.text`,
 * exactly like the file's existing "narrative_emitted carries exactly the
 * concatenation of its streamed tokens" test already has to guard against.
 *
 * The tokens are collected with a loop rather than `frames.filter(...).map(...)`:
 * a bare `.filter` predicate does not narrow `ServerFrame`'s discriminated
 * union through a following `.map` (see `e2e.test.ts`'s `eventFrames` for the
 * same fix), so `.map((f) => f.text)` would not typecheck.
 */
function narrativeOf(frames: ServerFrame[]): {
  tokens: string[];
  emitted: NarrativeEmittedPayload;
} {
  const event = frames.find((f) => f.type === "event" && f.event.type === "narrative_emitted");
  if (event?.type !== "event") throw new Error("no narrative_emitted frame");
  const emitted = NarrativeEmittedPayload.parse(event.event.payload);

  const tokens: string[] = [];
  for (const frame of frames) {
    if (frame.type === "narrative_token" && frame.streamId === emitted.streamId) {
      tokens.push(frame.text);
    }
  }
  return { tokens, emitted };
}

/**
 * Drives one hero dodge turn through a fresh store/campaign on the real
 * `goblin-ambush` build. Ruling P-4: the fixture must have real stat blocks
 * — `buildNarrationBrief`'s `creatureFor` falls back to the Latin
 * `combatantId` when one is missing, which would put Latin characters into a
 * Hebrew-only assertion for the wrong reason. `overrides.narrative` replaces
 * the default deterministic port; every other port is `portsWith`'s usual
 * double.
 */
async function runOneTurn(overrides: { narrative: NarrativePort }): Promise<ServerFrame[]> {
  const store = createInMemoryEventStore();
  const campaign = await freshCampaign(store);
  const ports: TurnPorts = { ...portsWith(store), ...overrides };
  return drain(handleCommand(campaign, dodge("hero"), ports));
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
 * `turnTimeoutMs`: a tactical call that
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
    const campaign = await freshCampaign(store);
    const frames = await drain(
      handleCommand(campaign, { type: "join", campaignId: "s1" }, portsWith(store)),
    );
    expect(frames[0]).toMatchObject({ type: "campaign_state" });
  });

  // IMPORTANT-2: the previous version of this test ran `resumeFrom: 0`
  // against a log that was exactly the sequence-0 genesis event, so
  // `frames` was `[]` and the sole assertion — zero `campaign_state`
  // frames — passed vacuously: it would keep passing even if the branch
  // replayed nothing at all, or replayed from the wrong offset. Real
  // events past `resumeFrom`, with the exact returned sequences pinned,
  // is what actually exercises the replay.
  it("replays only the events after resumeFrom, in ascending sequence order", async () => {
    const store = createInMemoryEventStore();
    const campaign = await freshCampaign(store);
    await store.append("s1", [syntheticEvent(2), syntheticEvent(3), syntheticEvent(4)]);

    const frames = await drain(
      handleCommand(campaign, { type: "join", campaignId: "s1", resumeFrom: 2 }, portsWith(store)),
    );

    expect(frames.filter((each) => each.type === "campaign_state")).toHaveLength(0);
    const eventFrames = frames.filter((each) => each.type === "event");
    expect(eventFrames.map((each) => each.event.sequence)).toEqual([3, 4]);
  });

  // IMPORTANT-2: without this branch, a reconnecting client whose
  // `resumeFrom` is already the newest sequence — it missed nothing — got
  // zero frames back and could not tell "you're caught up" from "the
  // server dropped your join". `join` must have exactly one guaranteed
  // response; a `campaign_state` frame at the current projection is it,
  // the same shape a resumeFrom-less join gets (see `protocol.ts`'s
  // `JoinMessage` doc-comment, which spec #2 — the web client — builds
  // against).
  it("sends a campaign_state frame, not silence, when resumeFrom is already caught up", async () => {
    const store = createInMemoryEventStore();
    const campaign = await freshCampaign(store);

    const frames = await drain(
      handleCommand(
        campaign,
        { type: "join", campaignId: "s1", resumeFrom: GENESIS_SEQUENCE },
        portsWith(store),
      ),
    );

    // Task 4: this join lands on the hero's own turn, so a trailing
    // `turn_affordances` frame follows the `campaign_state` frame.
    expect(frames[0]).toEqual({
      type: "campaign_state",
      sequence: GENESIS_SEQUENCE,
      snapshot: campaign.state,
    });
    expect(frames).toHaveLength(2);
    expect(frames[1]?.type).toBe("turn_affordances");
  });

  // The spec's §Reconnect says "without resumeFrom, OR when it predates
  // the retained log: campaign_state at the newest snapshot, then the events
  // since [the snapshot]". This is the second branch — it is what makes the
  // schema's own claim about reconnect behaviour true. Simulated by writing
  // straight to the store (bypassing handleCommand) so the test can pin exact
  // sequence numbers rather than depending on how many events one dodge turn
  // produces.
  it("falls back to the newest snapshot when resumeFrom predates the log", async () => {
    const store = createInMemoryEventStore();
    const campaign = await freshCampaign(store);

    const upToSnapshot = Array.from({ length: 50 }, (_, index) =>
      syntheticEvent(index + GENESIS_SEQUENCE + 1),
    );
    await store.append("s1", upToSnapshot);

    const snapshotState: CampaignState = {
      ...campaign.state,
      encounter: { ...encounterOf(campaign), round: 99 },
    };
    await store.putSnapshot("s1", 51, snapshotState);

    const tail = [syntheticEvent(52), syntheticEvent(53)];
    await store.append("s1", tail);

    const frames = await drain(
      handleCommand(campaign, { type: "join", campaignId: "s1", resumeFrom: 0 }, portsWith(store)),
    );

    expect(frames[0]).toEqual({
      type: "campaign_state",
      sequence: 51,
      snapshot: snapshotState,
    });
    const eventFrames = frames.filter((each) => each.type === "event");
    expect(eventFrames.map((each) => each.event.sequence)).toEqual([52, 53]);
  });
});

describe("handleCommand — free text", () => {
  it("is refused with a stable code rather than reaching a model", async () => {
    const store = createInMemoryEventStore();
    const campaign = await freshCampaign(store);
    const frames = await drain(
      handleCommand(
        campaign,
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
    const campaign = await freshCampaign(store);
    await drain(
      handleCommand(
        campaign,
        { type: "free_text", clientMessageId: "c1", text: "hello" },
        portsWith(store),
      ),
    );
    expect(await store.readSince("s1", GENESIS_SEQUENCE)).toEqual([]);
  });

  // (b) Guard 2. `freshCampaign` also has no scene, so this additionally
  // pins that guard 2 (open encounter) is checked BEFORE guard 3 (no
  // scene) — the two existing tests above only prove `code`, not which
  // guard produced it or the exact during-combat wording Decision 6 names.
  it("gives the during-combat message when an encounter is open", async () => {
    const store = createInMemoryEventStore();
    const campaign = await freshCampaign(store);
    const frames = await drain(
      handleCommand(
        campaign,
        { type: "free_text", clientMessageId: "c1", text: "I look around" },
        portsWith(store),
      ),
    );
    expect(frames).toEqual([
      {
        type: "error",
        clientMessageId: "c1",
        code: "free_text_not_supported",
        message: "Use the on-screen actions during combat.",
      },
    ]);
  });

  // (c) Guard 3, on a campaign with neither a board nor a scene — the legacy
  // shape that predates §4.7 step 4. The message text is unchanged from
  // before this task.
  it("keeps the legacy message for a combat-only campaign with no board open", async () => {
    const store = createInMemoryEventStore();
    const campaign = await encounterlessCampaign(store);
    const frames = await drain(
      handleCommand(
        campaign,
        { type: "free_text", clientMessageId: "c1", text: "I look around" },
        portsWith(store),
      ),
    );
    expect(frames).toEqual([
      {
        type: "error",
        clientMessageId: "c1",
        code: "free_text_not_supported",
        message: "Free text is not handled yet. Use the on-screen actions.",
      },
    ]);
  });

  // (a) Guard 1. The second call's `intent` double throws if it is ever
  // reached, so a regression that let a duplicate fall through to the
  // classifier fails loudly rather than merely producing extra frames.
  it("drops a duplicate clientMessageId with zero frames, without reaching the classifier", async () => {
    const store = createInMemoryEventStore();
    const campaign = await sceneCampaign(store);
    const firstPorts: TurnPorts = {
      ...portsWith(store),
      intent: classifiedAs({ category: "exploration", targetNodeId: null }),
    };
    await drain(
      handleCommand(
        campaign,
        { type: "free_text", clientMessageId: "c1", text: "look around" },
        firstPorts,
      ),
    );

    const secondPorts: TurnPorts = { ...portsWith(store), intent: unreachableIntent() };
    const frames = await drain(
      handleCommand(
        campaign,
        { type: "free_text", clientMessageId: "c1", text: "look around again" },
        secondPorts,
      ),
    );
    expect(frames).toEqual([]);
  });

  // (d) A classifier adapter failure: the message WAS received
  // (`player_input` is already in the log by the time `classify` runs), but
  // nothing about the scene moves.
  it("appends player_input then an internal_error frame when the classifier fails, and touches nothing else", async () => {
    const store = createInMemoryEventStore();
    const campaign = await sceneCampaign(store);
    const sceneBefore = campaign.state.world.scene;

    const ports: TurnPorts = {
      ...portsWith(store),
      intent: intentFailingWith({ code: "provider_error", message: "the model timed out" }),
    };
    const frames = await drain(
      handleCommand(
        campaign,
        { type: "free_text", clientMessageId: "c1", text: "look around" },
        ports,
      ),
    );

    expect(eventTypesOf(frames)).toEqual(["player_input"]);
    expect(frames.some((each) => each.type === "error" && each.code === "internal_error")).toBe(
      true,
    );
    expect(campaign.state.world.scene).toEqual(sceneBefore);
  });

  // (e) An open edge whose "from" node has a real effect: `guild-offer`
  // shifts ashen-guild/river-wardens from `cold` (the authored baseline) to
  // `hostile` on completion. `sceneNarrative` yields nothing, deliberately —
  // exercising the fallback rung of the same ladder combat narration uses.
  it("traverses an open edge: completes the from-node, applies its delta, enters the target, narrates", async () => {
    const store = createInMemoryEventStore();
    const before: SceneSnapshot = {
      worldId: "emberfall",
      currentNodeId: "guild-offer",
      completedNodeIds: ["arrival"],
      relations: [],
      npcAffinities: [],
      day: 1,
    };
    const campaign = await sceneCampaign(store, before);
    const ports: TurnPorts = {
      ...portsWith(store),
      intent: classifiedAs({ category: "exploration", targetNodeId: "the-weir" }),
      sceneNarrative: scriptedSceneNarrative([]),
    };

    const frames = await drain(
      handleCommand(
        campaign,
        { type: "free_text", clientMessageId: "c1", text: "let's see the weir" },
        ports,
      ),
    );

    expect(eventTypesOf(frames)).toEqual([
      "player_input",
      "intent_classified",
      "quest_node_completed",
      "world_delta_applied",
      "quest_node_entered",
      "narrative_emitted",
    ]);

    // The two payloads the brief specifies field-by-field: `player_input`
    // (the newly-sanctioned Hebrew `text` field, and the actor it came
    // from) and `intent_classified` (the classification, provider/model
    // the fixture stamped, and `INTENT_PROMPT_VERSION` — never
    // `NARRATIVE_PROMPT_VERSION`, since the two are easy to swap and
    // `reduce` validates neither payload, so nothing else here would catch
    // it).
    const eventOfType = (type: string): Extract<ServerFrame, { type: "event" }> | undefined =>
      frames.find(
        (each): each is Extract<ServerFrame, { type: "event" }> =>
          each.type === "event" && each.event.type === type,
      );

    expect(eventOfType("player_input")?.event.payload).toMatchObject({
      actorId: heroSceneStatics().character.characterId,
      text: "let's see the weir",
    });
    expect(eventOfType("intent_classified")?.event.payload).toMatchObject({
      classification: { category: "exploration", targetNodeId: "the-weir" },
      provider: "test-provider",
      modelId: "test-model",
      promptVersion: INTENT_PROMPT_VERSION,
    });

    const deltaEvent = eventOfType("world_delta_applied");
    expect(deltaEvent?.event.payload).toMatchObject({
      relations: [{ factionA: "ashen-guild", factionB: "river-wardens", band: "hostile" }],
    });

    const { tokens, emitted } = narrativeOf(frames);
    expect(emitted.text).toBe(tokens.join(""));
    expect(emitted.source).toBe("deterministic");
    expect(emitted.promptVersion).toBe(SCENE_PROMPT_VERSION);

    // The engine's own computation, independently reached — not re-derived
    // from the payload above — is the oracle `campaign.state.world.scene`
    // is checked against. `snapshotOf` emits sorted arrays; `reduce` appends
    // in event order, so both sides are sorted before comparing (Task 4's
    // round-trip test does the same).
    const expected = snapshotOf(
      stateOf(traverseEdge(loadWorld(), sceneStateFrom(before), "the-weir")),
      "emberfall",
    );
    const { scene } = campaign.state.world;
    expect(scene).not.toBeNull();
    if (scene === null) throw new Error("unreachable — asserted above");
    expect(sortedSnapshot(scene)).toEqual(sortedSnapshot(expected));
  });

  // Coordinator ruling on Task 9's review, finding 3: this turn's scene
  // group (`quest_node_completed` + `world_delta_applied` +
  // `quest_node_entered`) must land in ONE `store.append` call, not three —
  // `EventStore.append`'s own contract ("Atomic over the batch... either
  // all of them land or none", `packages/memory/src/event-store/port.ts`)
  // is what closes the half-applied-traversal hazard, and this is what
  // proves the pipeline actually spends that atomicity on the group rather
  // than three single-event appends that could fail between each other.
  it("appends the scene-event group as one atomic append, not one per event", async () => {
    const store = createInMemoryEventStore();
    const before: SceneSnapshot = {
      worldId: "emberfall",
      currentNodeId: "guild-offer",
      completedNodeIds: ["arrival"],
      relations: [],
      npcAffinities: [],
      day: 1,
    };
    const campaign = await sceneCampaign(store, before);
    const appendBatchSizes: number[] = [];
    const counting: EventStore = {
      ...store,
      append: (campaignId, events) => {
        appendBatchSizes.push(events.length);
        return store.append(campaignId, events);
      },
    };
    const ports: TurnPorts = {
      ...portsWith(counting),
      intent: classifiedAs({ category: "exploration", targetNodeId: "the-weir" }),
    };

    await drain(
      handleCommand(
        campaign,
        { type: "free_text", clientMessageId: "c1", text: "let's see the weir" },
        ports,
      ),
    );

    // player_input, intent_classified, the 3-event scene group, narrative_emitted.
    expect(appendBatchSizes).toEqual([1, 1, 3, 1]);
  });

  // (f) A closed edge: `reckoning` requires the faction relation to be no
  // worse than `hostile`, and this fixture starts it at `war`. Refusal is
  // narration only — no quest/delta event, and `world.scene` is untouched.
  // Reached from `saboteurs`, §4.7 step 5's node — the one edge to
  // `reckoning` in the shipped arc — rather than from `the-weir` directly,
  // since `the-weir` no longer has an edge to `reckoning` at all.
  it("refuses a closed edge with narration only, leaving the scene untouched", async () => {
    const store = createInMemoryEventStore();
    const before: SceneSnapshot = {
      worldId: "emberfall",
      currentNodeId: "saboteurs",
      completedNodeIds: ["arrival", "guild-offer", "the-weir"],
      relations: [{ factionA: "ashen-guild", factionB: "river-wardens", band: "war" }],
      npcAffinities: [],
      day: 1,
    };
    const campaign = await sceneCampaign(store, before);
    const ports: TurnPorts = {
      ...portsWith(store),
      intent: classifiedAs({ category: "exploration", targetNodeId: "reckoning" }),
    };

    const frames = await drain(
      handleCommand(
        campaign,
        { type: "free_text", clientMessageId: "c1", text: "put them in one room" },
        ports,
      ),
    );

    expect(eventTypesOf(frames)).toEqual(["player_input", "intent_classified", "narrative_emitted"]);
    expect(campaign.state.world.scene).toEqual(before);
  });

  // Coordinator ruling on Task 9's review, finding 2: `targetNodeId: null`
  // means "conclude the current node" (Decision 1) — the hook a TERMINAL
  // node needs — never "no edge matched". `guild-offer` has one edge (to
  // `the-weir`) and a real effect; a model reading its own prompt's old
  // "or null if none of the edges clearly match" wording could propose
  // `null` here for an utterance that requested no movement at all. This
  // must refuse exactly like a bad edge id: no quest/delta event, and
  // `world.scene` untouched — completing this node would shift a faction
  // band the player never asked to move, and `completed()`'s own
  // idempotency means no later turn could ever re-apply it.
  it("refuses targetNodeId: null on a non-terminal node instead of completing it", async () => {
    const store = createInMemoryEventStore();
    const before: SceneSnapshot = {
      worldId: "emberfall",
      currentNodeId: "guild-offer",
      completedNodeIds: ["arrival"],
      relations: [],
      npcAffinities: [],
      day: 1,
    };
    const campaign = await sceneCampaign(store, before);
    const ports: TurnPorts = {
      ...portsWith(store),
      intent: classifiedAs({ category: "exploration", targetNodeId: null }),
    };

    const frames = await drain(
      handleCommand(
        campaign,
        { type: "free_text", clientMessageId: "c1", text: "I look at the sky" },
        ports,
      ),
    );

    expect(eventTypesOf(frames)).toEqual(["player_input", "intent_classified", "narrative_emitted"]);
    expect(campaign.state.world.scene).toEqual(before);
  });

  // (g)/(h): a terminal node completed in place. `reckoning` has no edges,
  // so `targetNodeId: null` runs `completeCurrentNode`, not `traverseEdge`.
  it("completes a terminal node with no traversal: quest_node_completed, world_delta_applied, no quest_node_entered", async () => {
    const store = createInMemoryEventStore();
    const before: SceneSnapshot = {
      worldId: "emberfall",
      currentNodeId: "reckoning",
      completedNodeIds: ["arrival", "guild-offer", "the-weir"],
      relations: [{ factionA: "ashen-guild", factionB: "river-wardens", band: "hostile" }],
      npcAffinities: [],
      day: 1,
    };
    const campaign = await sceneCampaign(store, before);
    const ports: TurnPorts = {
      ...portsWith(store),
      intent: classifiedAs({ category: "exploration", targetNodeId: null }),
    };

    const frames = await drain(
      handleCommand(
        campaign,
        { type: "free_text", clientMessageId: "c1", text: "let's settle this" },
        ports,
      ),
    );

    expect(eventTypesOf(frames)).toEqual([
      "player_input",
      "intent_classified",
      "quest_node_completed",
      "world_delta_applied",
      "narrative_emitted",
    ]);
  });

  // Whole-branch review finding 2: `completeCurrentNode` with no traversal
  // is not an arrival — the player never moved. Narrating it as `arrived`
  // would tell the player they just reached a place they were already
  // standing in. Asserted on the actual `SceneBeat` the pipeline builds,
  // not just the event list, which is identical for both beat kinds.
  it("narrates a terminal node completed in place as concluded, not arrived", async () => {
    const store = createInMemoryEventStore();
    const before: SceneSnapshot = {
      worldId: "emberfall",
      currentNodeId: "reckoning",
      completedNodeIds: ["arrival", "guild-offer", "the-weir"],
      relations: [{ factionA: "ashen-guild", factionB: "river-wardens", band: "hostile" }],
      npcAffinities: [],
      day: 1,
    };
    const campaign = await sceneCampaign(store, before);
    const seen: SceneNarrationInput[] = [];
    const ports: TurnPorts = {
      ...portsWith(store),
      intent: classifiedAs({ category: "exploration", targetNodeId: null }),
      sceneNarrative: recordingSceneNarrative(seen),
    };

    await drain(
      handleCommand(
        campaign,
        { type: "free_text", clientMessageId: "c1", text: "let's settle this" },
        ports,
      ),
    );

    expect(seen.map((each) => each.beat)).toEqual([{ kind: "concluded", locationNameHebrew: "אמברפול" }]);
  });

  it("does not re-apply a world delta when re-completing an already-completed node", async () => {
    const store = createInMemoryEventStore();
    const before: SceneSnapshot = {
      worldId: "emberfall",
      currentNodeId: "reckoning",
      completedNodeIds: ["arrival", "guild-offer", "the-weir"],
      relations: [{ factionA: "ashen-guild", factionB: "river-wardens", band: "hostile" }],
      npcAffinities: [],
      day: 1,
    };
    const campaign = await sceneCampaign(store, before);
    const ports: TurnPorts = {
      ...portsWith(store),
      intent: classifiedAs({ category: "exploration", targetNodeId: null }),
    };

    await drain(
      handleCommand(
        campaign,
        { type: "free_text", clientMessageId: "c1", text: "let's settle this" },
        ports,
      ),
    );

    const frames = await drain(
      handleCommand(
        campaign,
        { type: "free_text", clientMessageId: "c2", text: "let's settle this again" },
        ports,
      ),
    );

    // The exact list, not merely "missing world_delta_applied": a
    // `free_text` implementation that refused everything (or one that
    // dropped this second call entirely) would also produce no
    // `world_delta_applied` and vacuously pass a weaker assertion.
    // `quest_node_completed` still fires — `reduce`'s fold of a repeat is
    // idempotent (Decision 4) — only `world_delta_applied` is suppressed,
    // since `completeCurrentNode` on an already-completed node returns the
    // SAME `SceneState`, unchanged, and `diffScene` of a state against
    // itself is empty.
    expect(eventTypesOf(frames)).toEqual([
      "player_input",
      "intent_classified",
      "quest_node_completed",
      "narrative_emitted",
    ]);
  });
});

/** Locates one `event` frame of the given `type`, or throws — every test
 *  below needs exactly one and a missing one is a broken fixture, not a
 *  legitimate "not found" case. */
function eventFrameOf(
  frames: readonly ServerFrame[],
  type: string,
): Extract<ServerFrame, { type: "event" }> {
  const found = frames.find(
    (each): each is Extract<ServerFrame, { type: "event" }> =>
      each.type === "event" && each.event.type === type,
  );
  if (found === undefined) throw new Error(`no "${type}" event frame`);
  return found;
}

describe("handleCommand — free text: check category", () => {
  // (a) Determinism is the assertion: the payload's `naturalRoll`/`total`/
  // `success` are checked against `abilityCheck` called in the test with the
  // SAME seeded rng, not against a hardcoded die value — the die value is an
  // implementation detail of `seeded`/`abilityCheck`, the reproducibility is
  // the contract.
  it("rolls a named skill check off the seeded rng, at the DC the difficulty names, with the skill's own modifier", async () => {
    const store = createInMemoryEventStore();
    const campaign = await sceneCampaign(store);
    const ports: TurnPorts = {
      ...portsWith(store),
      intent: classifiedAs({
        category: "check",
        ability: "str",
        skill: "athletics",
        difficulty: "medium",
      }),
      skillAbilities: skillAbilities(),
    };

    const frames = await drain(
      handleCommand(
        campaign,
        { type: "free_text", clientMessageId: "c1", text: "I try to climb the ridge" },
        ports,
      ),
    );

    expect(eventTypesOf(frames)).toEqual([
      "player_input",
      "intent_classified",
      "check_rolled",
      "narrative_emitted",
    ]);

    const payload = CheckRolledPayload.parse(eventFrameOf(frames, "check_rolled").event.payload);
    const hero = loadCharacter("hero");
    // `DerivedCharacter.skills` is a `Partial<Record<Skill, number>>` at the
    // type level (see `pipeline.ts`'s `checkModifierFor`); the fixture is
    // known to fill every skill, so a miss here is a broken fixture, not a
    // legitimate "no modifier" case.
    const athleticsModifier = hero.skills.athletics;
    if (athleticsModifier === undefined) throw new Error("fixture: hero has no athletics skill");

    expect(payload.dc).toBe(DC_BY_DIFFICULTY.medium);
    expect(payload.modifier).toBe(athleticsModifier);

    // `sequence-of-check_rolled`: a scene-only campaign's genesis is ONE
    // event (sequence 0, `campaign_started` — no board to open), so this
    // turn's own player_input/intent_classified/check_rolled land at
    // 1/2/3 — the same `campaign.nextSequence` `pipeline.ts` reads right
    // before computing this event's seed.
    const expectedSeed = 42 * 1000 + 3;
    expect(payload.seed).toBe(expectedSeed);

    const expected = abilityCheck(
      { abilityScore: 10, situationalBonus: athleticsModifier, dc: DC_BY_DIFFICULTY.medium },
      seeded(expectedSeed),
    );
    expect(payload.naturalRoll).toBe(expected.naturalRoll);
    expect(payload.total).toBe(expected.total);
    expect(payload.success).toBe(expected.success);
  });

  // (b) No skill named: the modifier comes from `abilityModifiers[ability]`
  // rather than any skill entry.
  it("uses abilityModifiers[ability] for a skill-less check", async () => {
    const store = createInMemoryEventStore();
    const campaign = await sceneCampaign(store);
    const ports: TurnPorts = {
      ...portsWith(store),
      intent: classifiedAs({ category: "check", ability: "wis", difficulty: "easy" }),
    };

    const frames = await drain(
      handleCommand(
        campaign,
        { type: "free_text", clientMessageId: "c1", text: "I listen at the door" },
        ports,
      ),
    );

    const payload = CheckRolledPayload.parse(eventFrameOf(frames, "check_rolled").event.payload);
    expect(payload.skill).toBeUndefined();
    expect(payload.ability).toBe("wis");
    expect(payload.modifier).toBe(loadCharacter("hero").abilityModifiers.wis);
  });

  // (c) The model chooses a word; the engine owns every number (design spec
  // Decision 5): once a skill is named, the payload's `ability` is the SRD
  // mapping's (`skillAbilities`, "athletics" -> "str"), even though this
  // fixture's mocked classifier proposes the mismatched "int".
  it("uses the SRD skill-to-ability mapping, not the model's mismatched ability, when a skill is named", async () => {
    const store = createInMemoryEventStore();
    const campaign = await sceneCampaign(store);
    const ports: TurnPorts = {
      ...portsWith(store),
      intent: classifiedAs({
        category: "check",
        ability: "int",
        skill: "athletics",
        difficulty: "medium",
      }),
      skillAbilities: skillAbilities(),
    };

    const frames = await drain(
      handleCommand(
        campaign,
        { type: "free_text", clientMessageId: "c1", text: "I try to climb the ridge" },
        ports,
      ),
    );

    const payload = CheckRolledPayload.parse(eventFrameOf(frames, "check_rolled").event.payload);
    expect(payload.ability).toBe("str");
    expect(payload.modifier).toBe(loadCharacter("hero").skills.athletics);
  });

  // (d) No state change from a check (design spec Non-goals: a check informs
  // narration and the log, it does not gate traversal).
  it("leaves the scene untouched", async () => {
    const store = createInMemoryEventStore();
    const campaign = await sceneCampaign(store);
    const sceneBefore = campaign.state.world.scene;
    const ports: TurnPorts = {
      ...portsWith(store),
      intent: classifiedAs({ category: "check", ability: "str", difficulty: "medium" }),
    };

    await drain(
      handleCommand(
        campaign,
        { type: "free_text", clientMessageId: "c1", text: "I try to force the door" },
        ports,
      ),
    );

    expect(campaign.state.world.scene).toEqual(sceneBefore);
  });
});

describe("handleCommand — free text: narrate-only categories", () => {
  it.each(["social", "ooc"] as const)(
    "routes %s to player_input + intent_classified + narration, and nothing else",
    async (category) => {
      const store = createInMemoryEventStore();
      const campaign = await sceneCampaign(store);
      const ports: TurnPorts = { ...portsWith(store), intent: classifiedAs({ category }) };

      const frames = await drain(
        handleCommand(
          campaign,
          { type: "free_text", clientMessageId: "c1", text: "hello there" },
          ports,
        ),
      );

      expect(eventTypesOf(frames)).toEqual(["player_input", "intent_classified", "narrative_emitted"]);
    },
  );

  it("routes combat to a grounded reply beat rather than starting a fight, narration only", async () => {
    const store = createInMemoryEventStore();
    const campaign = await sceneCampaign(store);
    const seen: SceneNarrationInput[] = [];
    const ports: TurnPorts = {
      ...portsWith(store),
      intent: classifiedAs({ category: "combat" }),
      sceneNarrative: recordingSceneNarrative(seen),
    };

    const frames = await drain(
      handleCommand(
        campaign,
        { type: "free_text", clientMessageId: "c1", text: "I draw my sword" },
        ports,
      ),
    );

    expect(eventTypesOf(frames)).toEqual(["player_input", "intent_classified", "narrative_emitted"]);
    expect(seen.map((each) => each.beat)).toEqual([{ kind: "reply", category: "combat" }]);
  });
});

// Invariant 4 ("schemas define everything once") only holds if these `.parse`
// calls actually reject a bad payload rather than being decoration around an
// object literal that was already correct by construction. Each test here
// injects a shape that could only ever reach the pipeline through a port
// (the classifier, or the SRD skill/ability data) — never through normal,
// correctly-typed control flow — which is exactly why the schema, not the
// type system, has to be the thing that catches it.
describe("handleCommand — free text: schema parsing at emit sites", () => {
  it("rejects an exploration classification whose targetNodeId isn't a valid ContentId, via IntentClassifiedPayload", async () => {
    const store = createInMemoryEventStore();
    const campaign = await sceneCampaign(store);
    // Structurally a valid "exploration" classification — it reaches the
    // "exploration" case, not `assertNever` — but `targetNodeId` fails
    // `ContentId`'s regex (lowercase kebab-case only). No real classifier
    // can produce this (Decision 5: `generateStructured` already
    // schema-validates), so this stands in for the port contract being
    // violated some other way. Deliberately NOT a bad `category`: every
    // category outside the five real ones falls through to `assertNever`
    // and throws regardless of whether `.parse` runs, which would prove
    // nothing about the parse specifically. And if this reached
    // `traverseEdge` unchecked, it would just be "no such edge" — a
    // graceful, narrated refusal, not a throw — which is what confirms the
    // throw here comes from `.parse`, not from engine validation downstream.
    const bogus: IntentClassification = {
      category: "exploration",
      targetNodeId: "NOT-A-VALID-ID!!",
    };
    const ports: TurnPorts = { ...portsWith(store), intent: classifiedAs(bogus) };

    await expect(
      drain(handleCommand(campaign, { type: "free_text", clientMessageId: "c1", text: "hello" }, ports)),
    ).rejects.toThrow();
  });

  it("rejects a check whose resolved ability isn't a real AbilityKey, via CheckRolledPayload", async () => {
    const store = createInMemoryEventStore();
    const campaign = await sceneCampaign(store);
    // The classification itself is entirely valid — it passes
    // `IntentClassifiedPayload.parse` cleanly — so this pins `.parse` at the
    // check_rolled site specifically, not a repeat of the test above. The
    // bad value enters through `skillAbilities` (a port this file fully
    // controls), which `checkAbilityFor` trusts for a named skill's
    // governing ability — the one field `CheckRolledPayload` sees that
    // never passed through `IntentClassification`'s own `AbilityKey` check.
    const ports: TurnPorts = {
      ...portsWith(store),
      intent: classifiedAs({
        category: "check",
        ability: "str",
        skill: "athletics",
        difficulty: "medium",
      }),
      skillAbilities: new Map([["athletics", "made-up-ability" as AbilityKey]]),
    };

    await expect(
      drain(
        handleCommand(
          campaign,
          { type: "free_text", clientMessageId: "c1", text: "I try to climb the ridge" },
          ports,
        ),
      ),
    ).rejects.toThrow();
  });
});

describe("handleCommand — structured action", () => {
  it("refuses an action from someone whose turn it is not", async () => {
    const store = createInMemoryEventStore();
    const campaign = await freshCampaign(store);
    const frames = await drain(handleCommand(campaign, dodge("goblin-a"), portsWith(store)));
    expect(frames[0]).toMatchObject({ type: "error", code: "not_your_turn" });
  });

  // The full, exact appended type sequence for a successful turn — not just
  // a `slice(0, 4)` prefix. Both `clock`/`uuid`/`seedFor` are fixed by
  // `portsWith`, so nothing about a successful dodge is nondeterministic;
  // there is no excuse for a weaker assertion here.
  //
  // A "successful turn" cascades — the hero's own six events are immediately
  // followed by the hostile sweep (`runEnemyTurns`), so the exact sequence is
  // hero's six plus five each for goblin-a and goblin-b (no `player_input`;
  // only a human client sends that). The assertion covers the whole cascade
  // rather than the hero's own prefix.
  it("appends the exact event type sequence for a successful turn", async () => {
    const store = createInMemoryEventStore();
    const campaign = await freshCampaign(store);
    await drain(handleCommand(campaign, dodge("hero"), portsWith(store)));
    const types = (await store.readSince("s1", GENESIS_SEQUENCE)).map((each) => each.type);
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
    const validated = (await store.readSince("s1", GENESIS_SEQUENCE)).filter(
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
    const campaign = await freshCampaign(store);
    const frames = await drain(handleCommand(campaign, dodge("hero"), portsWith(store)));
    const appended = await store.readSince("s1", GENESIS_SEQUENCE);
    const framedEvents = frames.filter((each) => each.type === "event").map((each) => each.event);
    expect(framedEvents).toEqual(appended);
  });

  it("records the dice seed in the event so replay does not re-derive it", async () => {
    const store = createInMemoryEventStore();
    const campaign = await freshCampaign(store);
    await drain(handleCommand(campaign, dodge("hero"), portsWith(store)));
    const rolled = (await store.readSince("s1", GENESIS_SEQUENCE)).find(
      (each) => each.type === "dice_rolled",
    );
    expect(rolled?.payload).toMatchObject({ seed: expect.any(Number) as number });
  });

  it("records movedFeet on the dice_rolled event for a turn that moved", async () => {
    const store = createInMemoryEventStore();
    const campaign = await freshCampaign(store);
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

    await drain(handleCommand(campaign, moveAndDodge, portsWith(store)));
    const rolled = (await store.readSince("s1", GENESIS_SEQUENCE)).find(
      (each) => each.type === "dice_rolled",
    );
    expect(rolled?.payload).toMatchObject({ movedFeet: 10 });
    // The real wire payload, not a hand-built fixture: proves DiceRolledPayload
    // actually describes what the server emits, not just what a test expects.
    expect(DiceRolledPayload.safeParse(rolled?.payload).success).toBe(true);
  });

  it("records movedFeet: 0 on a dice_rolled event for a turn with no movement", async () => {
    const store = createInMemoryEventStore();
    const campaign = await freshCampaign(store);
    await drain(handleCommand(campaign, dodge("hero"), portsWith(store)));
    const rolled = (await store.readSince("s1", GENESIS_SEQUENCE)).find(
      (each) => each.type === "dice_rolled",
    );
    expect(rolled?.payload).toMatchObject({ movedFeet: 0 });
  });

  it("streams narrative tokens and closes with narrative_emitted", async () => {
    const store = createInMemoryEventStore();
    const campaign = await freshCampaign(store);
    const frames = await drain(handleCommand(campaign, dodge("hero"), portsWith(store)));
    expect(frames.some((each) => each.type === "narrative_token")).toBe(true);
    const types = (await store.readSince("s1", GENESIS_SEQUENCE)).map((each) => each.type);
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
  // One hero dodge yields three `narrative_emitted` events (the
  // hero's own, then each hostile's), each with its own `streamId`. The
  // guarantee is per-stream, so this checks every one of them against only
  // its own `narrative_token` frames rather than the whole turn's tokens.
  it("narrative_emitted carries exactly the concatenation of its streamed tokens", async () => {
    const store = createInMemoryEventStore();
    const campaign = await freshCampaign(store);
    const frames = await drain(handleCommand(campaign, dodge("hero"), portsWith(store)));
    const emitted = (await store.readSince("s1", GENESIS_SEQUENCE)).filter(
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
    const campaign = await freshCampaign(store);
    await drain(handleCommand(campaign, dodge("hero"), portsWith(store)));
    const afterFirst = (await store.readSince("s1", GENESIS_SEQUENCE)).length;

    const frames = await drain(handleCommand(campaign, dodge("hero"), portsWith(store)));
    expect(frames).toEqual([]);
    expect((await store.readSince("s1", GENESIS_SEQUENCE)).length).toBe(afterFirst);
  });

  // `goblin-ambush` spawns the goblins within melee reach of the hero, so the
  // encounter is actually fightable and an "attack goblin-a" turn is LEGAL
  // there — it cannot stand in for an illegal one. This uses a movement
  // segment to an off-grid tile instead: illegal on any geometry, whatever
  // the encounter's spawn distances become.
  it("rejects an illegal turn without advancing the turn", async () => {
    const store = createInMemoryEventStore();
    const campaign = await freshCampaign(store);
    const before = encounterOf(campaign).currentActorIndex;
    const frames = await drain(
      handleCommand(
        campaign,
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
    // an off-grid tile is illegal on any geometry, so a later change to
    // `goblin-ambush`'s spawn distances cannot silently un-break this test by
    // making the proposed turn legal again.
    expect(rejected.reasons).toEqual(["destination_off_grid"]);
    expect(encounterOf(campaign).currentActorIndex).toBe(before);
    const types = (await store.readSince("s1", GENESIS_SEQUENCE)).map((each) => each.type);
    expect(types).toContain("action_rejected");
  });

  // The bracket refusal (spec §Wiring). Reachable in production today: a
  // `POST /campaigns {worldId}` scene campaign (Task 8) comes back with
  // `encounter === null`, and nothing in this case gates on campaign kind
  // before the check below, so a hand-crafted `structured_action` reaches
  // it. The shipped web client can't send one out of combat (Task 11 keeps
  // `Grid`/`ActionBar` out of the exploration view), so the guard's real job
  // today is refusing that message, not being dead code. `resolveEncounter`
  // — the other way a bracket could close and leave one open-ended — still
  // has no production caller anywhere in the tree (grep-verified).
  // `encounterlessCampaign` below is just the deterministic shortcut to the
  // same state; this pins the guard itself: a `structured_action` against a
  // closed/never-opened bracket must refuse cleanly rather than throwing
  // `encounterOf`'s corrupt-log error.
  it("refuses a structured action when no encounter is open, with an error frame", async () => {
    const store = createInMemoryEventStore();
    const campaign = await encounterlessCampaign(store);

    const frames = await drain(handleCommand(campaign, dodge("hero"), portsWith(store)));

    // An existing code, not a new one. `not_your_turn` is already what a
    // player gets for acting after a fight has ended
    // (`packages/schemas/src/conclusion.ts`) and the client already treats
    // it as a stale click it must not
    // surface (`ErrorBanner.tsx`) — which is exactly right here, since a
    // campaign with no board pushes no affordances to click in the first
    // place.
    expect(frames).toEqual([
      {
        type: "error",
        clientMessageId: "c1",
        code: "not_your_turn",
        message: expect.any(String) as string,
      },
    ]);
    // Refused, not half-applied: nothing appended and no trailing
    // affordance frame, because there is no board to offer one on. Read
    // from 0 rather than `GENESIS_SEQUENCE` — this campaign's genesis is the
    // single `campaign_started` event, with no `encounter_started` after it.
    expect(await store.readSince("s1", 0)).toEqual([]);
    expect(campaign.nextSequence).toBe(1);
  });

  // The store throws two error classes on a bad append, neither with a
  // dedicated ServerErrorCode — both must fold onto internal_error. Simulated
  // by pre-occupying the sequence the turn's own player_input event would
  // take, the way a concurrent writer on the same campaign would.
  it("turns a SequenceConflictError from the store into an internal_error frame", async () => {
    const store = createInMemoryEventStore();
    const campaign = await freshCampaign(store);
    await store.append("s1", [syntheticEvent(GENESIS_SEQUENCE + 1)]);

    const frames = await drain(handleCommand(campaign, dodge("hero"), portsWith(store)));

    // The error frame first, then a fresh affordance set. A failed append
    // does not advance the turn, so control is still the hero's, and the
    // client has already nulled its affordances against the frames `emit`
    // streamed before the throw — without the trailing frame the board goes
    // inert on the player's own turn — the inert-board soft-lock, by a
    // rarer route.
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
    expect(campaign.nextSequence).toBe(GENESIS_SEQUENCE + 1);
    expect((await store.readSince("s1", GENESIS_SEQUENCE)).map((each) => each.sequence)).toEqual([
      GENESIS_SEQUENCE + 1,
    ]);
  });

  // The third class, new with a durable store: a dropped connection, a lock
  // or statement timeout, a deadlock, or a stored row that no longer parses.
  // Unhandled it reaches ws.ts's catch-all, which sends internal_error and
  // restores nothing — the same inert-board soft-lock by a third route.
  it("turns an EventStoreUnavailableError from the store into an internal_error frame", async () => {
    const store = createInMemoryEventStore();
    const campaign = await freshCampaign(store);
    const failing: EventStore = {
      ...store,
      append: () => Promise.reject(new EventStoreUnavailableError("append", new Error("boom"))),
    };

    const frames = await drain(handleCommand(campaign, dodge("hero"), portsWith(failing)));

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
    // nextSequence.
    expect(campaign.nextSequence).toBe(GENESIS_SEQUENCE + 1);
  });
});

describe("handleCommand — snapshot cadence", () => {
  // `SNAPSHOT_EVERY`'s only production use is inside `emit`; the
  // resumeFrom-predates-the-log test above writes its snapshot by hand via
  // `store.putSnapshot` and proves
  // nothing about the pipeline actually calling it. Fast-forward the
  // campaign's own sequence counter so the hero's dodge turn's six events
  // land on 45..50 and the last one crosses the boundary.
  // `EventStore.append`'s only invariant is "no duplicate sequence for this
  // campaign" (`@ai-dm/memory`'s conformance suite, `event-store/contract.ts`)
  // — it does not require a contiguous log — so this is a legitimate way to
  // reach the boundary without a 44-turn setup.
  //
  // The hero's turn is immediately followed by the hostile sweep, which
  // keeps advancing `campaign.state` past sequence 50
  // within this same `handleCommand` call — by the time `drain` resolves,
  // `campaign.state` reflects the whole cascade, not just the moment the
  // snapshot was taken. So the expected state is captured live, the instant
  // the sequence-50 event frame is seen, rather than read back off
  // `campaign.state` afterwards. `reduce` never mutates in place
  // (`campaign.ts`'s doc comment), so that captured reference stays exactly
  // what it was at sequence 50 even as later turns replace `campaign.state`
  // with newer objects.
  it("writes a snapshot via the store once the running sequence crosses SNAPSHOT_EVERY", async () => {
    const store = createInMemoryEventStore();
    const campaign = await freshCampaign(store);
    campaign.nextSequence = SNAPSHOT_EVERY - 5;

    expect(await store.latestSnapshot("s1")).toBeNull();

    let stateAtSnapshot: CampaignState | undefined;
    for await (const frame of handleCommand(campaign, dodge("hero"), portsWith(store))) {
      if (frame.type === "event" && frame.event.sequence === SNAPSHOT_EVERY) {
        stateAtSnapshot = campaign.state;
      }
    }

    const snapshot = await store.latestSnapshot("s1");
    expect(snapshot).toEqual({ sequence: SNAPSHOT_EVERY, state: stateAtSnapshot });
  });

  // The sibling of the two `internal_error` cases above, and the reason they
  // are not enough: the in-memory store's `putSnapshot` can never reject, so
  // until there was a Postgres one this `await` sat inside the turn's `try`
  // harmlessly. A transient database error on the snapshot write must not
  // end a turn whose events are already committed — if the crossing event is
  // the closing `scene_changed`, control has already passed to a hostile,
  // `playerAffordances()` returns silently, and the client is left with an
  // `internal_error` and an inert board that a rejoin cannot repair.
  it("completes the turn when the snapshot write fails", async () => {
    const store = createInMemoryEventStore();
    const campaign = await freshCampaign(store);
    // Same fast-forward as the case above: the hero's six events land on
    // 45..50 and the last one crosses the boundary, so `putSnapshot` is
    // reached exactly once.
    campaign.nextSequence = SNAPSHOT_EVERY - 5;
    const failures: SnapshotFailureRecord[] = [];
    const failing: EventStore = {
      ...store,
      putSnapshot: () =>
        Promise.reject(new EventStoreUnavailableError("putSnapshot", new Error("boom"))),
    };
    const ports: TurnPorts = {
      ...portsWith(failing),
      metrics: {
        recordTacticalTurn: () => undefined,
        recordNarrativeTurn: () => undefined,
        recordSnapshotFailure(record) {
          failures.push(record);
        },
      },
    };

    const frames = await drain(handleCommand(campaign, dodge("hero"), ports));

    // No error frame at all — a cache write may not end a turn.
    expect(frames.filter((each) => each.type === "error")).toEqual([]);
    // And the turn ran all the way through the hostile sweep back to the
    // player, which is what a soft-locked board would not do.
    const last = frames.at(-1);
    expect(last?.type).toBe("turn_affordances");
    expect(last?.type === "turn_affordances" && last.actorId).toBe("hero");
    expect(encounterOf(campaign).round).toBe(2);
    expect(encounterOf(campaign).currentActorIndex).toBe(0);
    // The log is complete past the crossing event: the append half of the
    // turn never depended on the snapshot half.
    expect((await store.readSince("s1", SNAPSHOT_EVERY - 1)).map((each) => each.sequence)).toContain(
      SNAPSHOT_EVERY,
    );
    // Contained, not swallowed: the operator still learns the store rejected
    // a write, exactly once, for the sequence that failed.
    expect(failures.map((each) => each.sequence)).toEqual([SNAPSHOT_EVERY]);
    expect(failures[0]?.error).toBeInstanceOf(EventStoreUnavailableError);
  });
});

describe("handleCommand — enemy turns", () => {
  it("runs every hostile turn before handing control back to the player", async () => {
    const store = createInMemoryEventStore();
    const campaign = await freshCampaign(store);
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

    await drain(handleCommand(campaign, dodge("hero"), ports));

    // Back to the top of the order, one round later.
    expect(encounterOf(campaign).currentActorIndex).toBe(0);
    expect(encounterOf(campaign).round).toBe(2);
    // hero + two goblins each had their proposal validated — and in that
    // exact order. `toHaveLength(3)` alone would still pass if the loop
    // revisited an actor and skipped another: 3 `action_validated`, 3
    // `narrative_emitted`, `currentActorIndex === 0` and `round === 2` are
    // all reachable that way too, since every path emits exactly one
    // `turn_advanced` regardless of which actor it was for.
    const validated = (await store.readSince("s1", GENESIS_SEQUENCE)).filter(
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
    const campaign = await freshCampaign(store);
    const ports: TurnPorts = {
      ...portsWith(store),
      tactical: agentRejectingThenRecovering(),
    };

    await drain(handleCommand(campaign, dodge("hero"), ports));

    const rejected = (await store.readSince("s1", GENESIS_SEQUENCE)).filter(
      (each) => each.type === "action_rejected",
    );
    expect(rejected.length).toBeGreaterThan(0);
    expect(rejected[0]?.payload).toMatchObject({ actorId: "goblin-a", stage: "engine" });
  });

  // This drives a REAL rejection (goblin-a's first proposal is an off-grid
  // move, illegal on any geometry) rather than asserting a bare count of
  // validated turns: in a scenario that produces no rejection at all such a
  // count passes while checking nothing about stamping. It asserts the
  // resulting `action_rejected` payload names the model that actually
  // produced it, read from the routing the ports were configured with
  // rather than a hardcoded literal —
  // `DEFAULT_MODEL_ROUTING.tactical` is a placeholder step 7b's benchmark
  // will change.
  it("stamps action_rejected events with the model that produced them", async () => {
    const store = createInMemoryEventStore();
    const campaign = await freshCampaign(store);
    const ports: TurnPorts = {
      ...portsWith(store),
      tactical: agentRejectingThenRecovering(),
    };

    await drain(handleCommand(campaign, dodge("hero"), ports));

    const rejected = (await store.readSince("s1", GENESIS_SEQUENCE)).filter(
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
    const campaign = await freshCampaign(store);
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
    await drain(handleCommand(campaign, dodge("hero"), ports));
    const narrated = (await store.readSince("s1", GENESIS_SEQUENCE)).filter(
      (each) => each.type === "narrative_emitted",
    );
    expect(narrated).toHaveLength(3);
  });

  // Pins the `combatant.status !== "alive"` skip in `runEnemyTurns`
  // (`pipeline.ts`), previously untested: a dead combatant is passed over
  // with a bare `turn_advanced` rather than asked for a turn.
  it("skips a dead or unconscious combatant instead of asking it for a turn", async () => {
    const store = createInMemoryEventStore();
    const campaign = await freshCampaign(store);
    campaign.state = {
      ...campaign.state,
      encounter: {
        ...encounterOf(campaign),
        combatants: encounterOf(campaign).combatants.map((each) =>
          each.combatantId === "goblin-a" ? { ...each, status: "dead" as const } : each,
        ),
      },
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

    await drain(handleCommand(campaign, dodge("hero"), ports));

    const validated = (await store.readSince("s1", GENESIS_SEQUENCE)).filter(
      (each) => each.type === "action_validated",
    );
    expect(validated.map((each) => each.payload["actorId"])).toEqual(["hero", "goblin-b"]);
    expect(encounterOf(campaign).currentActorIndex).toBe(0);
    expect(encounterOf(campaign).round).toBe(2);
  });

  // Regression for the defect Task 11's replay properties caught: `reduce`
  // never used to reset a combatant's action economy between their own
  // turns, so every combatant's SECOND-EVER action was rejected
  // `action_already_used` — no campaign could ever complete a second round.
  // Every other test in this describe block only ever sends the hero one
  // command (`dodge("hero")`'s hardcoded `clientMessageId: "c1"`), which is
  // exactly why ten tasks and 66 green tests never caught it: nothing here
  // exercised a second round before now. Fixed in `reduce.ts`'s
  // `scene_changed`/`turn_advanced` case.
  it("lets a combatant act again on their second round, not just their first", async () => {
    const store = createInMemoryEventStore();
    const campaign = await freshCampaign(store);
    const ports = portsWith(store);

    await drain(handleCommand(campaign, dodge("hero"), ports));
    expect(encounterOf(campaign).round).toBe(2);
    expect(encounterOf(campaign).currentActorIndex).toBe(0);

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
    const frames = await drain(handleCommand(campaign, roundTwoHeroTurn, ports));

    // Before the fix, this is exactly where the engine answered
    // `action_already_used` and the round never advanced past hero again.
    expect(frames.filter((each) => each.type === "rejected")).toEqual([]);
    expect(encounterOf(campaign).round).toBe(3);
    expect(encounterOf(campaign).currentActorIndex).toBe(0);

    const heroValidations = (await store.readSince("s1", GENESIS_SEQUENCE)).filter(
      (each) => each.type === "action_validated" && each.payload["actorId"] === "hero",
    );
    expect(heroValidations).toHaveLength(2);
  });
});

// The per-turn metrics requirement (`apps/server/CLAUDE.md`: tokens in/out,
// latency, retries, cost "emitted as structured logs from day one") once
// rested entirely on code reading — no test constructed a `TurnPorts` with
// `metrics` and drove a turn through it. A `reduce` that summed
// `promptTokens` into `completionTokens`, or a call site placed on a branch
// that never runs, would have shipped green.
describe("handleCommand — tactical metrics", () => {
  it("records one MetricsPort call per enemy turn, with correct summed token totals", async () => {
    const store = createInMemoryEventStore();
    const campaign = await freshCampaign(store);
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
        // Not under test here — the narrative side has its own describe
        // block below — but `MetricsPort` requires both methods.
        recordNarrativeTurn: () => undefined,
      },
    };

    await drain(handleCommand(campaign, dodge("hero"), ports));

    // One call per enemy turn, in order — and NONE for the hero's own turn,
    // which makes no tactical call at all. A call recorded for "hero" (or
    // simply a length of 3) would mean the port fired on a player turn too;
    // a length of 0 would mean it never fired.
    expect(recorded.map((each) => each.actorId)).toEqual(["goblin-a", "goblin-b"]);

    for (const metrics of recorded) {
      // `agentProposing`'s fixture scripts exactly this `TokenUsage`
      // (`{ promptTokens, completionTokens, totalTokens }`) per billed
      // attempt, and each goblin's proposed dodge is legal on the first try
      // — one billed attempt, zero retries. Distinct
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
    const campaign = await freshCampaign(store);
    const frames = await drain(handleCommand(campaign, dodge("hero"), portsWith(store)));
    expect(frames.some((each) => each.type === "error")).toBe(false);
  });
});

// `onFinish` (the Hebrew agent's own instrumentation, `@ai-dm/agents`) and
// `recordNarrativeTurn` (the pipeline's own, below) are two independent
// sinks fed by two different callers. Collecting both into one shared array
// and asserting with `.some(...)` would stay green even if
// `recordNarrativeTurn` were never called, since `onFinish` firing alone
// would already satisfy the `.some`. These tests keep the two sinks in
// separate arrays and assert on the `recordNarrativeTurn` one specifically,
// so a missing call is the only way to fail them.
describe("handleCommand — narrative metrics", () => {
  const USAGE = { promptTokens: 900, completionTokens: 40, totalTokens: 940 };

  /**
   * Drives one hero dodge with both hostiles already dead — the same
   * fixture the degradation ladder's "feeds each narration into the next
   * turn's window" test (below) uses. Without it, the post-turn enemy sweep
   * would also call `narrative.stream(...)`, and a `createHebrewNarrative`
   * backed by `createFakePort({ stream: [[...]] })` only scripts one such
   * call — a second would throw "Fake port script exhausted" instead of
   * letting the assertions below run. Killing the hostiles keeps every test
   * that uses this fixture to exactly the one narrated turn its "one call"
   * assertions describe, regardless of which `narrative`/`clock` port it is
   * given. Not every test in this describe block uses it: "stamps each
   * narrated turn with its own actorId" below keeps both hostiles alive on
   * purpose, to narrate three turns instead of one.
   */
  async function narratedHeroTurn(overrides: Partial<TurnPorts>): Promise<ServerFrame[]> {
    const store = createInMemoryEventStore();
    const campaign = await freshCampaign(store);
    campaign.state = {
      ...campaign.state,
      encounter: {
        ...encounterOf(campaign),
        combatants: encounterOf(campaign).combatants.map((each) =>
          each.faction === "hostile" ? { ...each, status: "dead" as const } : each,
        ),
      },
    };
    const ports: TurnPorts = { ...portsWith(store), ...overrides };
    return drain(handleCommand(campaign, dodge("hero"), ports));
  }

  it("calls recordNarrativeTurn once per narrated turn, not just onFinish", async () => {
    const finishes: NarrativeFinish[] = [];
    const metricsRecords: NarrativeTurnMetrics[] = [];

    await narratedHeroTurn({
      narrative: createHebrewNarrative({
        runtime: createAgentRuntime({
          routing: DEFAULT_MODEL_ROUTING,
          port: createFakePort({ stream: [[{ type: "finish", text: "", usage: USAGE }]] }),
        }),
        onFinish: (finish) => finishes.push(finish),
      }),
      metrics: {
        recordTacticalTurn: () => undefined,
        recordNarrativeTurn: (record) => metricsRecords.push(record),
      },
    });

    // Proves the double actually ran — if this were 0, the assertion below
    // would be vacuous for the wrong reason (no stream ran at all), rather
    // than because `recordNarrativeTurn` specifically was skipped.
    expect(finishes).toHaveLength(1);
    // The claim that matters: the PIPELINE's own sink fired, once, for the
    // hero's turn. The fake port's script has no text-delta chunks, so the
    // stream yields nothing and `narrate()` (pipeline.ts) falls back to the
    // deterministic rung — hence `source: "deterministic"` here.
    expect(metricsRecords).toEqual([
      {
        actorId: "hero",
        source: "deterministic",
        latencyMs: 0,
        promptVersion: NARRATIVE_PROMPT_VERSION,
      },
    ]);
  });

  it("measures latencyMs from the injected clock, not wall time", async () => {
    // An ADVANCING clock, unlike the fixed one `portsWith` uses everywhere
    // else in this file: every `ports.clock()` call across the whole turn
    // returns a value STEP_MS later than the previous call, whoever makes
    // it. `narrate()`'s own start/end reads (pipeline.ts) are always two
    // CONSECUTIVE clock() calls — nothing else in `narrate()` reads the
    // clock in between — so their difference is exactly STEP_MS no matter
    // how many other emit() calls elsewhere in the turn drew from the same
    // clock first. A fixed clock makes latencyMs 0 under every other test in
    // this file — correct for those, since they hold time still on purpose —
    // but it would also hide a hardcoded or inverted latency computation
    // completely. This is the one test in the file that can catch that.
    const STEP_MS = 250;
    const startMs = Date.parse("2026-08-19T10:00:00.000Z");
    let calls = 0;
    const advancingClock = (): string => {
      const value = new Date(startMs + calls * STEP_MS).toISOString();
      calls += 1;
      return value;
    };

    const metricsRecords: NarrativeTurnMetrics[] = [];
    await narratedHeroTurn({
      clock: advancingClock,
      narrative: scriptedNarrative(["אלדד עומד במקומו."]),
      metrics: {
        recordTacticalTurn: () => undefined,
        recordNarrativeTurn: (record) => metricsRecords.push(record),
      },
    });

    expect(metricsRecords).toHaveLength(1);
    expect(metricsRecords[0]?.latencyMs).toBe(STEP_MS);
  });

  it("stamps each narrated turn with its own actorId, across a full live sequence", async () => {
    // A LIVE encounter — hostiles alive, unlike narratedHeroTurn's fixture
    // above — is required here on purpose: every test above only ever
    // narrates "hero", so `actorId: "hero"` in narrate() (pipeline.ts) is
    // indistinguishable from a hardcoded literal in any of them.
    // `scriptedNarrative` is stateless and re-iterable (each `.stream()`
    // call gets a fresh iterator over the same chunks), unlike
    // `createHebrewNarrative` over `createFakePort`'s single-use queue, so
    // it has no exhaustion problem across the three narrations — hero, then
    // both hostiles — a successful hero turn cascades into.
    const store = createInMemoryEventStore();
    const campaign = await freshCampaign(store);
    const metricsRecords: NarrativeTurnMetrics[] = [];
    const ports: TurnPorts = {
      ...portsWith(store),
      narrative: scriptedNarrative(["אלדד עומד במקומו."]),
      metrics: {
        recordTacticalTurn: () => undefined,
        recordNarrativeTurn: (record) => metricsRecords.push(record),
      },
    };

    await drain(handleCommand(campaign, dodge("hero"), ports));

    // goblin-ambush's own turnOrder (encounters/index.ts) is exactly hero,
    // goblin-a, goblin-b, and `defaultTactical` (this file) has both goblins
    // dodge legally on the first try, so one hero dodge narrates all three
    // in that order. Mirrors the tactical-metrics describe block's own
    // `recorded.map((each) => each.actorId)` guard above — the narrative
    // sink had no equivalent of it before this test, so a later refactor
    // that stamped the campaign's active combatant instead of narrate()'s
    // own `actorId` parameter would have shipped silently.
    expect(metricsRecords.map((each) => each.actorId)).toEqual(["hero", "goblin-a", "goblin-b"]);
  });
});

describe("handleCommand — turn timeout", () => {
  it("falls back to terse narration when the narrative stream hangs", async () => {
    const store = createInMemoryEventStore();
    const campaign = await freshCampaign(store);
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

    const frames = await drain(handleCommand(campaign, dodge("hero"), ports));

    // The turn completed rather than hanging, and it still produced prose.
    const emitted = (await store.readSince("s1", GENESIS_SEQUENCE)).filter(
      (each) => each.type === "narrative_emitted",
    );
    expect(emitted.length).toBeGreaterThan(0);
    // The stream never yielded a single chunk before the 50ms cap fired, so
    // this is the "nothing arrived at all" rung of the ladder: the full
    // Hebrew deterministic renderer, keyed off `buildNarrationBrief`'s own
    // output for the hero's turn (a Dodge -> the "other-action" beat) rather
    // than the old English `actorName` shape this test used to pin.
    expect(emitted[0]?.payload).toMatchObject({
      text: "אלדד נוקט פעולה.",
      source: "deterministic",
    });
    expect(frames.some((each) => each.type === "event")).toBe(true);
  }, 10_000);

  it("still advances the turn after a narrative timeout", async () => {
    const store = createInMemoryEventStore();
    const campaign = await freshCampaign(store);
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
    await drain(handleCommand(campaign, dodge("hero"), ports));
    expect(encounterOf(campaign).round).toBe(2);
  }, 10_000);

  // Previously untested: both timeout tests above stall only the narrative
  // port, so the tactical `AbortController` at `enemyTurn`'s `:187-189` and
  // the "creature forfeits its turn rather than the pipeline stalling"
  // branch it feeds (`:210-215`) had no coverage — the exact resilience
  // behaviour the 10s cap exists to provide.
  it("aborts a stalled tactical proposal and forfeits that creature's turn", async () => {
    const store = createInMemoryEventStore();
    const campaign = await freshCampaign(store);
    const ports: TurnPorts = {
      ...portsWith(store),
      tactical: abortingTactical(),
      turnTimeoutMs: 50,
    };

    await drain(handleCommand(campaign, dodge("hero"), ports));

    // hero's own turn (no tactical call involved) completes normally; both
    // goblins' tactical calls stall until the abort fires, and each
    // forfeits with a bare turn_advanced — no action_validated,
    // dice_rolled, state_delta_applied or narrative_emitted for either.
    const types = (await store.readSince("s1", GENESIS_SEQUENCE)).map((each) => each.type);
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
    expect(encounterOf(campaign).currentActorIndex).toBe(0);
    expect(encounterOf(campaign).round).toBe(2);
  }, 10_000);

  // The tactical call and the narration
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
  // `turnTimeoutMs` and `slowTactical`'s delay are scaled up 2.5x from an
  // initial 80ms/60ms (to 200ms/150ms), and the
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
    const campaign = await freshCampaign(store);
    const ports: TurnPorts = {
      ...portsWith(store),
      tactical: slowTactical(150),
      narrative: hangingNarrative(),
      turnTimeoutMs: 200,
    };

    // Timing the whole `drain(...)` would be wrong: that drain ends with a
    // `turn_affordances` frame — pure computation (`affordancesFor` probing
    // ~143 candidate tiles through `validateExecuteTurn`) that no deadline
    // governs. Folding that fixed ~100ms of real work into the budget-sharing
    // assertion erases the margin the comment above describes. Consuming the
    // generator by hand
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
    for await (const frame of handleCommand(campaign, dodge("hero"), ports)) {
      if (frame.type !== "turn_affordances") lastGovernedFrameAt = Date.now();
    }
    const elapsed = lastGovernedFrameAt - start;

    // Shared deadline (theoretical): hero (~200ms, narration-only) +
    // goblin-a (~200ms: 150ms tactical + ~50ms remaining narration cap) +
    // goblin-b (~200ms) is roughly 600ms. Two independent budgets per enemy
    // turn would instead be hero (~200ms) + goblin-a (150 + 200 = 350ms) +
    // goblin-b (350ms), or roughly 900ms. Measured wall-clock reality runs
    // higher than either estimate (see the budget-scaling comment above
    // for the actual figures and the real headroom the 750ms threshold
    // gives against each scenario).
    expect(elapsed).toBeLessThan(750);
    expect(encounterOf(campaign).round).toBe(2);
  }, 10_000);
});

// Task 12: `narrate` now builds its input via `buildNarrationBrief` and
// applies the degradation ladder described in `pipeline.ts`'s own comment —
// a complete model narration is stored as-is; a stream that yields nothing
// falls back to the full Hebrew deterministic renderer; a stream that stops
// mid-sentence is repaired by appending an ellipsis seam and then streaming
// the deterministic completion.
describe("handleCommand — narration degradation ladder", () => {
  it("marks a complete model narration as source model and stores it verbatim", async () => {
    const frames = await runOneTurn({
      narrative: scriptedNarrative(["אלדד ", "פוגע בגובלין לוחם."]),
    });
    const { tokens, emitted } = narrativeOf(frames);
    expect(emitted.source).toBe("model");
    expect(emitted.text).toBe(tokens.join(""));
    expect(emitted.text).toBe("אלדד פוגע בגובלין לוחם.");
    // The `model` rung's own promptVersion
    // check — see the "stamps the prompt version" test's comment below for
    // why it isn't checked only there.
    expect(emitted.promptVersion).toBe(NARRATIVE_PROMPT_VERSION);
  });

  it("falls back to full Hebrew when the model yields nothing at all", async () => {
    const frames = await runOneTurn({ narrative: scriptedNarrative([]) });
    const { tokens, emitted } = narrativeOf(frames);
    expect(emitted.source).toBe("deterministic");
    expect(emitted.text).toBe(tokens.join(""));
    expect(emitted.text).toMatch(/[֐-׿]/);
    expect(emitted.text).not.toMatch(/[a-zA-Z]/);
  });

  // Whitespace is not the same as nothing —
  // `narrate` (pipeline.ts) checks `text.trim() === ""`, not `text === ""`,
  // specifically so a provider that emits only `" "`/`"\n"` still falls back
  // rather than being treated as a (nonsensical) complete narration.
  it("falls back to full Hebrew when the model yields only whitespace", async () => {
    const frames = await runOneTurn({ narrative: scriptedNarrative([" "]) });
    const { tokens, emitted } = narrativeOf(frames);
    expect(emitted.source).toBe("deterministic");
    expect(emitted.text).toBe(tokens.join(""));
    expect(emitted.text).toMatch(/[֐-׿]/);
    expect(emitted.text).not.toMatch(/[a-zA-Z]/);
  });

  it("completes a truncated narration instead of storing a severed sentence", async () => {
    const frames = await runOneTurn({
      narrative: scriptedNarrative(["חרבו של אלדד מוצאת פתח מתח"]),
    });
    const { tokens, emitted } = narrativeOf(frames);
    expect(emitted.source).toBe("completed");
    expect(emitted.text).toBe(tokens.join(""));
    expect(emitted.text).toContain("… ");
    expect(emitted.text.trimEnd().endsWith(".")).toBe(true);
    // The `completed` rung's own promptVersion check.
    expect(emitted.promptVersion).toBe(NARRATIVE_PROMPT_VERSION);
  });

  // `NARRATION_TERMINATORS` (pipeline.ts) is
  // `[".", "!", "?", "…"]`, and covering only "." is not enough. A later "simplify" to
  // e.g. `/[.!?]$/` would silently drop "…" and nothing here would notice —
  // a model narration that legitimately trails off ("אלדד מהסס…") would then
  // be misclassified `completed`, get a doubled ellipsis appended, and be
  // permanently mislabelled in the event log. Every terminator gets its own
  // case so none of the four can regress unnoticed.
  it("treats a stream ending on any of the four terminators as complete, not truncated", async () => {
    const endings = ["אלדד עומד במקומו.", "אלדד תוקף!", "מי הבא בתור?", "אלדד מהסס…"];
    for (const text of endings) {
      const frames = await runOneTurn({ narrative: scriptedNarrative([text]) });
      expect(narrativeOf(frames).emitted.source).toBe("model");
    }
  });

  // This covers the `deterministic` rung; the `model` and `completed` rungs
  // are covered by their own promptVersion assertions above rather than
  // re-running a turn here — every payload every
  // rung can produce is checked, split across the tests that already build
  // each one, instead of duplicating three `runOneTurn` calls in one test.
  it("stamps the prompt version on every narration whatever produced it", async () => {
    const frames = await runOneTurn({ narrative: scriptedNarrative([]) });
    expect(narrativeOf(frames).emitted.promptVersion).toBe(NARRATIVE_PROMPT_VERSION);
  });

  // Both hostiles are killed up front so a hero dodge advances straight back
  // to the hero without the enemy sweep narrating too — otherwise a single
  // `structured_action` would push THREE narrations per call (hero plus both
  // goblins, all reading the same finite script), defeating a test that
  // expects exactly one distinct narration per call.
  it("feeds each narration into the next turn's window, newest last", async () => {
    const store = createInMemoryEventStore();
    const campaign = await freshCampaign(store);
    campaign.state = {
      ...campaign.state,
      encounter: {
        ...encounterOf(campaign),
        combatants: encounterOf(campaign).combatants.map((each) =>
          each.faction === "hostile" ? { ...each, status: "dead" as const } : each,
        ),
      },
    };

    await drain(
      handleCommand(campaign, dodge("hero", "c1"), {
        ...portsWith(store),
        narrative: scriptedNarrative(["ראשון."]),
      }),
    );
    await drain(
      handleCommand(campaign, dodge("hero", "c2"), {
        ...portsWith(store),
        narrative: scriptedNarrative(["שני."]),
      }),
    );
    await drain(
      handleCommand(campaign, dodge("hero", "c3"), {
        ...portsWith(store),
        narrative: scriptedNarrative(["שלישי."]),
      }),
    );

    expect(campaign.recentNarrations).toEqual(["שני.", "שלישי."]);
  });

  // Closes the loop the test above does not: that one only proves the
  // in-memory `campaign.recentNarrations` assignment inside `narrate`. Before
  // this task, `narrative_emitted` payloads carried no `source`/
  // `promptVersion`, so `NarrativeEmittedPayload.safeParse` in `loadCampaign`
  // (campaign.ts) rejected every one of them and a reload always came back
  // with an empty window regardless of what had actually been narrated —
  // this test fails on that regression and only passes once a real payload
  // round-trips through the store and back.
  it("round-trips recentNarrations through loadCampaign once narrative_emitted actually parses", async () => {
    const store = createInMemoryEventStore();
    const campaign = await freshCampaign(store);
    campaign.state = {
      ...campaign.state,
      encounter: {
        ...encounterOf(campaign),
        combatants: encounterOf(campaign).combatants.map((each) =>
          each.faction === "hostile" ? { ...each, status: "dead" as const } : each,
        ),
      },
    };

    await drain(
      handleCommand(campaign, dodge("hero", "c1"), {
        ...portsWith(store),
        narrative: scriptedNarrative(["ראשון."]),
      }),
    );
    await drain(
      handleCommand(campaign, dodge("hero", "c2"), {
        ...portsWith(store),
        narrative: scriptedNarrative(["שני."]),
      }),
    );

    const reloaded = await loadCampaign({ campaignId: "s1", store });
    expect(reloaded?.recentNarrations).toEqual(["ראשון.", "שני."]);
    // And the reload agrees with the live, in-memory campaign it was rebuilt
    // from — the round trip reproduces the same window, not merely a
    // non-empty one.
    expect(reloaded?.recentNarrations).toEqual(campaign.recentNarrations);
  });
});

describe("handleCommand — turn_affordances", () => {
  it("follows a join that lands on the player's turn", async () => {
    const store = createInMemoryEventStore();
    const campaign = await freshCampaign(store);
    const frames = await drain(
      handleCommand(campaign, { type: "join", campaignId: "s1" }, portsWith(store)),
    );

    const last = frames.at(-1);
    expect(last?.type).toBe("turn_affordances");
    expect(last?.type === "turn_affordances" && last.actorId).toBe("hero");
    expect(last?.type === "turn_affordances" && last.forSequence).toBe(campaign.nextSequence - 1);
  });

  it("offers the hero a reachable set and the longsword against an adjacent goblin", async () => {
    const store = createInMemoryEventStore();
    const campaign = await freshCampaign(store);
    const frames = await drain(
      handleCommand(campaign, { type: "join", campaignId: "s1" }, portsWith(store)),
    );
    const affordances = frames.at(-1);

    if (affordances?.type !== "turn_affordances") throw new Error("expected affordances");
    expect(affordances.reachableTiles.length).toBeGreaterThan(0);

    const longsword = affordances.actions.find((each) => each.actionId === "longsword");
    expect(longsword?.targetableCombatantIds).toContain("goblin-a");
  });

  it("does NOT follow a join that lands on a hostile's turn", async () => {
    const store = createInMemoryEventStore();
    const campaign = await freshCampaign(store);
    // Advance past the hero so a goblin is up.
    campaign.state = {
      ...campaign.state,
      encounter: { ...encounterOf(campaign), currentActorIndex: 1 },
    };

    const frames = await drain(
      handleCommand(campaign, { type: "join", campaignId: "s1" }, portsWith(store)),
    );
    expect(frames.some((each) => each.type === "turn_affordances")).toBe(false);
    // Pin that the join still produced its normal
    // response — absence-only would also pass a join that yields nothing.
    expect(frames.at(-1)?.type).toBe("campaign_state");
  });

  // An `if (index !== -1)` guard here would let this test pass vacuously —
  // deleting `yield* playerAffordances();` from the
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
    const campaign = await freshCampaign(store);
    const frames = await drain(handleCommand(campaign, dodge("hero"), portsWith(store)));

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
    const campaign = await freshCampaign(store);
    const frames = await drain(
      handleCommand(
        campaign,
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

describe("handleCommand — free text: the combat bridge", () => {
  const atTheWeir = {
    currentNodeId: "the-weir",
    completedNodeIds: ["arrival"],
    relations: [],
    day: 1,
  };

  it("opens a bracket when the entered node declares an encounter", async () => {
    const store = createInMemoryEventStore();
    const campaign = await sceneCampaign(store, atTheWeir);
    const ports: TurnPorts = {
      ...portsWith(store),
      intent: classifiedAs({ category: "exploration", targetNodeId: "saboteurs" }),
      sceneNarrative: scriptedSceneNarrative([]),
    };

    const frames = await drain(
      handleCommand(
        campaign,
        { type: "free_text", clientMessageId: "c1", text: "search the forced gate" },
        ports,
      ),
    );

    expect(eventTypesOf(frames)).toContain("encounter_started");
    expect(campaign.state.world.scene?.currentNodeId).toBe("saboteurs");
    expect(campaign.state.encounter?.encounterId).toBe("goblin-ambush");
    expect(campaign.state.encounter?.turnOrder).toEqual(["hero", "goblin-a", "goblin-b"]);
    expect(campaign.state.encounter?.round).toBe(1);
    // `emitAll` never touches `built`; the bridge must set it alongside the
    // bracket or `builtOf` throws at the first tactical turn.
    expect(campaign.built?.encounterId).toBe("goblin-ambush");
  });

  it("appends the entry group and the bracket together, in one store append", async () => {
    const inner = createInMemoryEventStore();
    const appendSizes: number[] = [];
    const store: EventStore = {
      ...inner,
      append(campaignId, events) {
        appendSizes.push(events.length);
        return inner.append(campaignId, events);
      },
    };
    const campaign = await sceneCampaign(store, atTheWeir);
    const ports: TurnPorts = {
      ...portsWith(store),
      intent: classifiedAs({ category: "exploration", targetNodeId: "saboteurs" }),
      sceneNarrative: scriptedSceneNarrative([]),
    };

    await drain(
      handleCommand(
        campaign,
        { type: "free_text", clientMessageId: "c1", text: "search the forced gate" },
        ports,
      ),
    );

    // `quest_node_completed` + `quest_node_entered` + `encounter_started` land
    // as one group. `player_input` and `intent_classified` precede them as
    // their own single-event appends, exactly as they already do — so the
    // group of three is what proves the bracket did not get an append of its
    // own.
    expect(appendSizes).toContain(3);
  });

  it("does not open a bracket for a node that declares no encounter", async () => {
    const store = createInMemoryEventStore();
    const campaign = await sceneCampaign(store, {
      currentNodeId: "arrival",
      completedNodeIds: [],
      relations: [],
      day: 1,
    });
    const ports: TurnPorts = {
      ...portsWith(store),
      intent: classifiedAs({ category: "exploration", targetNodeId: "guild-offer" }),
      sceneNarrative: scriptedSceneNarrative([]),
    };

    const frames = await drain(
      handleCommand(
        campaign,
        { type: "free_text", clientMessageId: "c1", text: "hear out the factor" },
        ports,
      ),
    );

    expect(eventTypesOf(frames)).not.toContain("encounter_started");
    expect(campaign.state.encounter).toBeNull();
    expect(campaign.built).toBeNull();
  });
});

describe("handleCommand — end of combat", () => {
  /** A campaign standing in `saboteurs` with its bracket open. */
  async function bridgedCampaign(store: EventStore): Promise<Campaign> {
    const campaign = await sceneCampaign(store, {
      currentNodeId: "the-weir",
      completedNodeIds: ["arrival"],
      relations: [],
      day: 1,
    });
    await drain(
      handleCommand(
        campaign,
        { type: "free_text", clientMessageId: "open", text: "search the forced gate" },
        {
          ...portsWith(store),
          intent: classifiedAs({ category: "exploration", targetNodeId: "saboteurs" }),
          sceneNarrative: scriptedSceneNarrative([]),
        },
      ),
    );
    return campaign;
  }

  /** Rewrites the open board in place — the poser for each outcome below. */
  function poseBoard(campaign: Campaign, patch: (each: Combatant) => Combatant, round = 1): void {
    const encounter = campaign.state.encounter;
    if (encounter === null) throw new Error("poseBoard: no bracket open");
    campaign.state = {
      ...campaign.state,
      encounter: { ...encounter, combatants: encounter.combatants.map(patch), round },
    };
  }

  const slain = (each: Combatant): Combatant =>
    each.faction === "hostile" ? { ...each, status: "dead", currentHp: 0 } : each;

  it("resolves with victory, completes the node and applies its effects", async () => {
    const store = createInMemoryEventStore();
    const campaign = await bridgedCampaign(store);
    poseBoard(campaign, slain);

    const frames = await drain(handleCommand(campaign, dodge("hero", "c-win"), portsWith(store)));

    expect(eventTypesOf(frames)).toContain("encounter_resolved");
    const resolved = frames
      .filter((each): each is Extract<ServerFrame, { type: "event" }> => each.type === "event")
      .map((each) => each.event)
      .find((each) => each.type === "encounter_resolved");
    expect(resolved?.payload).toMatchObject({
      encounterId: "goblin-ambush",
      outcome: "victory",
      survivorIds: ["hero"],
    });
    expect(campaign.state.encounter).toBeNull();
    expect(campaign.built).toBeNull();
    expect(campaign.state.world.scene?.completedNodeIds).toContain("saboteurs");
    // `saboteurs` declares an `advance_calendar` effect (days: 1), so victory
    // must also record the day it actually advanced — the exit criterion's
    // "and its effects apply" clause, exercised end to end.
    const deltaEvent = frames
      .filter((each): each is Extract<ServerFrame, { type: "event" }> => each.type === "event")
      .map((each) => each.event)
      .find((each) => each.type === "world_delta_applied");
    expect(deltaEvent?.payload).toEqual({ relations: [], npcAffinities: [], day: 2 });
    expect(campaign.state.world.scene?.day).toBe(2);
  });

  it("resolves with defeat and leaves the node uncompleted", async () => {
    const store = createInMemoryEventStore();
    const campaign = await bridgedCampaign(store);
    // The hero is about to be killed on the goblins' turn: 1 HP behind AC 1,
    // so any attack roll hits and any damage is lethal — no reliance on the
    // seed. `agentProposing` supplies the attack; `defaultTactical` would
    // only dodge.
    poseBoard(campaign, (each) =>
      each.faction === "party" ? { ...each, currentHp: 1, maxHp: 1, armorClass: 1 } : each,
    );

    const frames = await drain(
      handleCommand(
        campaign,
        dodge("hero", "c-lose"),
        portsWith(
          store,
          agentProposing([
            {
              actorId: "goblin-a",
              mainAction: { actionType: "attack", actionId: "scimitar", targetIds: ["hero"] },
              tacticalRationaleEnglish: "Test fixture: finish the hero.",
            },
          ]),
        ),
      ),
    );

    const resolved = frames
      .filter((each): each is Extract<ServerFrame, { type: "event" }> => each.type === "event")
      .map((each) => each.event)
      .find((each) => each.type === "encounter_resolved");
    expect(resolved?.payload).toMatchObject({ outcome: "defeat" });
    expect(campaign.state.encounter).toBeNull();
    expect(campaign.state.world.scene?.completedNodeIds).not.toContain("saboteurs");
    expect(campaign.state.world.scene?.currentNodeId).toBe("saboteurs");
    expect(eventTypesOf(frames)).not.toContain("quest_node_completed");
  });

  it("resolves a stalemate once the round passes maxRounds", async () => {
    const store = createInMemoryEventStore();
    const campaign = await bridgedCampaign(store);
    // Everyone alive, so `conclusionOf` stays "ongoing"; only the round is
    // past `goblin-ambush`'s maxRounds of 20.
    poseBoard(campaign, (each) => each, 21);

    const frames = await drain(handleCommand(campaign, dodge("hero", "c-draw"), portsWith(store)));

    const resolved = frames
      .filter((each): each is Extract<ServerFrame, { type: "event" }> => each.type === "event")
      .map((each) => each.event)
      .find((each) => each.type === "encounter_resolved");
    expect(resolved?.payload).toMatchObject({ outcome: "stalemate" });
    expect(campaign.state.world.scene?.completedNodeIds).not.toContain("saboteurs");
  });

  it("stays ongoing when the round lands exactly on maxRounds, not past it", async () => {
    const store = createInMemoryEventStore();
    const campaign = await bridgedCampaign(store);
    // Everyone alive, so `conclusionOf` stays "ongoing". Posed at 19: the
    // hero's dodge plus the two goblins' dodges wrap `currentActorIndex`
    // back to 0 once, landing the checked round at exactly 20 —
    // `goblin-ambush`'s `maxRounds`. `>` (not `>=`) must treat this as still
    // ongoing; this is the direct negative of the stalemate test above,
    // which only exercises round 22 (past the limit either way).
    poseBoard(campaign, (each) => each, 19);

    const frames = await drain(handleCommand(campaign, dodge("hero", "c-tie"), portsWith(store)));

    expect(eventTypesOf(frames)).not.toContain("encounter_resolved");
    expect(campaign.state.encounter).not.toBeNull();
  });

  it("emits nothing for a combat-only campaign whose fight ends", async () => {
    const store = createInMemoryEventStore();
    const campaign = await freshCampaign(store);
    poseBoard(campaign, slain);

    const frames = await drain(handleCommand(campaign, dodge("hero", "c-solo"), portsWith(store)));

    // Decision 7: the fight IS the campaign, so the bracket stays open and
    // the client keeps reading victory off `conclusionOf` as it does today.
    expect(eventTypesOf(frames)).not.toContain("encounter_resolved");
    expect(campaign.state.encounter).not.toBeNull();
    expect(campaign.built).not.toBeNull();
  });
});
