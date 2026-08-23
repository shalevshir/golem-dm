import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServerFrame } from "@ai-dm/schemas";
import { connect } from "./connection.js";
import { fakeSocket } from "./fake-socket.js";

const snapshotFrame: ServerFrame = {
  type: "campaign_state",
  sequence: 0,
  snapshot: {
    campaignId: "s1",
    rootSeed: 1,
    encounterId: "goblin-ambush",
    grid: { width: 1, height: 1, tiles: [["normal"]] },
    combatants: [],
    turnOrder: [],
    currentActorIndex: 0,
    round: 1,
    appliedClientMessageIds: [],
  },
};

afterEach(() => {
  vi.useRealTimers();
});

describe("connect", () => {
  it("sends a join as soon as the socket opens", () => {
    const socket = fakeSocket();
    connect({
      campaignId: "s1",
      onFrame: () => undefined,
      onStatus: () => undefined,
      resumeFrom: () => undefined,
      socketFactory: () => socket,
    });

    socket.emitOpen();
    expect(JSON.parse(socket.sent[0] ?? "{}")).toEqual({ type: "join", campaignId: "s1" });
  });

  it("re-joins with resumeFrom read fresh at reconnect time, not captured once", () => {
    vi.useFakeTimers();
    // A fresh socket per factory call, all recorded: this is what proves the
    // retry timer genuinely re-invoked `open()` rather than the test merely
    // re-firing a listener still registered on the original socket.
    const sockets: ReturnType<typeof fakeSocket>[] = [];
    // A plain mutable value, not a constant thunk: it changes between the
    // first join and the reconnect, the same way the store's folded
    // sequence actually changes while a campaign is live. A `connect` that
    // captured `resumeFrom()` once — at `connect()` time, or once per
    // `open()` call rather than inside the "open" listener — is
    // behaviourally identical here (no frames arrive during the reconnect
    // window either way), so this only proves the value is re-read on each
    // connection attempt, not captured once at `connect()`.
    let sequence: number | undefined = undefined;
    connect({
      campaignId: "s1",
      onFrame: () => undefined,
      onStatus: () => undefined,
      resumeFrom: () => sequence,
      socketFactory: () => {
        const socket = fakeSocket();
        sockets.push(socket);
        return socket;
      },
    });

    expect(sockets).toHaveLength(1);
    sockets[0]?.emitOpen();
    expect(JSON.parse(sockets[0]?.sent[0] ?? "{}")).toEqual({ type: "join", campaignId: "s1" });

    // The store folds events after the first join lands; a later drop must
    // resume from what has actually been folded by then.
    sequence = 7;
    sockets[0]?.emitClose(); // the drop
    vi.advanceTimersByTime(1000); // the retry delay

    // The timer must have genuinely constructed a second socket, not just
    // scheduled nothing.
    expect(sockets).toHaveLength(2);
    sockets[1]?.emitOpen(); // the reconnected socket's own open event

    expect(JSON.parse(sockets[1]?.sent[0] ?? "{}")).toEqual({
      type: "join",
      campaignId: "s1",
      resumeFrom: 7,
    });
  });

  it("parses every inbound frame with the schema rather than casting", () => {
    const onFrame = vi.fn();
    const socket = fakeSocket();
    connect({
      campaignId: "s1",
      onFrame,
      onStatus: () => undefined,
      resumeFrom: () => undefined,
      socketFactory: () => socket,
    });

    socket.emitOpen();
    socket.emitMessage(snapshotFrame);
    expect(onFrame).toHaveBeenCalledWith(snapshotFrame);

    // A frame that does not satisfy `ServerFrame` must never reach the store.
    socket.emitMessage({ type: "campaign_state", sequence: -1 });
    expect(onFrame).toHaveBeenCalledTimes(1);
  });

  it("reports status transitions so the UI can show reconnecting", () => {
    const onStatus = vi.fn();
    const socket = fakeSocket();
    const connection = connect({
      campaignId: "s1",
      onFrame: () => undefined,
      onStatus,
      resumeFrom: () => undefined,
      socketFactory: () => socket,
    });

    expect(onStatus).toHaveBeenCalledWith("connecting");
    socket.emitOpen();
    expect(onStatus).toHaveBeenCalledWith("open");
    socket.emitClose();
    expect(onStatus).toHaveBeenCalledWith("reconnecting");

    // Close deliberately: emitClose() above scheduled a real 1s retry, and
    // leaving it pending would let it fire into a later test's mocks.
    connection.close();
  });

  it("stops reconnecting once closed deliberately", () => {
    const onStatus = vi.fn();
    const socket = fakeSocket();
    const connection = connect({
      campaignId: "s1",
      onFrame: () => undefined,
      onStatus,
      resumeFrom: () => undefined,
      socketFactory: () => socket,
    });

    socket.emitOpen();
    connection.close();
    socket.emitClose();
    expect(onStatus).toHaveBeenLastCalledWith("closed");
  });

  it("cancels a scheduled reconnect when closed deliberately before it fires", () => {
    vi.useFakeTimers();
    const onStatus = vi.fn();
    // Recorded per factory call, same as the reconnect test above: this is
    // the positive counterpart proving the timer was actually cancelled,
    // not merely that nothing happened to be observable — a suite with the
    // `clearTimeout` deleted would still build a second socket here.
    const sockets: ReturnType<typeof fakeSocket>[] = [];
    const connection = connect({
      campaignId: "s1",
      onFrame: () => undefined,
      onStatus,
      resumeFrom: () => undefined,
      socketFactory: () => {
        const socket = fakeSocket();
        sockets.push(socket);
        return socket;
      },
    });

    sockets[0]?.emitOpen(); // the first join is sent
    sockets[0]?.emitClose(); // an unexpected drop — schedules a retry ~1000ms out
    connection.close(); // must cancel that pending retry, not just ignore it

    vi.advanceTimersByTime(5000); // well past the retry delay

    // The scheduled retry never fired: no second socket was ever built, and
    // no second join was ever sent on the first one.
    expect(sockets).toHaveLength(1);
    expect(sockets[0]?.sent).toHaveLength(1);
    expect(onStatus).toHaveBeenLastCalledWith("closed");
  });
});
