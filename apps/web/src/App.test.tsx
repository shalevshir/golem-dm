// The top-level wiring test: session lifecycle, reconnect, fold parity
// through the whole component, and ending detection from the projection.
//
// The fake socket (`net/fake-socket.ts`, shared with `connection.test.ts`)
// never fires "open" on its own — a real `WebSocket` fires it asynchronously,
// but this stand-in only does what a test tells it to. So every helper below
// that needs a join to land calls `socket.emitOpen()` itself, inside
// `waitFor` where the timing after `createSession`/`fetchCatalogue` resolve
// is not otherwise observable from outside the component.
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { ExecuteTurn, fold } from "@ai-dm/schemas";
import type { Combatant, GameEvent, SessionState } from "@ai-dm/schemas";
import { App, SESSION_STORAGE_KEY } from "./App.js";
import { he } from "./i18n.js";
import { fakeSocket } from "./net/fake-socket.js";
import type { FakeSocket } from "./net/fake-socket.js";
import { combatant } from "./state/combatant-fixture.js";

function snapshotWith(combatants: Combatant[]): SessionState {
  return {
    sessionId: "s1",
    rootSeed: 3,
    encounterId: "goblin-ambush",
    grid: {
      width: 12,
      height: 12,
      tiles: Array.from({ length: 12 }, () => Array.from({ length: 12 }, () => "normal" as const)),
    },
    combatants,
    turnOrder: combatants.map((each) => each.combatantId),
    currentActorIndex: 0,
    round: 1,
    appliedClientMessageIds: [],
  };
}

