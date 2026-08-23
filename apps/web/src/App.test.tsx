// The top-level wiring test: campaign lifecycle, reconnect, fold parity
// through the whole component, and ending detection from the projection.
//
// The fake socket (`net/fake-socket.ts`, shared with `connection.test.ts`)
// never fires "open" on its own — a real `WebSocket` fires it asynchronously,
// but this stand-in only does what a test tells it to. So every helper below
// that needs a join to land calls `socket.emitOpen()` itself, inside
// `waitFor` where the timing after `createCampaign`/`fetchCatalogue` resolve
// is not otherwise observable from outside the component.
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import type { RenderResult } from "@testing-library/react";
import { ExecuteTurn, fold } from "@ai-dm/schemas";
import type { Combatant, GameEvent, CampaignState } from "@ai-dm/schemas";
import { App, CAMPAIGN_STORAGE_KEY } from "./App.js";
import { LOG_STORAGE_KEY } from "./state/persistence.js";
import { he } from "./i18n.js";
import { fakeSocket } from "./net/fake-socket.js";
import type { FakeSocket } from "./net/fake-socket.js";
import { combatant } from "./state/combatant-fixture.js";

function snapshotWith(combatants: Combatant[]): CampaignState {
  return {
    campaignId: "s1",
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
    campaignId: "s1",
    sequence,
    timestamp: "2026-08-19T10:00:00.000Z",
    type,
    payload,
  };
}

const catalogue = {
  encounterId: "goblin-ambush",
  combatants: [
    { combatantId: "hero", nameEnglish: "Guard", nameHebrew: "שומר", maxHp: 11, faction: "party" },
    {
      combatantId: "goblin-a",
      nameEnglish: "Goblin Warrior",
      nameHebrew: "גובלין לוחם",
      maxHp: 10,
      faction: "hostile",
    },
  ],
  actions: [
    { actionId: "spear", nameEnglish: "Spear", nameHebrew: "חנית" },
    { actionId: "scimitar", nameEnglish: "Scimitar", nameHebrew: "חרב מעוקלת" },
  ],
};

/** Narration fixture. No dice expression in it, so `NarrativePane` renders
 *  it as a single node and `getByText` can match it whole. */
const NARRATION = "השומר נועץ את חניתו בגובלין.";

let socket: FakeSocket;
let fetchMock: ReturnType<typeof vi.fn>;

/**
 * Renders and, unless `skipClick`, presses the start button. Then polls
 * `socket.emitOpen()` inside `waitFor` until the `connect()` effect has
 * actually registered the socket's listeners (after the mocked
 * `createCampaign`/`fetchCatalogue` promises settle) — at which point the
 * first `emitOpen()` call finally fires the "open" listener and the join
 * goes out. Earlier calls are silent no-ops (`fake-socket.ts`'s
 * `listeners.get("open")` is `undefined` until `connect()` runs), so this
 * fires the real join exactly once, whenever it becomes possible to.
 */
async function start(options: { skipClick?: boolean } = {}): Promise<RenderResult> {
  const rendered = render(<App socketFactory={() => socket} wsUrl="ws://test/ws" />);
  if (options.skipClick !== true) {
    act(() => {
      screen.getByRole("button", { name: he.app.startFight }).click();
    });
  }
  await waitFor(() => {
    socket.emitOpen();
    expect(socket.sent.length).toBeGreaterThan(0);
  });
  return rendered;
}

