// The player half of the arc harness: create a campaign over HTTP, then hold
// one WebSocket and log every frame that arrives on it.
//
// This talks to a RUNNING server over the wire, exactly the way `apps/web`
// does, and imports nothing from `apps/server` — invariant 5 ("nothing
// depends on server") is about package dependencies, and a socket is not one.
// That is also the only way this harness can exercise the real pipeline at
// all: `loadWorld`, the encounter catalogue and `core/pipeline.ts` all live in
// that app, so a sim-side re-implementation would be a second orchestrator to
// keep in step (invariant 4).
//
// Both the socket and `fetch` are injected rather than reached for, so the
// walk in `run.ts` is testable with no server and no network — the same
// discipline `smoke/port.ts` applies to the provider.
import { CampaignCreated, ServerFrame } from "@ai-dm/schemas";

/**
 * The slice of `WebSocket` this harness uses. Narrow on purpose: Node's
 * global `WebSocket` (Node 22+) satisfies it via `wrapWebSocket` below, and
 * so does a two-line test double, which is what makes `runArc` runnable in
 * CI.
 */
export interface SocketLike {
  send(payload: string): void;
  close(): void;
}

/** A socket plus the hooks the frame log needs to subscribe before any frame lands. */
export interface SocketHandle extends SocketLike {
  onMessage(handler: (raw: string) => void): void;
  onClose(handler: () => void): void;
}

/**
 * Thrown when a `waitFor` gives up. Distinct from a transport failure: a
 * timeout here is usually the run's most interesting result (the server never
 * handed the player back control), so the walk catches it and reports rather
 * than crashing.
 */
export class FrameTimeoutError extends Error {
  constructor(what: string, timeoutMs: number) {
    super(`Timed out after ${String(timeoutMs)}ms waiting for ${what}`);
    this.name = "FrameTimeoutError";
  }
}

export type Frame = ReturnType<typeof ServerFrame.parse>;

/**
 * Every frame the socket has delivered, in order, with a promise-returning
 * `waitFor` over the accumulated list.
 *
 * Frames are PARSED, not cast: an unparseable frame is a protocol break worth
 * failing on, and parsing is what makes `frames` a discriminated union the
 * walk can switch over exhaustively.
 */
export class FrameLog {
  readonly frames: Frame[] = [];
  private closed = false;
  private readonly waiters = new Set<() => void>();

  constructor(socket: SocketHandle) {
    socket.onMessage((raw) => {
      this.frames.push(ServerFrame.parse(JSON.parse(raw)));
      this.wake();
    });
    socket.onClose(() => {
      this.closed = true;
      this.wake();
    });
  }

  private wake(): void {
    for (const waiter of this.waiters) waiter();
  }

  /** Frames appended at or after `from`, for a caller reading only what one send produced. */
  since(from: number): readonly Frame[] {
    return this.frames.slice(from);
  }

  async waitFor(
    predicate: (frames: readonly Frame[]) => boolean,
    what: string,
    timeoutMs: number,
  ): Promise<void> {
    if (predicate(this.frames)) return;

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        finish();
        reject(new FrameTimeoutError(what, timeoutMs));
      }, timeoutMs);

      const check = (): void => {
        if (predicate(this.frames)) {
          finish();
          resolve();
          return;
        }
        if (this.closed) {
          finish();
          reject(new FrameTimeoutError(`${what} (socket closed first)`, timeoutMs));
        }
      };

      const finish = (): void => {
        clearTimeout(timer);
        this.waiters.delete(check);
      };

      this.waiters.add(check);
      check();
    });
  }
}

/** `POST /campaigns` — the same call `apps/web` makes to start a world campaign. */
export async function createCampaign(
  httpUrl: string,
  worldId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const response = await fetchImpl(`${httpUrl}/campaigns`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ worldId }),
  });
  if (!response.ok) {
    throw new Error(
      `POST ${httpUrl}/campaigns answered ${String(response.status)}: ${await response.text()}`,
    );
  }
  return CampaignCreated.parse(await response.json()).campaignId;
}

/**
 * Adapts Node's global `WebSocket` to `SocketHandle`, resolving once it is
 * open. Node 22 ships this globally, so the harness needs no `ws` dependency
 * of its own — `apps/server` has one only because it also *serves* sockets.
 */
export async function connectWebSocket(wsUrl: string): Promise<SocketHandle> {
  const socket = new WebSocket(wsUrl);

  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => {
      resolve();
    });
    socket.addEventListener("error", () => {
      reject(new Error(`WebSocket to ${wsUrl} failed to open`));
    });
  });

  return {
    send: (payload) => {
      socket.send(payload);
    },
    close: () => {
      socket.close();
    },
    onMessage: (handler) => {
      socket.addEventListener("message", (event: MessageEvent) => {
        const { data } = event as { data: unknown };
        handler(typeof data === "string" ? data : String(data));
      });
    },
    onClose: (handler) => {
      socket.addEventListener("close", () => {
        handler();
      });
    },
  };
}
