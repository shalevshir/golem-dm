// A campaign is its projection plus the static encounter data that projection
// is not allowed to contain. Stat blocks and the world's `lineOfSight`
// algorithm are re-paired in from `encounterId` rather than snapshotted, by
// `worldFor` below: they never change, and one of them is a function so it
// could not be serialized even if it did. (`buildEncounter` never actually
// populates `CombatWorld.lineOfSight` today, so the validator falls through
// to its Bresenham default — but `worldFor` is where that field would come
// from if it were populated, which is the mechanism this comment documents.)
//
// C-26: `reduce` never writes `campaignId`, `rootSeed`, `encounterId`, `grid`
// or `turnOrder` — no event branch touches those five `CampaignState` fields,
// and `session_snapshot` is deliberately a no-op in the projection (that is
// what makes "fold-from-snapshot-plus-events equals fold-from-zero" hold).
// So "fold from zero" here means "fold from the campaign-creation state", not
// from an empty object: `initialState` below is that genesis state, and both
// `createCampaign` and `loadCampaign` build it the same way before folding
// anything on top of it.
import { z } from "zod";
import type { EventStore } from "@ai-dm/memory";
import type { BuiltEncounter, CombatWorld } from "@ai-dm/rules-engine";
import { fold, NarrativeEmittedPayload } from "@ai-dm/schemas";
import type { GameEvent, CampaignState } from "@ai-dm/schemas";
import { buildEncounterById } from "../encounters/index.js";

/** Sequence 0's payload. Parsed rather than cast — it is the only thing that
 * tells a reloaded campaign which encounter it is. */
const GenesisPayload = z.object({ encounterId: z.string(), rootSeed: z.number().int() });

/**
 * How many past narrations the narrative agent is shown. Two: enough to stop
 * it reusing a verb it just used, small enough that the uncached tier stays
 * cheap. Not in `CampaignState` — see the doc comment on `recentNarrations`.
 */
export const NARRATION_WINDOW = 2;

export interface Campaign {
  state: CampaignState;
  built: BuiltEncounter;
  /** The sequence the next appended event will take. */
  nextSequence: number;
  /** The encounter's narrator-facing scene card. Static; resolved once here. */
  sceneEnglish: string;
  /**
   * The last `NARRATION_WINDOW` narrations, oldest first. A projection of the
   * `narrative_emitted` events in the log, held here rather than in
   * `CampaignState` because the client has no use for it and `reduce` keeps
   * treating that event as a no-op. Rebuilt by `loadCampaign`, so a reconnect
   * does not hand the narrator an empty memory.
   */
  recentNarrations: string[];
}

export interface CreateCampaignInput {
  campaignId: string;
  encounterId: string;
  rootSeed: number;
  store: EventStore;
  clock: () => string;
  uuid: () => string;
}

/**
 * The genesis `CampaignState`: the five fields `reduce` never writes
 * (`campaignId`, `rootSeed`, `encounterId`, `grid`, `turnOrder`), plus the
 * starting combatants, round and turn index. `createCampaign` folds nothing
 * on top of this but the genesis event; `loadCampaign` rebuilds this exact
 * value before folding the rest of the log onto it.
 */
function initialState(input: {
  campaignId: string;
  rootSeed: number;
  built: BuiltEncounter;
}): CampaignState {
  return {
    campaignId: input.campaignId,
    rootSeed: input.rootSeed,
    encounterId: input.built.encounterId,
    grid: input.built.world.grid,
    combatants: [...input.built.world.combatants],
    turnOrder: [...input.built.turnOrder],
    currentActorIndex: 0,
    round: 1,
    appliedClientMessageIds: [],
  };
}

export async function createCampaign(input: CreateCampaignInput): Promise<Campaign> {
  const built = buildEncounterById(input.encounterId);
  const state = initialState({ campaignId: input.campaignId, rootSeed: input.rootSeed, built });

  // Sequence 0 is the campaign's own genesis event. Without it, a log with no
  // turns yet is indistinguishable from a campaign that does not exist, and
  // `loadCampaign` could not tell them apart.
  //
  // The payload deliberately carries only `encounterId`/`rootSeed`, not
  // `state` itself: nothing reads a persisted `state` field (`loadCampaign`
  // rebuilds it from `encounterId`/`rootSeed` via `initialState`, on purpose
  // — see `GenesisPayload` below), and including it would alias the exact
  // object returned as `campaign.state` into the store's own event, which the
  // in-memory store then holds by reference.
  const genesis: GameEvent = {
    eventId: input.uuid(),
    campaignId: input.campaignId,
    sequence: 0,
    timestamp: input.clock(),
    type: "session_snapshot",
    payload: { encounterId: input.encounterId, rootSeed: input.rootSeed },
  };
  await input.store.append(input.campaignId, [genesis]);

  return { state, built, nextSequence: 1, sceneEnglish: built.sceneEnglish, recentNarrations: [] };
}

export async function loadCampaign(input: {
  campaignId: string;
  store: EventStore;
}): Promise<Campaign | null> {
  // From genesis, deliberately, even though a snapshot may exist: snapshots
  // are a cache and never authority (`EventStore.putSnapshot`'s contract),
  // so folding the whole log is what guarantees a stale, truncated or
  // corrupt snapshot can never reach a restored campaign. `join` with
  // `resumeFrom` is the one path that reads `campaign_snapshots`, and it only
  // uses it to skip replaying events the client already has. Accelerating
  // this call with the snapshot is a possible follow-up, not an oversight;
  // it would need the snapshot to be validated against the log first.
  const events = await input.store.readSince(input.campaignId, -1);
  const genesis = events[0];
  if (genesis === undefined) return null;

  // A log whose first event is not `session_snapshot` is corrupt — `reduce`
  // will happily fold whatever is there, but `GenesisPayload.parse` below
  // would fail with a raw, undiagnosable `ZodError` if the actual event 0
  // shares no fields with what we expect here.
  if (genesis.type !== "session_snapshot") {
    throw new Error(
      `Campaign ${input.campaignId}'s log does not start with session_snapshot ` +
        `(sequence 0 is a ${genesis.type})`,
    );
  }

  const { encounterId, rootSeed } = GenesisPayload.parse(genesis.payload);
  const built = buildEncounterById(encounterId);
  const state = fold(
    initialState({ campaignId: input.campaignId, rootSeed, built }),
    events.slice(1),
  );

  // A projection of the `narrative_emitted` events in the log, not something
  // `reduce` folds — see the doc comment on `Campaign.recentNarrations`.
  const recentNarrations: string[] = [];
  for (const event of events) {
    if (event.type !== "narrative_emitted") continue;
    const parsed = NarrativeEmittedPayload.safeParse(event.payload);
    // Tolerant on purpose: this is a prompt-quality nicety, and a payload
    // from before this convention existed must not stop a campaign from
    // loading.
    if (!parsed.success) continue;
    recentNarrations.push(parsed.data.text);
  }

  const last = events[events.length - 1];
  return {
    state,
    built,
    nextSequence: (last?.sequence ?? 0) + 1,
    sceneEnglish: built.sceneEnglish,
    recentNarrations: recentNarrations.slice(-NARRATION_WINDOW),
  };
}

/**
 * The validator and the resolver want a `CombatWorld`; the projection holds
 * only its serializable half. This is where the two are married, and the only
 * place that knows the difference.
 */
export function worldFor(campaign: Campaign): CombatWorld {
  return {
    ...campaign.built.world,
    grid: campaign.state.grid,
    combatants: campaign.state.combatants,
  };
}