beforeEach(() => {
  socket = fakeSocket();
  sessionStorage.clear();
  fetchMock = vi.fn((...args: Parameters<typeof fetch>): Promise<Response> => {
    const [, init] = args;
    return Promise.resolve({
      ok: true,
      json: (): Promise<unknown> =>
        Promise.resolve(init?.method === "POST" ? { campaignId: "s1" } : catalogue),
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
    expect(JSON.parse(socket.sent[0] ?? "{}")).toEqual({ type: "join", campaignId: "s1" });

    const genesis = snapshotWith([
      combatant("hero", "party", "alive"),
      combatant("goblin-a", "hostile", "alive"),
    ]);

    act(() => {
      socket.emitMessage({ type: "campaign_state", sequence: 0, snapshot: genesis });
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
      socket.emitMessage({ type: "campaign_state", sequence: 0, snapshot: genesis });
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
      expect(screen.getByRole("button", { name: "גובלין לוחם 4/11" })).toBeInTheDocument();
    });
  });

  it("renders a defeat as a normal ending, not an error", async () => {
    // C-31/C-37: the party is expected to lose, and NO terminal frame is ever
    // sent — the pipeline simply stops answering. The conclusion is therefore
    // read from the projection, and defeat renders as an ending, not a fault.
    await start();
    act(() => {
      socket.emitMessage({
        type: "campaign_state",
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

  it("reuses a campaign id from sessionStorage instead of creating a new one", async () => {
    // Without this, a browser refresh mid-fight calls POST /campaigns and
    // starts a brand-new campaign — the exit criterion ("refresh mid-fight
    // without losing the campaign") fails outright.
    sessionStorage.setItem(CAMPAIGN_STORAGE_KEY, "s1");

    await start({ skipClick: true });

    expect(screen.queryByRole("button", { name: he.app.startFight })).not.toBeInTheDocument();
    expect(JSON.parse(socket.sent[0] ?? "{}")).toEqual({ type: "join", campaignId: "s1" });
    expect(fetchMock).not.toHaveBeenCalledWith(
      "/campaigns",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("clears the stored campaign id and returns to the start screen on unknown_campaign", async () => {
    await start();
    expect(sessionStorage.getItem(CAMPAIGN_STORAGE_KEY)).toBe("s1");

    act(() => {
      socket.emitMessage({ type: "error", code: "unknown_campaign", message: "gone" });
    });

    expect(sessionStorage.getItem(CAMPAIGN_STORAGE_KEY)).toBeNull();
    // The roll log goes with the id. A log left behind here would be restored
    // by the next mount and rendered against the next fight's board.
    expect(sessionStorage.getItem(LOG_STORAGE_KEY)).toBeNull();
    expect(await screen.findByRole("button", { name: he.app.startFight })).toBeInTheDocument();
  });

  it("clears the stored campaign id once the fight concludes, so a later refresh doesn't rejoin a finished campaign", async () => {
    await start();
    expect(sessionStorage.getItem(CAMPAIGN_STORAGE_KEY)).toBe("s1");

    act(() => {
      socket.emitMessage({
        type: "campaign_state",
        sequence: 9,
        snapshot: snapshotWith([
          combatant("hero", "party", "dead"),
          combatant("goblin-a", "hostile", "alive"),
        ]),
      });
    });

    expect(await screen.findByText(he.app.defeat)).toBeInTheDocument();
    // Without this, every refresh after the fight ends rejoins the same
    // finished campaign forever — a dead end sitting on the exit criterion.
    expect(sessionStorage.getItem(CAMPAIGN_STORAGE_KEY)).toBeNull();
    expect(sessionStorage.getItem(LOG_STORAGE_KEY)).toBeNull();
  });

  it("surfaces an error frame that arrives before the first snapshot instead of hanging on the connecting screen", async () => {
    // internal_error/malformed_message can arrive on join, before any
    // campaign_state — unlike unknown_campaign there is no recovery effect for
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
        type: "campaign_state",
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

  it("shows the roll detail for a resolved attack in the combat log", async () => {
    await start();
    act(() => {
      socket.emitMessage({
        type: "campaign_state",
        sequence: 0,
        snapshot: snapshotWith([
          combatant("hero", "party", "alive"),
          combatant("goblin-a", "hostile", "alive"),
        ]),
      });
      socket.emitMessage({
        type: "event",
        event: event(1, "action_validated", {
          actorId: "hero",
          turn: {
            actorId: "hero",
            mainAction: { actionType: "attack", actionId: "spear", targetIds: ["goblin-a"] },
            tacticalRationaleEnglish: "Test fixture.",
          },
          source: "human",
        }),
      });
      socket.emitMessage({
        type: "event",
        event: event(2, "dice_rolled", {
          actorId: "hero",
          movedFeet: 0,
          seed: 42,
          attacks: [
            {
              attackerId: "hero",
              targetId: "goblin-a",
              actionId: "spear",
              outcome: "hit",
              damage: 6,
              targetStatusAfter: "alive",
              attackRoll: { naturalRoll: 18, rolls: [18], total: 21, targetArmorClass: 15 },
              damageRolls: [{ kind: "dice", notation: "1d6+1", rolls: [5], modifier: 1, total: 6 }],
            },
          ],
        }),
      });
    });

    expect(await screen.findByText(he.log.hit)).toBeInTheDocument();
    expect(screen.getByText(/18/)).toBeInTheDocument();
  });

  it("restores the roll log and the narration on a remount, not just the board", async () => {
    // What a page reload actually is, from the component's side: the old tree
    // is gone, a new one mounts against the same stored campaign id, and the
    // join it sends is answered with the live projection. The board comes
    // back from that projection — but the roll log is folded client-side from
    // events `CampaignState` does not carry, and the narration arrives as
    // `narrative_token` frames that are not events at all, so neither is in
    // the answer. Without `state/persistence.ts` both come back empty, which
    // is exactly what the manual restart test found.
    const first = await start();
    const snapshot = snapshotWith([
      combatant("hero", "party", "alive"),
      combatant("goblin-a", "hostile", "alive"),
    ]);
    act(() => {
      socket.emitMessage({ type: "campaign_state", sequence: 0, snapshot });
      socket.emitMessage({
        type: "event",
        event: event(1, "action_validated", {
          actorId: "hero",
          turn: {
            actorId: "hero",
            mainAction: { actionType: "attack", actionId: "spear", targetId: "goblin-a" },
            tacticalRationaleEnglish: "Test fixture.",
          },
          source: "human",
        }),
      });
      socket.emitMessage({
        type: "event",
        event: event(2, "dice_rolled", {
          actorId: "hero",
          movedFeet: 0,
          seed: 42,
          attacks: [
            {
              attackerId: "hero",
              targetId: "goblin-a",
              actionId: "spear",
              outcome: "hit",
              damage: 6,
              targetStatusAfter: "alive",
              attackRoll: { naturalRoll: 18, rolls: [18], total: 21, targetArmorClass: 15 },
              damageRolls: [{ kind: "dice", notation: "1d6+1", rolls: [5], modifier: 1, total: 6 }],
            },
          ],
        }),
      });
      socket.emitMessage({ type: "narrative_token", streamId: "n1", text: NARRATION });
    });
    expect(await screen.findByText(he.log.hit)).toBeInTheDocument();
    expect(screen.getByText(NARRATION)).toBeInTheDocument();

    first.unmount();
    socket = fakeSocket();
    await start({ skipClick: true });

    // Still no `resumeFrom`, deliberately. A reloaded client holds no
    // snapshot, and the tail a `resumeFrom` buys it is a run of bare `event`
    // frames that `applyFrame` drops while `snapshot` is null — it would hang
    // on the connecting screen. Asking for the whole projection is the right
    // request; the log is restored beside it, not fetched.
    expect(JSON.parse(socket.sent[0] ?? "{}")).toEqual({ type: "join", campaignId: "s1" });

    act(() => {
      socket.emitMessage({ type: "campaign_state", sequence: 2, snapshot });
    });

    expect(await screen.findByText(he.log.hit)).toBeInTheDocument();
    expect(screen.getByText(/18/)).toBeInTheDocument();
    expect(screen.getByText(NARRATION)).toBeInTheDocument();
  });

  it("drops a restored roll log the server's own sequence has moved past", async () => {
    // The rule that keeps the restored log honest: it is tagged with the
    // sequence it was folded at, and a projection at any other sequence
    // describes a board it does not. Reaching this needs events the client
    // never saw — the server appending a turn after the socket died, which a
    // kill mid-turn does.
    sessionStorage.setItem(CAMPAIGN_STORAGE_KEY, "s1");
    sessionStorage.setItem(
      LOG_STORAGE_KEY,
      JSON.stringify({
        campaignId: "s1",
        sequence: 2,
        combatLog: [
          { actorId: "hero", actionType: "dodge", movedFeet: 0, attacks: [], forfeited: false },
        ],
        narrative: NARRATION,
        narrativeStreamId: "n1",
      }),
    );

    await start({ skipClick: true });
    act(() => {
      socket.emitMessage({
        type: "campaign_state",
        sequence: 9,
        snapshot: snapshotWith([
          combatant("hero", "party", "alive"),
          combatant("goblin-a", "hostile", "alive"),
        ]),
      });
    });

    expect(await screen.findByText(he.log.heading)).toBeInTheDocument();
    expect(screen.queryByText(he.actions.dodge)).not.toBeInTheDocument();
    expect(screen.queryByText(NARRATION)).not.toBeInTheDocument();
  });

  it("does not carry a dead campaign's resumeFrom into the next fight", async () => {
    // `sequenceRef` is a ref, not React state, so `resetToStart` clearing
    // every `useState` leaves it holding the sequence of the campaign that
    // just went away. The next fight's join would then resume from it.
    // Harmless today only by accident — a fresh log holds just sequence 0,
    // so the server falls back to a full `campaign_state` — which makes this
    // exactly the kind of latent coupling worth pinning rather than
    // rediscovering when that fallback changes.
    await start();
    act(() => {
      socket.emitMessage({
        type: "campaign_state",
        sequence: 7,
        snapshot: snapshotWith([
          combatant("hero", "party", "alive"),
          combatant("goblin-a", "hostile", "alive"),
        ]),
      });
    });

    act(() => {
      socket.emitMessage({ type: "error", code: "unknown_campaign", message: "gone" });
    });
    expect(await screen.findByRole("button", { name: he.app.startFight })).toBeInTheDocument();

    socket.sent.length = 0;
    act(() => {
      screen.getByRole("button", { name: he.app.startFight }).click();
    });

    await waitFor(() => {
      socket.emitOpen();
      expect(socket.sent.length).toBeGreaterThan(0);
    });
    // A brand-new fight starts from the beginning: no resumeFrom at all.
    expect(JSON.parse(socket.sent[0] ?? "{}")).toEqual({ type: "join", campaignId: "s1" });
  });

  it("reconnects to the same campaign on internal_error instead of discarding the fight", async () => {
    // Spec's error table: `internal_error` → "Surface, and offer reconnect",
    // and reconnect is meant literally. Both faults that raise this code
    // (SequenceConflictError/CampaignMismatchError on a failed append) leave
    // the campaign alive and resumable, so a control that cleared the stored
    // id would throw away a fight the server is still willing to continue.
    // What this pins is the difference: the id SURVIVES, and a fresh join
    // goes out carrying the sequence already folded.
    await start();
    act(() => {
      socket.emitMessage({
        type: "campaign_state",
        sequence: 4,
        snapshot: snapshotWith([
          combatant("hero", "party", "alive"),
          combatant("goblin-a", "hostile", "alive"),
        ]),
      });
    });
    const joinsBefore = socket.sent
      .map((each) => JSON.parse(each) as { type: string })
      .filter((each) => each.type === "join").length;

    act(() => {
      socket.emitMessage({ type: "error", code: "internal_error", message: "boom" });
    });

    const reconnectButton = await screen.findByRole("button", { name: he.app.reconnect });
    act(() => {
      reconnectButton.click();
    });

    // The whole point of the finding: not a teardown.
    expect(sessionStorage.getItem(CAMPAIGN_STORAGE_KEY)).toBe("s1");
    expect(screen.queryByRole("button", { name: he.app.startFight })).not.toBeInTheDocument();

    await waitFor(() => {
      socket.emitOpen();
      const joins = socket.sent
        .map(
          (each) => JSON.parse(each) as { type: string; campaignId?: string; resumeFrom?: number },
        )
        .filter((each) => each.type === "join");
      expect(joins).toHaveLength(joinsBefore + 1);
      expect(joins.at(-1)).toEqual({ type: "join", campaignId: "s1", resumeFrom: 4 });
    });
  });

  it("drops a tile selected on a previous turn instead of sending it as this turn's destination", async () => {
    // Finding 2: `selectedTile` used to be cleared only inside `commit`, so a
    // tile clicked (but never committed) on one turn's affordances survived
    // into the next turn's and could be sent as a destination the server
    // never sanctioned for the new board. The fix re-derives the effective
    // selection from the CURRENT `reachableTiles` every render, the same
    // pattern `ActionBar` already uses for its target picker.
    await start();

    act(() => {
      socket.emitMessage({
        type: "campaign_state",
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
        reachableTiles: [[5, 5]],
        actions: [{ actionType: "dodge", requiresTarget: false, targetableCombatantIds: [] }],
      });
    });

    act(() => {
      screen.getByRole("button", { name: /\(5,5\)/ }).click();
    });

    // A fresh affordance frame lands — same actor, same turn in terms of the
    // store's `sequence` guard, but a `reachableTiles` set that no longer
    // includes the tile clicked above (exactly what the enemy sweep landing
    // back on the player would look like).
    act(() => {
      socket.emitMessage({
        type: "turn_affordances",
        forSequence: 0,
        actorId: "hero",
        reachableTiles: [[1, 1]],
        actions: [{ actionType: "dodge", requiresTarget: false, targetableCombatantIds: [] }],
      });
    });

    act(() => {
      screen.getByRole("button", { name: he.actions.dodge }).click();
    });

    const sent = socket.sent.map((each) => JSON.parse(each) as Record<string, unknown>);
    const structured = sent.find((each) => each.type === "structured_action");
    expect(structured).toBeDefined();
    const turn = structured?.turn as Record<string, unknown>;
    // `exactOptionalPropertyTypes` means an omitted key and a key explicitly
    // set to `undefined` are different states on the wire (JSON.stringify
    // drops the latter too, so this assertion would pass either way in this
    // test specifically — but `Object.hasOwn` is the correct check for what
    // "no movement key" actually means, per the finding).
    expect(Object.hasOwn(turn, "movement")).toBe(false);
  });

  it("sends a tile clicked against the CURRENT affordances as this turn's destination", async () => {
    // The positive direction of the same rule. Without this, a regression
    // that permanently resolves the selection to null — no highlight, no
    // `movement` ever sent — ships green: every other assertion about
    // `selectedTile` is a negative one, and negatives all pass when the
    // feature is simply dead.
    await start();
    act(() => {
      socket.emitMessage({
        type: "campaign_state",
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
        reachableTiles: [[5, 5]],
        actions: [{ actionType: "dodge", requiresTarget: false, targetableCombatantIds: [] }],
      });
    });

    act(() => {
      screen.getByRole("button", { name: /\(5,5\)/ }).click();
    });
    act(() => {
      screen.getByRole("button", { name: he.actions.dodge }).click();
    });

    const sent = socket.sent.map((each) => JSON.parse(each) as Record<string, unknown>);
    const structured = sent.find((each) => each.type === "structured_action");
    const turn = structured?.turn as Record<string, unknown>;
    expect(turn.movement).toEqual([{ destinationTile: [5, 5], pathType: "direct" }]);
  });

  it("drops a selection when fresh affordances arrive even if the tile is still reachable", async () => {
    // The ghost-selection case, and the reason the rule is reference
    // identity rather than membership in `reachableTiles`. The reachable set
    // recentres on the hero every turn, so a tile clicked on turn N is
    // frequently still reachable on turn N+1 — a membership test would leave
    // it highlighted and committable as a choice the player never made this
    // turn. Note this test would PASS under the membership rule only if the
    // tile vanished; it is included here precisely because it does not.
    await start();
    act(() => {
      socket.emitMessage({
        type: "campaign_state",
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
        reachableTiles: [[5, 5]],
        actions: [{ actionType: "dodge", requiresTarget: false, targetableCombatantIds: [] }],
      });
    });

    act(() => {
      screen.getByRole("button", { name: /\(5,5\)/ }).click();
    });

    // A new offer that STILL contains the clicked tile.
    act(() => {
      socket.emitMessage({
        type: "turn_affordances",
        forSequence: 0,
        actorId: "hero",
        reachableTiles: [
          [5, 5],
          [1, 1],
        ],
        actions: [{ actionType: "dodge", requiresTarget: false, targetableCombatantIds: [] }],
      });
    });

    act(() => {
      screen.getByRole("button", { name: he.actions.dodge }).click();
    });

    const sent = socket.sent.map((each) => JSON.parse(each) as Record<string, unknown>);
    const structured = sent.find((each) => each.type === "structured_action");
    const turn = structured?.turn as Record<string, unknown>;
    expect(Object.hasOwn(turn, "movement")).toBe(false);
  });

  it("keeps exactly one live connection through StrictMode's dev double-invoke", async () => {
    // StrictMode double-invokes an effect (mount -> cleanup -> mount) only
    // around a component's INITIAL mount, not on a later re-run triggered by
    // a dependency change — so this has to start `started` true from the
    // very first render (a stored campaign id, exactly like a real refresh
    // mid-fight) rather than mounting idle and clicking the start button
    // afterward, or the effect's "real" (non-early-return) body would only
    // ever run once and the bug this guards against would go unexercised.
    //
    // main.tsx ships <StrictMode>, which in development runs this effect
    // mount -> cleanup -> mount. A single shared `cancelled` boolean gets
    // reset to false by the SECOND mount before the FIRST mount's still
    // -pending async IIFE ever reads it, so both runs reach `connect()` —
    // the socket factory call count is the observable proxy for that.
    sessionStorage.setItem(CAMPAIGN_STORAGE_KEY, "s1");
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
