import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { createInMemoryEventStore } from "../core/event-store.js";
import { createSessionRegistry, registerHttpRoutes } from "./http.js";

function appWith() {
  const store = createInMemoryEventStore();
  let n = 0;
  const registry = createSessionRegistry({
    store,
    uuid: () => {
      n += 1;
      return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
    },
    clock: () => "2026-08-19T10:00:00.000Z",
    seed: () => 42,
  });
  const app = Fastify();
  registerHttpRoutes(app, registry);
  return { app, registry, store };
}

describe("POST /sessions", () => {
  it("creates a session and returns its id", async () => {
    const { app } = appWith();
    const response = await app.inject({
      method: "POST",
      url: "/sessions",
      payload: { encounterId: "goblin-ambush" },
    });
    expect(response.statusCode).toBe(201);
    expect(JSON.parse(response.body)).toMatchObject({ sessionId: expect.any(String) as string });
  });

  it("rejects an unknown encounter with 404", async () => {
    const { app } = appWith();
    const response = await app.inject({
      method: "POST",
      url: "/sessions",
      payload: { encounterId: "nope" },
    });
    expect(response.statusCode).toBe(404);
  });

  it("rejects a body with no encounterId with 400", async () => {
    const { app } = appWith();
    const response = await app.inject({ method: "POST", url: "/sessions", payload: {} });
    expect(response.statusCode).toBe(400);
  });

  it("makes the created session retrievable from the registry", async () => {
    const { app, registry } = appWith();
    const response = await app.inject({
      method: "POST",
      url: "/sessions",
      payload: { encounterId: "goblin-ambush" },
    });
    const { sessionId } = JSON.parse(response.body) as { sessionId: string };
    expect(await registry.get(sessionId)).not.toBeNull();
  });
});

describe("GET /health", () => {
  it("answers 200", async () => {
    const { app } = appWith();
    expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
  });
});
