// HTTP surface: creating a campaign, and a health check. Creating a game is a
// one-shot request, so it is a POST rather than a websocket message — folding
// it into `join` would make that message mean two different things depending
// on whether the id already existed.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { EventStore } from "@ai-dm/memory";
import { createCampaign, loadCampaign, startEncounter } from "../core/campaign.js";
import type { Campaign } from "../core/campaign.js";
import { encounterCatalogue, UnknownEncounterError } from "../encounters/index.js";

const CreateCampaignBody = z.object({ encounterId: z.string().min(1) });

export interface CampaignRegistry {
  create(encounterId: string): Promise<Campaign>;
  get(campaignId: string): Promise<Campaign | null>;
  /**
   * Claims the one in-flight-command slot for `campaignId`. Returns `false`
   * without side effects if it is already claimed — the caller must not
   * proceed with `handleCommand` in that case.
   *
   * CRITICAL-1: campaigns are shared across sockets — `live` below is the
   * mechanism that makes two WS connections (Task 14) alias the same
   * `Campaign` object, with `nextSequence` advanced on it in place — so the
   * mutual-exclusion guard belongs on the object that creates that sharing,
   * not on a per-socket flag in the transport (which cannot see a second
   * socket's in-flight command at all) and not on `Campaign` itself (a
   * `core/` type; in-flight-command policy is a transport concern per the
   * spec's "core/ never touches a socket").
   *
   * Deliberately synchronous: the caller must call this in its handler's
   * synchronous prefix, before its first `await`, the same way the old
   * per-socket flag was claimed — that is what makes the check-and-set
   * atomic under JS's single-threaded execution.
   */
  tryBegin(campaignId: string): boolean;
  /** Releases the slot `tryBegin` claimed. Always call from a `finally`. A
   * `join` for a campaign that turns out not to exist still claims and
   * releases an id — harmless, since the slot is just a key in a set. */
  end(campaignId: string): void;
}

export interface CampaignRegistryInput {
  store: EventStore;
  uuid: () => string;
  clock: () => string;
  seed: () => number;
}

/**
 * Live campaigns, keyed by id. In-process only, matching the in-memory event
 * store: both go away on restart, and both are replaced together by the
 * persistence spec. There is no eviction: every campaign created in a run
 * stays pinned here for the run's lifetime, each entry holding a full
 * `BuiltEncounter` plus a `CampaignState` whose `appliedClientMessageIds`
 * itself grows without bound (C-30). Unbounded growth within a run, not just
 * across a restart — deliberately left to the persistence spec, not fixed
 * here.
 */
export function createCampaignRegistry(input: CampaignRegistryInput): CampaignRegistry {
  const live = new Map<string, Campaign>();
  // The per-campaign in-flight-command lock (CRITICAL-1). A plain `Set`: a
  // campaign id is a member exactly while some socket's `handleCommand` call
  // for it is running, from `tryBegin` to the matching `end`.
  const inFlight = new Set<string>();
  // In-flight `loadCampaign` calls, keyed the same way. `live` alone was
  // enough while the store was synchronous; a durable store puts a real
  // await between the miss and the set, and `join` is outside the campaign
  // lock by design, so without this two concurrent joins fold two Campaigns
  // and the loser keeps appending from its own nextSequence.
  const loading = new Map<string, Promise<Campaign | null>>();

  return {
    async create(encounterId) {
      const campaignId = input.uuid();
      const campaign = await createCampaign({
        campaignId,
        rootSeed: input.seed(),
        store: input.store,
        clock: input.clock,
        uuid: input.uuid,
      });
      // Creating a campaign and entering its first fight are two events and
      // two calls, but one request: the client-visible flow is unchanged, so
      // a campaign that exists always has a board. §4.7's step 4 is what
      // separates them — an exploration mode gives the gap between these two
      // lines somewhere to live, and this call moves out to whatever starts
      // an encounter then. `startEncounter` mutates `campaign` in place, so
      // `live` holds the started one either way; it is awaited before the set
      // so a half-started campaign is never reachable through `get`.
      //
      // `buildEncounterById` runs inside `startEncounter`, which is what
      // keeps `UnknownEncounterError` reaching the route's 404 branch. The
      // sequence-0 `campaign_started` is already in the log when it throws:
      // an unknown id therefore leaves an encounter-less campaign behind
      // rather than nothing at all. Harmless — it is unreachable, since its
      // id was never returned to anyone — and the log is append-only, so
      // there is nothing to roll back.
      await startEncounter({
        campaign,
        encounterId,
        store: input.store,
        clock: input.clock,
        uuid: input.uuid,
      });
      live.set(campaignId, campaign);
      return campaign;
    },

    get(campaignId) {
      const cached = live.get(campaignId);
      if (cached !== undefined) return Promise.resolve(cached);

      const inFlightLoad = loading.get(campaignId);
      if (inFlightLoad !== undefined) return inFlightLoad;

      // Not in memory: fold it back from the log. This is what makes a
      // reconnect after a process restart possible now that the store is
      // durable.
      const load = loadCampaign({ campaignId, store: input.store })
        .then((loaded) => {
          if (loaded !== null) live.set(campaignId, loaded);
          return loaded;
        })
        .finally(() => {
          // Cleared on both paths: a failed load must not be cached as a
          // permanently pending promise.
          loading.delete(campaignId);
        });
      loading.set(campaignId, load);
      return load;
    },

    tryBegin(campaignId) {
      if (inFlight.has(campaignId)) return false;
      inFlight.add(campaignId);
      return true;
    },

    end(campaignId) {
      inFlight.delete(campaignId);
    },
  };
}

export function registerHttpRoutes(app: FastifyInstance, registry: CampaignRegistry): void {
  app.get("/health", () => ({ status: "ok" }));

  app.post("/campaigns", async (request, reply) => {
    const body = CreateCampaignBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "encounterId must be a non-empty string" });
    }

    // Scoped tightly around the one call that can throw `UnknownEncounterError`
    // — not around the response send too, so a failure while writing the
    // reply (e.g. the connection dropping mid-send) cannot be mistaken for an
    // encounter-lookup failure and re-enter this `catch`.
    let campaign: Campaign;
    try {
      campaign = await registry.create(body.data.encounterId);
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
    return reply.code(201).send({ campaignId: campaign.state.world.campaignId });
  });

  app.get<{ Params: { encounterId: string } }>("/encounters/:encounterId", (request, reply) => {
    // C-34: `UnknownEncounterError` is the only 404. Everything else
    // `encounterCatalogue` can throw — ENOENT from a missing SRD file, a
    // ZodError from a malformed one, any of `buildEncounter`'s validations —
    // is a genuine server fault and must not be reported as "not found".
    try {
      return reply.send(encounterCatalogue(request.params.encounterId));
    } catch (error) {
      if (error instanceof UnknownEncounterError) {
        return reply.code(404).send({ error: error.message });
      }
      throw error;
    }
  });
}