function event(
  sequence: number,
  type: GameEvent["type"],
  payload: Record<string, unknown>,
): GameEvent {
  return {
    eventId: `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
    sessionId: "s1",
    sequence,
    timestamp: "2026-08-19T10:00:00.000Z",
    type,
    payload,
  };
}

const catalogue = {
  encounterId: "goblin-ambush",
  combatants: [
    { combatantId: "hero", nameEnglish: "Guard", maxHp: 11, faction: "party" },
    { combatantId: "goblin-a", nameEnglish: "Goblin Warrior", maxHp: 10, faction: "hostile" },
  ],
  actions: [
    { actionId: "spear", nameEnglish: "Spear" },
    { actionId: "scimitar", nameEnglish: "Scimitar" },
  ],
};

let socket: FakeSocket;
let fetchMock: ReturnType<typeof vi.fn>;

/**
 * Renders and, unless `skipClick`, presses the start button. Then polls
 * `socket.emitOpen()` inside `waitFor` until the `connect()` effect has
 * actually registered the socket's listeners (after the mocked
 * `createSession`/`fetchCatalogue` promises settle) — at which point the
 * first `emitOpen()` call finally fires the "open" listener and the join
 * goes out. Earlier calls are silent no-ops (`fake-socket.ts`'s
 * `listeners.get("open")` is `undefined` until `connect()` runs), so this
 * fires the real join exactly once, whenever it becomes possible to.
 */
async function start(options: { skipClick?: boolean } = {}): Promise<void> {
  render(<App socketFactory={() => socket} wsUrl="ws://test/ws" />);
  if (options.skipClick !== true) {
    act(() => {
      screen.getByRole("button", { name: he.app.startFight }).click();
    });
  }
  await waitFor(() => {
    socket.emitOpen();
    expect(socket.sent.length).toBeGreaterThan(0);
  });
}

beforeEach(() => {
  socket = fakeSocket();
  sessionStorage.clear();
  fetchMock = vi.fn((...args: Parameters<typeof fetch>): Promise<Response> => {
    const [, init] = args;
    return Promise.resolve({
      ok: true,
      json: (): Promise<unknown> =>
        Promise.resolve(init?.method === "POST" ? { sessionId: "s1" } : catalogue),
    } as Response);
  });
  vi.stubGlobal("fetch", fetchMock);
  // `vi.spyOn` wraps the one method rather than spreading `globalThis.crypto`
  // (a class instance — spreading it would lose its prototype, which
  // `@typescript-eslint/no-misused-spread` correctly flags). Real dash
  // positions are required: `Crypto.randomUUID`'s return type is a template
  // literal of five dash-separated segments, so a plain string like
  // "fixed-id" does not satisfy it at the type level.
  vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue("11111111-1111-4111-8111-111111111111");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  sessionStorage.clear();
});

describe("App", () => {
  it("re-joins with the highest folded sequence after a drop", async () => {
    await start();
    expect(JSON.parse(socket.sent[0] ?? "{}")).toEqual({ type: "join", sessionId: "s1" });

    const genesis = snapshotWith([
      combatant("hero", "party", "alive"),
      combatant("goblin-a", "hostile", "alive"),
    ]);

    act(() => {
      socket.emitMessage({ type: "session_state", sequence: 0, snapshot: genesis });
      socket.emitMessage({
        type: "event",
        event: event(1, "player_input", { clientMessageId: "m1" }),
      });
      socket.emitMessage({
        type: "event",
        event: event(2, "scene_changed", { kind: "turn_advanced" }),
      });
      socket.emitMessage({
        type: "event",
        event: event(3, "scene_changed", { kind: "turn_advanced" }),
      });
    });

    // The reconnect contract: resume from what the client ACTUALLY folded, not
    // from where it was when `connect` was first called. Fake timers make the
    // 1s retry delay in `net/connection.ts` deterministic instead of a real
    // wall-clock wait.
    vi.useFakeTimers();
    act(() => {
      socket.emitClose();
    });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    vi.useRealTimers();

    act(() => {
      socket.emitOpen(); // the reconnected socket's own open event
    });

    const rejoin = socket.sent.map((each) => JSON.parse(each) as { resumeFrom?: number });
    expect(rejoin.some((each) => each.resumeFrom === 3)).toBe(true);
  });

  it("holds a projection equal to the server's own fold over the same log", async () => {
    // Fold parity through the whole component, not just the store: if the
    // `reduce` move ever changed behaviour on this side, this fails loudly.
    // A `state_delta_applied` event is included deliberately — a log made of
    // only `player_input`/`scene_changed` never changes anything the DOM
    // shows, so a no-op `event` case in `applyFrame` would pass a weaker
    // version of this test. The HP text below is what actually depends on
    // the fold having run.
    await start();
    const genesis = snapshotWith([
      combatant("hero", "party", "alive"),
      combatant("goblin-a", "hostile", "alive"),
    ]);
    const log: GameEvent[] = [
      event(1, "player_input", { clientMessageId: "m1" }),
      event(2, "state_delta_applied", {
        combatants: [
          combatant("hero", "party", "alive"),
          combatant("goblin-a", "hostile", "alive", { currentHp: 4 }),
        ],
      }),
      event(3, "scene_changed", { kind: "turn_advanced" }),
      event(4, "scene_changed", { kind: "turn_advanced" }),
    ];

    act(() => {
      socket.emitMessage({ type: "session_state", sequence: 0, snapshot: genesis });
      for (const each of log) socket.emitMessage({ type: "event", event: each });
    });

    const expected = fold(genesis, log);
    // Round is the projection field the fold advances; a divergence in the
    // fold's turn-order bookkeeping shows up here.
    expect(expected.round).toBe(2);
    expect(expected.combatants.find((each) => each.combatantId === "goblin-a")?.currentHp).toBe(4);

    // The component's own projection, read back from the DOM (the Grid's
    // accessible combatant list) rather than from internal state — this is
    // what makes the check exercise the whole component, not `applyFrame` in
    // isolation.
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Goblin Warrior 4/11" })).toBeInTheDocument();
    });
  });

  it("renders a defeat as a normal ending, not an error", async () => {
    // C-31/C-37: the party is expected to lose, and NO terminal frame is ever
    // sent — the pipeline simply stops answering. The conclusion is therefore
    // read from the projection, and defeat renders as an ending, not a fault.
    await start();
    act(() => {
      socket.emitMessage({
        type: "session_state",
        sequence: 9,
        snapshot: snapshotWith([
          combatant("hero", "party", "dead"),
          combatant("goblin-a", "hostile", "alive"),
        ]),
      });
    });

    expect(await screen.findByText(he.app.defeat)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("reuses a session id from sessionStorage instead of creating a new one", async () => {
    // Without this, a browser refresh mid-fight calls POST /sessions and
    // starts a brand-new session — the exit criterion ("refresh mid-fight
    // without losing the session") fails outright.
    sessionStorage.setItem(SESSION_STORAGE_KEY, "s1");

    await start({ skipClick: true });

    expect(screen.queryByRole("button", { name: he.app.startFight })).not.toBeInTheDocument();
    expect(JSON.parse(socket.sent[0] ?? "{}")).toEqual({ type: "join", sessionId: "s1" });
    expect(fetchMock).not.toHaveBeenCalledWith(
      "/sessions",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("clears the stored session id and returns to the start screen on unknown_session", async () => {
    await start();
    expect(sessionStorage.getItem(SESSION_STORAGE_KEY)).toBe("s1");

    act(() => {
      socket.emitMessage({ type: "error", code: "unknown_session", message: "gone" });
    });

    expect(sessionStorage.getItem(SESSION_STORAGE_KEY)).toBeNull();
    expect(await screen.findByRole("button", { name: he.app.startFight })).toBeInTheDocument();
  });

  it("clears the stored session id once the fight concludes, so a later refresh doesn't rejoin a finished session", async () => {
    await start();
    expect(sessionStorage.getItem(SESSION_STORAGE_KEY)).toBe("s1");

    act(() => {
      socket.emitMessage({
        type: "session_state",
        sequence: 9,
        snapshot: snapshotWith([
          combatant("hero", "party", "dead"),
          combatant("goblin-a", "hostile", "alive"),
        ]),
      });
    });

    expect(await screen.findByText(he.app.defeat)).toBeInTheDocument();
    // Without this, every refresh after the fight ends rejoins the same
    // finished session forever — a dead end sitting on the exit criterion.
    expect(sessionStorage.getItem(SESSION_STORAGE_KEY)).toBeNull();
  });

  it("surfaces an error frame that arrives before the first snapshot instead of hanging on the connecting screen", async () => {
    // internal_error/malformed_message can arrive on join, before any
    // session_state — unlike unknown_session there is no recovery effect for
    // these, so ErrorBanner is the only way the player ever finds out.
    await start();

    act(() => {
      socket.emitMessage({ type: "error", code: "internal_error", message: "boom" });
    });

    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByText(he.errors.internal_error)).toBeInTheDocument();
    // Still pre-snapshot: the connecting text is still there alongside it,
    // not replaced by it.
    expect(screen.getByText(he.app.connecting)).toBeInTheDocument();
  });

  it("sends a structured_action whose turn parses against ExecuteTurn when a player commits an action", async () => {
    // The ActionBar -> buildTurn -> structured_action send path, driven
    // through the real ActionBar component rather than calling `commit`
    // directly — this is the one integration edge "fights to conclusion"
    // actually depends on.
    await start();

    act(() => {
      socket.emitMessage({
        type: "session_state",
        sequence: 0,
        snapshot: snapshotWith([
          combatant("hero", "party", "alive"),
          combatant("goblin-a", "hostile", "alive"),
        ]),
      });
      socket.emitMessage({
        type: "turn_affordances",
        forSequence: 0,
        actorId: "hero",
        reachableTiles: [],
        actions: [{ actionType: "dodge", requiresTarget: false, targetableCombatantIds: [] }],
      });
    });

    act(() => {
      screen.getByRole("button", { name: he.actions.dodge }).click();
    });

    const sent = socket.sent.map((each) => JSON.parse(each) as Record<string, unknown>);
    const structured = sent.find((each) => each.type === "structured_action");
    expect(structured).toBeDefined();
    expect(structured?.actorId).toBe("hero");
    expect(structured?.clientMessageId).toBe("11111111-1111-4111-8111-111111111111");
    expect(ExecuteTurn.safeParse(structured?.turn).success).toBe(true);
  });

  it("keeps exactly one live connection through StrictMode's dev double-invoke", async () => {
    // StrictMode double-invokes an effect (mount -> cleanup -> mount) only
    // around a component's INITIAL mount, not on a later re-run triggered by
    // a dependency change — so this has to start `started` true from the
    // very first render (a stored session id, exactly like a real refresh
    // mid-fight) rather than mounting idle and clicking the start button
    // afterward, or the effect's "real" (non-early-return) body would only
    // ever run once and the bug this guards against would go unexercised.
    //
    // main.tsx ships <StrictMode>, which in development runs this effect
    // mount -> cleanup -> mount. A single shared `cancelled` boolean gets
    // reset to false by the SECOND mount before the FIRST mount's still
    // -pending async IIFE ever reads it, so both runs reach `connect()` —
    // the socket factory call count is the observable proxy for that.
    sessionStorage.setItem(SESSION_STORAGE_KEY, "s1");
    const sockets: FakeSocket[] = [];
    const factory = vi.fn((): FakeSocket => {
      const created = fakeSocket();
      sockets.push(created);
      return created;
    });

    render(
      <StrictMode>
        <App socketFactory={factory} wsUrl="ws://test/ws" />
      </StrictMode>,
    );

    // Whichever socket survives eventually opens and joins; by that point a
    // second, erroneous `connect()` call (if the guard were broken) would
    // already have happened too — every run shares the exact same two
    // mocked awaits, with no extra delay on either.
    await waitFor(() => {
      for (const each of sockets) each.emitOpen();
      expect(sockets.some((each) => each.sent.length > 0)).toBe(true);
    });

    expect(factory).toHaveBeenCalledTimes(1);
  });
});
