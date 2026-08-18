// One runner per timing port, no concurrent sharing — this is the invariant
// both probe mode and encounter mode depend on, extracted once so it is
// documented and tested in exactly one place instead of duplicated at two
// call sites with the same comment.
import type {
  CallTiming,
  ProposeTurnInput,
  TacticalAgent,
  TimingPort,
  TurnProposalResult,
} from "@ai-dm/agents";

export interface TimedProposeResult {
  result: TurnProposalResult;
  timings: readonly CallTiming[];
}

/**
 * Calls `agent.proposeTurn` and attributes the `CallTiming` entries it
 * produced back to this one call.
 *
 * `TimingPort.timings` is a single append-only array shared by the whole run,
 * so the only correct way to attribute entries to one `proposeTurn` call is
 * to snapshot its length immediately before the call and slice after —
 * nothing may run between the snapshot and the `await` that could append to
 * the same port from another call, or the slice attributes someone else's
 * timing to this turn. **Precondition, not enforced here:** one runner
 * drives a given `TimingPort` at a time — no two `proposeTurn` calls against
 * it may be in flight concurrently.
 */
export async function timedPropose(
  agent: TacticalAgent,
  timingPort: TimingPort,
  request: ProposeTurnInput,
): Promise<TimedProposeResult> {
  const before = timingPort.timings.length;
  const result = await agent.proposeTurn(request);
  const timings = timingPort.timings.slice(before);

  return { result, timings };
}
