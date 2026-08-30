// The whole point of Tasks 1-7, proven end to end in one file: a campaign
// walks the arc, closes episodes as it goes, fights and resolves an
// encounter, a later scene turn's prompt carries a retrieved summary of what
// already happened, the index rebuilds from the log alone, and a reload
// folds to the identical `CampaignState` the live run held — summaries are
// not state (invariant 3).
//
// Built on `replay.test.ts`'s own fixture and event-driving helpers
// (`portsWith`, `defaultTactical`, `classifiedAs`, `drain`, `uuids`), not a
// new world: same real `emberfall` content, same real `hero` character, same
// `TurnPorts` shape Task 7 wired the three episodic-memory ports into. The
// one addition `replay.test.ts` has no need for is a way to force a fight to
// an actual conclusion and a way to see what `sceneNarrate` handed the
// narrator — both borrowed from `pipeline.test.ts`'s own proven patterns
// (`poseBoard`, `agentProposing`, `recordingSceneNarrative`) rather than
// invented fresh.
import { describe, expect, it } from "vitest";
import { validateExecuteTurn } from "@ai-dm/rules-engine";
import type { IntentAgent, IntentResult, SceneNarrationInput, SceneNarrativePort, TacticalAgent } from "@ai-dm/agents";
import {
  createAgentRuntime,
  createDeterministicNarrative,
  createDeterministicSceneNarrative,
  createDeterministicSceneSummary,
  createFakePort,
  createFakeEmbeddingPort,
  createTacticalAgent,
  DEFAULT_EMBEDDING_SPEC,
  DEFAULT_MODEL_ROUTING,
} from "@ai-dm/agents";
import { createInMemoryEpisodicStore, createInMemoryEventStore } from "@ai-dm/memory";
import type { EventStore } from "@ai-dm/memory";
import {
  EMBEDDING_DIMENSIONS,
  EncounterResolvedPayload,
  EpisodicMemory,
  QuestNodeCompletedPayload,
  WorldDeltaAppliedPayload,
} from "@ai-dm/schemas";
import type {
  Combatant,
  ClientMessage,
  ExecuteTurn,
  GameEvent,
  IntentClassification,
  ServerFrame,
  CampaignState,
} from "@ai-dm/schemas";
import { indexEpisode } from "./episodic.js";
import { handleCommand } from "./pipeline.js";
import type { TurnPorts } from "./pipeline.js";
import { createCampaign, loadCampaign } from "./campaign.js";
import type { Campaign } from "./campaign.js";
import { loadCharacter } from "../encounters/index.js";
import { loadWorld } from "../world/index.js";

/** This file's own campaign id — fixed rather than random, so the rebuild
 *  test's `PROBE_VECTOR` query and the reload test's `loadCampaign` call
 *  both name the same stream deterministically. */
const CAMPAIGN_ID = "episodic-e2e";

/** `axisVector(0)` from `packages/memory/src/episodic/contract.ts` is not
 *  exported from `@ai-dm/memory`'s public barrel (internal to that
 *  package's own contract suite) — this is the brief's documented fallback,
 *  "any fixed unit vector". The rebuild assertion compares two stores under
 *  the SAME query, so only fixedness matters, not which axis. */
const PROBE_VECTOR: number[] = Array.from({ length: EMBEDDING_DIMENSIONS }, (_unused, index) =>
  index === 0 ? 1 : 0,
);

/** `emberfall`'s `startingDay` (`data/world/world.json`). The fixture below
 *  forces a DEFEAT rather than a victory specifically so no `advance_calendar`
 *  effect ever fires — every episode this campaign closes is indexed under
 *  this same day, which is what lets the rebuild test reconstruct `day`
 *  without having to fold `world_delta_applied` events itself. */
const DAY_AT_CLOSE = 1;

const CLOCK = (): string => "2026-08-19T10:00:00.000Z";

function uuids(): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  };
}

/** `replay.test.ts`'s own tactical double, copied verbatim: proposes a legal
 *  Dodge for whichever actor is asked, so every round short of the forced
 *  defeat below can run without a script running out. */
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
        tacticalRationaleEnglish: "e2e fixture: always dodge.",
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

/** `pipeline.test.ts`'s own scripted-attacker double, copied verbatim: makes
 *  one hostile propose exactly the given turns via the real tactical agent
 *  and its real tool-call machinery, rather than a hand-rolled stub. */
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

/** `pipeline.test.ts`'s own board-poser, copied verbatim: rewrites the open
 *  bracket's combatants in place so an outcome (here, a lethal hit incoming)
 *  is reached deterministically rather than by relying on dice. */
