import { describe, expect, it, vi } from "vitest";
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

  it("re-joins with resumeFrom after a drop", () => {
    const socket = fakeSocket();
    connect({
      sessionId: "s1",
      onFrame: () => undefined,
      onStatus: () => undefined,
      resumeFrom: () => 7,
      socketFactory: () => socket,
    });

    socket.emitOpen();
    expect(JSON.parse(socket.sent[0] ?? "{}")).toEqual({
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
    connect({
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
});
