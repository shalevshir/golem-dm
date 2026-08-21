import { describe, expect, it } from "vitest";
import type { TurnEffect } from "@ai-dm/rules-engine";
import { createDeterministicNarrative } from "./deterministic.js";

async function collect(stream: AsyncIterable<string>): Promise<string> {
  let text = "";
  for await (const chunk of stream) text += chunk;
  return text;
}

const names = { hero: "Fighter", villain: "Goblin" };

function effectWith(overrides: Partial<TurnEffect>): TurnEffect {
  return {
    attacks: [],
    damageDealt: 0,
    killed: [],
    movedFeet: 0,
    nonAttackAction: false,
    unresolvedActionIds: [],
    ...overrides,
  };
}

describe("createDeterministicNarrative", () => {
  it("narrates a hit with its damage", async () => {
    const narrative = createDeterministicNarrative();
    const text = await collect(
      narrative.stream({
        actorName: "Goblin",
        namesByCombatantId: names,
        effect: effectWith({
          damageDealt: 5,
          attacks: [
            {
              attackerId: "villain",
              targetId: "hero",
              actionId: "scimitar",
              outcome: "hit",
              attackRoll: { naturalRoll: 15, rolls: [15], total: 18, targetArmorClass: 14 },
              damageRolls: [{ kind: "dice", notation: "1d6+2", rolls: [3], modifier: 2, total: 5 }],
              damage: 5,
              targetStatusAfter: "alive",
            },
          ],
        }),
      }),
    );
    expect(text).toContain("Goblin");
    expect(text).toContain("Fighter");
    expect(text).toContain("5");
  });

  it("narrates a miss without inventing damage", async () => {
    const narrative = createDeterministicNarrative();
    const text = await collect(
      narrative.stream({
        actorName: "Goblin",
        namesByCombatantId: names,
        effect: effectWith({
          attacks: [
            {
              attackerId: "villain",
              targetId: "hero",
              actionId: "scimitar",
              outcome: "miss",
              attackRoll: { naturalRoll: 3, rolls: [3], total: 6, targetArmorClass: 14 },
              damageRolls: [],
              damage: 0,
              targetStatusAfter: "alive",
            },
          ],
        }),
      }),
    );
    expect(text).toContain("misses");
    expect(text).not.toContain("damage");
  });

  it("narrates a zero-damage hit as a hit, keying on outcome rather than the damage number", async () => {
    // { outcome: "hit", damage: 0 } is constructible: damage rolls floor at
    // 0 (dice/index.ts) and a flat DamageRoll can print an average of 0.
    // The engine's verdict is `outcome`; the renderer must not second-guess
    // it from the derived damage number.
    const narrative = createDeterministicNarrative();
    const text = await collect(
      narrative.stream({
        actorName: "Goblin",
        namesByCombatantId: names,
        effect: effectWith({
          attacks: [
            {
              attackerId: "villain",
              targetId: "hero",
              actionId: "scimitar",
              outcome: "hit",
              attackRoll: { naturalRoll: 15, rolls: [15], total: 18, targetArmorClass: 14 },
              damageRolls: [{ kind: "flat", total: 0 }],
              damage: 0,
              targetStatusAfter: "alive",
            },
          ],
        }),
      }),
    );
    expect(text).toBe("Goblin hits Fighter for 0 damage.");
    expect(text).not.toContain("misses");
  });

  it("narrates movement when nothing else happened", async () => {
    const narrative = createDeterministicNarrative();
    const text = await collect(
      narrative.stream({
        actorName: "Fighter",
        namesByCombatantId: names,
        effect: effectWith({ movedFeet: 15, nonAttackAction: true }),
      }),
    );
    expect(text).toContain("15");
  });

  it("always yields at least one chunk, even for an empty turn", async () => {
    const narrative = createDeterministicNarrative();
    const chunks: string[] = [];
    for await (const chunk of narrative.stream({
      actorName: "Fighter",
      namesByCombatantId: names,
      effect: effectWith({}),
    })) {
      chunks.push(chunk);
    }
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.join("")).toBe("Fighter holds position.");
  });

  it("falls back to the id when a name is unknown", async () => {
    const narrative = createDeterministicNarrative();
    const text = await collect(
      narrative.stream({
        actorName: "Goblin",
        namesByCombatantId: {},
        effect: effectWith({
          attacks: [
            {
              attackerId: "villain",
              targetId: "ghost",
              actionId: "scimitar",
              outcome: "miss",
              attackRoll: { naturalRoll: 3, rolls: [3], total: 6, targetArmorClass: 14 },
              damageRolls: [],
              damage: 0,
              targetStatusAfter: "alive",
            },
          ],
        }),
      }),
    );
    expect(text).toContain("ghost");
  });

  it("concatenates its chunks into the exact text a narrative_emitted event would carry", async () => {
    const narrative = createDeterministicNarrative();
    const chunks: string[] = [];
    for await (const chunk of narrative.stream({
      actorName: "Goblin",
      namesByCombatantId: names,
      effect: effectWith({
        movedFeet: 10,
        damageDealt: 5,
        attacks: [
          {
            attackerId: "villain",
            targetId: "hero",
            actionId: "scimitar",
            outcome: "hit",
            attackRoll: { naturalRoll: 15, rolls: [15], total: 18, targetArmorClass: 14 },
            damageRolls: [{ kind: "dice", notation: "1d6+2", rolls: [3], modifier: 2, total: 5 }],
            damage: 5,
            targetStatusAfter: "alive",
          },
        ],
      }),
    })) {
      chunks.push(chunk);
    }

    // Naive "" concatenation is exactly what a consumer does to reassemble
    // the completed text stored verbatim in the narrative_emitted event.
    // Pinned to an exact literal — with no trailing space — so a regression
    // in chunk boundaries or separator handling cannot hide behind a
    // substring check.
    expect(chunks.join("")).toBe("Goblin moves 10 feet. Goblin hits Fighter for 5 damage.");
  });

  it("narrates a critical hit distinctly from a normal hit", async () => {
    const narrative = createDeterministicNarrative();
    const text = await collect(
      narrative.stream({
        actorName: "Goblin",
        namesByCombatantId: names,
        effect: effectWith({
          damageDealt: 10,
          attacks: [
            {
              attackerId: "villain",
              targetId: "hero",
              actionId: "scimitar",
              outcome: "critical_hit",
              attackRoll: { naturalRoll: 20, rolls: [20], total: 24, targetArmorClass: 14 },
              damageRolls: [
                { kind: "dice", notation: "1d6+2", rolls: [4, 4], modifier: 2, total: 10 },
              ],
              damage: 10,
              targetStatusAfter: "alive",
            },
          ],
        }),
      }),
    );
    expect(text).toContain("critically");
    expect(text).toContain("10");
  });

  it("narrates a kill", async () => {
    const narrative = createDeterministicNarrative();
    const text = await collect(
      narrative.stream({
        actorName: "Fighter",
        namesByCombatantId: names,
        effect: effectWith({
          damageDealt: 8,
          killed: ["villain"],
          attacks: [
            {
              attackerId: "hero",
              targetId: "villain",
              actionId: "longsword",
              outcome: "hit",
              attackRoll: { naturalRoll: 15, rolls: [15], total: 18, targetArmorClass: 14 },
              damageRolls: [{ kind: "dice", notation: "1d6+2", rolls: [6], modifier: 2, total: 8 }],
              damage: 8,
              targetStatusAfter: "dead",
            },
          ],
        }),
      }),
    );
    expect(text).toBe("Fighter hits Goblin for 8 damage. Goblin falls.");
  });

  it("narrates a downed-but-alive target distinctly from a kill (ADR 0002: solo game)", async () => {
    // The narrator distinguishes a downed-but-alive target from a kill, and
    // that distinction is exercised here directly because the pipeline
    // cannot currently produce it: `diesAtZeroHp` is pinned true pending
    // death saves (RULES_REFERENCE.md §8's gap, correction C-31), so every
    // 0-HP outcome in play today is a kill. This test keeps the narrator's
    // other branch honest for when death saves land.
    const narrative = createDeterministicNarrative();
    const text = await collect(
      narrative.stream({
        actorName: "Goblin",
        namesByCombatantId: names,
        effect: effectWith({
          damageDealt: 6,
          attacks: [
            {
              attackerId: "villain",
              targetId: "hero",
              actionId: "scimitar",
              outcome: "hit",
              attackRoll: { naturalRoll: 15, rolls: [15], total: 18, targetArmorClass: 14 },
              damageRolls: [{ kind: "dice", notation: "1d6+2", rolls: [4], modifier: 2, total: 6 }],
              damage: 6,
              targetStatusAfter: "unconscious",
            },
          ],
        }),
      }),
    );
    expect(text).toBe("Goblin hits Fighter for 6 damage. Fighter falls unconscious.");
    expect(text).not.toContain("Fighter falls.");
  });

  it("narrates multiple attacks in one turn, in order", async () => {
    const narrative = createDeterministicNarrative();
    const chunks: string[] = [];
    for await (const chunk of narrative.stream({
      actorName: "Fighter",
      namesByCombatantId: names,
      effect: effectWith({
        damageDealt: 5,
        attacks: [
          {
            attackerId: "hero",
            targetId: "villain",
            actionId: "longsword",
            outcome: "miss",
            attackRoll: { naturalRoll: 3, rolls: [3], total: 6, targetArmorClass: 14 },
            damageRolls: [],
            damage: 0,
            targetStatusAfter: "alive",
          },
          {
            attackerId: "hero",
            targetId: "villain",
            actionId: "longsword",
            outcome: "hit",
            attackRoll: { naturalRoll: 15, rolls: [15], total: 18, targetArmorClass: 14 },
            damageRolls: [{ kind: "dice", notation: "1d6+2", rolls: [3], modifier: 2, total: 5 }],
            damage: 5,
            targetStatusAfter: "alive",
          },
        ],
      }),
    })) {
      chunks.push(chunk);
    }
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toContain("misses");
    expect(chunks[1]).toContain("hits");
  });

  it("narrates a pure move with no action taken", async () => {
    const narrative = createDeterministicNarrative();
    const text = await collect(
      narrative.stream({
        actorName: "Fighter",
        namesByCombatantId: names,
        effect: effectWith({ movedFeet: 20 }),
      }),
    );
    expect(text).toBe("Fighter moves 20 feet.");
  });

  it("notes an unresolved action instead of narrating a silent turn", async () => {
    const narrative = createDeterministicNarrative();
    const text = await collect(
      narrative.stream({
        actorName: "Fighter",
        namesByCombatantId: names,
        effect: effectWith({ unresolvedActionIds: ["mystery-move"] }),
      }),
    );
    expect(text).toBe("Fighter attempts an action the engine could not resolve.");
  });
});
