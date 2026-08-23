// Top-level wiring. It owns the campaign lifecycle and nothing else: the store
// folds, the components render, the connection carries frames.
import { useCallback, useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import type {
  ActionAffordance,
  ClientMessage,
  EncounterCatalogue,
  ServerFrame,
  Tile,
  TurnAffordances,
} from "@ai-dm/schemas";
import { connect } from "./net/connection.js";
import type { Connection, ConnectionStatus, WebSocketLike } from "./net/connection.js";
import { createCampaign, fetchCatalogue } from "./net/api.js";
import { applyFrame, initialClientState } from "./state/store.js";
import type { ClientState } from "./state/store.js";
import {
  clearStoredClientState,
  restoreClientState,
  storeClientState,
} from "./state/persistence.js";
import { conclusionOf } from "./state/conclusion.js";
import { buildTurn } from "./turn/build-turn.js";
import { ActionBar } from "./components/ActionBar.js";
import { CombatLog } from "./components/CombatLog.js";
import { ErrorBanner } from "./components/ErrorBanner.js";
import { Grid } from "./components/Grid.js";
import { NarrativePane } from "./components/NarrativePane.js";
import { he } from "./i18n.js";

const ENCOUNTER_ID = "goblin-ambush";

/**
 * Persisted across a refresh so the exit criterion — "refresh mid-fight
 * without losing the campaign" — actually holds. Without this, a reload reads
 * no stored id, calls `POST /campaigns` again, and starts a brand-new fight;
 * `sessionStorage` (not `localStorage`) is deliberate too, since a fight
 * should not survive into a new tab that never joined it.
 *
 * Cleared on an `unknown_campaign` error frame (see the effect below): the
 * server has forgotten the campaign, so an id that outlives it must not be
 * reused on the next mount either.
 *
 * `state/persistence.ts` keeps a second key beside this one, holding the
 * display state the server's projection does not carry. The two are written
 * and cleared together — everywhere this key goes, that one goes with it.
 */
export const CAMPAIGN_STORAGE_KEY = "ai-dm:campaign-id";

export interface AppProps {
  /** Test seam. Production leaves both undefined and the real ones are used. */
  socketFactory?: (url: string) => WebSocketLike;
  wsUrl?: string;
}

export function App(props: AppProps): JSX.Element {
  // Seeded from storage, not from `initialClientState`: a reload has to get
  // its roll log and its narration back, and neither is in the projection the
  // join below is answered with. `restoreClientState` returns exactly
  // `initialClientState` when there is nothing to restore.
  const [state, setState] = useState<ClientState>(() =>
    restoreClientState(sessionStorage.getItem(CAMPAIGN_STORAGE_KEY)),
  );
  const [catalogue, setCatalogue] = useState<EncounterCatalogue | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  // A click is stored together with the affordance set it was made against,
  // and counts only while that exact set is still the live one. `store.ts`
  // builds a new `affordances` object in precisely one place — the
  // `turn_affordances` case — and every other branch either keeps the same
  // reference or nulls it, so reference identity is an exact test for "the
  // offer the player was looking at when they clicked".
  //
  // Membership in `reachableTiles` is NOT the same test and is too weak: the
  // reachable set recentres on the hero each turn, so a tile clicked on turn
  // N is frequently still reachable on turn N+1, and a membership check
  // would let it stay highlighted and committable as a selection the player
  // never made this turn. Identity drops it. This is plain derivation during
  // render — no effect, so it cannot loop.
  const [click, setClick] = useState<{ tile: Tile; against: TurnAffordances } | null>(null);
  const selectedTile = click !== null && click.against === state.affordances ? click.tile : null;
  const selectTile = useCallback(
    (tile: Tile) => {
      setClick(state.affordances === null ? null : { tile, against: state.affordances });
    },
    [state.affordances],
  );
  // A stored campaign id means a fight is already in progress: mounting goes
  // straight to reconnecting rather than showing the start screen again, or
  // a refresh mid-fight would look like it lost the campaign even though
  // `resumeFrom` below would have recovered it.
  const [started, setStarted] = useState(
    () => sessionStorage.getItem(CAMPAIGN_STORAGE_KEY) !== null,
  );

  // `resumeFrom` is read at join time, not captured at connect time — a
  // reconnect must resume from where the client actually got to. Written
  // only from `onFrame` below (the point the sequence actually changes),
  // never during render — React forbids a ref write during render, and a
  // discarded concurrent render could otherwise store a sequence that was
  // never committed.
  const sequenceRef = useRef(0);
  const connectionRef = useRef<Connection | null>(null);
  // A monotonic run id rather than a shared boolean. `<StrictMode>` (which
  // `main.tsx` ships) runs this effect mount -> cleanup -> mount in dev: a
  // single `cancelled` boolean is reset to `false` by the SECOND mount
  // before the FIRST mount's still-pending async IIFE ever reads it, so
  // both runs sail past their cancellation check and both call `connect()`
  // — the first connection is then unreachable (overwritten in
  // `connectionRef`) and never closed, leaking a socket whose 1s retry
  // loop (`net/connection.ts`) runs forever. Each run instead captures its
  // OWN id at the top of the effect; the effect (on cleanup) and every
  // later run bump the shared counter, so a stale run's post-await check
  // (`runIdRef.current !== runId`) is only ever true for a run that has
  // genuinely been superseded, never reset back to "current" by a run that
  // isn't itself.
  const runIdRef = useRef(0);
  // Bumping this re-runs the connect effect: cleanup closes the live socket,
  // the new run re-reads the SAME stored campaign id and rejoins with
  // `resumeFrom`. That is a genuine reconnect rather than a new fight, which
  // is what the spec's error table asks for on `internal_error`.
  const [reconnectNonce, setReconnectNonce] = useState(0);

  useEffect(() => {
    if (!started) return;
    runIdRef.current += 1;
    const runId = runIdRef.current;

    void (async () => {
      // Reuse a stored id rather than minting a new one: `createCampaign` is
      // only ever called when this mount is genuinely starting a fresh
      // fight, never on a reconnect.
      const stored = sessionStorage.getItem(CAMPAIGN_STORAGE_KEY);
      const campaignId = stored ?? (await createCampaign(ENCOUNTER_ID));
      if (stored === null) sessionStorage.setItem(CAMPAIGN_STORAGE_KEY, campaignId);
      if (runIdRef.current !== runId) return;

      const fetched = await fetchCatalogue(ENCOUNTER_ID);
      // The guard that matters: no state update, and no connection, reaches
      // a run that has since been cancelled or superseded.
      if (runIdRef.current !== runId) return;
      setCatalogue(fetched);

      connectionRef.current = connect({
        campaignId,
        ...(props.wsUrl === undefined ? {} : { url: props.wsUrl }),
        ...(props.socketFactory === undefined ? {} : { socketFactory: props.socketFactory }),
        onFrame: (frame: ServerFrame) => {
          setState((previous) => {
            const next = applyFrame(previous, frame);
            sequenceRef.current = next.sequence;
            return next;
          });
        },
        onStatus: setStatus,
        resumeFrom: () => (sequenceRef.current === 0 ? undefined : sequenceRef.current),
      });
    })();

    return () => {
      runIdRef.current += 1;
      connectionRef.current?.close();
      connectionRef.current = null;
    };
  }, [started, reconnectNonce, props.wsUrl, props.socketFactory]);

  // The one teardown that gets back to a clean start screen: drop the stored
  // campaign id, close whatever connection is live, and reset every piece of
  // state a fresh mount would otherwise read as "still in progress". Used by
  // the automatic `unknown_campaign` recovery below — the campaign is gone, so
  // there is nothing to resume and nothing to weigh.
  //
  // `sequenceRef` is part of "every piece": it is not React state, so it
  // survives this reset unless cleared by hand, and the next campaign's join
  // would otherwise carry a dead campaign's `resumeFrom`. Today that is
  // harmless only by accident (a fresh log has just sequence 0, so the
  // server falls back to a full `campaign_state`); if that fallback ever
  // changes, the client would get bare `event` frames against a null
  // snapshot and drop every one of them, hanging on "connecting…".
  const resetToStart = useCallback(() => {
    sessionStorage.removeItem(CAMPAIGN_STORAGE_KEY);
    clearStoredClientState();
    connectionRef.current?.close();
    connectionRef.current = null;
    sequenceRef.current = 0;
    setState(initialClientState);
    setCatalogue(null);
    setStarted(false);
  }, []);

  // `internal_error`: the spec's error table says "Surface, and offer
  // reconnect", and reconnect is meant literally. Both producers
  // (`SequenceConflictError`/`CampaignMismatchError` on a failed append) leave
  // the campaign ALIVE and resumable, and an `error` frame does not close the
  // socket — so tearing the campaign down would throw away a fight the server
  // is still perfectly willing to continue. This keeps the stored id and
  // `sequenceRef` intact and just re-runs the connect effect, which rejoins
  // and resumes. The error is cleared because the reconnect IS the response
  // to it; if the fault persists, the next frame says so again.
  const reconnect = useCallback(() => {
    setState((previous) => ({ ...previous, lastError: null, lastRejection: null }));
    setReconnectNonce((previous) => previous + 1);
  }, []);

  // `unknown_campaign`: the server has forgotten this campaign (error table,
  // design doc `## Error handling`). The stored id must not outlive it, and
  // the only sane recovery is back to the start screen — there is nothing
  // left here to resume. Automatic, unlike `internal_error`'s player-
  // triggered control below: there is nothing to weigh here, the campaign is
  // simply gone.
  useEffect(() => {
    if (state.lastError?.code !== "unknown_campaign") return;
    resetToStart();
  }, [state.lastError, resetToStart]);

  // Once the fight is over, the stored id must not outlive it either —
  // otherwise a later refresh rejoins a campaign that has already ended,
  // with no path back to the start screen short of clearing storage by
  // hand. The live view still shows the victory/defeat screen normally;
  // this only affects what a subsequent mount reads.
  useEffect(() => {
    if (state.snapshot === null) return;
    if (conclusionOf(state.snapshot) === "ongoing") return;
    sessionStorage.removeItem(CAMPAIGN_STORAGE_KEY);
    clearStoredClientState();
  }, [state.snapshot]);

  // The roll log and the narration survive a reload only because they are
  // written down here: `CampaignState` carries neither, so the `campaign_state`
  // frame a fresh join is answered with restores the board and nothing else
  // (`state/persistence.ts` has the full argument).
  //
  // Declared after both teardowns above, and that order is load-bearing:
  // effects run in declaration order, so on the commit where the fight ends
  // or the campaign is disowned, the id is already gone by the time this runs
  // and the guard below stops it writing the log straight back.
  useEffect(() => {
    const campaignId = sessionStorage.getItem(CAMPAIGN_STORAGE_KEY);
    if (campaignId === null) return;
    storeClientState(campaignId, state);
  }, [state]);

  const send = useCallback((message: ClientMessage) => {
    connectionRef.current?.send(message);
  }, []);

  // Shared by both the pre- and post-snapshot renders below: an `error` or
  // `rejected` frame can arrive before the first `campaign_state` (e.g. an
  // `internal_error` on join), so `ErrorBanner` is not exclusive to the
  // post-snapshot view either.
  const dismissError = useCallback(() => {
    setState((previous) => ({ ...previous, lastError: null, lastRejection: null }));
  }, []);

  const commit = useCallback(
    (action: ActionAffordance, targetId?: string) => {
      const actorId = state.affordances?.actorId;
      if (actorId === undefined) return;

      send({
        type: "structured_action",
        clientMessageId: crypto.randomUUID(),
        actorId,
        turn: buildTurn({
          actorId,
          ...(selectedTile === null ? {} : { destinationTile: selectedTile }),
          action,
          ...(targetId === undefined ? {} : { targetId }),
        }),
      });
      setClick(null);
    },
    [send, selectedTile, state.affordances],
  );

  if (!started) {
    return (
      <main>
        <h1>{he.app.title}</h1>
        <button
          type="button"
          onClick={() => {
            setStarted(true);
          }}
        >
          {he.app.startFight}
        </button>
      </main>
    );
  }

  if (state.snapshot === null || catalogue === null) {
    // `ErrorBanner` renders here too: an `error` frame that is not
    // `unknown_campaign` (`internal_error`, `malformed_message`) can arrive
    // on join, before any `campaign_state` — without this, the player would
    // be stuck reading the "connecting…" status forever with no explanation.
    return (
      <main>
        <h1>{he.app.title}</h1>
        <p className="status">
          {status === "reconnecting" ? he.app.reconnecting : he.app.connecting}
        </p>
        <ErrorBanner
          error={state.lastError}
          rejection={state.lastRejection}
          onDismiss={dismissError}
          onReconnect={reconnect}
        />
      </main>
    );
  }

  const conclusion = conclusionOf(state.snapshot);
  const yourTurn = state.affordances !== null && conclusion === "ongoing";

  return (
    <main>
      <h1>{he.app.title}</h1>

      <p className="status">
        {conclusion === "defeat"
          ? he.app.defeat
          : conclusion === "victory"
            ? he.app.victory
            : yourTurn
              ? he.app.yourTurn
              : status === "reconnecting"
                ? he.app.reconnecting
                : he.app.waiting}
      </p>

      <ErrorBanner
        error={state.lastError}
        rejection={state.lastRejection}
        onDismiss={dismissError}
        onReconnect={reconnect}
      />

      <Grid
        snapshot={state.snapshot}
        affordances={state.affordances}
        catalogue={catalogue.combatants}
        selectedTile={selectedTile}
        onTileClick={selectTile}
        onCombatantClick={() => undefined}
      />

      {/* Mounted only while affordances exist, not fed an empty list: an
          `ActionBar` re-derives its target picker from `props.actions` on
          every render but never clears `pendingKey` when the action behind
          it disappears, so a still-mounted bar that goes actions -> [] ->
          actions again can make the picker spring back open with no click
          in between. No affordances also means it is not the player's turn
          regardless of `conclusion`, so there is nothing to show anyway. */}
      {state.affordances !== null && conclusion === "ongoing" && (
        <ActionBar
          actions={state.affordances.actions}
          catalogue={catalogue.actions}
          combatants={catalogue.combatants}
          // NOT `!yourTurn` — that is exactly the mount guard above, so it
          // can never be true here. `status` is a genuinely independent
          // condition: the socket can drop mid-turn while the last known
          // `turn_affordances` frame is still what is rendered (nothing
          // clears it on a status change), so this is what actually
          // disables input while reconnecting instead of leaving the
          // player click into a message `connect()`'s `send()` silently
          // drops.
          disabled={status !== "open"}
          onCommit={commit}
        />
      )}

      <NarrativePane text={state.narrative} />

      <CombatLog turns={state.combatLog} catalogue={catalogue.combatants} />
    </main>
  );
}
