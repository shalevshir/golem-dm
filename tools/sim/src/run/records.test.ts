import { describe, expect, it } from "vitest";
import type {
  CallTiming,
  TokenUsage,
  TurnProposalFailure,
  TurnProposalSuccess,
} from "@ai-dm/agents";
import type { TurnPlan } from "@ai-dm/rules-engine";
import type { ActionRejectedPayload, ExecuteTurn } from "@ai-dm/schemas";
import { recordFrom, type RecordInput } from "./records.js";

// `turn` and `plan` are irrelevant to `recordFrom` — it never reads them — so
// fixtures stub them out rather than constructing full valid game state.
const STUB_TURN = {} as ExecuteTurn;
const STUB_PLAN = {} as TurnPlan;

function usage(promptTokens: number, completionTokens: number): TokenUsage {
  return { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens };
}

function timing(durationMs: number): CallTiming {
  return { kind: "structured", durationMs };
}

function rejection(overrides: Partial<ActionRejectedPayload> = {}): ActionRejectedPayload {
  return {
    actorId: "goblin_1",
    attempt: 1,
    stage: "engine",
    messages: ["rejected"],
    provider: "google",
    modelId: "gemini-3-flash",
    ...overrides,
  };
}

function success(overrides: Partial<TurnProposalSuccess> = {}): TurnProposalSuccess {
  return {
    ok: true,
    turn: STUB_TURN,
    plan: STUB_PLAN,
    source: "model",
    rejections: [],
    usage: [],
    ...overrides,
  };
}

function failure(overrides: Partial<TurnProposalFailure> = {}): TurnProposalFailure {
  return {
    ok: false,
    kind: "no_legal_turn",
    rejections: [],
    usage: [],
    ...overrides,
  };
}

function input(overrides: Partial<RecordInput> = {}): RecordInput {
  return {
    armId: "fake@medium",
    scenarioId: "melee-brawl",
    seed: 1,
    round: 1,
    actorId: "goblin_1",
    result: success(),
    timings: [],
    ...overrides,
  };
}

describe("recordFrom: outcome mapping", () => {
  it("maps a success result's source directly for model, retry and fallback", () => {
    expect(recordFrom(input({ result: success({ source: "model" }) })).outcome).toBe("model");
    expect(recordFrom(input({ result: success({ source: "retry" }) })).outcome).toBe("retry");
    expect(recordFrom(input({ result: success({ source: "fallback" }) })).outcome).toBe("fallback");
  });

  it("maps a failure result's kind for aborted and no_legal_turn", () => {
    expect(recordFrom(input({ result: failure({ kind: "aborted" }) })).outcome).toBe("aborted");
    expect(recordFrom(input({ result: failure({ kind: "no_legal_turn" }) })).outcome).toBe(
      "no_legal_turn",
    );
  });
});

describe("recordFrom: usage completeness", () => {
  it("is complete and reports zero missing when every timing has a matching usage entry", () => {
    const record = recordFrom(
      input({
        result: success({ usage: [usage(100, 10), usage(200, 20)] }),
        timings: [timing(50), timing(60)],
      }),
    );

    expect(record.attempts).toBe(2);
    expect(record.attemptsMissingUsage).toBe(0);
    expect(record.usageComplete).toBe(true);
  });

  it("flags a shortfall when an attempt was timed but produced no usage entry", () => {
    const record = recordFrom(
      input({
        result: success({ usage: [usage(100, 10)] }),
        timings: [timing(50), timing(60)],
      }),
    );

    expect(record.attempts).toBe(2);
    expect(record.attemptsMissingUsage).toBe(1);
    expect(record.usageComplete).toBe(false);
  });

  it("does not count a terminal provider_error attempt as a shortfall — nothing was billed", () => {
    const record = recordFrom(
      input({
        result: success({
          rejections: [rejection({ stage: "adapter", adapterErrorCode: "provider_error" })],
        }),
        timings: [timing(50)],
      }),
    );

    expect(record.attempts).toBe(1);
    expect(record.attemptsMissingUsage).toBe(0);
    expect(record.usageComplete).toBe(true);
    expect(record.adapterErrorCodes).toStrictEqual(["provider_error"]);
  });

  it("still counts an aborted attempt as a shortfall — it may have been billed", () => {
    const record = recordFrom(
      input({
        result: success({
          rejections: [rejection({ stage: "adapter", adapterErrorCode: "aborted" })],
        }),
        timings: [timing(50)],
      }),
    );

    expect(record.attempts).toBe(1);
    expect(record.attemptsMissingUsage).toBe(1);
    expect(record.usageComplete).toBe(false);
  });

  it("throws rather than silently reporting completeness when usage exceeds timings", () => {
    expect(() =>
      recordFrom(
        input({
          actorId: "goblin_1",
          result: success({ usage: [usage(100, 10), usage(200, 20)] }),
          timings: [timing(50)],
        }),
      ),
    ).toThrow(/goblin_1/);
  });
});

describe("recordFrom: token totals", () => {
  it("sums promptTokens and completionTokens across multiple usage entries", () => {
    const record = recordFrom(
      input({
        result: success({ usage: [usage(100, 10), usage(200, 20), usage(300, 30)] }),
        timings: [timing(10), timing(10), timing(10)],
      }),
    );

    expect(record.promptTokens).toBe(600);
    expect(record.completionTokens).toBe(60);
  });
});

describe("recordFrom: rejection flattening", () => {
  it("collects engine reasons and adapter error codes separately, skipping a payload with neither", () => {
    const record = recordFrom(
      input({
        result: success({
          rejections: [
            rejection({ stage: "engine", reasons: ["target_out_of_reach"] }),
            rejection({ stage: "adapter", adapterErrorCode: "no_tool_call" }),
            rejection({ stage: "engine", reasons: undefined, adapterErrorCode: undefined }),
          ],
        }),
        timings: [timing(10)],
      }),
    );

    expect(record.rejectionReasons).toStrictEqual(["target_out_of_reach"]);
    expect(record.adapterErrorCodes).toStrictEqual(["no_tool_call"]);
  });
});
