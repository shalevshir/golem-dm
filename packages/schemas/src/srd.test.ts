// Roadmap step 5's exit criterion: every file in data/srd loads and validates.
// Reading the filesystem is fine here — this is a test, not package runtime.
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ArmorDefinition,
  ClassDefinition,
  ConditionDefinition,
  Condition,
  CreatureStatBlock,
  MonsterStatBlock,
  Skill,
  SkillDefinition,
  WeaponDamage,
  WeaponDefinition,
} from "./index.js";

const SRD_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../../data/srd");
const MONSTER_DIR = join(SRD_DIR, "monsters");

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

const monsterFiles = readdirSync(MONSTER_DIR).filter((name) => name.endsWith(".json"));

describe("SRD monsters", () => {
  it("ships the POC roster", () => {
    expect(monsterFiles.length).toBeGreaterThanOrEqual(10);
  });

  it.each(monsterFiles)("%s parses as a MonsterStatBlock", (file) => {
    const parsed = MonsterStatBlock.parse(readJson(join(MONSTER_DIR, file)));
    // The filename is the id, so a roster can be loaded without opening each file.
    expect(`${parsed.monsterId}.json`).toBe(file);
  });

  it("gives every attack a way to measure distance", () => {
    for (const file of monsterFiles) {
      const parsed = MonsterStatBlock.parse(readJson(join(MONSTER_DIR, file)));
      for (const action of parsed.actions) {
        expect(action.reachFeet ?? action.rangeFeet).toBeDefined();
      }
    }
  });

  it("uses unique monster ids", () => {
    const ids = monsterFiles.map(
      (file) => MonsterStatBlock.parse(readJson(join(MONSTER_DIR, file))).monsterId,
    );
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("SRD conditions", () => {
  const parsed = ConditionDefinition.array().parse(readJson(join(SRD_DIR, "conditions.json")));

  it("covers every condition in the Condition enum", () => {
    expect(new Set(parsed.map((entry) => entry.condition))).toStrictEqual(
      new Set(Condition.options),
    );
  });

  it("records the Speed 0 rule on exactly the five conditions that state it", () => {
    const immobilising = parsed
      .filter((entry) => entry.effects.some((effect) => effect.nameEnglish === "Speed 0"))
      .map((entry) => entry.condition)
      .sort();
    expect(immobilising).toStrictEqual([
      "grappled",
      "paralyzed",
      "petrified",
      "restrained",
      "unconscious",
    ]);
  });
});

describe("SRD classes", () => {
  const parsed = ClassDefinition.array().parse(readJson(join(SRD_DIR, "classes.json")));

  it("covers the four POC classes", () => {
    expect(parsed.map((entry) => entry.class).sort()).toStrictEqual([
      "cleric",
      "fighter",
      "rogue",
      "wizard",
    ]);
  });

  it("gives the Fighter Extra Attack at level 5", () => {
    expect(parsed.find((entry) => entry.class === "fighter")?.extraAttackLevel).toBe(5);
  });

  it("gives spellcasters an ability and martials none", () => {
    const spellcasting = Object.fromEntries(
      parsed.map((entry) => [entry.class, entry.spellcastingAbility]),
    );
    expect(spellcasting).toStrictEqual({
      fighter: undefined,
      wizard: "int",
      rogue: undefined,
      cleric: "wis",
    });
  });

  it("gives each class its SRD weapon proficiencies and armor training", () => {
    const parsed = ClassDefinition.array().parse(readJson(join(SRD_DIR, "classes.json")));
    const byClass = new Map(parsed.map((each) => [each.class, each]));

    expect(byClass.get("fighter")?.weaponProficiencies.categories).toEqual(["simple", "martial"]);
    expect(byClass.get("fighter")?.armorTraining).toEqual(["light", "medium", "heavy", "shield"]);

    expect(byClass.get("wizard")?.weaponProficiencies.categories).toEqual(["simple"]);
    expect(byClass.get("wizard")?.armorTraining).toEqual([]);

    // "Simple weapons and Martial weapons that have the Finesse or Light
    // property" — the reason this is not a plain category list.
    expect(byClass.get("rogue")?.weaponProficiencies.categories).toEqual(["simple"]);
    expect(byClass.get("rogue")?.weaponProficiencies.martialWithProperties).toEqual([
      "finesse",
      "light",
    ]);
    expect(byClass.get("rogue")?.armorTraining).toEqual(["light"]);

    expect(byClass.get("cleric")?.weaponProficiencies.categories).toEqual(["simple"]);
    expect(byClass.get("cleric")?.armorTraining).toEqual(["light", "medium", "shield"]);
  });
});

describe("SRD skills", () => {
  it("maps all 18 skills to a governing ability", () => {
    const parsed = SkillDefinition.array().parse(readJson(join(SRD_DIR, "skills.json")));
    expect(parsed).toHaveLength(18);
    const byId = new Map(parsed.map((each) => [each.skill, each.ability]));
    expect(byId.get("athletics")).toBe("str");
    expect(byId.get("stealth")).toBe("dex");
    expect(byId.get("arcana")).toBe("int");
    expect(byId.get("perception")).toBe("wis");
    expect(byId.get("persuasion")).toBe("cha");
  });

  it("lists every Skill enum member exactly once", () => {
    const parsed = SkillDefinition.array().parse(readJson(join(SRD_DIR, "skills.json")));
    const ids = parsed.map((each) => each.skill).sort();
    expect(ids).toEqual([...Skill.options].sort());
  });

  it("rejects a value that is not a real skill", () => {
    expect(() => Skill.parse("banana")).toThrow();
  });
});

describe("SRD weapons", () => {
  const weapons = (): WeaponDefinition[] =>
    WeaponDefinition.array().parse(readJson(join(SRD_DIR, "weapons.json")));

  it("ships the whole weapon table", () => {
    expect(weapons()).toHaveLength(38);
  });

  it("uses unique weapon ids", () => {
    const ids = weapons().map((each) => each.weaponId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("gives the longsword its versatile die", () => {
    const longsword = weapons().find((each) => each.weaponId === "longsword");
    expect(longsword?.damage.diceNotation).toBe("1d8");
    expect(longsword?.versatileDamage?.diceNotation).toBe("1d10");
    expect(longsword?.properties).toEqual(["versatile"]);
  });

  // The blowgun is the table's only flat-damage weapon ("1 Piercing"), so it
  // is the row that proves `diceNotation` is genuinely optional.
  it("carries the blowgun as flat damage, not dice", () => {
    const blowgun = weapons().find((each) => each.weaponId === "blowgun");
    expect(blowgun?.damage.diceNotation).toBeUndefined();
    expect(blowgun?.damage.fixedDamage).toBe(1);
  });

  it("marks reach weapons so melee reach can be derived", () => {
    const reachIds = weapons()
      .filter((each) => each.properties.includes("reach"))
      .map((each) => each.weaponId)
      .sort();
    expect(reachIds).toEqual(["glaive", "halberd", "lance", "pike", "whip"]);
  });

  it("gives every ranged and thrown weapon both range bands", () => {
    for (const weapon of weapons()) {
      const ranged = weapon.kind === "ranged" || weapon.properties.includes("thrown");
      if (!ranged) continue;
      expect(weapon.rangeFeet, weapon.weaponId).toBeGreaterThan(0);
      expect(weapon.longRangeFeet, weapon.weaponId).toBeGreaterThan(0);
    }
  });

  it("names every weapon in Hebrew", () => {
    for (const weapon of weapons()) {
      expect(weapon.nameHebrew.trim(), weapon.weaponId).not.toBe("");
    }
  });

  it("rejects a weapon carrying both dice and flat damage", () => {
    expect(() =>
      WeaponDamage.parse({ diceNotation: "1d6", fixedDamage: 1, damageType: "piercing" }),
    ).toThrow();
  });
});

describe("SRD armor", () => {
  const armor = (): ArmorDefinition[] =>
    ArmorDefinition.array().parse(readJson(join(SRD_DIR, "armor.json")));

  it("ships the armor table including the shield", () => {
    expect(armor()).toHaveLength(13);
  });

  it("carries base AC on body armor and a bonus on the shield", () => {
    const byId = new Map(armor().map((each) => [each.armorId, each]));
    expect(byId.get("leather")?.baseAc).toBe(11);
    expect(byId.get("half_plate")?.baseAc).toBe(15);
    expect(byId.get("plate")?.baseAc).toBe(18);
    expect(byId.get("shield")?.acBonus).toBe(2);
    expect(byId.get("shield")?.baseAc).toBeUndefined();
  });

  it("records the Strength requirements that cost speed", () => {
    const byId = new Map(armor().map((each) => [each.armorId, each]));
    expect(byId.get("chain_mail")?.strengthRequirement).toBe(13);
    expect(byId.get("splint")?.strengthRequirement).toBe(15);
    expect(byId.get("plate")?.strengthRequirement).toBe(15);
    expect(byId.get("leather")?.strengthRequirement).toBeUndefined();
  });

  it("rejects body armor that carries a shield's acBonus", () => {
    expect(() =>
      ArmorDefinition.parse({
        armorId: "bad",
        nameEnglish: "Bad",
        nameHebrew: "רע",
        category: "light",
        baseAc: 11,
        acBonus: 2,
      }),
    ).toThrow();
  });

  it("rejects a shield that carries no acBonus", () => {
    expect(() =>
      ArmorDefinition.parse({
        armorId: "bad_shield",
        nameEnglish: "Bad Shield",
        nameHebrew: "מגן רע",
        category: "shield",
      }),
    ).toThrow();
  });

  it("names every armor in Hebrew", () => {
    for (const each of armor()) {
      expect(each.nameHebrew.trim(), each.armorId).not.toBe("");
    }
  });
});

const MINIMAL_STAT_BLOCK = {
  nameEnglish: "Test Creature",
  nameHebrew: "יצור בדיקה",
  grammaticalGender: "masculine",
  size: "medium",
  armorClass: 10,
  hitPoints: { average: 4, diceNotation: "1d8" },
  speedFeet: 30,
  actions: [
    {
      actionId: "test_attack",
      nameEnglish: "Test Attack",
      nameHebrew: "התקפת בדיקה",
      attackBonus: 2,
      reachFeet: 5,
      damage: { averageDamage: 3, damageType: "bludgeoning" },
    },
  ],
};

describe("CreatureStatBlock", () => {
  it("names every monster and every attack in Hebrew", () => {
    for (const file of monsterFiles) {
      const parsed = MonsterStatBlock.parse(readJson(join(MONSTER_DIR, file)));
      expect(parsed.nameHebrew.trim(), file).not.toBe("");
      for (const action of parsed.actions) {
        expect(action.nameHebrew.trim(), `${file}:${action.actionId}`).not.toBe("");
      }
    }
  });

  // The widening's whole promise: a monster IS a creature, so anything the
  // engine accepts as a CreatureStatBlock accepts a parsed monster unchanged.
  it("accepts a parsed monster as a CreatureStatBlock", () => {
    const guard = readJson(join(MONSTER_DIR, "guard.json"));
    const creature = CreatureStatBlock.parse(guard);
    expect(creature.nameEnglish).toBe("Guard");
    expect(creature.actions).toHaveLength(1);
  });

  it("keeps monster-only fields off the creature supertype", () => {
    const creature = CreatureStatBlock.parse(readJson(join(MONSTER_DIR, "guard.json")));
    expect("challengeRating" in creature).toBe(false);
  });

  it("requires a grammaticalGender on every creature stat block", () => {
    const { grammaticalGender, ...withoutGender } = MINIMAL_STAT_BLOCK;
    expect(grammaticalGender).toBe("masculine");
    expect(() => CreatureStatBlock.parse(withoutGender)).toThrow();
  });

  it("rejects a grammatical gender outside the enum", () => {
    expect(() =>
      CreatureStatBlock.parse({ ...MINIMAL_STAT_BLOCK, grammaticalGender: "neuter" }),
    ).toThrow();
  });
});
