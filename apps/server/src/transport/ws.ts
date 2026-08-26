// The websocket adapter. It parses, validates, routes to the core and pumps
// frames back — nothing else. Every decision about the game is made by
// `handleCommand`, which never sees a socket.
import type { FastifyInstance } from "fastify";
import { ClientMessage } from "@ai-dm/schemas";
import type { ServerFrame } from "@ai-dm/schemas";
import { handleCommand } from "../core/pipeline.js";
import type { TurnPorts } from "../core/pipeline.js";
import type { Campaign } from "../core/campaign.js";
import type { CampaignRegistry } from "./http.js";

export interface WebSocketRouteInput {
  registry: CampaignRegistry;
  ports: TurnPorts;
}

export function registerWebSocketRoute(app: FastifyInstance, input: WebSocketRouteInput): void {
  app.get("/ws", { websocket: true }, (socket) => {
    // One socket, one campaign (ADR 0002 is solo play), bound by `join`.
    let campaign: Campaign | null = null;
    // Per-SOCKET ordering guard only — see the two-guard comment in the
    // message handler below for why a per-campaign lock (via `registry`) is
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
        //    could reach `campaign === null` before the first event's own
        //    `await input.registry.get` below had resumed and `campaign` was
        //    ever assigned — misreporting a legitimate pipelined action as
        //    `unknown_campaign` (review finding, task 14 round 2). Rejected
        //    with `turn_in_progress`, not queued — see point 2.
        //
        // 2. The `CampaignRegistry`'s per-CAMPAIGN lock (CRITICAL-1). Campaigns
        //    are deliberately shared across sockets — `http.ts`'s `live`
        //    cache is what lets two WS connections onto the same campaign
        //    (Task 14) alias one mutable `Campaign` object, with
        //    `nextSequence` advanced on it in place — so `localBusy` alone
        //    cannot prevent two different sockets bound to the same campaign
        //    from each passing their own turn-order check while the other's
        //    turn is still resolving. Claimed ONLY for mutating commands
        //    (`structured_action`/`free_text`) — see the `join` exclusion
        //    just below for why. `campaignId` below reads `campaign?.state.
        //    world.campaignId`, which is `undefined` whenever this socket has not
        //    yet bound a campaign — including a stray non-join sent before
        //    any `join` at all, a case guard 1 does NOT rule out (it only
        //    serializes messages on this socket; it does not require the
        //    first one to have been a `join`). When `campaignId` is
        //    `undefined` no lock is consulted, and control falls through to
        //    the `campaign === null` ("send a join message first") branch
        //    further down.
        //
        // `join` is deliberately EXCLUDED from the campaign lock (post-review
        // fix): `pipeline.ts`'s `join` branch is read-only — it calls
        // `latestSnapshot`/`readSince` and yields `campaign_state`/`event`
        // frames, never `emit`, so it cannot itself duplicate a turn, which
        // is the only hazard this lock exists to prevent. Claiming it for
        // `join` was a regression: C-36a keeps a turn's `handleCommand`
        // draining, lock held, for the WHOLE hero turn plus the entire enemy
        // sweep (each budgeted `turnTimeoutMs`) even after the originating
        // socket has disappeared — so a client that drops mid-turn and
        // reconnects could have its own `join` rejected with
        // `turn_in_progress` instead of getting the `campaign_state` restore
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
        const campaignId = command.type === "join" ? undefined : campaign?.state.world.campaignId;
        const claimedCampaignLock = campaignId !== undefined && input.registry.tryBegin(campaignId);
        if (campaignId !== undefined && !claimedCampaignLock) {
          turnInProgress();
          return;
        }

        localBusy = true;
        try {
          if (command.type === "join") {
            const found = await input.registry.get(command.campaignId);
            if (found === null) {
              send({
                type: "error",
                code: "unknown_campaign",
                message: `No campaign ${command.campaignId}. Create one with POST /campaigns.`,
              });
              return;
            }
            campaign = found;
          }

          if (campaign === null) {
            send({
              type: "error",
              code: "unknown_campaign",
              message: "Send a join message first.",
            });
            return;
          }

          // C-36a: drain to completion — never `break` out of this loop.
          // `handleCommand`'s `emit` writes its periodic snapshot after its
          // `yield`, and the enemy-turn loop appends several events per
          // turn; abandoning the iterator mid-turn (which a `break` would
          // do) would leave the rest of that turn unwritten. `send` above
          // is what makes it safe to keep pulling after the socket closes.
          for await (const frame of handleCommand(campaign, command, input.ports)) send(frame);
        } catch (error) {
          // The log is already consistent — `emit` appends before it yields —
          // so the socket reporting a failure does not leave a torn campaign.
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
          // Release the CAMPAIGN lock last — after the drain above has fully
          // finished (or thrown) — never earlier. `claimedCampaignLock` is
          // only ever `true` for a mutating command whose `campaign` was
          // already bound when the lock was claimed (see the guard-2
          // comment above), so this only fires on the one path that could
          // have held it: the full `handleCommand` drain, success or
          // failure. `join` never reaches here with anything to release —
          // it never claims the lock at all (excluded above).
          if (campaignId !== undefined && claimedCampaignLock) input.registry.end(campaignId);
        }
      })();
    });
  });
}