function poseBoard(campaign: Campaign, patch: (each: Combatant) => Combatant): void {
  const encounter = campaign.state.encounter;
  if (encounter === null) throw new Error("poseBoard: no bracket open");
  campaign.state = {
    ...campaign.state,
    encounter: { ...encounter, combatants: encounter.combatants.map(patch) },
  };
}

/** `pipeline.test.ts`'s own recording scene-narrative double, copied and
 *  wired to the REAL deterministic renderer rather than an empty script —
 *  Task 8's own "real implementations, no mocks" instruction — so this file
 *  can inspect every `SceneNarrationInput` `sceneNarrate` actually built
 *  without stubbing away the narration it produces. */
function recordingSceneNarrative(sink: SceneNarrationInput[]): SceneNarrativePort {
  const inner = createDeterministicSceneNarrative();
  return {
    stream(input: SceneNarrationInput): AsyncIterable<string> {
      sink.push(input);
      return inner.stream(input);
    },
  };
}

/** `replay.test.ts`'s own `portsWith`, copied and given a `sceneNarrative`
 *  override slot — every other port is exactly what Task 7 wired into
 *  `TurnPorts`: a real in-memory episodic store, a real (fake, deterministic)
 *  embedding port, and the real deterministic summary tier. */
function portsWith(store: EventStore, sceneInputs: SceneNarrationInput[]): TurnPorts {
  return {
    store,
    tactical: defaultTactical(),
    narrative: createDeterministicNarrative(),
    intent: {
      classify: () => Promise.reject(new Error("intent.classify not scripted for this call")),
    },
    sceneNarrative: recordingSceneNarrative(sceneInputs),
    episodic: createInMemoryEpisodicStore(),
    embedding: createFakeEmbeddingPort(),
    summary: createDeterministicSceneSummary(),
    clock: CLOCK,
    uuid: uuids(),
    seedFor: (rootSeed, sequence) => rootSeed * 1000 + sequence,
    turnTimeoutMs: 10_000,
    conditionNamesHebrew: new Map([["prone", "שרוע"]]),
    skillAbilities: new Map(),
  };
}

function classifiedAs(classification: IntentClassification): IntentAgent {
  return {
    classify: () =>
      Promise.resolve({
        ok: true,
        classification,
        provider: "test-provider",
        modelId: "test-model",
        usage: [{ promptTokens: 10, completionTokens: 5, totalTokens: 15 }],
      } satisfies IntentResult),
  };
}

function dodgeCommand(actorId: string, clientMessageId: string): ClientMessage {
  const turn: ExecuteTurn = {
    actorId,
    mainAction: { actionType: "dodge" },
    tacticalRationaleEnglish: "e2e fixture.",
  };
  return { type: "structured_action", clientMessageId, actorId, turn };
}

async function drain(stream: AsyncIterable<ServerFrame>): Promise<ServerFrame[]> {
  const frames: ServerFrame[] = [];
  for await (const frame of stream) frames.push(frame);
  return frames;
}

/**
 * Walks the real `emberfall` arc — arrival -> guild-offer -> the-weir ->
 * saboteurs — closing a quest_node episode at each hop (three, all summarized
 * and indexed unconditionally per `pipeline.ts`'s exploration branch), then
 * opens the `goblin-ambush` bracket the "saboteurs" node bridges into and
 * forces it to a DEFEAT: the hero posed at 1 HP/1 AC and goblin-a scripted to
 * land the kill (`pipeline.test.ts`'s own proven recipe for a fight that
 * concludes without relying on dice). Defeat rather than victory is
 * deliberate — "saboteurs" declares an `advance_calendar` effect that only
 * fires on victory, and this fixture wants EVERY closed episode indexed under
 * the same `DAY_AT_CLOSE` so the rebuild test does not have to re-derive a
 * day that changed mid-campaign. `resolveIfConcluded` closes the "encounter"
 * episode unconditionally regardless of outcome, so a defeat still proves the
 * whole closing path. One final scene turn afterward proves retrieval still
 * reaches the narration prompt once the fight is over.
 *
 * Returns the episodic store (not the event store — `store.search` is what
 * every test below wants), the full event log, every `SceneNarrationInput`
 * `sceneNarrate` built along the way, and the live-vs-reloaded `CampaignState`
 * pair.
 */
