import { describe, expect, it } from "vitest";
import { ImprovisedEffect, NarrativeMove } from "./narrative-move.js";

describe("ImprovisedEffect", () => {
  it("accepts the four improvisable kinds", () => {
    for (const effect of [
      { kind: "shift_faction_relation", factionA: "a", factionB: "b", delta: -1 },
      { kind: "advance_calendar", days: 1 },
      { kind: "shift_npc_affinity", npcId: "old-tobin", delta: 1 },
      { kind: "add_npc_fact", npcId: "old-tobin", fact: "remembers the favour" },
    ]) {
      expect(ImprovisedEffect.parse(effect)).toEqual(effect);
    }
  });

  it("refuses long_rest — a conversation may not heal to full", () => {
    expect(ImprovisedEffect.safeParse({ kind: "long_rest" }).success).toBe(false);
  });
});

describe("NarrativeMove", () => {
  it("parses none", () => {
    expect(NarrativeMove.parse({ kind: "none" })).toEqual({ kind: "none" });
  });

  it("parses a world move with a reason", () => {
    const move = {
      kind: "world",
      effects: [{ kind: "shift_npc_affinity", npcId: "old-tobin", delta: 1 }],
      reasonEnglish: "the player bought him a drink and listened",
    };
    expect(NarrativeMove.parse(move)).toEqual(move);
  });

  it("parses an enter_detour move", () => {
    const move = {
      kind: "enter_detour",
      nodeId: "tobins-daughter",
      reasonEnglish: "he asked for help",
    };
    expect(NarrativeMove.parse(move)).toEqual(move);
  });

  it("refuses a world move with no effects, and one with three", () => {
    const reasonEnglish = "r";
    const one = { kind: "shift_npc_affinity", npcId: "n", delta: 1 };
    expect(NarrativeMove.safeParse({ kind: "world", effects: [], reasonEnglish }).success).toBe(
      false,
    );
    expect(
      NarrativeMove.safeParse({ kind: "world", effects: [one, one, one], reasonEnglish }).success,
    ).toBe(false);
  });

  it("refuses a mutating move with no reason — §4.7 requires a logged reason", () => {
    expect(
      NarrativeMove.safeParse({
        kind: "world",
        effects: [{ kind: "shift_npc_affinity", npcId: "n", delta: 1 }],
      }).success,
    ).toBe(false);
    expect(NarrativeMove.safeParse({ kind: "enter_detour", nodeId: "n" }).success).toBe(false);
  });

  it("refuses an unknown kind", () => {
    expect(NarrativeMove.safeParse({ kind: "invent_npc" }).success).toBe(false);
  });
});
