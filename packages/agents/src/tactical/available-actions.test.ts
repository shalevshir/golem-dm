import { describe, expect, it } from "vitest";
import type { MonsterStatBlock } from "@ai-dm/schemas";
import { availableActionsFor } from "./available-actions.js";

describe("availableActionsFor", () => {
  it("lists one action per attack in the stat block", () => {
    const statBlock = {
      actions: [
        { actionId: "scimitar", nameEnglish: "Scimitar" },
        { actionId: "bow", nameEnglish: "Shortbow" },
      ],
    } as unknown as MonsterStatBlock;

    expect(availableActionsFor(statBlock)).toEqual([
      { actionId: "scimitar", name: "Scimitar" },
      { actionId: "bow", name: "Shortbow" },
    ]);
  });

  it("returns an empty list for a stat block with no actions", () => {
    expect(availableActionsFor({ actions: [] } as unknown as MonsterStatBlock)).toEqual([]);
  });
});
