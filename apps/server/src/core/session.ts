// A session is its projection plus the static encounter data that projection
// is not allowed to contain. Stat blocks and the world's `lineOfSight`
// algorithm are re-paired in from `encounterId` rather than snapshotted, by
// `worldFor` below: they never change, and one of them is a function so it
// could not be serialized even if it did. (`buildEncounter` never actually
// populates `CombatWorld.lineOfSight` today, so the validator falls through
// to its Bresenham default — but `worldFor` is where that field would come
// from if it were populated, which is the mechanism this comment documents.)
//
// C-26: `reduce` never writes `sessionId`, `rootSeed`, `encounterId`, `grid`
// or `turnOrder` — no event branch touches those five `SessionState` fields,
// and `session_snapshot` is deliberately a no-op in the projection (that is
// what makes "fold-from-snapshot-plus-events equals fold-from-zero" hold).
// So "fold from zero" here means "fold from the session-creation state", not
// from an empty object: `initialState` below is that genesis state, and both
// `createSession` and `loadSession` build it the same way before folding
// anything on top of it.
import { z } from "zod";
import type { BuiltEncounter, CombatWorld } from "@ai-dm/rules-engine";
import { fold, NarrativeEmittedPayload } from "@ai-dm/schemas";
import type { GameEvent, SessionState } from "@ai-dm/schemas";
import { buildEncounterById } from "../encounters/index.js";
import type { EventStore } from "./event-store.js";

/** Sequence 0's payload. Parsed rather than cast — it is the only thing that
 * tells a reloaded session which encounter it is. */
const GenesisPayload = z.object({ encounterId: z.string(), rootSeed: z.number().int() });

/**
 * How many past narrations the narrative agent is shown. Two: enough to stop
 * it reusing a verb it just used, small enough that the uncached tier stays
 * cheap. Not in `SessionState` — see the doc comment on `recentNarrations`.
 */
export const NARRATION_WINDOW = 2;

export interface Session {
  state: SessionState;
  built: BuiltEncounter;
  /** The sequence the next appended event will take. */
  nextSequence: number;
  /** The encounter's narrator-facing scene card. Static; resolved once here. */
  sceneEnglish: string;
  /**
   * The last `NARRATION_WINDOW` narrations, oldest first. A projection of the
   * `narrative_emitted` events in the log, held here rather than in
   * `SessionState` because the client has no use for it and `reduce` keeps
   * treating that event as a no-op. Rebuilt by `loadSession`, so a reconnect
   * does not hand the narrator an empty memory.
   */
  recentNarrations: string[];
}

export interface CreateSessionInput {
  sessionId: string;
  encounterId: string;
  rootSeed: number;
  store: EventStore;
  clock: () => string;
  uuid: () => string;
}

/**
 * The genesis `SessionState`: the five fields `reduce` never writes
 * (`sessionId`, `rootSeed`, `encounterId`, `grid`, `turnOrder`), plus the
 * starting combatants, round and turn index. `createSession` folds nothing
 * on top of this but the genesis event; `loadSession` rebuilds this exact
 * value before folding the rest of the log onto it.
 */
function initialState(input: {
  sessionId: string;
  rootSeed: number;
  built: BuiltEncounter;
}): SessionState {
  return {
    sessionId: input.sessionId,
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

export async function createSession(input: CreateSessionInput): Promise<Session> {
  const built = buildEncounterById(input.encounterId);
  const state = initialState({ sessionId: input.sessionId, rootSeed: input.rootSeed, built });

  // Sequence 0 is the session's own genesis event. Without it, a log with no
  // turns yet is indistinguishable from a session that does not exist, and
  // `loadSession` could not tell them apart.
  //
  // The payload deliberately carries only `encounterId`/`rootSeed`, not
  // `state` itself: nothing reads a persisted `state` field (`loadSession`
  // rebuilds it from `encounterId`/`rootSeed` via `initialState`, on purpose
  // — see `GenesisPayload` below), and including it would alias the exact
  // object returned as `session.state` into the store's own event, which the
  // in-memory store then holds by reference.
  const genesis: GameEvent = {
    eventId: input.uuid(),
    sessionId: input.sessionId,
    sequence: 0,
    timestamp: input.clock(),
    type: "session_snapshot",
    payload: { encounterId: input.encounterId, rootSeed: input.rootSeed },
  };
  await input.store.append(input.sessionId, [genesis]);

  return { state, built, nextSequence: 1, sceneEnglish: built.sceneEnglish, recentNarrations: [] };
}

export async function loadSession(input: {
  sessionId: string;
  store: EventStore;
}): Promise<Session | null> {
  const events = await input.store.readSince(input.sessionId, -1);
  const genesis = events[0];
  if (genesis === undefined) return null;

  // A log whose first event is not `session_snapshot` is corrupt — `reduce`
  // will happily fold whatever is there, but `GenesisPayload.parse` below
  // would fail with a raw, undiagnosable `ZodError` if the actual event 0
  // shares no fields with what we expect here.
  if (genesis.type !== "session_snapshot") {
    throw new Error(
      `Session ${input.sessionId}'s log does not start with session_snapshot ` +
        `(sequence 0 is a ${genesis.type})`,
    );
  }

  const { encounterId, rootSeed } = GenesisPayload.parse(genesis.payload);
  const built = buildEncounterById(encounterId);
  const state = fold(
    initialState({ sessionId: input.sessionId, rootSeed, built }),
    events.slice(1),
  );

  // A projection of the `narrative_emitted` events in the log, not something
  // `reduce` folds — see the doc comment on `Session.recentNarrations`.
  const recentNarrations: string[] = [];
  for (const event of events) {
    if (event.type !== "narrative_emitted") continue;
    const parsed = NarrativeEmittedPayload.safeParse(event.payload);
    // Tolerant on purpose: this is a prompt-quality nicety, and a payload
    // from before this convention existed must not stop a session from
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
export function worldFor(session: Session): CombatWorld {
  return {
    ...session.built.world,
    grid: session.state.grid,
    combatants: session.state.combatants,
  };
}
