import { beforeEach, describe, expect, it, vi } from "vitest";
import { initialClientState } from "./store.js";
import type { ClientState } from "./store.js";
import {
  LOG_STORAGE_KEY,
  clearStoredClientState,
  restoreClientState,
  storeClientState,
} from "./persistence.js";

const played: ClientState = {
  ...initialClientState,
  sequence: 12,
  narrative: "השומר נועץ את חניתו בגובלין.",
  narrativeStreamId: "n1",
  combatLog: [
    {
      actorId: "hero",
      actionType: "attack",
      movedFeet: 10,
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
      forfeited: false,
    },
  ],
};

beforeEach(() => {
  sessionStorage.clear();
});

describe("client state persistence", () => {
  it("round-trips the roll log, the narration and the sequence", () => {
    storeClientState("s1", played);

    const restored = restoreClientState("s1");
    expect(restored.sequence).toBe(12);
    expect(restored.narrative).toBe(played.narrative);
    expect(restored.narrativeStreamId).toBe("n1");
    expect(restored.combatLog).toEqual(played.combatLog);
  });

  it("restores no snapshot — the server's join answer is the only authority on state", () => {
    storeClientState("s1", { ...played, snapshot: null });
    expect(restoreClientState("s1").snapshot).toBeNull();
  });

  it("returns the initial state when nothing was stored", () => {
    expect(restoreClientState("s1")).toEqual(initialClientState);
  });

  it("returns the initial state when there is no session to restore into", () => {
    storeClientState("s1", played);
    expect(restoreClientState(null)).toEqual(initialClientState);
  });

  it("discards a log left behind by a different session", () => {
    // Both keys are written and cleared together, so this should be
    // unreachable — which is exactly why it is worth pinning: the failure it
    // guards against is a log folded from one fight being shown against
    // another fight's board.
    storeClientState("s1", played);
    expect(restoreClientState("s2")).toEqual(initialClientState);
  });

  it("discards a malformed stored payload rather than throwing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    sessionStorage.setItem(LOG_STORAGE_KEY, "{not json");
    expect(restoreClientState("s1")).toEqual(initialClientState);

    sessionStorage.setItem(
      LOG_STORAGE_KEY,
      JSON.stringify({ sessionId: "s1", sequence: "twelve" }),
    );
    expect(restoreClientState("s1")).toEqual(initialClientState);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("clears what it stored", () => {
    storeClientState("s1", played);
    clearStoredClientState();
    expect(sessionStorage.getItem(LOG_STORAGE_KEY)).toBeNull();
    expect(restoreClientState("s1")).toEqual(initialClientState);
  });
});
