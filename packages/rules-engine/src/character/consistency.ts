// `CharacterSheet` stores three values that are also derivable —
// `proficiencyBonus`, `combat.armorClass`, `combat.initiativeModifier` — plus
// saving-throw proficiencies that the class also declares. Keeping them is a
// deliberate choice, so this is the check that stops the two copies drifting.
//
// It lives here rather than in zod because deriving needs weapons, armor and
// class data, and `@ai-dm/schemas` loads no data files by design. Callers run
// it where the SRD data already is: `loadCharacter` in apps/server.
import type { CharacterSheet, ClassDefinition, DerivedCharacter } from "@ai-dm/schemas";

function mismatch(characterId: string, field: string, stored: unknown, derived: unknown): Error {
  return new Error(
    `${characterId}: ${field} is ${JSON.stringify(stored)} on the sheet but derives to ` +
      `${JSON.stringify(derived)}. Fix the sheet, or the derivation is wrong.`,
  );
}

export function assertSheetConsistent(
  sheet: CharacterSheet,
  derived: DerivedCharacter,
  classDefinition: ClassDefinition,
): void {
  // Not a stored-vs-derived check like the others below — `maxHp` derives
  // nothing to compare against. `combat.currentHp` has no upper bound in the
  // schema, and a spawned combatant is marked `alive` regardless of its HP,
  // so an impossible sheet like this would otherwise reach combat unnoticed.
  if (sheet.combat.currentHp > sheet.combat.maxHp) {
    throw new Error(
      `${sheet.characterId}: combat.currentHp (${String(sheet.combat.currentHp)}) exceeds ` +
        `combat.maxHp (${String(sheet.combat.maxHp)})`,
    );
  }

  if (sheet.proficiencyBonus !== derived.proficiencyBonus) {
    throw mismatch(
      sheet.characterId,
      "proficiencyBonus",
      sheet.proficiencyBonus,
      derived.proficiencyBonus,
    );
  }

  if (sheet.combat.armorClass !== derived.armorClass) {
    throw mismatch(
      sheet.characterId,
      "combat.armorClass",
      sheet.combat.armorClass,
      derived.armorClass,
    );
  }

  if (sheet.combat.initiativeModifier !== derived.initiative) {
    throw mismatch(
      sheet.characterId,
      "combat.initiativeModifier",
      sheet.combat.initiativeModifier,
      derived.initiative,
    );
  }

  const stored = [...sheet.savingThrowProficiencies].sort();
  const fromClass = [...classDefinition.savingThrowProficiencies].sort();
  if (stored.join(",") !== fromClass.join(",")) {
    throw mismatch(sheet.characterId, "savingThrowProficiencies", stored, fromClass);
  }
}
