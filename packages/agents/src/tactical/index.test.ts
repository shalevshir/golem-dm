import { describe, expect, it } from "vitest";
import { ExecuteTurn as ExecuteTurnSchema } from "@ai-dm/schemas";
import { adapterFailure, adapterSuccess } from "../providers/errors.js";
import { DEFAULT_MODEL_ROUTING } from "../providers/routing.js";
import { createAgentRuntime } from "../providers/runtime.js";
import { createFakePort } from "../providers/testing/fake-port.js";
import type { AdapterResult } from "../providers/errors.js";
import type { StructuredOutput } from "../providers/port.js";
import { createTacticalAgent } from "./index.js";
import { combatant, parseGrid } from "./test-fixtures.js";

const usage = { promptTokens: 100, completionTokens: 20, totalTokens: 120 };

const grid = parseGrid(`
  ......
  ......
`);

const goblin = combatant({ combatantId: "gob-1", faction: "hostile", position: [0, 0] });
const hero = combatant({ combatantId: "pc-1", faction: "party", position: [1, 0] });
const world = { grid, combatants: [goblin, hero] };

const legalTurn = {
  actorId: "gob-1",
  mainAction: { actionType: "attack", targetIds: ["pc-1"] },
  tacticalRationaleEnglish: "The hero is adjacent.",
};

function agentWith(...structured: AdapterResult<StructuredOutput<unknown>>[]) {
  const port = createFakePort({ structured });
  const runtime = createAgentRuntime({ routing: DEFAULT_MODEL_ROUTING, port });
  return { port, agent: createTacticalAgent({ runtime, routing: DEFAULT_MODEL_ROUTING }) };
}

describe("createTacticalAgent — a legal proposal", () => {
  it("returns the model's turn untouched", async () => {
    const { agent } = agentWith(adapterSuccess({ value: legalTurn, usage }));

    const result = await agent.proposeTurn({ world, actorId: "gob-1" });

    if (!result.ok) throw new Error("expected a proposal");
    expect(result.turn).toStrictEqual(legalTurn);
    expect(result.source).toBe("model");
  });

  it("makes exactly one model call", async () => {
    const { port, agent } = agentWith(adapterSuccess({ value: legalTurn, usage }));

    await agent.proposeTurn({ world, actorId: "gob-1" });

    expect(port.calls).toHaveLength(1);
  });

  it("logs no rejection when nothing was rejected", async () => {
    const { agent } = agentWith(adapterSuccess({ value: legalTurn, usage }));

    const result = await agent.proposeTurn({ world, actorId: "gob-1" });

    expect(result.rejections).toStrictEqual([]);
  });

  it("returns the engine's plan, not just the turn", async () => {
    const { agent } = agentWith(adapterSuccess({ value: legalTurn, usage }));

    const result = await agent.proposeTurn({ world, actorId: "gob-1" });

    if (!result.ok) throw new Error("expected a proposal");
    expect(result.plan.economyAfter.actionUsed).toBe(true);
  });

  it("accumulates token usage for cost metering", async () => {
    const { agent } = agentWith(adapterSuccess({ value: legalTurn, usage }));

    const result = await agent.proposeTurn({ world, actorId: "gob-1" });

    expect(result.usage).toStrictEqual([usage]);
  });

  it("asks the tactical model, with the ExecuteTurn tool", async () => {
    const { port, agent } = agentWith(adapterSuccess({ value: legalTurn, usage }));

    await agent.proposeTurn({ world, actorId: "gob-1" });

    expect(port.calls[0]?.spec.modelId).toBe("gemini-3-flash");
    expect(port.calls[0]?.request.toolName).toBe("execute_turn");
  });
});

const illegalTurn = {
  actorId: "gob-1",
  // pc-1 is 5 ft away; pc-99 does not exist.
  mainAction: { actionType: "attack", targetIds: ["pc-99"] },
  tacticalRationaleEnglish: "Attack someone who is not here.",
};

function dynamicOf(port: ReturnType<typeof createFakePort>, call: number): string {
  return (port.calls[call]?.request.prompt.dynamic ?? []).join("\n");
}

