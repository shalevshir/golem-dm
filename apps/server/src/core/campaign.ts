// A campaign is its projection plus the static encounter data that projection
// is not allowed to contain. Stat blocks and the world's `lineOfSight`
// algorithm are re-paired in from `encounterId` rather than snapshotted, by
// `worldFor` below: they never change, and one of them is a function so it
// could not be serialized even if it did. (`buildEncounter` never actually
// populates `CombatWorld.lineOfSight` today, so the validator falls through
// to its Bresenham default — but `worldFor` is where that field would come
// from if it were populated, which is the mechanism this comment documents.)
//
// C-26: `reduce` never writes `world.campaignId`, `world.rootSeed`,
// `encounter.encounterId`, `encounter.grid` or `encounter.turnOrder` — no
// event branch touches those five fields, and neither `campaign_started` nor
// `encounter_started` fills the state it declares (that is what makes
// "fold-from-snapshot-plus-events equals fold-from-zero" hold).
// So "fold from zero" here means "fold from the state the campaign's own
// bracket events declare", not from an empty object: `initialWorldState` and
// `initialEncounterState` below build those two halves, and `createCampaign`,
// `startEncounter` and `loadCampaign` all use the same two functions so a
// reloaded campaign and a live one cannot diverge.
//
// Genesis is two events, not one. `campaign_started` at sequence 0 opens the
// stream; a later `encounter_started` opens a bracket inside it. Between them
// — and after every `encounter_resolved` — `state.encounter` is null and the
// campaign is a world with no board, which is the state §4.7's step 4 needs
// and the old single-genesis model could not express.
import type { EventStore } from "@ai-dm/memory";
import type { BuiltEncounter, CombatWorld } from "@ai-dm/rules-engine";
import {
  CampaignStartedPayload,
  EncounterResolvedPayload,
  EncounterStartedPayload,
  NarrativeEmittedPayload,
  reduce,
} from "@ai-dm/schemas";
import type { CampaignState, EncounterState, GameEvent, WorldState } from "@ai-dm/schemas";
import { buildEncounterById } from "../encounters/index.js";

/**
 * How many past narrations the narrative agent is shown. Two: enough to stop
 * it reusing a verb it just used, small enough that the uncached tier stays
 * cheap. Not in `CampaignState` — see the doc comment on `recentNarrations`.
 */
export const NARRATION_WINDOW = 2;

export interface Campaign {
  state: CampaignState;
  /**
   * The open encounter's static half: stat blocks, the scene card, and the
   * `CombatWorld` fields the projection cannot serialize. Null exactly when
   * `state.encounter` is null.
   *
   * The two are separate fields because only one of them belongs in the
   * projection, so they *could* disagree — which is why nothing reads this
   * field directly. `builtOf` below is the single reader, and it derives the
   * bracket's open/closed answer from `state.encounter` (the source of truth,
   * since it is what `reduce` folds) before consulting this at all, then
   * refuses a `built` describing a different encounter. The three functions
   * that write the bracket — `createCampaign`, `startEncounter`,
   * `resolveEncounter` — each set both halves in one place.
   *
   * That is not the whole set of writers, though: `pipeline.ts`'s `emit`
   * assigns `campaign.state = next` for every event it appends and never
   * touches `built` at all, so it is a fourth path that CAN set one without
   * the other — it just doesn't today, because no `emit` call site passes a
   * bracket event. `emit` is the natural home for the `encounter_resolved`
   * that §4.7's step 4 will eventually append there, and the day it does,
   * `built` would go stale exactly at that call. `builtOf`'s guard above is
   * what catches that the moment anything reads the board afterward — that
   * is the design working as intended, not a hole this comment is papering
   * over.
   *
   * There is deliberately no separate `sceneEnglish` field: it was exactly
   * `built.sceneEnglish`, and a second copy would be a second thing to keep
   * null in step with the bracket for no gain. Read it through `builtOf`.
   */
  built: BuiltEncounter | null;
  /** The sequence the next appended event will take. */
  nextSequence: number;
  /**
   * The last `NARRATION_WINDOW` narrations, oldest first. A projection of the
   * `narrative_emitted` events in the log, held here rather than in
   * `CampaignState` because the client has no use for it and `reduce` keeps
   * treating that event as a no-op. Rebuilt by `loadCampaign`, so a reconnect
   * does not hand the narrator an empty memory.
   *
   * Campaign-scoped, not encounter-scoped: it survives `resolveEncounter` for
   * the same reason `world.appliedClientMessageIds` does — the narrator's
   * memory of what it just said is not a property of the fight.
   */
  recentNarrations: string[];
}

