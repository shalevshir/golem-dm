// A hand-driven stand-in for a WebSocket: tests push frames into it and drop
// it at will. Shared by the connection tests and the App tests — one
// definition, so the two cannot disagree about how a socket behaves.
import type { WebSocketLike } from "./connection.js";

export interface FakeSocket extends WebSocketLike {
  emitOpen: () => void;
  emitMessage: (payload: unknown) => void;
  emitClose: () => void;
  sent: string[];
}

export function fakeSocket(): FakeSocket {
  const listeners = new Map<string, (event: unknown) => void>();
  const sent: string[] = [];
  return {
    sent,
    readyState: 1,
    send: (data: string) => sent.push(data),
    close: () => undefined,
    addEventListener: (type, listener) => {
      listeners.set(type, listener as (event: unknown) => void);
    },
    emitOpen: () => listeners.get("open")?.(new Event("open")),
    emitMessage: (payload: unknown) =>
      listeners.get("message")?.({ data: JSON.stringify(payload) }),
    emitClose: () => listeners.get("close")?.(new CloseEvent("close")),
  };
}