async function runCampaignThroughAnEpisodeAndAFight(): Promise<{
  store: ReturnType<typeof createInMemoryEpisodicStore>;
  events: GameEvent[];
  sceneInputs: SceneNarrationInput[];
  liveState: CampaignState;
  reloadedState: CampaignState | null;
}> {
  const eventStore = createInMemoryEventStore();
  const campaign = await createCampaign({
    campaignId: CAMPAIGN_ID,
    rootSeed: 42,
    store: eventStore,
    clock: CLOCK,
    uuid: uuids(),
    scene: { authored: loadWorld(), character: loadCharacter("hero") },
  });

  const sceneInputs: SceneNarrationInput[] = [];
  // One fixed ports object for the whole sequence — `eventId` comes from
  // `ports.uuid()`, so a fresh `portsWith` per turn would restart that
  // generator and collide `eventId`s across turns (`replay.test.ts`'s own
  // header rationale). `intent` is overridden per call below instead.
  const ports = portsWith(eventStore, sceneInputs);

  async function freeText(
    clientMessageId: string,
    text: string,
    classification: IntentClassification,
  ): Promise<ServerFrame[]> {
    return drain(
      handleCommand(
        campaign,
        { type: "free_text", clientMessageId, text },
        { ...ports, intent: classifiedAs(classification) },
      ),
    );
  }

  // Nothing has happened yet — the campaign's first scene turn, still
  // standing at "arrival".
  await freeText("c0", "who's in charge here", { category: "social" });

  // Walks the arc, one real edge at a time (`data/world/arc.json`). Each hop
  // completes the node just left, unconditionally summarized and indexed —
  // three "quest_node" episodes closed before the fight ever starts.
  await freeText("c1", "hear out the guild factor", {
    category: "exploration",
    targetNodeId: "guild-offer",
  });
  await freeText("c2", "go look at the weir myself", {
    category: "exploration",
    targetNodeId: "the-weir",
  });
  // "the-weir" -> "saboteurs" bridges into the goblin-ambush bracket
  // (`arc.json`'s own `encounterId`).
  await freeText("c3", "search the forced gate mechanism", {
    category: "exploration",
    targetNodeId: "saboteurs",
  });

  // Force the fight to a real, deterministic conclusion: the hero cannot
  // survive a hit, and goblin-a is scripted to land one. `runEnemyTurns`
  // checks `conclusionOf` before every hostile's turn, so goblin-b is never
  // asked to act once the party is wiped — one scripted turn is enough.
  poseBoard(campaign, (each) =>
    each.faction === "party" ? { ...each, currentHp: 1, maxHp: 1, armorClass: 1 } : each,
  );
  await drain(
    handleCommand(campaign, dodgeCommand("hero", "c-lose"), {
      ...ports,
      tactical: agentProposing([
        {
          actorId: "goblin-a",
          mainAction: { actionType: "attack", actionId: "scimitar", targetIds: ["hero"] },
          tacticalRationaleEnglish: "e2e fixture: finish the hero.",
        },
      ]),
    }),
  );

  // The bracket is closed; the scene is still open at "saboteurs" (defeat
  // leaves the node uncompleted). One more scene turn proves a retrieved
  // memory still reaches the prompt after the fight, not only before it.
  await freeText("c4", "who's in charge here", { category: "social" });

  const events = await eventStore.readSince(CAMPAIGN_ID, -1);
  const reloaded = await loadCampaign({ campaignId: CAMPAIGN_ID, store: eventStore });

  return {
    store: ports.episodic,
    events,
    sceneInputs,
    liveState: campaign.state,
    reloadedState: reloaded?.state ?? null,
  };
}

/** Every summary a `quest_node_completed`/`encounter_resolved` event carried,
 *  in log order — shared by the first and second tests below, since both
 *  need "what the log says every closed episode's summary was". */
function summariesInLogOf(events: readonly GameEvent[]): string[] {
  return events.flatMap((event) => {
    if (event.type === "quest_node_completed") {
      return [QuestNodeCompletedPayload.parse(event.payload).summaryEnglish].filter(
        (each): each is string => each !== undefined,
      );
    }
    if (event.type === "encounter_resolved") {
      return [EncounterResolvedPayload.parse(event.payload).summaryEnglish].filter(
        (each): each is string => each !== undefined,
      );
    }
    return [];
  });
}