/**
 * The three ports every campaign write needs, named once so the four
 * functions below cannot drift apart on them. `clock` and `uuid` are ports
 * rather than globals for the same reason `pipeline.ts`'s are: a test can
 * assert an exact event stream, and a replayed campaign reproduces the
 * original rather than a new one.
 */
export interface CampaignPorts {
  store: EventStore;
  clock: () => string;
  uuid: () => string;
}

export interface CreateCampaignInput extends CampaignPorts {
  campaignId: string;
  rootSeed: number;
}

export interface StartEncounterInput extends CampaignPorts {
  campaign: Campaign;
  encounterId: string;
}

export interface ResolveEncounterInput extends CampaignPorts {
  campaign: Campaign;
  /** Open string, matching `EncounterResolvedPayload` — persisted forever. */
  outcome: string;
  survivorIds: string[];
}

/**
 * The campaign half of the projection, rebuilt from `campaign_started`'s
 * payload rather than read out of a persisted `state` field. `campaignId` is
 * not in that payload because it is the stream key — every event in the log
 * already carries it, and `loadCampaign` is called with it.
 */
function initialWorldState(input: { campaignId: string; rootSeed: number }): WorldState {
  return {
    campaignId: input.campaignId,
    rootSeed: input.rootSeed,
    appliedClientMessageIds: [],
  };
}

/**
 * The encounter half, rebuilt from `encounter_started`'s `encounterId` via
 * the catalogue — the three fields `reduce` never writes (`encounterId`,
 * `grid`, `turnOrder`) plus the starting combatants, round and turn index.
 *
 * `reduce` cannot do this itself: the catalogue lives downstream in
 * `apps/server` and `@ai-dm/schemas` may never import it (invariant 5). So
 * `encounter_started` is a guard-only no-op in the fold, and the two callers
 * that own a catalogue — `startEncounter` and `loadCampaign` — substitute
 * this value straight after running that guard.
 */
function initialEncounterState(built: BuiltEncounter): EncounterState {
  return {
    encounterId: built.encounterId,
    grid: built.world.grid,
    combatants: [...built.world.combatants],
    turnOrder: [...built.turnOrder],
    currentActorIndex: 0,
    round: 1,
  };
}

/**
 * One event envelope. All three bracket events differ only in type and
 * payload, and stamping them in one place is what keeps `campaignId`,
 * `eventId` and `timestamp` from drifting between them.
 */
function envelope(input: {
  ports: CampaignPorts;
  campaignId: string;
  sequence: number;
  type: GameEvent["type"];
  payload: GameEvent["payload"];
}): GameEvent {
  return {
    eventId: input.ports.uuid(),
    campaignId: input.campaignId,
    sequence: input.sequence,
    timestamp: input.ports.clock(),
    type: input.type,
    payload: input.payload,
  };
}

/**
 * Opens the stream. The campaign exists, has a world, and has no board:
 * `state.encounter` is null until `startEncounter` runs.
 *
 * Sequence 0 is the campaign's own genesis event. Without it, a log with no
 * turns yet is indistinguishable from a campaign that does not exist, and
 * `loadCampaign` could not tell them apart.
 *
 * The payload deliberately carries only `rootSeed`, not `state` itself:
 * nothing reads a persisted `state` field (`loadCampaign` rebuilds it via
 * `initialWorldState`, on purpose), and including it would alias the exact
 * object returned as `campaign.state` into the store's own event, which the
 * in-memory store then holds by reference. `encounter_started` follows the
 * same rule with `encounterId` — a bracket event names a thing and never
 * snapshots it.
 */
