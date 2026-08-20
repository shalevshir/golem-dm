// Top-level wiring. It owns the session lifecycle and nothing else: the store
// folds, the components render, the connection carries frames.
import { useCallback, useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import type {
  ActionAffordance,
  ClientMessage,
  EncounterCatalogue,
  ServerFrame,
  Tile,
} from "@ai-dm/schemas";
import { connect } from "./net/connection.js";
import type { Connection, ConnectionStatus, WebSocketLike } from "./net/connection.js";
import { createSession, fetchCatalogue } from "./net/api.js";
import { applyFrame, initialClientState } from "./state/store.js";
import type { ClientState } from "./state/store.js";
import { conclusionOf } from "./state/conclusion.js";
import { buildTurn } from "./turn/build-turn.js";
import { ActionBar } from "./components/ActionBar.js";
import { ErrorBanner } from "./components/ErrorBanner.js";
import { Grid } from "./components/Grid.js";
import { NarrativePane } from "./components/NarrativePane.js";
import { he } from "./i18n.js";

const ENCOUNTER_ID = "goblin-ambush";

/**
 * Persisted across a refresh so the exit criterion — "refresh mid-fight
 * without losing the session" — actually holds. Without this, a reload reads
 * no stored id, calls `POST /sessions` again, and starts a brand-new fight;
 * `sessionStorage` (not `localStorage`) is deliberate too, since a fight
 * should not survive into a new tab that never joined it.
 *
 * Cleared on an `unknown_session` error frame (see the effect below): the
 * server has forgotten the session, so an id that outlives it must not be
 * reused on the next mount either.
 */
export const SESSION_STORAGE_KEY = "ai-dm:session-id";

export interface AppProps {
  /** Test seam. Production leaves both undefined and the real ones are used. */
  socketFactory?: (url: string) => WebSocketLike;
  wsUrl?: string;
}

export function App(props: AppProps): JSX.Element {
  const [state, setState] = useState<ClientState>(initialClientState);
  const [catalogue, setCatalogue] = useState<EncounterCatalogue | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [selectedTile, setSelectedTile] = useState<Tile | null>(null);
  // A stored session id means a fight is already in progress: mounting goes
  // straight to reconnecting rather than showing the start screen again, or
  // a refresh mid-fight would look like it lost the session even though
  // `resumeFrom` below would have recovered it.
  const [started, setStarted] = useState(
    () => sessionStorage.getItem(SESSION_STORAGE_KEY) !== null,
  );

  // `resumeFrom` is read at join time, not captured at connect time — a
  // reconnect must resume from where the client actually got to.
  const sequenceRef = useRef(0);
  sequenceRef.current = state.sequence;
  const connectionRef = useRef<Connection | null>(null);
  // A ref rather than a plain `let cancelled` closure variable: the
  // mutation below happens in a sibling closure (the effect's cleanup),
  // which only ever runs later, so TypeScript's control-flow analysis
  // narrows a captured `let` to a literal `false` for the entire async IIFE
  // and flags every check against it as dead code — even though at runtime
  // the effect can genuinely be cleaned up mid-flight (fast unmount, a
  // `started`/`wsUrl`/`socketFactory` change) while the awaits below are
  // still pending. `.current` on a ref sidesteps that false narrowing.
  const cancelledRef = useRef(false);

  useEffect(() => {
    if (!started) return;
    cancelledRef.current = false;

    void (async () => {
      // Reuse a stored id rather than minting a new one: `createSession` is
      // only ever called when this mount is genuinely starting a fresh
      // fight, never on a reconnect.
      const stored = sessionStorage.getItem(SESSION_STORAGE_KEY);
      const sessionId = stored ?? (await createSession(ENCOUNTER_ID));
      if (stored === null) sessionStorage.setItem(SESSION_STORAGE_KEY, sessionId);

      const fetched = await fetchCatalogue(ENCOUNTER_ID);
      // The one guard that matters: no state update reaches a component that
      // has since unmounted or moved on to a different session.
      if (cancelledRef.current) return;
      setCatalogue(fetched);

      connectionRef.current = connect({
        sessionId,
        ...(props.wsUrl === undefined ? {} : { url: props.wsUrl }),
        ...(props.socketFactory === undefined ? {} : { socketFactory: props.socketFactory }),
        onFrame: (frame: ServerFrame) => {
          setState((previous) => applyFrame(previous, frame));
        },
        onStatus: setStatus,
        resumeFrom: () => (sequenceRef.current === 0 ? undefined : sequenceRef.current),
      });
    })();

    return () => {
      cancelledRef.current = true;
      connectionRef.current?.close();
      connectionRef.current = null;
    };
  }, [started, props.wsUrl, props.socketFactory]);

  // `unknown_session`: the server has forgotten this session (error table,
  // design doc `## Error handling`). The stored id must not outlive it, and
  // the only sane recovery is back to the start screen — there is nothing
  // left here to resume.
  useEffect(() => {
    if (state.lastError?.code !== "unknown_session") return;

    sessionStorage.removeItem(SESSION_STORAGE_KEY);
    connectionRef.current?.close();
    connectionRef.current = null;
    setState(initialClientState);
    setCatalogue(null);
    setStarted(false);
  }, [state.lastError]);

  const send = useCallback((message: ClientMessage) => {
    connectionRef.current?.send(message);
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
      setSelectedTile(null);
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
    return <main>{status === "reconnecting" ? he.app.reconnecting : he.app.connecting}</main>;
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
        onDismiss={() => {
          setState((previous) => ({ ...previous, lastError: null, lastRejection: null }));
        }}
      />

      <Grid
        snapshot={state.snapshot}
        affordances={state.affordances}
        catalogue={catalogue.combatants}
        selectedTile={selectedTile}
        onTileClick={setSelectedTile}
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
          disabled={!yourTurn}
          onCommit={commit}
        />
      )}

      <NarrativePane text={state.narrative} />
    </main>
  );
}
