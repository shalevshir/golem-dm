// The panel renders server-derived numbers and decides exactly one thing:
// which of two HP sources is the live one. That decision, and the RTL
// handling of Latin fragments, are what these cover.
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { DerivedCharacter } from "@ai-dm/schemas";
import { SheetPanel } from "./SheetPanel.js";
import { he } from "../i18n.js";

function character(overrides: Partial<DerivedCharacter> = {}): DerivedCharacter {
  return {
    characterId: "hero",
    nameHebrew: "אלדד",
    grammaticalGender: "masculine",
    class: "fighter",
    level: 3,
    size: "medium",
    abilityModifiers: { str: 3, dex: 1, con: 2, int: 0, wis: 1, cha: -1 },
    proficiencyBonus: 2,
    armorClass: 16,
    initiative: 1,
    speedFeet: 30,
    passivePerception: 13,
    maxHp: 28,
    currentHp: 28,
    tempHp: 0,
    hitDice: "3d10",
    savingThrows: { str: 5, dex: 1, con: 4, int: 0, wis: 1, cha: -1 },
    skills: { athletics: 5, stealth: 1 },
    armorNameEnglish: "Chain Mail",
    attacks: [
      {
        actionId: "longsword",
        nameEnglish: "Longsword",
        nameHebrew: "חרב ארוכה",
        attackBonus: 5,
        damage: { diceNotation: "1d8", averageDamage: 7, damageType: "slashing" },
        extraDamage: [],
      },
    ],
    attacksPerAction: 1,
    inventory: [
      { itemId: "chain_mail", nameHebrew: "שריון שרשראות", quantity: 1, equipped: true },
      { itemId: "rope_hempen", quantity: 2, equipped: false },
    ],
    ...overrides,
  };
}

describe("SheetPanel", () => {
  it("says it is loading before the sheet arrives", () => {
    render(<SheetPanel character={null} currentHp={null} />);
    expect(screen.getByText(he.sheet.loading)).toBeTruthy();
  });

  // A panel stuck on "loading" is indistinguishable from a slow network, and
  // nothing retries the fetch, so the failed case has to say so.
  it("says the sheet is unavailable once the fetch has failed", () => {
    render(<SheetPanel character={null} currentHp={null} unavailable />);
    expect(screen.getByText(he.sheet.unavailable)).toBeTruthy();
    expect(screen.queryByText(he.sheet.loading)).toBeNull();
  });

  // The bug this guards: the fetched sheet's `currentHp` is a load-time
  // snapshot, so a wounded player would otherwise be shown full health.
  it("shows the live HP from the projection, not the sheet's load-time value", () => {
    render(<SheetPanel character={character({ currentHp: 28 })} currentHp={9} />);
    expect(screen.getByText("9/28")).toBeTruthy();
    expect(screen.queryByText("28/28")).toBeNull();
  });

  it("falls back to the sheet's own HP when the projection has none yet", () => {
    render(<SheetPanel character={character({ currentHp: 28 })} currentHp={null} />);
    expect(screen.getByText("28/28")).toBeTruthy();
  });

  it("renders negative modifiers as signed, with a real minus sign", () => {
    render(<SheetPanel character={character()} currentHp={28} />);
    expect(screen.getAllByText("−1").length).toBeGreaterThan(0);
    expect(screen.getAllByText("+5").length).toBeGreaterThan(0);
  });

  it("lists carried items by Hebrew name and marks the equipped ones", () => {
    render(<SheetPanel character={character()} currentHp={28} />);
    expect(screen.getByText("שריון שרשראות")).toBeTruthy();
    expect(screen.getByText(he.sheet.equipped)).toBeTruthy();
  });

  // Ordinary gear has no SRD row, so the raw Latin id is all there is —
  // and a Latin fragment in an RTL page must be direction-isolated.
  it("falls back to the Latin item id for gear with no Hebrew name, isolated for RTL", () => {
    render(<SheetPanel character={character()} currentHp={28} />);
    const fallback = screen.getByText("rope_hempen");
    expect(fallback.tagName).toBe("BDI");
    expect(fallback.getAttribute("dir")).toBe("ltr");
  });

  it("shows a stacked quantity but not a quantity of one", () => {
    render(<SheetPanel character={character()} currentHp={28} />);
    expect(screen.getByText("×2")).toBeTruthy();
    expect(screen.queryByText("×1")).toBeNull();
  });

  it("hides temporary HP when there is none, and shows it when there is", () => {
    const { rerender } = render(<SheetPanel character={character()} currentHp={28} />);
    expect(screen.queryByText(he.sheet.tempHp)).toBeNull();

    rerender(<SheetPanel character={character()} currentHp={28} tempHp={5} />);
    expect(screen.getByText(he.sheet.tempHp)).toBeTruthy();
  });

  it("omits the armor row entirely for an unarmored character", () => {
    const bare = character();
    delete (bare as { armorNameEnglish?: string }).armorNameEnglish;
    render(<SheetPanel character={bare} currentHp={28} />);
    expect(screen.queryByText(he.sheet.armor)).toBeNull();
  });

  // The summary answers "how much HP", so the panel opens only when asked —
  // an expanded 18-skill list would bury the narration it sits above.
  it("starts collapsed, with HP readable without opening it", () => {
    const { container } = render(<SheetPanel character={character()} currentHp={9} />);
    expect(container.querySelector("details")?.open).toBe(false);
    expect(screen.getByText("9/28")).toBeTruthy();
  });
});
