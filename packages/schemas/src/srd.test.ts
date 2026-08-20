// Roadmap step 5's exit criterion: every file in data/srd loads and validates.
// Reading the filesystem is fine here — this is a test, not package runtime.
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ClassDefinition,
  ConditionDefinition,
  Condition,
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

  it("rejects a skill proficiency that is not a real skill", () => {
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