describe("episodic memory end to end", () => {
  it("writes one memory per closed episode, and the log carries the same text", async () => {
    const { store, events } = await runCampaignThroughAnEpisodeAndAFight();

    const summariesInLog = summariesInLogOf(events);

    // Exactly one summarized closure per episode this fixture closes: three
    // quest_node completions (arrival, guild-offer, the-weir) plus one
    // encounter closure (the defeat). A fixed count, not a lower bound.
    expect(summariesInLog).toHaveLength(4);

    // ONE row per closed episode, not "at least one somewhere findable" —
    // `toContain` below on its own would still pass a bug that wrote two
    // rows per episode. Any fixed query vector returns every row up to
    // `limit` here: the in-memory store applies no similarity threshold, so
    // a limit comfortably above the known count returns the campaign's
    // whole row set regardless of which vector is asked.
    const allMemories = await store.search(CAMPAIGN_ID, PROBE_VECTOR, summariesInLog.length + 10);
    expect(allMemories).toHaveLength(summariesInLog.length);

    // Every summary the log recorded is retrievable, with identical text —
    // proven with a FRESH embedding port: `createFakeEmbeddingPort` is a
    // pure hash of the text, so re-embedding the exact summary independently
    // reproduces the same vector the pipeline indexed it under.
    const embedding = createFakeEmbeddingPort();
    for (const summary of summariesInLog) {
      const query = await embedding.embed(DEFAULT_EMBEDDING_SPEC, [summary]);
      expect(query.ok).toBe(true);
      if (!query.ok) continue;

      const hits = await store.search(CAMPAIGN_ID, query.value.vectors[0] ?? [], 5);
      expect(hits.map((hit) => hit.memory.summaryEnglish)).toContain(summary);
    }
  });

  it("puts a retrieved summary into the scene narration prompt on re-entry", async () => {
    const { events, sceneInputs } = await runCampaignThroughAnEpisodeAndAFight();

    // The last scene turn, well after the fight has closed its own episode.
    const last = sceneInputs[sceneInputs.length - 1];
    expect(last?.memoryEnglish.length).toBeGreaterThan(0);

    // Stronger than "non-empty": every node in this fixture shares one
    // location ("emberfall"), so `memoryEnglish` always carries at least one
    // authored NPC-affinity line regardless of retrieval — a bare
    // `.length > 0` check alone would pass even if retrieval were wired to
    // nothing. Pinning that one of the log's own closed-episode summaries is
    // literally present in the prompt's `memoryEnglish` proves the RETRIEVED
    // half specifically reached the narrator, not just the authored half.
    const summariesInLog = summariesInLogOf(events);
    expect(summariesInLog.length).toBeGreaterThan(0);
    expect(summariesInLog.some((summary) => last?.memoryEnglish.includes(summary))).toBe(true);
  });

  it("rebuilds the index from the log alone", async () => {
    const { store, events } = await runCampaignThroughAnEpisodeAndAFight();
    const live = await store.search(CAMPAIGN_ID, PROBE_VECTOR, 5);

    // Rebuild into a fresh store from nothing but the event log. `day` is
    // folded from `world_delta_applied.day` (`WorldDeltaAppliedPayload`,
    // `packages/schemas/src/events.ts`) in sequence order, not read off a
    // constant — `quest_node_completed`/`encounter_resolved` carry no `day`
    // field of their own, but every day advance the log ever recorded does
    // land in a `world_delta_applied` payload, so this is genuinely
    // reconstructible from the log alone. A hardcoded `day` would silently
    // pass this fixture (which never crosses a day boundary) while getting
    // a real campaign wrong the moment one did.
    const rebuilt = createInMemoryEpisodicStore();
    const embedding = createFakeEmbeddingPort();
    let day = DAY_AT_CLOSE;
    for (const event of events) {
      if (event.type === "world_delta_applied") {
        const delta = WorldDeltaAppliedPayload.parse(event.payload);
        if (delta.day !== undefined) day = delta.day;
      }

      const summaryEnglish =
        event.type === "quest_node_completed"
          ? QuestNodeCompletedPayload.parse(event.payload).summaryEnglish
          : event.type === "encounter_resolved"
            ? EncounterResolvedPayload.parse(event.payload).summaryEnglish
            : undefined;
      if (summaryEnglish === undefined) continue;

      await indexEpisode({
        store: rebuilt,
        embedding,
        spec: DEFAULT_EMBEDDING_SPEC,
        record: EpisodicMemory.parse({
          campaignId: event.campaignId,
          sequence: event.sequence,
          kind: event.type === "encounter_resolved" ? "encounter" : "quest_node",
          refId:
            event.type === "encounter_resolved"
              ? EncounterResolvedPayload.parse(event.payload).encounterId
              : QuestNodeCompletedPayload.parse(event.payload).nodeId,
          summaryEnglish,
          day,
        }),
        deadline: Date.now() + 10_000,
      });
    }

    expect((await rebuilt.search(CAMPAIGN_ID, PROBE_VECTOR, 5)).map((hit) => hit.memory)).toEqual(
      live.map((hit) => hit.memory),
    );
  });

  it("folds to an identical CampaignState after a reload — summaries are not state", async () => {
    const { liveState, reloadedState } = await runCampaignThroughAnEpisodeAndAFight();
    expect(reloadedState).toEqual(liveState);
  });
});
