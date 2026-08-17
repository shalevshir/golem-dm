import { describe, expect, it } from "vitest";
import { buildTacticalPrompt } from "./prompt.js";
import { buildCapabilityCard, buildSnapshot } from "./snapshot.js";
import { combatant, parseGrid } from "./test-fixtures.js";

const world = {
  grid: parseGrid(`
    .....
    .....
  `),
  combatants: [
    combatant({ combatantId: "gob-1", faction: "hostile", position: [0, 0] }),
    combatant({ combatantId: "pc-1", faction: "party", position: [4, 0] }),
  ],
};

const snapshot = buildSnapshot({ world, actorId: "gob-1" });
const card = buildCapabilityCard(world.combatants[0] ?? combatant({ combatantId: "gob-1" }), [
  { actionId: "scimitar", name: "Scimitar", rangeFeet: 5 },
]);

const feedback = {
  stage: "engine",
  codes: ["target_out_of_reach"],
  messages: ["pc-1 is 20 ft away, beyond the 5 ft reach of this action"],
} as const;

function joined(tier: readonly string[] | undefined): string {
  return (tier ?? []).join("\n");
}

describe("buildTacticalPrompt", () => {
  it("puts the combat state in the dynamic tier", () => {
    const prompt = buildTacticalPrompt({ snapshot, card });

    expect(joined(prompt.dynamic)).toContain("pc-1");
  });

  it("keeps the combat state out of the cached tiers", () => {
    const prompt = buildTacticalPrompt({ snapshot, card });

    // One line of turn state in the cached prefix invalidates the cache on
    // every call, and the symptom is a bill rather than a failure.
    expect(joined(prompt.static)).not.toContain("pc-1");
    expect(joined(prompt.semiStatic)).not.toContain("pc-1");
  });

  it("puts the actor's capabilities in the semi-static tier", () => {
    const prompt = buildTacticalPrompt({ snapshot, card });

    expect(joined(prompt.semiStatic)).toContain("scimitar");
  });

  it("leaves the cached tiers byte-identical when a retry adds feedback", () => {
    const first = buildTacticalPrompt({ snapshot, card });
    const retry = buildTacticalPrompt({ snapshot, card, feedback });

    expect(retry.static).toStrictEqual(first.static);
    expect(retry.semiStatic).toStrictEqual(first.semiStatic);
  });

  it("carries the machine-readable rejection code into the retry", () => {
    const retry = buildTacticalPrompt({ snapshot, card, feedback });

    expect(joined(retry.dynamic)).toContain("target_out_of_reach");
    expect(joined(retry.dynamic)).toContain("beyond the 5 ft reach");
  });

  it("frames an adapter-stage retry as a missing tool call, not an illegal turn", () => {
    const retry = buildTacticalPrompt({
      snapshot,
      card,
      feedback: { stage: "adapter", codes: ["no_tool_call"], messages: ["Answered in prose."] },
    });

    expect(joined(retry.dynamic)).toContain("must call the execute_turn tool");
    expect(joined(retry.dynamic)).not.toContain("rejected by the rules engine");
  });

  it("adds no feedback section when there is no feedback", () => {
    const prompt = buildTacticalPrompt({ snapshot, card });

    expect(joined(prompt.dynamic)).not.toContain("rejected");
  });

  it("shows the model the proposal that was rejected, when there was one", () => {
    const retry = buildTacticalPrompt({
      snapshot,
      card,
      feedback: {
        ...feedback,
        proposedTurn: {
          actorId: "gob-1",
          mainAction: { actionType: "attack", targetIds: ["pc-1"] },
          tacticalRationaleEnglish: "Swing at the hero.",
        },
      },
    });

    expect(joined(retry.dynamic)).toContain("Swing at the hero.");
  });
});
