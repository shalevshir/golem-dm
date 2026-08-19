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
    // Per-SOCKET ordering guard only — see the two-guard comment in the
    // message handler below for why a per-session lock (via `registry`) is
    // also required and this alone is not the CRITICAL-1 fix.
    let localBusy = false;

    function send(frame: ServerFrame): void {
      // C-36a: `handleCommand` is always drained to completion below, even
      // once the client has gone — a half-drained generator mid-turn would
      // leave the rest of that turn's events unwritten. That means frames
      // can still arrive here after the socket has closed. Guarding here,
      // rather than letting `socket.send` run on a non-OPEN socket — `ws`
      // routes that to `sendAfterClose`, which surfaces as an `'error'`
      // event rather than a thrown exception (verified against
      // `ws@8.21.3`'s `lib/websocket.js`) — is what lets the drain finish
      // undisturbed without that stray event needing its own handler:
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

        function turnInProgress(): void {
          send({
            type: "error",
            ...(command.type === "join" ? {} : { clientMessageId: command.clientMessageId }),
            code: "turn_in_progress",
            message: "A turn is already resolving.",
          });
        }

        // Two DISTINCT guards, both claimed here in the synchronous prefix,
        // before any `await` — that is what makes each atomic under JS's
        // single-threaded execution, the same guarantee the old lone
        // per-socket flag had, just correctly split across the two hazards
        // it was actually covering:
        //
        // 1. `localBusy` — per SOCKET. `ws` delivers two writes that arrive
        //    in one TCP read (e.g. a client that pipelines `join`
        //    immediately followed by its first action) as two synchronous
        //    `message` events. Without this, the second event's handler
        //    could reach `session === null` before the first event's own
        //    `await input.registry.get` below had resumed and `session` was
        //    ever assigned — misreporting a legitimate pipelined action as
        //    `unknown_session` (review finding, task 14 round 2). Rejected
        //    with `turn_in_progress`, not queued — see point 2.
        //
        // 2. The `SessionRegistry`'s per-SESSION lock (CRITICAL-1). Sessions
        //    are deliberately shared across sockets — `http.ts`'s `live`
        //    cache is what lets two WS connections onto the same session
        //    (Task 14) alias one mutable `Session` object, with
        //    `nextSequence` advanced on it in place — so `localBusy` alone
        //    cannot prevent two different sockets bound to the same session
        //    from each passing their own turn-order check while the other's
        //    turn is still resolving. Claimed ONLY for mutating commands
        //    (`structured_action`/`free_text`) — see the `join` exclusion
        //    just below for why. `sessionId` below reads `session?.state.
        //    sessionId`, which is `undefined` whenever this socket has not
        //    yet bound a session — including a stray non-join sent before
        //    any `join` at all, a case guard 1 does NOT rule out (it only
        //    serializes messages on this socket; it does not require the
        //    first one to have been a `join`). When `sessionId` is
        //    `undefined` no lock is consulted, and control falls through to
        //    the `session === null` ("send a join message first") branch
        //    further down.
        //
        // `join` is deliberately EXCLUDED from the session lock (post-review
        // fix): `pipeline.ts`'s `join` branch is read-only — it calls
        // `latestSnapshot`/`readSince` and yields `session_state`/`event`
        // frames, never `emit`, so it cannot itself duplicate a turn, which
        // is the only hazard this lock exists to prevent. Claiming it for
        // `join` was a regression: C-36a keeps a turn's `handleCommand`
        // draining, lock held, for the WHOLE hero turn plus the entire enemy
        // sweep (each budgeted `turnTimeoutMs`) even after the originating
        // socket has disappeared — so a client that drops mid-turn and
        // reconnects could have its own `join` rejected with
        // `turn_in_progress` instead of getting the `session_state` restore
        // the spec's §Reconnect and `protocol.ts`'s `JoinMessage`
        // doc-comment both promise.
        //
        // Neither guard is a queue: the spec is explicit that a queued stale
        // click would land against a changed board and fail validation for
        // reasons the player cannot see, so a command arriving under either
        // guard is answered `turn_in_progress` and dropped, not deferred.
        if (localBusy) {
          turnInProgress();
          return;
        }
        const sessionId = command.type === "join" ? undefined : session?.state.sessionId;
        const claimedSessionLock = sessionId !== undefined && input.registry.tryBegin(sessionId);
        if (sessionId !== undefined && !claimedSessionLock) {
          turnInProgress();
          return;
        }

        localBusy = true;
        try {
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
          // Also covers a `registry.get` failure (e.g. a corrupt log):
          // previously that `await` sat outside this `try`, so it could
          // reject the whole async handler as an unhandled rejection
          // instead of a graceful frame.
          send({
            type: "error",
            code: "internal_error",
            message: error instanceof Error ? error.message : String(error),
          });
        } finally {
          localBusy = false;
          // Release the SESSION lock last — after the drain above has fully
          // finished (or thrown) — never earlier. `claimedSessionLock` is
          // only ever `true` for a mutating command whose `session` was
          // already bound when the lock was claimed (see the guard-2
          // comment above), so this only fires on the one path that could
          // have held it: the full `handleCommand` drain, success or
          // failure. `join` never reaches here with anything to release —
          // it never claims the lock at all (excluded above).
          if (sessionId !== undefined && claimedSessionLock) input.registry.end(sessionId);
        }
      })();
    });
  });
}
