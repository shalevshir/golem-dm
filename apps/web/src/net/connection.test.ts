import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServerFrame } from "@ai-dm/schemas";
import { connect } from "./connection.js";
import { fakeSocket } from "./fake-socket.js";

const snapshotFrame: ServerFrame = {
  type: "session_state",
  sequence: 0,
  snapshot: {
    sessionId: "s1",
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
      sessionId: "s1",
      onFrame: () => undefined,
      onStatus: () => undefined,
      resumeFrom: () => undefined,
      socketFactory: () => socket,
    });

    socket.emitOpen();
    expect(JSON.parse(socket.sent[0] ?? "{}")).toEqual({ type: "join", sessionId: "s1" });
  });

  it("re-joins with resumeFrom read fresh at reconnect time, not captured once", () => {
    vi.useFakeTimers();
    const socket = fakeSocket();
    // A plain mutable value, not a constant thunk: it changes between the
    // first join and the reconnect, the same way the store's folded
    // sequence actually changes while a session is live. A `connect` that
    // captured `resumeFrom()` once (at `connect()` time, or once per `open`
    // call before the socket has actually reopened) would still send
    // `undefined` on the second join here — this is what catches that bug.
    let sequence: number | undefined = undefined;
    connect({
      sessionId: "s1",
      onFrame: () => undefined,
      onStatus: () => undefined,
      resumeFrom: () => sequence,
      socketFactory: () => socket,
    });

    socket.emitOpen();
    expect(JSON.parse(socket.sent[0] ?? "{}")).toEqual({ type: "join", sessionId: "s1" });

    // The store folds events after the first join lands; a later drop must
    // resume from what has actually been folded by then.
    sequence = 7;
    socket.emitClose(); // the drop
    vi.advanceTimersByTime(1000); // the retry delay
    socket.emitOpen(); // the reconnected socket's open event

    expect(JSON.parse(socket.sent[1] ?? "{}")).toEqual({
      type: "join",
      sessionId: "s1",
      resumeFrom: 7,
    });
  });

  it("parses every inbound frame with the schema rather than casting", () => {
    const onFrame = vi.fn();
    const socket = fakeSocket();
    connect({
      sessionId: "s1",
      onFrame,
      onStatus: () => undefined,
      resumeFrom: () => undefined,
      socketFactory: () => socket,
    });

    socket.emitOpen();
    socket.emitMessage(snapshotFrame);
    expect(onFrame).toHaveBeenCalledWith(snapshotFrame);

    // A frame that does not satisfy `ServerFrame` must never reach the store.
    socket.emitMessage({ type: "session_state", sequence: -1 });
    expect(onFrame).toHaveBeenCalledTimes(1);
  });

  it("reports status transitions so the UI can show reconnecting", () => {
    const onStatus = vi.fn();
    const socket = fakeSocket();
    const connection = connect({
      sessionId: "s1",
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
      sessionId: "s1",
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
    const socket = fakeSocket();
    const connection = connect({
      sessionId: "s1",
      onFrame: () => undefined,
      onStatus,
      resumeFrom: () => undefined,
      socketFactory: () => socket,
    });

    socket.emitOpen(); // the first join is sent
    socket.emitClose(); // an unexpected drop — schedules a retry ~1000ms out
    connection.close(); // must cancel that pending retry, not just ignore it

    vi.advanceTimersByTime(5000); // well past the retry delay

    // No second join was ever sent: the scheduled retry never fired.
    expect(socket.sent).toHaveLength(1);
    expect(onStatus).toHaveBeenLastCalledWith("closed");
  });
});
