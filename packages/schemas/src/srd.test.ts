// Roadmap step 5's exit criterion: every file in data/srd loads and validates.
// Reading the filesystem is fine here — this is a test, not package runtime.
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { ClassDefinition, ConditionDefinition, Condition, MonsterStatBlock } from "./index.js";

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
