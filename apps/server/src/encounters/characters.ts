// Loads a player character and derives it. The cross-check runs HERE, where
// the SRD data is in hand: zod cannot compare a stored armorClass against a
// derived one without weapons, armor and classes loaded, and
// `@ai-dm/schemas` deliberately loads none of them.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CharacterSheet, DerivedCharacter } from "@ai-dm/schemas";
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
  // A file filed under the wrong name would otherwise be cached under
  // `characterId` while the derived character (and its `nameEnglish`) still
  // carries the sheet's own id — a mismatch the client's lookup-by-id would
  // silently fail on, rather than a load-time error naming the file.
  if (sheet.characterId !== characterId) {
    throw new Error(
      `${path} is filed as ${characterId} but its characterId is ${sheet.characterId}`,
    );
  }

  const gear = loadGear();
  const derived = deriveCharacter(sheet, gear);

  const classDefinition = gear.classes.get(sheet.class);
  if (classDefinition === undefined) throw new Error(`No class definition for ${sheet.class}`);
  assertSheetConsistent(sheet, derived, classDefinition);

  // Parsed at this server boundary rather than left to the first validator
  // downstream (`apps/web`'s `net/api.ts`): a schema-invalid derivation
  // should fail loudly here, at session creation, not as an opaque
  // client-side catalogue rejection.
  const parsed = DerivedCharacter.parse(derived);
  cache.set(characterId, parsed);
  return parsed;
}
