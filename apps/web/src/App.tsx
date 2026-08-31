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
import { conclusionOf } from "@ai-dm/schemas";
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
import { buildTurn } from "./turn/build-turn.js";
import { ActionBar } from "./components/ActionBar.js";
import { CombatLog } from "./components/CombatLog.js";
import { ErrorBanner } from "./components/ErrorBanner.js";
import { FreeTextBar } from "./components/FreeTextBar.js";
import { Grid } from "./components/Grid.js";
import { NarrativePane } from "./components/NarrativePane.js";
import { SceneOptions } from "./components/SceneOptions.js";
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

  // The one outstanding `free_text` send, out of combat (§4.7 step 4). Set
  // when the player submits; `FreeTextBar` stays disabled the whole time it
  // is non-null, which is what stops a second send racing the first (and is
  // why at most one send is ever in flight).
  //
  // Four sites clear it, and all four are load-bearing — a path that misses
  // leaves the bar disabled forever, which is the inert-board soft-lock in an
  // out-of-combat costume:
  //   1. `onFrame`, on a `narrative_emitted` event: the turn answered.
  //   2. `onFrame`, on an `error`/`rejected` frame whose `clientMessageId`
  //      matches — or carries none at all. `ws.ts`'s catch-all `internal_error`
  //      is schema-legal without one, so treating absent as a match is what
  //      keeps that frame from latching the bar.
  //   3. `onStatus`, on any transition away from `"open"`. A send dropped
  //      client-side on a closed socket produces no frame at all, so `onFrame`
  //      never runs; this is the only site that sees that case.
  //   4. `resetToStart` and `reconnect`, so a fresh campaign or a manual
  //      reconnect never inherits a stale pending id.
  const [pendingFreeTextId, setPendingFreeTextId] = useState<string | null>(null);

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

    // §4.7 step 4: `?world=emberfall` starts a scene campaign instead of a
    // combat one. Read once per run rather than stored in state — nothing
    // downstream needs it to be reactive, and re-reading a `URLSearchParams`
    // on every render would be pointless work for a value that cannot change
    // without a navigation, which already remounts this effect via `started`.
    const worldId = new URLSearchParams(window.location.search).get("world");

    void (async () => {
      // Reuse a stored id rather than minting a new one: `createCampaign` is
      // only ever called when this mount is genuinely starting a fresh
      // fight, never on a reconnect.
      const stored = sessionStorage.getItem(CAMPAIGN_STORAGE_KEY);
      const campaignId =
        stored ??
        (
          await createCampaign(worldId !== null ? { worldId } : { encounterId: ENCOUNTER_ID })
        ).campaignId;
      // The staleness check comes first: a superseded run must not persist
      // ITS campaign id over whatever the surviving run has already written
      // (or is about to write) — see `runIdRef` above.
      if (runIdRef.current !== runId) return;
      if (stored === null) sessionStorage.setItem(CAMPAIGN_STORAGE_KEY, campaignId);

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
          // `pendingFreeTextId` tracks the one outstanding free-text send:
          // cleared unconditionally on `narrative_emitted` (there is at most
          // one in flight, since the bar is disabled while pending, so no
          // `clientMessageId` travels on that event to match against), and
          // on an `error`/`rejected` frame whose `clientMessageId` either
          // matches it or is ABSENT. Absent matters: `ServerFrame`'s error
          // member declares `clientMessageId` optional, and
          // `apps/server/src/transport/ws.ts`'s catch-all around a failed
          // `handleCommand` drain sends exactly that shape — the frame this
          // task's own smoke test received when the provider key was
          // missing. Treating "no id" as "not a match" left the bar latched
          // disabled forever on that path; treating it as "clear" is safe
          // because the only other thing an unrelated in-flight id could be
          // is a stale one from a send this same latch already disabled
          // further sends for.
          if (frame.type === "event" && frame.event.type === "narrative_emitted") {
            setPendingFreeTextId(null);
          } else if (frame.type === "error" || frame.type === "rejected") {
            const clientMessageId = frame.clientMessageId;
            setPendingFreeTextId((current) =>
              current !== null && (clientMessageId === undefined || current === clientMessageId)
                ? null
                : current,
            );
          }
        },
        onStatus: (nextStatus) => {
          setStatus(nextStatus);
          // Path (ii) of the pendingFreeTextId latch: a `free_text` send can
          // be dropped purely client-side (`net/connection.ts`'s `send`,
          // `readyState !== 1`) when the socket drops mid-turn — no error
          // frame is ever produced for that, so the `onFrame` clears above
          // never fire, and the automatic reconnect loop
          // (`onStatus("reconnecting")` + a timed `open()` retry) never
          // calls this component's own `reconnect()` either. `status`
          // leaving `"open"` is the one signal that IS observable here for
          // that drop, so it is what actually closes this path. Re-enabling
          // early is deliberate, not a compromise: a turn's frames cannot
          // arrive on a dead socket regardless, a resend is deduped
          // server-side on `clientMessageId`, and a permanently disabled
          // input is strictly worse than one that unlocks a beat early.
          if (nextStatus !== "open") setPendingFreeTextId(null);
        },
        resumeFrom: () => (sequenceRef.current === 0 ? undefined : sequenceRef.current),
      });
    })();

    return () => {
      runIdRef.current += 1;
      connectionRef.current?.close();
      connectionRef.current = null;
    };
  }, [started, reconnectNonce, props.wsUrl, props.socketFactory]);

  // The catalogue is display metadata — combatant labels and action
  // descriptions — that no event carries and the fold never needed. Since
  // §4.7 step 5 a bracket can open at any point in a campaign's life, not
  // only before the first frame, so this follows the projection rather than
  // firing once at mount. `encounter_started` now folds into a real board
  // (`reduce` fills it from the payload), so `openEncounterId` becoming
  // non-null is the exact moment a catalogue is needed.
  const openEncounterId = state.snapshot?.encounter?.encounterId ?? null;
  useEffect(() => {
    if (openEncounterId === null) return;
    if (catalogue?.encounterId === openEncounterId) return;
    // A ref cell rather than a plain `let`: a `let` mutated only from the
    // cleanup closure below narrows (wrongly) to its initial literal `false`
    // at the read site under `no-unnecessary-condition`, since TS's flow
    // analysis does not see the cross-closure write. Property access on a
    // ref sidesteps that narrowing entirely.
    const cancelled = { current: false };
    void (async () => {
      try {
        const fetched = await fetchCatalogue(openEncounterId);
        if (!cancelled.current) setCatalogue(fetched);
      } catch (error) {
        // Without this, a failed fetch leaves `catalogue` null forever: the
        // board never renders (the `catalogue === null` branch below just
        // repeats the "not ready" placeholder) and nothing tells the player
        // why. Routed through the same `lastError`/`ErrorBanner` mechanism
        // every other error in this file uses — that placeholder already
        // renders `ErrorBanner`, so surfacing it here needs nothing new.
        if (!cancelled.current) {
          setState((previous) => ({
            ...previous,
            lastError: {
              code: "catalogue_fetch_failed",
              message: error instanceof Error ? error.message : String(error),
            },
          }));
        }
      }
    })();
    return () => {
      cancelled.current = true;
    };
  }, [openEncounterId, catalogue?.encounterId]);

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
    // Part of "every piece of state a fresh mount would otherwise read as
    // still in progress" (see the comment above): left set, a NEXT scene
    // campaign would render its `FreeTextBar` disabled from its very first
    // frame, for a send that named a campaign this reset just discarded.
    setPendingFreeTextId(null);
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
    // A drop between render and click can leave `pendingFreeTextId` set for
    // a `free_text` that never reached the wire (`net/connection.ts`'s
    // `send` silently no-ops while disconnected) — the resume replay that
    // follows has no `narrative_emitted` for it, so nothing would ever
    // clear the latch without this.
    setPendingFreeTextId(null);
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
  //
  // Only for a genuinely combat-only campaign, though: since §4.7 step 5 a
  // bridged fight can conclude (win OR lose) and return to narration at the
  // same scene node, so "an encounter concluded" no longer implies "the
  // campaign is over". `state.snapshot.world.scene !== null` is the client
  // side of the same predicate `resolveIfConcluded` gates on server-side
  // (`campaign.sceneStatics === null`) — a scene campaign always has
  // somewhere to go back to, so its storage must survive here.
  useEffect(() => {
    const encounter = state.snapshot?.encounter ?? null;
    if (encounter === null) return;
    if (conclusionOf(encounter) === "ongoing") return;
    if (state.snapshot?.world.scene !== null) return;
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

  const sendFreeText = useCallback(
    (text: string) => {
      const clientMessageId = crypto.randomUUID();
      setPendingFreeTextId(clientMessageId);
      send({ type: "free_text", clientMessageId, text });
    },
    [send],
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

  // Shared by every "nothing to draw yet" case below: pre-snapshot, a scene
  // campaign with no scene genesis (a legacy/pre-§4.7-step-4 campaign), and
  // a combat campaign whose catalogue hasn't arrived. `ErrorBanner` renders
  // here too: an `error` frame that is not `unknown_campaign`
  // (`internal_error`, `malformed_message`) can arrive on join, before any
  // `campaign_state` — without this, the player would be stuck reading the
  // "connecting…" status forever with no explanation.
  function renderNotReady(): JSX.Element {
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

  if (state.snapshot === null) return renderNotReady();

  // A campaign with no encounter open renders the exploration/social view
  // instead of the board — §4.7 step 4. `encounter === null && scene !==
  // null` is the gating condition that matters most in this file: combat
  // controls (`Grid`/`ActionBar`) exist ONLY in the branch below this one,
  // which is what keeps the known `not_your_turn`-in-`SILENT_CODES` trap
  // unreachable — nothing out of combat can ever send a `structured_action`,
  // so the silent refusal has no sender.
  const encounter = state.snapshot.encounter;
  if (encounter === null) {
    const scene = state.snapshot.world.scene;
    // No scene either: a legacy campaign, or one whose genesis never ran.
    // Same "not ready" placeholder combat used to show unconditionally.
    if (scene === null) return renderNotReady();

    return (
      <main>
        <h1>{he.app.title}</h1>

        {/* Out of combat there is no "turn" concept, so this mirrors only
            the connection half of the combat view's status line below --
            a dropped socket must not present as a dead input box with
            nothing explaining it (the inert-board soft-lock in a scene
            costume, whole-branch review finding 3). */}
        <p className="status">
          {status === "reconnecting" ? he.app.reconnecting : he.app.waiting}
        </p>

        <ErrorBanner
          error={state.lastError}
          rejection={state.lastRejection}
          onDismiss={dismissError}
          onReconnect={reconnect}
        />

        <NarrativePane text={state.narrative} />

        {/* Above the input, not below it: the options are what the player
            reads before deciding what to type, and a list under the box is a
            list found after the decision was already made. */}
        <SceneOptions
          affordances={state.sceneAffordances}
          disabled={pendingFreeTextId !== null || status !== "open"}
          onChoose={sendFreeText}
        />

        <FreeTextBar
          disabled={pendingFreeTextId !== null || status !== "open"}
          onSend={sendFreeText}
        />
      </main>
    );
  }

  // A catalogue is needed only once an encounter is actually open — a scene
  // campaign (handled above) never fetches one at all.
  if (catalogue === null) return renderNotReady();

  const conclusion = conclusionOf(encounter);
  const yourTurn = state.affordances !== null && conclusion === "ongoing";

  return (
    <main>
      <h1>{he.app.title}</h1>

      <p className="status">
        {conclusion === "defeat"
          ? he.app.defeat
          : conclusion === "victory"
            ? he.app.victory
            : conclusion === "stalemate"
              ? he.app.stalemate
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
        snapshot={encounter}
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
