import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import {
  createAgentRuntime,
  createDeterministicNarrative,
  createFakePort,
  createTacticalAgent,
  DEFAULT_MODEL_ROUTING,
} from "@ai-dm/agents";
import type { ServerFrame } from "@ai-dm/schemas";
import { buildApp } from "../app.js";
import { createInMemoryEventStore } from "../core/event-store.js";
import type { TurnPorts } from "../core/pipeline.js";
import { createSessionRegistry } from "./http.js";
import type { FastifyInstance } from "fastify";

let running: FastifyInstance | null = null;

afterEach(async () => {
  await running?.close();
  running = null;
});

async function startServer() {
  const store = createInMemoryEventStore();
  let n = 0;
  const uuid = (): string => {
    n += 1;
    return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  };
  // C-1/C-2: `ExecuteTurn.tacticalRationaleEnglish` has no `.optional()` and
  // `TokenUsage` is `{ promptTokens, completionTokens, totalTokens }`, not
  // `{ inputTokens, outputTokens }` — see `packages/agents/src/providers/
  // testing/fake-port.ts` and `packages/schemas/src/actions.ts`. Getting
  // either wrong here makes `ClientMessage.safeParse` (for the wire
  // literals below) or the compiler (for this typed script) reject, not the
  // assertions.
  const port = createFakePort({
    structured: Array.from({ length: 40 }, () => ({
      ok: true as const,
      value: {
        value: {
          actorId: "goblin-a",
          mainAction: { actionType: "dodge" },
          tacticalRationaleEnglish: "Fake tactical fixture: always dodge.",
        },
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      },
    })),
  });
  const ports: TurnPorts = {
    store,
    tactical: createTacticalAgent({
      runtime: createAgentRuntime({ routing: DEFAULT_MODEL_ROUTING, port }),
    }),
    narrative: createDeterministicNarrative(),
    clock: () => "2026-08-19T10:00:00.000Z",
    uuid,
    seedFor: (rootSeed, sequence) => rootSeed * 1000 + sequence,
    turnTimeoutMs: 10_000,
  };
  const registry = createSessionRegistry({
    store,
    uuid,
    clock: () => "2026-08-19T10:00:00.000Z",
    seed: () => 42,
  });

  const app = buildApp({ registry, ports });
  await app.listen({ port: 0, host: "127.0.0.1" });
  running = app;

  const address = app.server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return { app, url: `ws://127.0.0.1:${String(address.port)}/ws`, store };
}

function connect(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url);
  return new Promise((resolve, reject) => {
    socket.once("open", () => {
      resolve(socket);
    });
    socket.once("error", reject);
  });
}

/** Collect frames until `stop` says we have what we came for. */
function framesUntil(
  socket: WebSocket,
  stop: (frame: ServerFrame) => boolean,
): Promise<ServerFrame[]> {
  const frames: ServerFrame[] = [];
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`timed out after ${String(frames.length)} frames`));
    }, 5000);
    socket.on("message", (data: Buffer | string) => {
      const frame = JSON.parse(String(data)) as ServerFrame;
      frames.push(frame);
      if (stop(frame)) {
        clearTimeout(timer);
        resolve(frames);
      }
    });
    socket.once("error", reject);
  });
}

async function createSessionOver(app: FastifyInstance): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/sessions",
    payload: { encounterId: "goblin-ambush" },
  });
  return (JSON.parse(response.body) as { sessionId: string }).sessionId;
}

describe("websocket transport", () => {
  // Break scenario: `registerWebSocketRoute` returning nothing but a bare
  // `session_state` echo (or never wiring `join` to the registry at all)
  // still needs SOME response for this to fail — this asserts the frame
  // is specifically `session_state`, so a handler that answered every
  // message with a generic `error` frame, or that hung and never replied,
  // both turn this red rather than green.
  it("answers a join with a session_state snapshot", async () => {
    const { app, url } = await startServer();
    const sessionId = await createSessionOver(app);
    const socket = await connect(url);
    const pending = framesUntil(socket, (frame) => frame.type === "session_state");
    socket.send(JSON.stringify({ type: "join", sessionId }));
    const frames = await pending;
    expect(frames[0]).toMatchObject({ type: "session_state" });
    socket.close();
  });

  // Break scenario: a handler that let an unknown sessionId fall through to
  // `handleCommand` (which assumes a bound `Session`) would throw or hang
  // instead of answering `unknown_session` — this fails red either way,
  // rather than passing on any non-empty response.
  it("errors on an unknown session rather than closing the socket", async () => {
    const { url } = await startServer();
    const socket = await connect(url);
    const pending = framesUntil(socket, (frame) => frame.type === "error");
    socket.send(JSON.stringify({ type: "join", sessionId: "nope" }));
    expect((await pending)[0]).toMatchObject({ code: "unknown_session" });
    socket.close();
  });

  // Break scenario: a handler that let `JSON.parse` throw uncaught (instead
  // of catching it and answering `malformed_message`) would crash the
  // message handler and this promise would time out rather than resolve.
  it("errors on a malformed message rather than crashing", async () => {
    const { url } = await startServer();
    const socket = await connect(url);
    const pending = framesUntil(socket, (frame) => frame.type === "error");
    socket.send("not json at all");
    expect((await pending)[0]).toMatchObject({ code: "malformed_message" });
    socket.close();
  });

  // Break scenario: a handler that only guarded against invalid JSON, not
  // against JSON that parses but fails `ClientMessage.safeParse` (an
  // unrecognized `type`), would pass this a `command` typed as `never` and
  // either throw inside `handleCommand`'s exhaustiveness guard or silently
  // drop the message — both leave this pending forever instead of getting
  // `malformed_message`.
  it("errors on a message that parses but is not a ClientMessage", async () => {
    const { url } = await startServer();
    const socket = await connect(url);
    const pending = framesUntil(socket, (frame) => frame.type === "error");
    socket.send(JSON.stringify({ type: "shout", text: "hi" }));
    expect((await pending)[0]).toMatchObject({ code: "malformed_message" });
    socket.close();
  });

  // Break scenario: this is the one test that would go red if the transport
  // merely echoed frames without actually driving `handleCommand`'s turn
  // pipeline, or if it stopped at the first frame instead of streaming both
  // `narrative_token` and `event` frames — asserting on frame *types*
  // (not `frames.length > 0`) is what a `malformed_message` error frame
  // cannot satisfy by accident.
  it("plays a turn and streams its events and narrative", async () => {
    const { app, url } = await startServer();
    const sessionId = await createSessionOver(app);
    const socket = await connect(url);

    await new Promise<void>((resolve) => {
      socket.once("message", () => {
        resolve();
      });
      socket.send(JSON.stringify({ type: "join", sessionId }));
    });

    const pending = framesUntil(
      socket,
      (frame) => frame.type === "event" && frame.event.type === "scene_changed",
    );
    socket.send(
      JSON.stringify({
        type: "structured_action",
        clientMessageId: "c1",
        actorId: "hero",
        turn: {
          actorId: "hero",
          mainAction: { actionType: "dodge" },
          tacticalRationaleEnglish: "Test fixture: hero dodges.",
        },
      }),
    );

    const frames = await pending;
    expect(frames.some((each) => each.type === "narrative_token")).toBe(true);
    expect(frames.some((each) => each.type === "event")).toBe(true);
    socket.close();
  });
});
