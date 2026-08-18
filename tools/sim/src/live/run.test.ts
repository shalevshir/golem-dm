// Network-free: every model in this file is `MockLanguageModelV1` or a plain
// synchronous throw, standing in for the SDK's own `loadApiKey` throwing
// before any request is built. `resolveModel` is the seam `createVercelPort`
// already exposes for exactly this — see `packages/agents/src/providers/vercel.test.ts`.
import type { LanguageModelV1 } from "ai";
import { MockLanguageModelV1 } from "ai/test";
import { describe, expect, it } from "vitest";
import type { ModelSpec } from "@ai-dm/agents";
import type { Arm } from "../config.js";
import { runLive } from "./run.js";

function asLanguageModel(mock: MockLanguageModelV1): LanguageModelV1 {
  return mock as LanguageModelV1;
}

/**
 * A tool call that fails schema validation no matter which turn is being
 * decided: `actorId` must be a string, so `7` trips zod on every attempt.
 * Two attempts, both `schema_validation_failed`, then the deterministic
 * fallback — a different failure shape from `throwingModel` below, which is
 * the point of the "own model, not a shared one" test.
 */
function schemaBadModel(): LanguageModelV1 {
  return asLanguageModel(
    new MockLanguageModelV1({
      defaultObjectGenerationMode: "tool",
      doGenerate: () =>
        Promise.resolve({
          rawCall: { rawPrompt: null, rawSettings: {} },
          finishReason: "tool-calls",
          usage: { promptTokens: 10, completionTokens: 5 },
          toolCalls: [
            {
              toolCallType: "function" as const,
              toolCallId: "call-1",
              toolName: "execute_turn",
              args: JSON.stringify({
                actorId: 7,
                mainAction: { actionType: "dodge" },
                tacticalRationaleEnglish: "bad shape on purpose",
              }),
            },
          ],
        }),
    }),
  );
}

/**
 * Stands in for a real provider client refusing to build a request with no
 * API key: `loadApiKey` (`@ai-sdk/provider-utils`) throws synchronously,
 * before any network I/O, the same way this does. One attempt, straight to
 * fallback — no retry, since `provider_error` means the transport already
 * gave up.
 */
function throwingModel(message: string): LanguageModelV1 {
  throw new Error(message);
}

const KEY_MISSING_ARM: Arm = {
  armId: "key-missing-model@low",
  spec: { provider: "anthropic", modelId: "key-missing-model", reasoningEffort: "low" },
};

const SCHEMA_BAD_ARM: Arm = {
  armId: "schema-bad-model@low",
  spec: { provider: "openai", modelId: "schema-bad-model", reasoningEffort: "low" },
};

const CONFIG = {
  seeds: [1],
  scenarioIds: ["melee-brawl"],
} as const;

describe("runLive", () => {
  it("assembles a report with turns for the configured arm, no network involved", async () => {
    const report = await runLive({
      ...CONFIG,
      runId: "live-1",
      generatedAt: "T",
      gitCommit: "c",
      mode: "both",
      arms: [SCHEMA_BAD_ARM],
      resolveModel: () => schemaBadModel(),
    });

    expect(report.live).toBe(true);
    expect(report.arms).toHaveLength(1);
    expect(report.arms[0]?.armId).toBe(SCHEMA_BAD_ARM.armId);
    expect(report.arms[0]?.modelId).toBe(SCHEMA_BAD_ARM.spec.modelId);
    expect(report.arms[0]?.probe.turns).toBeGreaterThan(0);
    expect(report.arms[0]?.encounter.turns).toBeGreaterThan(0);
  });

  it("resolves each arm's calls through that arm's own model, not a shared one", async () => {
    const report = await runLive({
      ...CONFIG,
      runId: "live-2",
      generatedAt: "T",
      gitCommit: "c",
      mode: "probe",
      arms: [KEY_MISSING_ARM, SCHEMA_BAD_ARM],
      resolveModel: (spec: ModelSpec) =>
        spec.modelId === KEY_MISSING_ARM.spec.modelId
          ? throwingModel("simulated: ANTHROPIC_API_KEY is not set")
          : schemaBadModel(),
    });

    const keyMissing = report.arms.find((arm) => arm.armId === KEY_MISSING_ARM.armId);
    const schemaBad = report.arms.find((arm) => arm.armId === SCHEMA_BAD_ARM.armId);
    if (keyMissing === undefined || schemaBad === undefined) {
      throw new Error("expected both arms in the report");
    }

    // Every turn fell back on both arms, but by different, arm-specific
    // paths — proof the two arms did not secretly share one resolved model.
    const keyMissingRecords = report.records.probe.filter(
      (record) => record.armId === KEY_MISSING_ARM.armId,
    );
    const schemaBadRecords = report.records.probe.filter(
      (record) => record.armId === SCHEMA_BAD_ARM.armId,
    );
    expect(keyMissingRecords.length).toBeGreaterThan(0);
    expect(schemaBadRecords.length).toBeGreaterThan(0);

    for (const record of keyMissingRecords) {
      expect(record.attempts).toBe(1);
      expect(record.adapterErrorCodes).toStrictEqual(["provider_error"]);
    }
    for (const record of schemaBadRecords) {
      expect(record.attempts).toBe(2);
      expect(record.adapterErrorCodes).toStrictEqual([
        "schema_validation_failed",
        "schema_validation_failed",
      ]);
    }

    expect(keyMissing.probe.legality.fallback).toBe(keyMissing.probe.turns);
    expect(schemaBad.probe.legality.fallback).toBe(schemaBad.probe.turns);
  });

  it("falls back without throwing when model resolution fails, e.g. a missing API key", async () => {
    const report = await runLive({
      ...CONFIG,
      runId: "live-3",
      generatedAt: "T",
      gitCommit: "c",
      mode: "probe",
      arms: [KEY_MISSING_ARM],
      resolveModel: () =>
        throwingModel(
          "Anthropic API key is missing. Set the ANTHROPIC_API_KEY environment variable.",
        ),
    });

    const arm = report.arms[0];
    if (arm === undefined) throw new Error("expected one arm in the report");

    expect(arm.probe.turns).toBeGreaterThan(0);
    expect(arm.probe.legality.fallback).toBe(arm.probe.turns);
    for (const record of report.records.probe) {
      expect(record.attempts).toBe(1);
      expect(record.adapterErrorCodes).toStrictEqual(["provider_error"]);
    }
  });
});
