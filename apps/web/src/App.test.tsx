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
import userEvent from "@testing-library/user-event";
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
    world: { campaignId: "s1", rootSeed: 3, appliedClientMessageIds: [], scene: null },
    encounter: {
      encounterId: "goblin-ambush",
      grid: {
        width: 12,
        height: 12,
        tiles: Array.from({ length: 12 }, () =>
          Array.from({ length: 12 }, () => "normal" as const),
        ),
      },
      combatants,
      turnOrder: combatants.map((each) => each.combatantId),
      currentActorIndex: 0,
      round: 1,
    },
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
    expect(expected.encounter?.round).toBe(2);
    expect(
      expected.encounter?.combatants.find((each) => each.combatantId === "goblin-a")?.currentHp,
    ).toBe(4);

    // The component's own projection, read back from the DOM (the Grid's
    // accessible combatant list) rather than from internal state — this is
    // what makes the check exercise the whole component, not `applyFrame` in
    // isolation.
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "גובלין לוחם 4/11" })).toBeInTheDocument();
    });
  });

  it("renders a defeat as a normal ending, not an error", async () => {
    // The party is expected to lose, and NO terminal frame is ever
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

    // The board mounts only once the (now reactive, §4.7 step 5) catalogue
    // fetch resolves, so this waits for the button rather than assuming it is
    // already there the instant the frames above are applied.
    const dodgeButton = await screen.findByRole("button", { name: he.actions.dodge });
    act(() => {
      dodgeButton.click();
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
    //
    // That was the whole story back when a campaign was one fight, so a
    // restored log could only ever describe the fight it came from. A
    // campaign now spans encounters, and this same check is what stops the
    // sharper case: a restored log describing a fight the campaign has
    // already left, since an encounter_resolved always advances the
    // sequence past whatever was stored. This fixture still drives the
    // mid-fight case above, not a bracket crossing — the sequence jump here
    // comes from a live reconnect — but `applyFrame` takes the identical
    // branch either way.
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
    // `selectedTile` used to be cleared only inside `commit`, so a
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

    // The board mounts only once the (now reactive, §4.7 step 5) catalogue
    // fetch resolves, so this waits for the tile rather than assuming it is
    // already there the instant the frames above are applied.
    const initialTile = await screen.findByRole("button", { name: /\(5,5\)/ });
    act(() => {
      initialTile.click();
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

    // The board mounts only once the (now reactive, §4.7 step 5) catalogue
    // fetch resolves, so this waits for the tile rather than assuming it is
    // already there the instant the frames above are applied.
    const tile = await screen.findByRole("button", { name: /\(5,5\)/ });
    act(() => {
      tile.click();
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

    // The board mounts only once the (now reactive, §4.7 step 5) catalogue
    // fetch resolves, so this waits for the tile rather than assuming it is
    // already there the instant the frames above are applied.
    const tile = await screen.findByRole("button", { name: /\(5,5\)/ });
    act(() => {
      tile.click();
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
    // that shared-boolean bug is what the monotonic `runIdRef` in App.tsx
    // guards against.
    //
    // Since §4.7 step 5 (this task) removed the unconditional mount-time
    // catalogue fetch, this reconnect path (a stored id, no `?world=`) has no
    // `await` left before `connect()` at all -- `stored ?? (await
    // createCampaign(...))` short-circuits without ever evaluating its right
    // side. So the mount -> cleanup -> mount sequence now runs synchronously
    // start to finish: TWO sockets are genuinely constructed (the factory
    // call count below), not one. That is fine -- the property this test
    // actually cares about is that cleanup disposes of the first one before
    // the second is ever used, i.e. no connection is left open and
    // forgotten. `close` is spied per socket to prove exactly that.
    sessionStorage.setItem(CAMPAIGN_STORAGE_KEY, "s1");
    const sockets: FakeSocket[] = [];
    const factory = vi.fn((): FakeSocket => {
      const created = fakeSocket();
      const withCloseSpy = { ...created, close: vi.fn(created.close) };
      sockets.push(withCloseSpy);
      return withCloseSpy;
    });

    render(
      <StrictMode>
        <App socketFactory={factory} wsUrl="ws://test/ws" />
      </StrictMode>,
    );

    // Whichever socket survives eventually opens and joins.
    await waitFor(() => {
      for (const each of sockets) each.emitOpen();
      expect(sockets.some((each) => each.sent.length > 0)).toBe(true);
    });

    expect(factory).toHaveBeenCalledTimes(2);
    // The first (stale) connection was torn down by cleanup before the
    // second (surviving) one was ever created -- the actual bug the old
    // shared-boolean guard let through was this NOT happening.
    expect(sockets[0]?.close).toHaveBeenCalledTimes(1);
    expect(sockets[1]?.close).not.toHaveBeenCalled();
  });
});

// §4.7 step 4's web slice. A joined scene campaign has `encounter === null`
// and `world.scene !== null` -- the gating assertion below is the point of
// this whole suite: combat controls (Grid/ActionBar) exist ONLY inside an
// open encounter, which is what keeps the known `not_your_turn`-in-
// `SILENT_CODES` trap unreachable -- nothing out of combat can send a
// `structured_action`, so the silent refusal never has a sender.
describe("App (scene mode, out-of-combat free text)", () => {
  const scene = {
    worldId: "emberfall",
    currentNodeId: "market-square",
    completedNodeIds: [],
    relations: [],
    day: 1,
  };

  function sceneSnapshot(): CampaignState {
    return {
      world: { campaignId: "s1", rootSeed: 3, appliedClientMessageIds: [], scene },
      encounter: null,
    };
  }

  it("renders NarrativePane + FreeTextBar for a joined scene campaign and renders no Grid or ActionBar, keeping the not_your_turn-in-SILENT_CODES trap unreachable since nothing out of combat can send a structured_action", async () => {
    const { container } = await start();
    act(() => {
      socket.emitMessage({ type: "campaign_state", sequence: 0, snapshot: sceneSnapshot() });
    });

    expect(await screen.findByPlaceholderText(he.freeText.placeholder)).toBeInTheDocument();
    expect(container.querySelector(".grid")).not.toBeInTheDocument();
    expect(container.querySelector(".action-bar")).not.toBeInTheDocument();
    // The gating property stated concretely: no structured_action can ever
    // be sent from here, because the component that builds one (ActionBar,
    // via App's `commit`) is simply not mounted.
    expect(
      socket.sent.some((each) => (JSON.parse(each) as { type: string }).type === "structured_action"),
    ).toBe(false);
  });

  // Whole-branch review finding 3: the scene view had no connection-status
  // line at all, so a dropped socket presented as a dead input box with
  // nothing explaining it -- the inert-board soft-lock in an out-of-combat
  // costume. Drives the same drop -> retry -> reconnect cycle the
  // pendingFreeTextId test below uses.
  it("shows a connection-status line in the scene view, switching to reconnecting on a drop and back once reconnected", async () => {
    await start();
    act(() => {
      socket.emitMessage({ type: "campaign_state", sequence: 0, snapshot: sceneSnapshot() });
    });

    await screen.findByPlaceholderText(he.freeText.placeholder);
    expect(screen.queryByText(he.app.reconnecting)).not.toBeInTheDocument();

    vi.useFakeTimers();
    act(() => {
      socket.emitClose();
    });
    expect(screen.getByText(he.app.reconnecting)).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    vi.useRealTimers();

    act(() => {
      socket.emitOpen();
    });

    expect(screen.queryByText(he.app.reconnecting)).not.toBeInTheDocument();
  });

  it("keeps today's placeholder when encounter is null and scene is also null (a legacy/pre-genesis campaign)", async () => {
    await start();
    act(() => {
      socket.emitMessage({
        type: "campaign_state",
        sequence: 0,
        snapshot: {
          world: { campaignId: "s1", rootSeed: 3, appliedClientMessageIds: [], scene: null },
          encounter: null,
        },
      });
    });

    expect(screen.queryByPlaceholderText(he.freeText.placeholder)).not.toBeInTheDocument();
    expect(screen.getByText(he.app.connecting)).toBeInTheDocument();
  });

  it("disables the FreeTextBar on send and re-enables it once narrative_emitted folds", async () => {
    await start();
    act(() => {
      socket.emitMessage({ type: "campaign_state", sequence: 0, snapshot: sceneSnapshot() });
    });

    const input = await screen.findByPlaceholderText(he.freeText.placeholder);
    await userEvent.type(input, "לך לשוק{Enter}");

    expect(screen.getByPlaceholderText(he.freeText.placeholder)).toBeDisabled();
    const sent = socket.sent.map((each) => JSON.parse(each) as Record<string, unknown>);
    expect(sent.find((each) => each.type === "free_text")).toEqual({
      type: "free_text",
      clientMessageId: "11111111-1111-4111-8111-111111111111",
      text: "לך לשוק",
    });

    act(() => {
      socket.emitMessage({
        type: "event",
        event: event(1, "narrative_emitted", {
          actorId: "hero",
          streamId: "n1",
          text: NARRATION,
          source: "deterministic",
          promptVersion: "v1",
        }),
      });
    });

    expect(screen.getByPlaceholderText(he.freeText.placeholder)).not.toBeDisabled();
  });

  it("re-enables the FreeTextBar and shows the banner on an error frame -- free_text_not_supported is not in SILENT_CODES, so a typing player actually sees it", async () => {
    await start();
    act(() => {
      socket.emitMessage({ type: "campaign_state", sequence: 0, snapshot: sceneSnapshot() });
    });

    const input = await screen.findByPlaceholderText(he.freeText.placeholder);
    await userEvent.type(input, "לך לשוק{Enter}");
    expect(screen.getByPlaceholderText(he.freeText.placeholder)).toBeDisabled();

    act(() => {
      socket.emitMessage({
        type: "error",
        clientMessageId: "11111111-1111-4111-8111-111111111111",
        code: "free_text_not_supported",
        message: "not yet supported",
      });
    });

    expect(screen.getByPlaceholderText(he.freeText.placeholder)).not.toBeDisabled();
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByText(he.errors.free_text_not_supported)).toBeInTheDocument();
  });

  it("does not latch the FreeTextBar disabled forever on an internal_error with no clientMessageId (the ws.ts catch-all shape)", async () => {
    // apps/server/src/transport/ws.ts's catch-all around a failed
    // handleCommand drain sends {type:"error", code:"internal_error"} with
    // NO clientMessageId -- ServerFrame's error member declares it optional,
    // so this is schema-legal. This is the exact frame this task's own
    // manual smoke test received when the configured provider key was
    // invalid: without treating "no id" as a match, `current === clientMessageId`
    // (undefined) never holds and the bar stays disabled forever -- a
    // soft-lock in a new costume, recoverable only by a page refresh.
    await start();
    act(() => {
      socket.emitMessage({ type: "campaign_state", sequence: 0, snapshot: sceneSnapshot() });
    });

    const input = await screen.findByPlaceholderText(he.freeText.placeholder);
    await userEvent.type(input, "לך לשוק{Enter}");
    expect(screen.getByPlaceholderText(he.freeText.placeholder)).toBeDisabled();

    act(() => {
      // No clientMessageId at all -- distinct from the matching-id case
      // already covered above.
      socket.emitMessage({ type: "error", code: "internal_error", message: "boom" });
    });

    expect(screen.getByPlaceholderText(he.freeText.placeholder)).not.toBeDisabled();
  });

  it("clears a stuck pendingFreeTextId on a silent socket drop, so the bar re-enables once reconnected instead of staying disabled forever", async () => {
    // The path the previous version of this test missed: `net/connection.ts`'s
    // `send()` silently no-ops while the socket is not OPEN -- a `free_text`
    // dropped that way produces NO error frame (nothing reaches the server at
    // all), so the `onFrame`-based clears above never fire. The automatic
    // reconnect loop that follows a real drop (`onStatus("reconnecting")` +
    // `net/connection.ts`'s own timed retry) never calls this component's
    // `reconnect()` callback either -- that is wired only to `ErrorBanner`'s
    // button, which needs an `internal_error` frame to even render. `status`
    // leaving `"open"` is the one signal actually reachable from a silent
    // client-side drop, which is why the fix lives on `onStatus`, not on any
    // frame handler.
    //
    // While disconnected the bar is (correctly) disabled by its OWN
    // `status !== "open"` clause regardless of `pendingFreeTextId` -- so the
    // fix is only observable once the socket comes back: without it,
    // `pendingFreeTextId` would still be the old id after reconnecting, and
    // the bar would stay disabled even once `status` is `"open"` again. This
    // drives the full drop -> retry -> reconnect cycle (the same fake-timer
    // dance this file's very first test uses for `net/connection.ts`'s own
    // 1s retry) and asserts the bar comes back.
    await start();
    act(() => {
      socket.emitMessage({ type: "campaign_state", sequence: 0, snapshot: sceneSnapshot() });
    });

    const input = await screen.findByPlaceholderText(he.freeText.placeholder);
    await userEvent.type(input, "לך לשוק{Enter}");
    expect(screen.getByPlaceholderText(he.freeText.placeholder)).toBeDisabled();

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

    expect(screen.getByPlaceholderText(he.freeText.placeholder)).not.toBeDisabled();
    // No banner either -- this was a silent drop, not a surfaced fault.
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

// §4.7 step 4's only real production path: `?world=` campaign creation. The
// scene-mode tests above all go through the default `start()` helper, which
// fetches an encounter catalogue -- so without this suite, the scene branch
// is never exercised with `catalogue === null`, and nothing pins that the
// catalogue fetch is genuinely skipped for a world campaign.
describe("App (?world= query param)", () => {
  const scene = {
    worldId: "emberfall",
    currentNodeId: "market-square",
    completedNodeIds: [],
    relations: [],
    day: 1,
  };

  function sceneSnapshot(): CampaignState {
    return {
      world: { campaignId: "s1", rootSeed: 3, appliedClientMessageIds: [], scene },
      encounter: null,
    };
  }

  // Ids matched to the shared `catalogue` fixture (not `goblin-ambush`'s real
  // spawns) since `fetchMock` answers every non-POST call with that fixture.
  function bracketOpen(): CampaignState["encounter"] {
    return snapshotWith([
      combatant("hero", "party", "alive"),
      combatant("goblin-a", "hostile", "alive"),
    ]).encounter;
  }

  beforeEach(() => {
    window.history.pushState({}, "", "/?world=emberfall");
  });

  afterEach(() => {
    window.history.pushState({}, "", "/");
  });

  it("creates the campaign with {worldId}, never fetches an encounter catalogue, and still renders the FreeTextBar", async () => {
    await start();

    const posts = fetchMock.mock.calls.filter(
      (call: unknown[]) => (call[1] as RequestInit | undefined)?.method === "POST",
    );
    expect(posts).toHaveLength(1);
    expect(JSON.parse((posts[0]?.[1] as RequestInit).body as string)).toEqual({
      worldId: "emberfall",
    });
    // The gap this closes: without this assertion, reinstating the old
    // combined "not ready" condition (requiring a catalogue unconditionally)
    // would break `?world=` in production while every other test here stays
    // green, since none of them set `window.location.search`.
    expect(
      fetchMock.mock.calls.some((call: unknown[]) => String(call[0]).includes("/encounters/")),
    ).toBe(false);

    act(() => {
      socket.emitMessage({ type: "campaign_state", sequence: 0, snapshot: sceneSnapshot() });
    });
    expect(await screen.findByPlaceholderText(he.freeText.placeholder)).toBeInTheDocument();
  });

  it("fetches the catalogue and renders the board when a bracket opens mid-scene", async () => {
    await start();

    act(() => {
      socket.emitMessage({ type: "campaign_state", sequence: 0, snapshot: sceneSnapshot() });
    });
    expect(await screen.findByPlaceholderText(he.freeText.placeholder)).toBeInTheDocument();

    // The bracket opens on the already-open socket — the case that was
    // unreachable before §4.7 step 5 and is the whole point of it. `reduce`
    // now folds this into a real board (Task 2), so the client needs the
    // catalogue it never fetched at mount.
    act(() => {
      socket.emitMessage({
        type: "campaign_state",
        sequence: 1,
        snapshot: { ...sceneSnapshot(), encounter: bracketOpen() },
      });
    });

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some((call: unknown[]) =>
          String(call[0]).includes("/encounters/goblin-ambush"),
        ),
      ).toBe(true);
    });
    // The board replaces the free-text bar once the catalogue lands.
    await waitFor(() => {
      expect(screen.queryByPlaceholderText(he.freeText.placeholder)).not.toBeInTheDocument();
    });
  });
});