export async function createCampaign(input: CreateCampaignInput): Promise<Campaign> {
  const state: CampaignState = {
    world: initialWorldState({ campaignId: input.campaignId, rootSeed: input.rootSeed }),
    encounter: null,
  };

  const genesis = envelope({
    ports: input,
    campaignId: input.campaignId,
    sequence: 0,
    type: "campaign_started",
    payload: CampaignStartedPayload.parse({ rootSeed: input.rootSeed }),
  });
  await input.store.append(input.campaignId, [genesis]);

  return { state, built: null, nextSequence: 1, recentNarrations: [] };
}

/**
 * Opens a bracket on an existing campaign, in place. Mutates rather than
 * returns a fresh record because campaigns are shared objects — two sockets
 * alias the same `Campaign` and `pipeline.ts`'s `emit` already advances
 * `state`/`nextSequence` on it in place (`http.ts`'s `CampaignRegistry`,
 * CRITICAL-1). Returning a copy here would leave the registry and every live
 * socket holding the pre-encounter one.
 *
 * The catalogue lookup runs first and the fold guard runs second, both before
 * the append: an unknown encounter id or an already-open bracket must not
 * leave a refused event in an append-only log.
 */
export async function startEncounter(input: StartEncounterInput): Promise<Campaign> {
  const { campaign } = input;
  const campaignId = campaign.state.world.campaignId;
  const built = buildEncounterById(input.encounterId);

  const event = envelope({
    ports: input,
    campaignId,
    sequence: campaign.nextSequence,
    type: "encounter_started",
    payload: EncounterStartedPayload.parse({ encounterId: input.encounterId }),
  });

  // `reduce` owns the non-overlap invariant and throws if a bracket is
  // already open; it returns the state otherwise, unable to fill the bracket
  // it just opened (see `initialEncounterState`). So run it for the guard,
  // then substitute the rebuilt board.
  const guarded = reduce(campaign.state, event);
  await input.store.append(campaignId, [event]);

  campaign.state = { ...guarded, encounter: initialEncounterState(built) };
  campaign.built = built;
  campaign.nextSequence += 1;
  return campaign;
}

/**
 * Closes the open bracket, in place, for the same aliasing reason
 * `startEncounter` mutates.
 *
 * `encounterId` comes from the open encounter rather than from a caller
 * argument: it is the one field of this payload that already has an
 * authoritative source, and taking it from anywhere else would let a caller
 * record the resolution of a fight the campaign was not in.
 */
export async function resolveEncounter(input: ResolveEncounterInput): Promise<Campaign> {
  const { campaign } = input;
  const campaignId = campaign.state.world.campaignId;
  const { encounterId } = encounterOf(campaign);

  const event = envelope({
    ports: input,
    campaignId,
    sequence: campaign.nextSequence,
    type: "encounter_resolved",
    payload: EncounterResolvedPayload.parse({
      encounterId,
      outcome: input.outcome,
      survivorIds: [...input.survivorIds],
    }),
  });

  // As in `startEncounter`: fold first so a refused event is never appended.
  // Unlike it, `reduce` can finish the job here — clearing a bracket needs no
  // catalogue — so this state is used as-is.
  const next = reduce(campaign.state, event);
  await input.store.append(campaignId, [event]);

  campaign.state = next;
  campaign.built = null;
  campaign.nextSequence += 1;
  return campaign;
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

  // A log whose first event is not `campaign_started` is corrupt — `reduce`
  // will happily fold whatever is there, but `CampaignStartedPayload.parse`
  // below would fail with a raw, undiagnosable `ZodError` if the actual
  // event 0 shares no fields with what we expect here.
  if (genesis.type !== "campaign_started") {
    throw new Error(
      `Campaign ${input.campaignId}'s log does not start with campaign_started ` +
        `(sequence 0 is a ${genesis.type})`,
    );
  }

  const { rootSeed } = CampaignStartedPayload.parse(genesis.payload);
  let state: CampaignState = {
    world: initialWorldState({ campaignId: input.campaignId, rootSeed }),
    encounter: null,
  };
  let built: BuiltEncounter | null = null;

  // Folded one event at a time rather than through `fold`, because a campaign
  // log is not foldable by `reduce` alone: every `encounter_started` opens a
  // bracket whose contents only the catalogue can rebuild. `reduce` still
  // sees every event — it holds the bracket invariants — and this loop only
  // supplies the two things it cannot reach.
  //
  // Two real costs this carries that the split does not otherwise name:
  //
  // - `buildEncounterById` re-reads and re-parses SRD files on every call,
  //   with no memoization (`encounters/index.ts`). A campaign with N
  //   resolved fights therefore does N blocking `readFileSync` + zod passes
  //   on the event loop for every cold `registry.get`, even though only the
  //   final `built` survives past this loop. That is NOT N-1 wasted builds,
  //   though: each intermediate one is still needed while it runs, because
  //   its `initialEncounterState` is what seeds the fold for that
  //   encounter's own events (the combatants `state_delta_applied` mutates,
  //   the turn order `scene_changed` walks) before the next
  //   `encounter_resolved` discards it. Memoizing the catalogue lookup would
  //   still be a legitimate follow-up; it is out of scope for this commit.
  // - Load success is coupled to the catalogue's entire history, not just
  //   its current contents: retiring or renaming an encounter id makes every
  //   campaign that ever fought it permanently unloadable, because
  //   `UnknownEncounterError` propagates straight out of `buildEncounterById`
  //   here with nothing to catch it. A catalogue that only ever grows never
  //   hits this; one that prunes or renames needs an answer this loop does
  //   not have.
  for (const event of events.slice(1)) {
    state = reduce(state, event);
    if (event.type === "encounter_started") {
      built = buildEncounterById(EncounterStartedPayload.parse(event.payload).encounterId);
      state = { ...state, encounter: initialEncounterState(built) };
    } else if (event.type === "encounter_resolved") {
      // `reduce` already cleared `state.encounter`; the static half goes with
      // it, so a campaign between fights reloads with both halves null.
      built = null;
    }
  }

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
    recentNarrations: recentNarrations.slice(-NARRATION_WINDOW),
  };
}

