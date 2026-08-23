import type { GameEvent } from "@ai-dm/schemas";
import { SequenceConflictError, CampaignMismatchError } from "./port.js";

/**
 * The append precondition, shared by both stores so neither can drift from
 * it. Order is observable and therefore part of the contract: each event's
 * `campaignId` is checked before its `sequence`, walking the batch in order,
 * so a batch whose first event conflicts and whose second mismatches raises
 * `SequenceConflictError` — not the other way round.
 *
 * `taken` holds the sequences already present for this campaign. The returned
 * error is thrown by the caller; returning it rather than throwing keeps this
 * function usable inside a transaction callback, where the throw is what
 * triggers the rollback.
 */
export function findAppendConflict(
  campaignId: string,
  events: readonly GameEvent[],
  taken: ReadonlySet<number>,
): SequenceConflictError | CampaignMismatchError | null {
  const seen = new Set(taken);
  for (const event of events) {
    if (event.campaignId !== campaignId) {
      return new CampaignMismatchError(campaignId, event.campaignId);
    }
    if (seen.has(event.sequence)) {
      return new SequenceConflictError(campaignId, event.sequence);
    }
    seen.add(event.sequence);
  }
  return null;
}