describe("createTacticalAgent — the single retry", () => {
  it("retries once when the engine rejects the first proposal", async () => {
    const { port, agent } = agentWith(
      adapterSuccess({ value: illegalTurn, usage }),
      adapterSuccess({ value: legalTurn, usage }),
    );

    const result = await agent.proposeTurn({ world, actorId: "gob-1" });

    if (!result.ok) throw new Error("expected a proposal");
    expect(port.calls).toHaveLength(2);
    expect(result.source).toBe("retry");
    expect(result.turn).toStrictEqual(legalTurn);
  });

  it("carries the machine-readable reason into the retry", async () => {
    const { port, agent } = agentWith(
      adapterSuccess({ value: illegalTurn, usage }),
      adapterSuccess({ value: legalTurn, usage }),
    );

    await agent.proposeTurn({ world, actorId: "gob-1" });

    expect(dynamicOf(port, 1)).toContain("target_not_found");
  });

  it("leaves the cached prompt tiers byte-identical across the retry", async () => {
    const { port, agent } = agentWith(
      adapterSuccess({ value: illegalTurn, usage }),
      adapterSuccess({ value: legalTurn, usage }),
    );

    await agent.proposeTurn({ world, actorId: "gob-1" });

    // A retry that touched the cached prefix would silently cost ~10x on every
    // call, and the symptom would be a bill rather than a failure.
    expect(port.calls[1]?.request.prompt.static).toStrictEqual(
      port.calls[0]?.request.prompt.static,
    );
    expect(port.calls[1]?.request.prompt.semiStatic).toStrictEqual(
      port.calls[0]?.request.prompt.semiStatic,
    );
  });

  it("logs the engine rejection that triggered the retry", async () => {
    const { agent } = agentWith(
      adapterSuccess({ value: illegalTurn, usage }),
      adapterSuccess({ value: legalTurn, usage }),
    );

    const result = await agent.proposeTurn({ world, actorId: "gob-1" });

    expect(result.rejections).toHaveLength(1);
    expect(result.rejections[0]?.stage).toBe("engine");
    expect(result.rejections[0]?.attempt).toBe(1);
    expect(result.rejections[0]?.reasons).toStrictEqual(["target_not_found"]);
    expect(result.rejections[0]?.modelId).toBe("gemini-3-flash");
  });

  it("retries plainly when the model answered in prose", async () => {
    const { port, agent } = agentWith(
      adapterFailure("no_tool_call", "The model answered in prose."),
      adapterSuccess({ value: legalTurn, usage }),
    );

    const result = await agent.proposeTurn({ world, actorId: "gob-1" });

    if (!result.ok) throw new Error("expected a proposal");
    expect(port.calls).toHaveLength(2);
    expect(result.source).toBe("retry");
    expect(result.rejections[0]?.adapterErrorCode).toBe("no_tool_call");
  });

  it("quotes the zod issues back when the tool call did not match the schema", async () => {
    // Real issues from the real schema, so the assertion cannot drift from
    // whatever zod actually emits. A turn missing `mainAction` yields an issue
    // whose path is ["mainAction"].
    const parsed = ExecuteTurnSchema.safeParse({ actorId: "gob-1" });
    if (parsed.success) throw new Error("expected the fixture to be invalid");

    const { port, agent } = agentWith(
      adapterFailure("schema_validation_failed", "Tool call did not match", {
        issues: parsed.error.issues,
      }),
      adapterSuccess({ value: legalTurn, usage }),
    );

    await agent.proposeTurn({ world, actorId: "gob-1" });

    expect(dynamicOf(port, 1)).toContain("mainAction");
    // The issues are what reached the model, not just the generic message.
    expect(dynamicOf(port, 1)).not.toContain("Tool call did not match");
  });

  it("counts only the calls that produced output toward usage", async () => {
    const { agent } = agentWith(
      adapterFailure("no_tool_call", "The model answered in prose."),
      adapterSuccess({ value: legalTurn, usage }),
    );

    const result = await agent.proposeTurn({ world, actorId: "gob-1" });

    expect(result.usage).toStrictEqual([usage]);
  });
});
