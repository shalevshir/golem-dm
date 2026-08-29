// HTTP surface: creating a campaign, and a health check. Creating a game is a
// one-shot request, so it is a POST rather than a websocket message — folding
// it into `join` would make that message mean two different things depending
// on whether the id already existed.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { EventStore } from "@ai-dm/memory";
import { createCampaign, loadCampaign, startEncounter } from "../core/campaign.js";
import type { Campaign } from "../core/campaign.js";
import {
  encounterById,
  encounterCatalogue,
  loadCharacter,
  UnknownEncounterError,
} from "../encounters/index.js";
import { loadWorld, UnknownWorldError } from "../world/index.js";

/**
 * ADR-0002: the POC is solo play, exactly one human-controlled character. A
 * `characterId` body field for `POST /campaigns {worldId}` would be YAGNI
 * until a second PC exists — the hero is the only character a scene
 * campaign could ever name.
 */
const HERO_CHARACTER_ID = "hero";

// `.strict()` on both arms, not just a comment: plain `z.object` silently
// strips unknown keys, so a body carrying BOTH `encounterId` and `worldId`
// matched the first arm and quietly discarded `worldId` — a false claim by
// the 400 message below, which says "exactly one" but the schema never
// checked that (whole-branch review finding 5). Strict rejects an unknown
// key instead of stripping it, so a body with both fails BOTH arms and
// falls into the same 400 a single bad field already produces, without
// widening `CreateCampaignBody`'s resolved type or `CampaignRegistry.create`'s
// input away from the `{ encounterId } | { worldId }` the plan mandated.
const CreateCampaignBody = z.union([
  z.object({ encounterId: z.string().min(1) }).strict(),
  z.object({ worldId: z.string().min(1) }).strict(),
]);

export interface CampaignRegistry {
  create(input: { encounterId: string } | { worldId: string }): Promise<Campaign>;
  get(campaignId: string): Promise<Campaign | null>;
  /**
   * Claims the one in-flight-command slot for `campaignId`. Returns `false`
   * without side effects if it is already claimed — the caller must not
   * proceed with `handleCommand` in that case.
   *
   * Campaigns are shared across sockets — `live` below is the mechanism
   * that makes two WS connections alias the same `Campaign` object, with
   * `nextSequence` advanced on it in place — so the
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
 * itself grows without bound. Unbounded growth within a run, not just
 * across a restart — deliberately left to the persistence spec, not fixed
 * here.
 */
export function createCampaignRegistry(input: CampaignRegistryInput): CampaignRegistry {
  const live = new Map<string, Campaign>();
  // The per-campaign in-flight-command lock. A plain `Set`: a
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
    async create(body) {
      if ("worldId" in body) {
        // The world path: no encounter is ever started. `apps/server` authors
        // exactly one world (`data/world/`), so "unknown world" means the
        // requested id does not match the one `loadWorld` produced — checked
        // before anything is written, same posture as `encounterById` below,
        // for the same reason: `createCampaign` appends `campaign_started`
        // unconditionally, so a refusal after that append would leave a
        // durable orphaned row.
        const authored = loadWorld();
        if (authored.worldId !== body.worldId) {
          throw new UnknownWorldError(body.worldId);
        }
        const character = loadCharacter(HERO_CHARACTER_ID);

        const campaignId = input.uuid();
        const campaign = await createCampaign({
          campaignId,
          rootSeed: input.seed(),
          store: input.store,
          clock: input.clock,
          uuid: input.uuid,
          scene: { authored, character },
        });
        live.set(campaignId, campaign);
        return campaign;
      }

      const { encounterId } = body;
      // Validated before anything is written, deliberately separate from and
      // earlier than `startEncounter`'s own `buildEncounterById` call below.
      // `createCampaign` appends `campaign_started` unconditionally — it has
      // no way to refuse an id it is never given — so an unknown id must be
      // caught before that append or it leaves a durable, permanently
      // orphaned `game_events` row for a campaign id that is never returned
      // to anyone (the append-only log has no way to take it back out).
      // `encounterById` is the pure, in-memory half of `buildEncounterById`
      // (a `CATALOGUE.get`, no file I/O) — cheap enough to call here purely
      // for the guard and again inside `startEncounter` for the real build,
      // rather than threading a `BuiltEncounter` across the two calls for
      // one avoided lookup.
      encounterById(encounterId);

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
      // an `encounterId` campaign always has a board. §4.7's step 4 has
      // landed the gap this comment used to predict — it lives above, in the
      // `worldId` branch: a scene campaign is created with no board and
      // never calls `startEncounter` at all. This branch stays exactly as it
      // was; only the encounter path takes it. `startEncounter` mutates
      // `campaign` in place, so `live` holds the started one either way; it
      // is awaited before the set so a half-started campaign is never
      // reachable through `get`.
      //
      // The id is already known good by the time this runs — the guard above
      // ran first — so `buildEncounterById`'s own `UnknownEncounterError`
      // here is unreachable in practice. It stays because this call is what
      // actually builds the `BuiltEncounter` (stat blocks, scene card,
      // combat world) the guard above never needed to.
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
      return reply.code(400).send({ error: "provide exactly one of encounterId or worldId" });
    }

    // Scoped tightly around the one call that can throw `UnknownEncounterError`
    // or `UnknownWorldError` — not around the response send too, so a failure
    // while writing the reply (e.g. the connection dropping mid-send) cannot
    // be mistaken for a lookup failure and re-enter this `catch`.
    let campaign: Campaign;
    try {
      campaign = await registry.create(body.data);
    } catch (error) {
      // `registry.create` throws `UnknownEncounterError` for an encounter id
      // the catalogue does not know, and `UnknownWorldError` for a `worldId`
      // that does not match `apps/server`'s one authored world — those are
      // the only two cases that are a 404. The encounter error comes from
      // `encounterById`'s guard at the top of `create`, which runs before
      // anything is written; `startEncounter`'s own `buildEncounterById` call
      // further down can throw the same error type in principle, but by the
      // time it runs the id has already cleared that guard, so it is
      // unreachable in practice. Everything else `registry.create` can throw
      // (ENOENT from a missing SRD or character file, a ZodError from an
      // invalid one, or any of `buildEncounter`'s own validation errors) is a
      // genuine server fault and must not be reported to the client as "not
      // found".
      if (error instanceof UnknownEncounterError || error instanceof UnknownWorldError) {
        return reply.code(404).send({ error: error.message });
      }
      throw error;
    }
    return reply.code(201).send({ campaignId: campaign.state.world.campaignId });
  });

  app.get<{ Params: { encounterId: string } }>("/encounters/:encounterId", (request, reply) => {
    // `UnknownEncounterError` is the only 404. Everything else
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