/**
 * The open encounter, or a throw.
 *
 * `campaign.state.encounter` is nullable because a campaign between fights is
 * now representable, but every caller below runs on the turn path, where an
 * absent board is not a state to handle — it is a corrupt log or a producer
 * bug, the same class `reduce` throws on. The one place a closed bracket is
 * an ordinary answer rather than a fault is `pipeline.ts`'s `structured_action`
 * refusal, which reads `campaign.state.encounter` directly and yields an
 * `error` frame instead of calling this.
 *
 * Narrow once through this at each point that reads the board, rather than
 * re-narrowing per field: `emit` replaces `campaign.state` wholesale as a turn
 * progresses, so a binding taken earlier would be describing a board that has
 * already moved.
 */
export function encounterOf(campaign: Campaign): EncounterState {
  const { encounter } = campaign.state;
  if (encounter === null) {
    throw new Error(`Campaign ${campaign.state.world.campaignId} has no encounter open`);
  }
  return encounter;
}

/**
 * The open encounter's static half, or a throw. The only reader of
 * `Campaign.built` — see that field's doc comment for why nothing reads it
 * directly.
 *
 * The projection is consulted first, so a `built` left behind by a bug can
 * never be served for a closed bracket; the id check then catches the
 * opposite drift, a `built` describing some other encounter than the one the
 * fold says is open. Neither is reachable today, which is the point: they
 * fail loudly at the seam rather than quietly handing the narrator one
 * encounter's scene card and the validator another's stat blocks.
 */
export function builtOf(campaign: Campaign): BuiltEncounter {
  const encounter = encounterOf(campaign);
  const { built } = campaign;
  if (built === null || built.encounterId !== encounter.encounterId) {
    throw new Error(
      `Campaign ${campaign.state.world.campaignId} has encounter ${encounter.encounterId} ` +
        `open but built encounter ${built?.encounterId ?? "none"}`,
    );
  }
  return built;
}

/**
 * The validator and the resolver want a `CombatWorld`; the projection holds
 * only its serializable half. This is where the two are married, and the only
 * place that knows the difference.
 */
export function worldFor(campaign: Campaign): CombatWorld {
  const encounter = encounterOf(campaign);
  return {
    ...builtOf(campaign).world,
    grid: encounter.grid,
    combatants: encounter.combatants,
  };
}
