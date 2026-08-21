// The one place 5e character math happens. The engine consumes a projection of
// the result (`characterStatBlock`); a character-sheet page consumes it whole.
// Anything that computes one of these numbers a second time somewhere else is
// a bug, not an optimisation.
import type {
  AbilityKey,
  ArmorDefinition,
  CharacterClass,
  CharacterSheet,
  ClassDefinition,
  CreatureStatBlock,
  DerivedCharacter,
  Skill,
  SkillDefinition,
  WeaponDefinition,
} from "@ai-dm/schemas";
import { abilityModifier, proficiencyBonusForLevel } from "../checks/index.js";
import { armorClassFor, speedFeetFor } from "./armor.js";
import type { EquippedArmor } from "./armor.js";
import { attacksFor } from "./attacks.js";

export interface SrdGear {
  weapons: ReadonlyMap<string, WeaponDefinition>;
  armor: ReadonlyMap<string, ArmorDefinition>;
  classes: ReadonlyMap<CharacterClass, ClassDefinition>;
  skills: ReadonlyMap<Skill, SkillDefinition>;
}

const ABILITY_KEYS: readonly AbilityKey[] = ["str", "dex", "con", "int", "wis", "cha"];
const PASSIVE_BASE = 10;
const SPELL_SAVE_BASE = 8;

/**
 * Split equipped inventory into worn armor, wielded shield and wielded
 * weapons. "A creature can wear only one suit of armor at a time and wield
 * only one Shield at a time", so a sheet breaking that is rejected here rather
 * than silently resolved — zod cannot check it, since classifying an `itemId`
 * needs SRD data that `@ai-dm/schemas` never loads.
 */
function equipmentOf(
  sheet: CharacterSheet,
  gear: SrdGear,
): { armor: EquippedArmor; weapons: WeaponDefinition[] } {
  const armor: EquippedArmor = {};
  const weapons: WeaponDefinition[] = [];

  for (const entry of sheet.inventory) {
    if (!entry.equipped) continue;

    const armorPiece = gear.armor.get(entry.itemId);
    if (armorPiece !== undefined) {
      if (armorPiece.category === "shield") {
        if (armor.shield !== undefined) {
          throw new Error(`${sheet.characterId} equips more than one Shield`);
        }
        armor.shield = armorPiece;
      } else {
        if (armor.body !== undefined) {
          throw new Error(`${sheet.characterId} equips more than one suit of armor`);
        }
        armor.body = armorPiece;
      }
      continue;
    }

    const weapon = gear.weapons.get(entry.itemId);
    if (weapon !== undefined) weapons.push(weapon);
    // An itemId that is neither armor nor weapon is ordinary gear — rope,
    // rations, a holy symbol. Not an error, just not an action.
  }

  return { armor, weapons };
}

function modifiersOf(sheet: CharacterSheet): Record<AbilityKey, number> {
  const modifiers = {} as Record<AbilityKey, number>;
  for (const key of ABILITY_KEYS) modifiers[key] = abilityModifier(sheet.abilities[key]);
  return modifiers;
}

export function deriveCharacter(sheet: CharacterSheet, gear: SrdGear): DerivedCharacter {
  const classDefinition = gear.classes.get(sheet.class);
  if (classDefinition === undefined) {
    throw new Error(`No class definition for ${sheet.class}`);
  }

  const modifiers = modifiersOf(sheet);
  const proficiencyBonus = proficiencyBonusForLevel(sheet.level);
  const { armor, weapons } = equipmentOf(sheet, gear);

  const savingThrows = {} as Record<AbilityKey, number>;
  for (const key of ABILITY_KEYS) {
    const proficient = sheet.savingThrowProficiencies.includes(key);
    savingThrows[key] = modifiers[key] + (proficient ? proficiencyBonus : 0);
  }

  const skills = {} as Record<Skill, number>;
  for (const [skill, definition] of gear.skills) {
    const proficient = sheet.skillProficiencies.includes(skill);
    skills[skill] = modifiers[definition.ability] + (proficient ? proficiencyBonus : 0);
  }

  const extraAttackLevel = classDefinition.extraAttackLevel;
  const attacksPerAction =
    extraAttackLevel !== undefined && sheet.level >= extraAttackLevel ? 2 : 1;

  const spellcastingAbility = classDefinition.spellcastingAbility;

  return {
    characterId: sheet.characterId,
    nameHebrew: sheet.nameHebrew,
    grammaticalGender: sheet.grammaticalGender,
    class: sheet.class,
    level: sheet.level,
    size: sheet.size,

    abilityModifiers: modifiers,
    proficiencyBonus,
    armorClass: armorClassFor(armor, modifiers.dex, classDefinition.armorTraining),
    initiative: modifiers.dex,
    speedFeet: speedFeetFor(armor, sheet.abilities.str, sheet.combat.speedFeet),
    passivePerception: PASSIVE_BASE + skills.perception,

    maxHp: sheet.combat.maxHp,
    currentHp: sheet.combat.currentHp,
    tempHp: sheet.combat.tempHp,
    hitDice: `${String(sheet.level)}d${String(classDefinition.hitDie)}`,

    savingThrows,
    skills,

    attacks: attacksFor({
      weapons,
      abilityModifiers: modifiers,
      proficiencyBonus,
      proficiencies: classDefinition.weaponProficiencies,
      shieldEquipped: armor.shield !== undefined,
    }),
    attacksPerAction,

    ...(spellcastingAbility === undefined
      ? {}
      : {
          spellSaveDc: SPELL_SAVE_BASE + proficiencyBonus + modifiers[spellcastingAbility],
        }),
  };
}

/**
 * The seven fields the combat engine actually reads, selected out of the full
 * derivation. Everything else in `DerivedCharacter` — saves, skills, passive
 * Perception, spell save DC — exists for the character sheet, not for combat,
 * and deliberately does not cross this line.
 *
 * `nameEnglish` is the `characterId`: a character sheet is authored in Hebrew
 * and has no English name, and the engine only ever uses this for logs and
 * for the tactical agent's English prompt.
 */
export function characterStatBlock(derived: DerivedCharacter): CreatureStatBlock {
  return {
    nameEnglish: derived.characterId,
    nameHebrew: derived.nameHebrew,
    grammaticalGender: derived.grammaticalGender,
    size: derived.size,
    armorClass: derived.armorClass,
    hitPoints: { average: derived.maxHp, diceNotation: derived.hitDice },
    speedFeet: derived.speedFeet,
    attacksPerAction: derived.attacksPerAction,
    actions: derived.attacks,
  };
}
