// Reads the four SRD data files the character derivation needs. File I/O
// lives here, never in `@ai-dm/rules-engine`, which must stay pure and
// bundleable — same split as `srd.ts` and its monsters.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ArmorDefinition,
  ClassDefinition,
  SkillDefinition,
  WeaponDefinition,
} from "@ai-dm/schemas";
import type { SrdGear } from "@ai-dm/rules-engine";
import { dataDir } from "./srd.js";

const SRD_DIR_RELATIVE = join("data", "srd");

function readJson(dir: string, file: string): unknown {
  return JSON.parse(readFileSync(join(dir, file), "utf8"));
}

// Parsed once. The files never change at runtime, and re-parsing them per
// campaign would be pure waste.
let cached: SrdGear | undefined;

export function loadGear(): SrdGear {
  if (cached !== undefined) return cached;

  const dir = dataDir(SRD_DIR_RELATIVE);
  const weapons = WeaponDefinition.array().parse(readJson(dir, "weapons.json"));
  const armor = ArmorDefinition.array().parse(readJson(dir, "armor.json"));
  const classes = ClassDefinition.array().parse(readJson(dir, "classes.json"));
  const skills = SkillDefinition.array().parse(readJson(dir, "skills.json"));

  cached = {
    weapons: new Map(weapons.map((each) => [each.weaponId, each])),
    armor: new Map(armor.map((each) => [each.armorId, each])),
    classes: new Map(classes.map((each) => [each.class, each])),
    skills: new Map(skills.map((each) => [each.skill, each])),
  };
  return cached;
}
