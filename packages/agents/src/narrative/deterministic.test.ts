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
              cover: "none",
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
              cover: "none",
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
    expect(chunks.join("")).not.toBe("");
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
              cover: "none",
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
            cover: "none",
            damage: 5,
            targetStatusAfter: "alive",
          },
        ],
      }),
    })) {
      chunks.push(chunk);
    }

    // Naive concatenation ("" join) is exactly what a consumer does to
    // reassemble the completed text — it must match the array's own join,
    // and the result must be a single well-formed string with no dropped or
    // duplicated separators between sentences.
    const joined = chunks.reduce((acc, chunk) => acc + chunk, "");
    expect(joined).toBe(chunks.join(""));
    expect(joined).toBe("Goblin moves 10 feet. Goblin hits Fighter for 5 damage. ");
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
              cover: "none",
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
              cover: "none",
              damage: 8,
              targetStatusAfter: "dead",
            },
          ],
        }),
      }),
    );
    expect(text).toContain("falls");
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
            cover: "none",
            damage: 0,
            targetStatusAfter: "alive",
          },
          {
            attackerId: "hero",
            targetId: "villain",
            actionId: "longsword",
            outcome: "hit",
            cover: "none",
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
    expect(text).toBe("Fighter moves 20 feet. ");
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
    expect(text).not.toBe("Fighter holds position. ");
    expect(text.length).toBeGreaterThan(0);
  });
});
