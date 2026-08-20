// Loads a player character and derives it. The cross-check runs HERE, where
// the SRD data is in hand: zod cannot compare a stored armorClass against a
// derived one without weapons, armor and classes loaded, and
// `@ai-dm/schemas` deliberately loads none of them.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CharacterSheet } from "@ai-dm/schemas";
import type { DerivedCharacter } from "@ai-dm/schemas";
import { assertSheetConsistent, deriveCharacter } from "@ai-dm/rules-engine";
import { dataDir } from "./srd.js";
import { loadGear } from "./gear.js";

const CHARACTER_DIR_RELATIVE = join("data", "characters");

const cache = new Map<string, DerivedCharacter>();

export function loadCharacter(characterId: string): DerivedCharacter {
  const hit = cache.get(characterId);
  if (hit !== undefined) return hit;

  const path = join(dataDir(CHARACTER_DIR_RELATIVE), `${characterId}.json`);
  const sheet = CharacterSheet.parse(JSON.parse(readFileSync(path, "utf8")));

  const gear = loadGear();
  const derived = deriveCharacter(sheet, gear);

  const classDefinition = gear.classes.get(sheet.class);
  if (classDefinition === undefined) throw new Error(`No class definition for ${sheet.class}`);
  assertSheetConsistent(sheet, derived, classDefinition);

  cache.set(characterId, derived);
  return derived;
}
