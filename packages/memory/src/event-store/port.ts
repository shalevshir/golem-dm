// The event log's storage boundary, and the two implementations' shared
// contract. `append` is an atomic batch that conflicts on
// (campaignId, sequence), which is exactly `game_events`' primary key — the
// Postgres store gets that atomicity from a transaction, the in-memory one
// from validating the whole batch before mutating anything.
import type { GameEvent, CampaignState } from "@ai-dm/schemas";

export class SequenceConflictError extends Error {
  readonly campaignId: string;
  readonly sequence: number;

  constructor(campaignId: string, sequence: number) {
    super(`Event ${String(sequence)} already exists for campaign ${campaignId}`);
    this.name = "SequenceConflictError";
    this.campaignId = campaignId;
    this.sequence = sequence;
  }
}

/**
 * Raised when an event's own `campaignId` disagrees with the campaign it was
 * appended to. The log must never hold a row whose own payload contradicts
 * the stream containing it — a Postgres implementation that derives
 * `campaign_id` from the row rather than the call argument would silently
 * diverge from this one otherwise.
 */
export class CampaignMismatchError extends Error {
  readonly campaignId: string;
  readonly eventCampaignId: string;

  constructor(campaignId: string, eventCampaignId: string) {
    super(
      `Event has campaignId "${eventCampaignId}", which does not match the campaign "${campaignId}" it was appended to`,
    );
    this.name = "CampaignMismatchError";
    this.campaignId = campaignId;
    this.eventCampaignId = eventCampaignId;
  }
}

/**
 * Every other way a durable store can fail: a dropped connection, a lock or
 * statement timeout, a deadlock, or a stored row that no longer parses as a
 * `GameEvent`. It exists so the store's failure surface stays a closed set of
 * three classes — `pipeline.ts` special-cases exactly those and rethrows
 * anything else, and an unhandled rejection there reaches a transport
 * catch-all that restores no player affordances.
 *
 * The in-memory store never raises this. It is not a bug that it doesn't:
 * the shared contract permits it, it does not require it.
 */
export class EventStoreUnavailableError extends Error {
  readonly operation: string;

  constructor(operation: string, cause: unknown) {
    // `{ cause }` rather than a redeclared field: `Error.cause` already
    // exists in the ES2022 lib, and redeclaring it would need `override`
    // under `noImplicitOverride`.
    super(`Event store unavailable during ${operation}`, { cause });
    this.name = "EventStoreUnavailableError";
    this.operation = operation;
  }
}

/** A projected `CampaignState`, cached at the log `sequence` it reflects. */
export interface EventSnapshot {
  sequence: number;
  state: CampaignState;
}

export interface EventStore {
  /**
   * Atomic over the batch. A turn emits several events and a crash mid-turn
   * must not leave half a turn in the log, so either all of them land or none.
   * Rejects with `SequenceConflictError` on a sequence collision (including a
   * duplicate within the batch itself) or `CampaignMismatchError` if an
   * event's own `campaignId` disagrees with `campaignId`. Either rejection
   * leaves the store exactly as it was before the call.
   *
   * A `payload` is stored by value, through a JSON round trip: the caller
   * may mutate the event it passed once this resolves, and the store keeps
   * what it was handed. That round trip is lossy in the ways a jsonb column
   * is — a key whose value is `undefined` is dropped, `NaN`/`Infinity`
   * become `null`, a `Date` becomes its ISO string — and that lossiness is
   * part of the contract, not an implementation detail of the durable store:
   * `contract.ts` holds both implementations to it, so a payload cannot
   * behave one way in a dev run and another on a deploy.
   */
  append(campaignId: string, events: readonly GameEvent[]): Promise<void>;
  /** Everything with `sequence > afterSequence`, in ascending order. */
  readSince(campaignId: string, afterSequence: number): Promise<GameEvent[]>;
  latestSnapshot(campaignId: string): Promise<EventSnapshot | null>;
  /**
   * Keeps only the newest snapshot: a call whose `sequence` is less than or
   * equal to the one already stored is a no-op. Snapshots are a cache, never
   * authority — `fold(events)` must equal the snapshot at every snapshot
   * point, so this exists purely to speed up reconnect.
   */
  putSnapshot(campaignId: string, sequence: number, state: CampaignState): Promise<void>;
}
