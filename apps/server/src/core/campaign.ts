// A campaign is its projection plus the static encounter data that projection
// is not allowed to contain. Stat blocks and the world's `lineOfSight`
// algorithm are re-paired in from `encounterId` rather than snapshotted, by
// `worldFor` below: they never change, and one of them is a function so it
// could not be serialized even if it did. (`buildEncounter` never actually
// populates `CombatWorld.lineOfSight` today, so the validator falls through
// to its Bresenham default — but `worldFor` is where that field would come
// from if it were populated, which is the mechanism this comment documents.)
//
// `reduce` never writes `world.campaignId`, `world.rootSeed`,
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
import type { AuthoredWorld, BuiltEncounter, CombatWorld } from "@ai-dm/rules-engine";
import {
  CampaignStartedPayload,
  EncounterResolvedPayload,
  EncounterStartedPayload,
  NarrativeEmittedPayload,
  reduce,
  sceneFromGenesis,
} from "@ai-dm/schemas";
import type {
  CampaignState,
  DerivedCharacter,
  EncounterState,
  GameEvent,
  WorldState,
} from "@ai-dm/schemas";
import { buildEncounterById, loadCharacter } from "../encounters/index.js";
import { loadWorld, UnknownWorldError } from "../world/index.js";

/**
 * How many past narrations the narrative agent is shown. Two: enough to stop
 * it reusing a verb it just used, small enough that the uncached tier stays
 * cheap. Not in `CampaignState` — see the doc comment on `recentNarrations`.
 */
export const NARRATION_WINDOW = 2;

/**
 * A scene campaign's static half: the authored world its `SceneSnapshot`
 * indexes into, and the solo PC's derived sheet. Mirrors `BuiltEncounter`'s
 * role for the combat half — content that never changes and, for `authored`,
 * holds `Map`s that could not be serialized onto `WorldState` even if the
 * design wanted a second copy of authored data in the log.
 */
export interface SceneStatics {
  authored: AuthoredWorld;
  character: DerivedCharacter;
}

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
   * that §4.7's step 5 will eventually append there, and the day it does,
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
  /**
   * The scene half's statics, mirroring `built`'s doc contract exactly: null
   * exactly when `state.world.scene` is null, and the single writer for both
   * (`createCampaign`, or `loadCampaign` re-deriving it from the genesis ids)
   * sets them together. `sceneStaticsOf` below is the one reader, for the
   * same disagreement-guarding reason `builtOf` is `built`'s.
   *
   * Combat-only campaigns and scene campaigns are otherwise siblings, not a
   * union: a campaign has at most one bracket and at most one scene, and
   * nothing in this plan lets a single campaign have both at once — but
   * nothing enforces that either, since the two halves are independent
   * fields on independent projections (`state.encounter` and
   * `state.world.scene`).
   */
  sceneStatics: SceneStatics | null;
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
  /**
   * Retrieved episode summaries for the current node, English. Refreshed
   * only when the current node changes — the query is the node's card and
   * the NPCs there, both static while the campaign stands at one node, so a
   * six-turn conversation costs one embedding call rather than six
   * (episodic-memory spec, Decision 7). A cache, not a projection: a
   * reloaded campaign starts with an empty list and refills on the next
   * node transition.
   */
  recentMemories: string[];
  /**
   * The node id `recentMemories` was retrieved for, or `null` before the
   * first retrieval. `sceneNarrate` (`pipeline.ts`) refreshes
   * `recentMemories` exactly when this disagrees with the current node —
   * `null` on a freshly loaded campaign guarantees the first scene turn
   * after a load always retrieves rather than serving a stale empty cache.
   */
  memoriesForNodeId: string | null;
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
  /**
   * Present ⇒ a scene campaign: the genesis quartet
   * (`worldId`/`startingNodeId`/`startingDay`/`characterId`) is derived from
   * these statics and written into `campaign_started`'s payload. Absent ⇒ a
   * combat-only campaign, byte-identical to every genesis before this task.
   */
  scene?: SceneStatics;
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
 *
 * `scene` comes from `sceneFromGenesis`, the one definition of the
 * genesis-quartet-to-`SceneSnapshot` rebuild (`@ai-dm/schemas`). Unlike
 * `initialEncounterState` below, this needs no catalogue lookup and
 * therefore no substitution step at load time — `loadCampaign` calls this
 * same function with the parsed genesis payload, not a second projector.
 *
 * `sceneFromGenesis` cannot resolve the hero's starting HP itself (it stays
 * pure); this is the one place both `createCampaign` and `loadCampaign`
 * build a starting `WorldState`, so it resolves the character once and
 * passes its `maxHp` in — a fresh campaign always starts at full HP.
 */
