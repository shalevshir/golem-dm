// HTTP surface: creating a session, and a health check. Creating a game is a
// one-shot request, so it is a POST rather than a websocket message — folding
// it into `join` would make that message mean two different things depending
// on whether the id already existed.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { EventStore } from "../core/event-store.js";
import { createSession, loadSession } from "../core/session.js";
import type { Session } from "../core/session.js";
import { UnknownEncounterError } from "../encounters/index.js";

const CreateSessionBody = z.object({ encounterId: z.string().min(1) });

export interface SessionRegistry {
  create(encounterId: string): Promise<Session>;
  get(sessionId: string): Promise<Session | null>;
}

export interface SessionRegistryInput {
  store: EventStore;
  uuid: () => string;
  clock: () => string;
  seed: () => number;
}

/**
 * Live sessions, keyed by id. In-process only, matching the in-memory event
 * store: both go away on restart, and both are replaced together by the
 * persistence spec. There is no eviction: every session created in a run
 * stays pinned here for the run's lifetime, each entry holding a full
 * `BuiltEncounter` plus a `SessionState` whose `appliedClientMessageIds`
 * itself grows without bound (C-30). Unbounded growth within a run, not just
 * across a restart — deliberately left to the persistence spec, not fixed
 * here.
 */
export function createSessionRegistry(input: SessionRegistryInput): SessionRegistry {
  const live = new Map<string, Session>();

  return {
    async create(encounterId) {
      const sessionId = input.uuid();
      const session = await createSession({
        sessionId,
        encounterId,
        rootSeed: input.seed(),
        store: input.store,
        clock: input.clock,
        uuid: input.uuid,
      });
      live.set(sessionId, session);
      return session;
    },

    async get(sessionId) {
      const cached = live.get(sessionId);
      if (cached !== undefined) return cached;

      // Not in memory: fold it back from the log. This is what makes a
      // reconnect after a process restart possible once the store is durable.
      const loaded = await loadSession({ sessionId, store: input.store });
      if (loaded !== null) live.set(sessionId, loaded);
      return loaded;
    },
  };
}

export function registerHttpRoutes(app: FastifyInstance, registry: SessionRegistry): void {
  app.get("/health", () => ({ status: "ok" }));

  app.post("/sessions", async (request, reply) => {
    const body = CreateSessionBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "encounterId must be a non-empty string" });
    }

    // Scoped tightly around the one call that can throw `UnknownEncounterError`
    // — not around the response send too, so a failure while writing the
    // reply (e.g. the connection dropping mid-send) cannot be mistaken for an
    // encounter-lookup failure and re-enter this `catch`.
    let session: Session;
    try {
      session = await registry.create(body.data.encounterId);
    } catch (error) {
      // `buildEncounterById` throws `UnknownEncounterError` for an id the
      // catalogue does not know — that is the only case that is a 404.
      // Everything else it can throw (ENOENT from a missing SRD file, a
      // ZodError from an invalid one, or any of `buildEncounter`'s own
      // validation errors) is a genuine server fault and must not be
      // reported to the client as "not found".
      if (error instanceof UnknownEncounterError) {
        return reply.code(404).send({ error: error.message });
      }
      throw error;
    }
    return reply.code(201).send({ sessionId: session.state.sessionId });
  });
}
