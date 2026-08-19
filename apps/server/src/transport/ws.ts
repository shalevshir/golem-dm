// The websocket adapter. It parses, validates, routes to the core and pumps
// frames back — nothing else. Every decision about the game is made by
// `handleCommand`, which never sees a socket.
import type { FastifyInstance } from "fastify";
import { ClientMessage } from "@ai-dm/schemas";
import type { ServerFrame } from "@ai-dm/schemas";
import { handleCommand } from "../core/pipeline.js";
import type { TurnPorts } from "../core/pipeline.js";
import type { Session } from "../core/session.js";
import type { SessionRegistry } from "./http.js";

export interface WebSocketRouteInput {
  registry: SessionRegistry;
  ports: TurnPorts;
}

export function registerWebSocketRoute(app: FastifyInstance, input: WebSocketRouteInput): void {
  app.get("/ws", { websocket: true }, (socket) => {
    // One socket, one session (ADR 0002 is solo play), bound by `join`.
    let session: Session | null = null;
    // One command in flight. A queued stale click would land against a changed
    // board and fail validation for reasons the player cannot see.
    let busy = false;

    function send(frame: ServerFrame): void {
      // C-36a: `handleCommand` is always drained to completion below, even
      // once the client has gone — a half-drained generator mid-turn would
      // leave the rest of that turn's events unwritten. That means frames
      // can still arrive here after the socket has closed. Silently
      // dropping them (rather than calling `socket.send` on a closed
      // socket, which throws) is what lets the drain finish undisturbed:
      // stop *sending*, don't stop *pulling*.
      if (socket.readyState !== socket.OPEN) return;
      socket.send(JSON.stringify(frame));
    }

    socket.on("message", (raw: Buffer | string) => {
      void (async () => {
        let parsed;
        try {
          parsed = ClientMessage.safeParse(JSON.parse(String(raw)));
        } catch {
          send({ type: "error", code: "malformed_message", message: "Body is not valid JSON." });
          return;
        }
        if (!parsed.success) {
          send({ type: "error", code: "malformed_message", message: parsed.error.message });
          return;
        }
        const command = parsed.data;

        if (command.type === "join") {
          const found = await input.registry.get(command.sessionId);
          if (found === null) {
            send({
              type: "error",
              code: "unknown_session",
              message: `No session ${command.sessionId}. Create one with POST /sessions.`,
            });
            return;
          }
          session = found;
        }

        if (session === null) {
          send({ type: "error", code: "unknown_session", message: "Send a join message first." });
          return;
        }

        if (busy) {
          send({
            type: "error",
            ...(command.type === "join" ? {} : { clientMessageId: command.clientMessageId }),
            code: "turn_in_progress",
            message: "A turn is already resolving.",
          });
          return;
        }

        busy = true;
        try {
          // C-36a: drain to completion — never `break` out of this loop.
          // `handleCommand`'s `emit` writes its periodic snapshot after its
          // `yield`, and the enemy-turn loop appends several events per
          // turn; abandoning the iterator mid-turn (which a `break` would
          // do) would leave the rest of that turn unwritten. `send` above
          // is what makes it safe to keep pulling after the socket closes.
          for await (const frame of handleCommand(session, command, input.ports)) send(frame);
        } catch (error) {
          // The log is already consistent — `emit` appends before it yields —
          // so the socket reporting a failure does not leave a torn session.
          send({
            type: "error",
            code: "internal_error",
            message: error instanceof Error ? error.message : String(error),
          });
        } finally {
          busy = false;
        }
      })();
    });
  });
}