function initialWorldState(input: {
  campaignId: string;
  genesis: CampaignStartedPayload;
}): WorldState {
  const { characterId } = input.genesis;
  const heroMaxHp = characterId === undefined ? undefined : loadCharacter(characterId).maxHp;
  return {
    campaignId: input.campaignId,
    rootSeed: input.genesis.rootSeed,
    appliedClientMessageIds: [],
    scene: sceneFromGenesis(input.genesis, heroMaxHp),
  };
}

/**
 * The encounter half, rebuilt from `encounter_started`'s `encounterId` via
 * the catalogue — the three fields `reduce` never writes (`encounterId`,
 * `grid`, `turnOrder`) plus the starting combatants, round and turn index.
 *
 * `reduce` fills this from `encounter_started`'s payload itself since §4.7
 * step 5 (spec Decision 2). What remains here is the legacy path: a payload
 * persisted before that step names an encounter and carries no board, so
 * `loadCampaign` rebuilds one through the catalogue for those logs alone.
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
 * The payload deliberately carries only `rootSeed` (plus, for a scene
 * campaign, the genesis quartet derived from `input.scene`) — never `state`
 * itself: nothing reads a persisted `state` field (`loadCampaign` rebuilds it
 * via `initialWorldState`, on purpose), and including it would alias the
 * exact object returned as `campaign.state` into the store's own event, which
 * the in-memory store then holds by reference.
 *
 * `encounter_started` is the one deliberate exception, taken in §4.7 step 5:
 * it carries its initial board. That is not mutable state leaking into the
 * log — it is a deterministic starting condition, the same class of thing
 * this payload's own `startingNodeId` records, and for the same replay
 * reason: editing an encounter's spawns in the catalogue must not
 * retroactively move where an existing campaign's fight began. Evolving
 * combatant state still travels only in `state_delta_applied`.
 *
 * The quartet is no exception: `worldId`/`startingNodeId`/
 * `startingDay` come from `input.scene.authored`, `characterId` from
 * `input.scene.character.characterId` — never a `SceneSnapshot` itself.
 */
export async function createCampaign(input: CreateCampaignInput): Promise<Campaign> {
  const { scene } = input;
  const genesisPayload = CampaignStartedPayload.parse(
    scene === undefined
      ? { rootSeed: input.rootSeed }
      : {
          rootSeed: input.rootSeed,
          worldId: scene.authored.worldId,
          startingNodeId: scene.authored.startingNodeId,
          startingDay: scene.authored.startingDay,
          characterId: scene.character.characterId,
        },
  );

  const state: CampaignState = {
    world: initialWorldState({ campaignId: input.campaignId, genesis: genesisPayload }),
    encounter: null,
  };

  const genesis = envelope({
    ports: input,
    campaignId: input.campaignId,
    sequence: 0,
    type: "campaign_started",
    payload: genesisPayload,
  });
  await input.store.append(input.campaignId, [genesis]);

  return {
    state,
    built: null,
    sceneStatics: scene ?? null,
    nextSequence: 1,
    recentNarrations: [],
    recentMemories: [],
    memoriesForNodeId: null,
  };
}

/**
 * Opens a bracket on an existing campaign, in place. Mutates rather than
 * returns a fresh record because campaigns are shared objects — two sockets
 * alias the same `Campaign` and `pipeline.ts`'s `emit` already advances
 * `state`/`nextSequence` on it in place (`http.ts`'s `CampaignRegistry`).
 * Returning a copy here would leave the registry and every live
 * socket holding the pre-encounter one.
 *
 * The catalogue lookup runs first and the fold guard runs second, both before
 * the append: an unknown encounter id or an already-open bracket must not
 * leave a refused event in an append-only log.
 */
