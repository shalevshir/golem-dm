// The socket, and the only file in the client that touches one.
//
// Every inbound frame goes through `ServerFrame.safeParse`, never a cast.
// Spec #1's final review found server test helpers casting instead of parsing,
// which suppresses exactly the check that proves the protocol holds — so this
// end parses, and a frame that does not satisfy the schema never reaches the
// store.
import { ClientMessage, ServerFrame } from "@ai-dm/schemas";

/**
 * The slice of `WebSocket` this module uses. Narrow on purpose: it is what a
 * test substitutes, and it keeps the DOM's full socket surface out of the
 * module's contract.
 *
 * The listener parameter is a union rather than `never`: a real `WebSocket`'s
 * `addEventListener` overloads accept an `any`-typed event on the plain
 * string-type overload, which is not assignable into a listener typed to
 * take `never` — so this widens to what the three events this module
 * actually registers for can be, and each call site narrows from there.
 */
export interface WebSocketLike {
  readyState: number;
  send: (data: string) => void;
  close: () => void;
  addEventListener: (
    type: string,
    listener: (event: Event | MessageEvent | CloseEvent) => void,
  ) => void;
}

export type ConnectionStatus = "connecting" | "open" | "reconnecting" | "closed";

export interface ConnectInput {
  campaignId: string;
  url?: string;
  onFrame: (frame: ServerFrame) => void;
  onStatus: (status: ConnectionStatus) => void;
  /**
   * The highest sequence the store has folded, read at join time rather than
   * captured once — a reconnect must resume from where the client actually
   * got to, not from where it was when `connect` was called.
   */
  resumeFrom: () => number | undefined;
  socketFactory?: (url: string) => WebSocketLike;
}

export interface Connection {
  send: (message: ClientMessage) => void;
  close: () => void;
}

const RECONNECT_DELAY_MS = 1000;

function defaultUrl(): string {
  const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${window.location.host}/ws`;
}

export function connect(input: ConnectInput): Connection {
  const url = input.url ?? defaultUrl();
  const makeSocket: (target: string) => WebSocketLike =
    input.socketFactory ?? ((target) => new WebSocket(target));

  let socket: WebSocketLike | null = null;
  let closedByCaller = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  function open(): void {
    input.onStatus("connecting");
    const next = makeSocket(url);
    socket = next;

    next.addEventListener("open", () => {
      input.onStatus("open");
      // A `join` always gets exactly one response, so this is also the client's
      // way of asking "did my last command land?" — the answer is whether its
      // clientMessageId appears in `appliedClientMessageIds` on the snapshot.
      // That is why no ack frame exists.
      const from = input.resumeFrom();
      send(
        from === undefined
          ? { type: "join", campaignId: input.campaignId }
          : { type: "join", campaignId: input.campaignId, resumeFrom: from },
      );
    });

    next.addEventListener("message", (event) => {
      const { data } = event as unknown as { data: unknown };
      let payload: unknown;
      try {
        payload = JSON.parse(String(data));
      } catch {
        return;
      }
      const parsed = ServerFrame.safeParse(payload);
      if (!parsed.success) return;
      input.onFrame(parsed.data);
    });

    next.addEventListener("close", () => {
      if (closedByCaller) {
        input.onStatus("closed");
        return;
      }
      input.onStatus("reconnecting");
      retryTimer = setTimeout(open, RECONNECT_DELAY_MS);
    });
  }

  function send(message: ClientMessage): void {
    const active = socket;
    if (active === null || active.readyState !== 1) return;
    active.send(JSON.stringify(ClientMessage.parse(message)));
  }

  open();

  return {
    send,
    close: () => {
      closedByCaller = true;
      if (retryTimer !== null) clearTimeout(retryTimer);
      socket?.close();
      input.onStatus("closed");
    },
  };
}
