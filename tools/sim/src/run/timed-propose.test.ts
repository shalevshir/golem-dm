import { describe, expect, it } from "vitest";
import type {
  CallTiming,
  ProposeTurnInput,
  TacticalAgent,
  TimingPort,
  TurnProposalSuccess,
} from "@ai-dm/agents";
import type { ExecuteTurn } from "@ai-dm/schemas";
import type { TurnPlan } from "@ai-dm/rules-engine";
import { timedPropose } from "./timed-propose.js";

const STUB_RESULT: TurnProposalSuccess = {
  ok: true,
  turn: {} as ExecuteTurn,
  plan: {} as TurnPlan,
  source: "model",
  rejections: [],
  usage: [],
};

/**
 * A fake `TimingPort` whose `timings` array is shared with a fake agent, the
 * same relationship a real `createTimingPort` + `TacticalAgent` pair has:
 * the port owns one append-only array, and every call the agent makes pushes
 * onto it while `proposeTurn` is in flight.
 */
function harness(preexisting: readonly CallTiming[], pushesDuringCall: readonly CallTiming[]) {
  const timings: CallTiming[] = [...preexisting];
  // Only `.timings` is read by `timedPropose`; the port's other methods are
  // never called in this test, same as the `STUB_TURN` idiom in records.test.ts.
  const port = { timings } as unknown as TimingPort;

  let capturedRequest: ProposeTurnInput | undefined;
  const agent: TacticalAgent = {
    proposeTurn(request) {
      capturedRequest = request;
      timings.push(...pushesDuringCall);
      return Promise.resolve(STUB_RESULT);
    },
  };

  return { port, agent, requestCapturedBy: () => capturedRequest };
}

describe("timedPropose", () => {
  it("attributes only the timings produced during this call, not ones already on the port", async () => {
    const { port, agent } = harness(
      [{ kind: "structured", durationMs: 999 }],
      [{ kind: "structured", durationMs: 5 }],
    );

    const { timings } = await timedPropose(agent, port, { world: {} as never, actorId: "gob-1" });

    expect(timings).toStrictEqual([{ kind: "structured", durationMs: 5 }]);
  });

  it("passes the request through to proposeTurn unchanged and returns its result", async () => {
    const { port, agent, requestCapturedBy } = harness([], []);
    const request: ProposeTurnInput = { world: {} as never, actorId: "gob-1" };

    const { result } = await timedPropose(agent, port, request);

    expect(requestCapturedBy()).toBe(request);
    expect(result).toBe(STUB_RESULT);
  });

  it("attributes nothing when the call produced no timing entries", async () => {
    const { port, agent } = harness([], []);

    const { timings } = await timedPropose(agent, port, { world: {} as never, actorId: "gob-1" });

    expect(timings).toStrictEqual([]);
  });
});