export async function startEncounter(input: StartEncounterInput): Promise<Campaign> {
  const { campaign } = input;
  const campaignId = campaign.state.world.campaignId;
  // Floored at 1, never at the persisted value directly: a hero who last won
  // a fight only by stabilizing (Unconscious, 0 HP) would otherwise spawn
  // already face-down. Natural recovery from Stable stays out of scope; this
  // floor is what keeps that gap from cascading into an unplayable spawn
  // (death-saves-persistent-hp spec, Decision 7). `undefined` for a
  // combat-only campaign — `scene` is always null for one — keeps spawning
  // byte-for-byte unchanged.
  const heroCurrentHp =
    campaign.state.world.scene === null
      ? undefined
      : Math.max(1, campaign.state.world.scene.heroHp);
  const built = buildEncounterById(input.encounterId, heroCurrentHp);

  const event = envelope({
    ports: input,
    campaignId,
    sequence: campaign.nextSequence,
    type: "encounter_started",
    payload: EncounterStartedPayload.parse({
      encounterId: input.encounterId,
      grid: built.world.grid,
      combatants: built.world.combatants,
      turnOrder: built.turnOrder,
    }),
  });

  // `reduce` now both guards the non-overlap invariant AND fills the bracket
  // from the payload written above (spec Decision 2), so there is no
  // substitution step left here — the fold's own answer is used as-is, the
  // way `resolveEncounter`'s already is.
  const next = reduce(campaign.state, event);
  await input.store.append(campaignId, [event]);

  campaign.state = next;
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

  const genesisPayload = CampaignStartedPayload.parse(genesis.payload);
  let state: CampaignState = {
    world: initialWorldState({ campaignId: input.campaignId, genesis: genesisPayload }),
    encounter: null,
  };
  let built: BuiltEncounter | null = null;

  // The scene half's substitution step — `sceneFromGenesis` needed none (it
  // is what `initialWorldState` just called), but `sceneStatics` is a live
  // `AuthoredWorld`/`DerivedCharacter` pair, not serializable data, so it is
  // re-derived from the genesis ids exactly the way `built` below is
  // re-derived from `encounterId`.
  //
  // Gated on `state.world.scene`, the projection just computed, rather than
  // re-deriving the genesis quartet's own presence predicate (that check
  // already happened once, inside `sceneFromGenesis`) — the two are then
  // structurally incapable of disagreeing, which is `sceneStatics`'s whole
  // doc contract ("null exactly when `state.world.scene` is null").
  // `characterId` still needs its own narrowing: it is not part of
  // `SceneSnapshot`, so its presence has to be read off the payload, but
  // `state.world.scene !== null` already guarantees it via
  // `CampaignStartedPayload`'s all-or-none `.refine`.
  //
  // `authored.worldId !== scene.worldId` is the same load-time coupling
  // `buildEncounterById` already has for `encounterId` (documented in the
  // loop below): a world that has been renamed since this campaign started
  // makes it permanently unloadable. `loadWorld` here always returns
  // `apps/server`'s one authored world (`data/world/`), so the check is
  // "does this deployment's world still match the one this campaign began
  // in" — not a catalogue lookup, since there is no catalogue of worlds.
  const { scene } = state.world;
  const { characterId } = genesisPayload;
  let sceneStatics: SceneStatics | null = null;
  if (scene !== null && characterId !== undefined) {
    const authored = loadWorld();
    if (authored.worldId !== scene.worldId) throw new UnknownWorldError(scene.worldId);
    sceneStatics = { authored, character: loadCharacter(characterId) };
  }

  // Folded one event at a time rather than through `fold`, because `built`
  // is not something `reduce` can ever supply: a bracket's stat blocks come
  // from the catalogue, never from the log, board-carrying payload or not
  // (`reduce` fills `state.encounter` itself for those — see the loop's own
  // comment for the one exception, a legacy payload with no board). `reduce`
  // still sees every event and holds every bracket invariant; this loop only
  // adds the catalogue lookup, resolved once, after the loop, from whatever
  // `state.encounter` the fold actually lands on — see the comment below the
  // loop for why.
  //
  // One real cost the legacy path (and a still-open bracket) still carries,
  // unavoidably: `buildEncounterById` re-reads and re-parses SRD files on
  // every call, with no memoization (`encounters/index.ts`). Load success is
  // therefore coupled to the catalogue's contents at that one id: retiring
  // or renaming it makes that one campaign unloadable, because
  // `UnknownEncounterError` propagates straight out of `buildEncounterById`
  // here with nothing to catch it. A HISTORICAL (already-resolved) fight in
  // a modern log carries no such risk at all — its build, deferred below, is
  // never attempted, so retiring or renaming an id no longer touches a
  // campaign whose only fight against it is already over. A catalogue that
  // only ever grows never hits this; one that prunes or renames needs an
  // answer this loop does not have for a legacy payload or an open bracket.
  for (const event of events.slice(1)) {
    state = reduce(state, event);
    if (event.type === "encounter_started") {
      // Step 5 and later logs carry the board and `reduce` has already
      // filled the bracket, so the SUBSTITUTION — patching a rebuilt board
      // into `state.encounter` — disappears for those logs; only a payload
      // persisted BEFORE step 5 leaves `state.encounter` null and still
      // needs it immediately: `initialEncounterState(legacy)` is what seeds
      // the fold for that encounter's own events (`scene_changed` reads
      // `turnOrder`/`currentActorIndex`/`round` straight off the seed on the
      // first `turn_advanced` of a bracket), so this build cannot be
      // deferred the way the modern arm's can.
      if (state.encounter === null) {
        const legacy = buildEncounterById(EncounterStartedPayload.parse(event.payload).encounterId);
        state = { ...state, encounter: initialEncounterState(legacy) };
        built = legacy;
      } else {
        // Deferred rather than built here: `state.encounter` already has its
        // board (the fold supplied it), so nothing downstream in this loop
        // reads `built` before the next `encounter_started`/
        // `encounter_resolved` overwrites or clears it again — only its
        // FINAL value, once the whole log has been folded, ever escapes.
        // Building on every iteration was one `buildEncounterById` call per
        // historical fight for a result every call but the last one
        // immediately discarded; null here and a single build after the
        // loop (once, only if a bracket is still open) is the same
        // observable result for one catalogue lookup instead of N.
        built = null;
      }
    } else if (event.type === "encounter_resolved") {
      // `reduce` already cleared `state.encounter`; the static half goes with
      // it, so a campaign between fights reloads with both halves null.
      built = null;
    }
  }

  // The modern-payload build deferred above: resolved exactly once, for
  // whichever encounter the fold leaves open once the whole log has been
  // read — never for one a later event has already closed or replaced.
  if (built === null && state.encounter !== null) {
    built = buildEncounterById(state.encounter.encounterId);
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
    sceneStatics,
    nextSequence: (last?.sequence ?? 0) + 1,
    recentNarrations: recentNarrations.slice(-NARRATION_WINDOW),
    // A cache, not a projection — see `Campaign.recentMemories`'s doc
    // comment. A reload always starts empty and re-retrieves on the next
    // node transition rather than replaying the log to rebuild it.
    recentMemories: [],
    memoriesForNodeId: null,
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
 * The scene's static half, or a throw. The only reader of `Campaign
 * .sceneStatics` — see that field's doc comment for why nothing reads it
 * directly. Mirrors `builtOf` exactly: the projection is consulted first, so
 * statics left behind by a bug can never be served for a campaign with no
 * scene open; the id check then catches the opposite drift, statics
 * describing some other world than the one the projection says is open.
 */
export function sceneStaticsOf(campaign: Campaign): SceneStatics {
  const { scene } = campaign.state.world;
  if (scene === null) {
    throw new Error(`Campaign ${campaign.state.world.campaignId} has no scene open`);
  }
  const { sceneStatics } = campaign;
  if (sceneStatics === null || sceneStatics.authored.worldId !== scene.worldId) {
    throw new Error(
      `Campaign ${campaign.state.world.campaignId} has scene world ${scene.worldId} ` +
        `open but scene statics world ${sceneStatics?.authored.worldId ?? "none"}`,
    );
  }
  return sceneStatics;
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
