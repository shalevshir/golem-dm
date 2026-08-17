import { describe, expect, it } from "vitest";
import { adapterSuccess } from "../providers/errors.js";
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
