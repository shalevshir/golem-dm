// The half of the client's view that the event log's projection does not
// carry. `CampaignState` is the board — combatants, grid, turn order — and a
// join answers with it in full, which is why a reload already gets its board
// back. The roll log and the narration are neither: `foldCombatLog` builds
// the first client-side from events the server never projects, and the second
// arrives as `narrative_token` frames that are not events at all. Both live
// only in this tab's memory, so a reload lost them.
//
// This does not make the browser a second source of truth (CLAUDE.md
// invariant 3). What is written here is display state derived from the log,
// tagged with the sequence it was derived at, and `applyFrame` throws it away
// the moment the server's own sequence disagrees — the server always wins.
//
// `sessionStorage`, not `localStorage`, for the same reason the campaign id
// uses it (`App.tsx`): a fight must not follow the player into a new tab that
// never joined it.
import { z } from "zod";
import { CombatLogTurn, initialClientState } from "./store.js";
import type { ClientState } from "./store.js";

export const LOG_STORAGE_KEY = "ai-dm:campaign-log";

/**
 * `campaignId` is stored alongside the rest and checked on the way back in.
 * The two keys are written and cleared together so a mismatch should be
 * unreachable, but the failure it would cause — one fight's roll log rendered
 * against another fight's board — is bad enough to be worth one comparison.
 */
const StoredClientState = z.object({
  campaignId: z.string(),
  sequence: z.number().int().nonnegative(),
  combatLog: z.array(CombatLogTurn),
  narrative: z.string(),
  narrativeStreamId: z.string().nullable(),
});

export function storeClientState(campaignId: string, state: ClientState): void {
  const stored: z.infer<typeof StoredClientState> = {
    campaignId,
    sequence: state.sequence,
    combatLog: state.combatLog,
    narrative: state.narrative,
    narrativeStreamId: state.narrativeStreamId,
  };
  sessionStorage.setItem(LOG_STORAGE_KEY, JSON.stringify(stored));
}

/**
 * The state a mount starts from. `snapshot` is deliberately not among the
 * fields restored: the board is the server's to state, and the join it is
 * about to send answers with the authoritative one.
 *
 * Anything unreadable is dropped rather than thrown: a stored payload written
 * by an older build is a display-state cache miss, not a reason to refuse to
 * render a fight the server is perfectly able to serve.
 */
export function restoreClientState(campaignId: string | null): ClientState {
  const raw = sessionStorage.getItem(LOG_STORAGE_KEY);
  if (campaignId === null || raw === null) return initialClientState;

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch (error) {
    console.warn("persistence: discarding unparseable stored client state", error);
    return initialClientState;
  }

  const parsed = StoredClientState.safeParse(payload);
  if (!parsed.success) {
    console.warn("persistence: discarding malformed stored client state", parsed.error);
    return initialClientState;
  }
  if (parsed.data.campaignId !== campaignId) return initialClientState;

  return {
    ...initialClientState,
    sequence: parsed.data.sequence,
    combatLog: parsed.data.combatLog,
    narrative: parsed.data.narrative,
    narrativeStreamId: parsed.data.narrativeStreamId,
  };
}

export function clearStoredClientState(): void {
  sessionStorage.removeItem(LOG_STORAGE_KEY);
}
