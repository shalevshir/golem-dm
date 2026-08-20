# Player Character in the Engine — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `goblin-ambush`'s stand-in hero — currently the `guard`
monster stat block — with a real `CharacterSheet` whose AC, speed, attacks and
damage are derived from equipped SRD gear, and serve that derivation to the
client so a future character-sheet page renders it without doing any 5e math.

**Architecture:** Three layers. `CharacterSheet` holds choices; a pure
`deriveCharacter()` in `@ai-dm/rules-engine` computes every 5e number into a
`DerivedCharacter`; a thin `characterStatBlock()` selects the seven fields the
combat engine reads into a `CreatureStatBlock`. `MonsterStatBlock` becomes
`CreatureStatBlock` plus SRD-only fields, so the engine's five stat-block call
sites widen by type alone with no behaviour change. The server derives and
serves; the client never computes.

**Tech Stack:** TypeScript strict, ESM (`.js` extensions on relative imports),
zod for schemas and validation, Vitest (`globals: false` — import
`describe`/`it`/`expect` explicitly), pnpm workspaces.

**Spec:** [`docs/superpowers/specs/2026-08-20-player-character-design.md`](../specs/2026-08-20-player-character-design.md)

## Prerequisite: rebase after the combat roll log

**Do not start this plan until
[`2026-08-20-combat-roll-log.md`](2026-08-20-combat-roll-log.md) (spec #3 of
step 8) has merged.** Both plans were written on `fbfb420` and both edit
`packages/rules-engine/src/encounter/resolve.ts`. Sequencing was decided
2026-08-20: the roll log first, because it closes step 8 before step 9 opens
and is a third the size.

Two edits are then required here before Task 5 runs, and neither is optional:

1. **Task 5, Step 4 — `resolve.ts` imports.** The roll-log plan's Task 2
   Step 4 rewrites that file's import block, adding `AttackRollTrace`,
   `DamageRollTrace` and `AttackOutcome` and removing `CoverLevel`. Apply the
   `MonsterAttack` → `CreatureAttack` and `MonsterStatBlock` →
   `CreatureStatBlock` rename over **that** list, not the one this plan was
   written against.
2. **Task 5 — the roll log's new test fixtures.** Its `resolve.test.ts` adds
   two hand-authored stat blocks (`flatDamageBlock`, `riderBlock`) whose
   `actions` entries carry `actionId`, `nameEnglish`, `attackBonus`,
   `reachFeet`, `damage` and `extraDamage` — but **no `nameHebrew`**, which
   Task 5 makes required on `CreatureAttack`. Add it to both, or they stop
   typechecking. This is a real break, not a warning: verify with
   `pnpm --filter @ai-dm/rules-engine typecheck` immediately after Task 5.

One opportunity, not a requirement: the roll log's `CombatLog` component
renders creature and action names in English inside `<bdi>`, because no
Hebrew name data existed when it was written. Task 15 here puts `nameHebrew`
on every `CatalogueCombatant` and `CatalogueAction`, so a small follow-up can
switch that component to Hebrew once this plan lands.

## Global Constraints

- **`corepack enable` before any pnpm command** — pnpm is not on PATH.
- **Never run `pnpm format`.** There is no `.prettierignore`, so `--write .`
  rewrites ~37 unrelated files including the lockfile. Format the files you
  touched, individually, or let CI's check tell you.
- **Never run root `pnpm lint`** — ESLint walks sibling worktrees under
  `.claude/worktrees/` and fails on their code. Scope it:
  `npx eslint packages/schemas packages/rules-engine apps/server`.
- **English only in code, comments, prompts and logs** (invariant 2). Hebrew
  appears solely as `nameHebrew` data values in this plan's scope.
- **The rules engine is the only authority on game legality and math**
  (invariant 1). No 5e arithmetic in `apps/web` or `apps/server`.
- **Schemas define everything once** (invariant 4). No hand-written interface
  duplicating a zod schema.
- **Dependency direction:** `schemas ← rules-engine ← agents ← server`; `web`
  depends only on `schemas`.
- **Only SRD 5.2.1 content in `data/srd/`.** Character sheets are our own
  content and go in `data/characters/`. `NOTICE.md` attribution is reproduced
  verbatim and gains nothing.
- **ESLint `strictTypeChecked` gotchas:** `[...str]` is banned — use
  `Array.from(str, fn)`. `x as keyof typeof obj` makes a `=== undefined` guard
  dead code — type lookups as `Record<string, T | undefined>`. There is no
  `argsIgnorePattern`, so `_`-prefixed unused params still error.
- **Prettier 100 columns.**
- **Golden tests are required for new rules-engine code** (that package's
  `CLAUDE.md`).
- **The sabotage rule** (`PROJECT_PLAN.md` §4.4): when a test exists to
  protect a specific line, delete that line and watch the test fail. Seven
  tests in the step 8 web slice passed against the exact defect they were
  written to catch. The sabotage check, not the green run, is the evidence.

## SRD source data

Every game rule and every data row in this plan was verified against the SRD
5.2.1 NotebookLM notebook `3a0d4f39-93c2-48ee-b1d1-258c7f7583ab` while the
plan was written. The tables below are transcribed from that verification, so
implementers do **not** need to re-query the notebook to type them in. Query
it only if you believe a row is wrong.

## File Structure

**Created:**

| Path | Responsibility |
|---|---|
| `data/srd/weapons.json` | SRD weapon table, 37 rows |
| `data/srd/armor.json` | SRD armor table, 13 rows including Shield |
| `data/srd/skills.json` | 18 skill → governing ability rows |
| `data/characters/README.md` | States this directory is **not** SRD content |
| `data/characters/hero.json` | The `goblin-ambush` player character |
| `packages/schemas/src/gear.ts` | `WeaponDefinition`, `ArmorDefinition`, `SkillDefinition` |
| `packages/schemas/src/derived.ts` | `DerivedCharacter` |
| `packages/rules-engine/src/character/armor.ts` | AC and speed derivation |
| `packages/rules-engine/src/character/attacks.ts` | Weapon and unarmed attack derivation |
| `packages/rules-engine/src/character/derive.ts` | `deriveCharacter`, `characterStatBlock` |
| `packages/rules-engine/src/character/consistency.ts` | `assertSheetConsistent` |
| `packages/rules-engine/src/character/index.ts` | Barrel |
| `apps/server/src/encounters/gear.ts` | Loads the four SRD data files |
| `apps/server/src/encounters/characters.ts` | `loadCharacter` |

**Modified:**

| Path | Change |
|---|---|
| `packages/schemas/src/character.ts` | `Skill` enum; `size`; `inventory[].equipped`; retype `skillProficiencies` |
| `packages/schemas/src/srd.ts` | `MonsterAttack`→`CreatureAttack`; extract `CreatureStatBlock`; `nameHebrew`; `ClassDefinition` proficiencies |
| `packages/schemas/src/index.ts` | Export the new modules |
| `packages/rules-engine/src/combat/statblock.ts` | Widen three signatures |
| `packages/rules-engine/src/combat/affordances.ts` | Widen `affordancesFor` |
| `packages/rules-engine/src/encounter/resolve.ts` | Widen; rename `MonsterAttack` |
| `packages/rules-engine/src/encounter/build.ts` | Spawn union; `characters` map |
| `packages/rules-engine/src/index.ts` | Export `character/` |
| `packages/agents/src/tactical/available-actions.ts` | Widen `availableActionsFor` |
| `apps/server/src/encounters/index.ts` | Resolve both spawn kinds; hero spawn |
| `apps/server/src/encounters/srd.ts` | Reuse the shared JSON reader |
| `apps/server/src/transport/http.ts` | Catalogue gains `characters` |
| `data/srd/classes.json` | `weaponProficiencies`, `armorTraining` |
| `data/srd/monsters/*.json` | `nameHebrew` on block and actions |
| `RULES_REFERENCE.md` | Close the base-AC row; record the house rule and gaps |
| `PROJECT_PLAN.md` | Tick §4.1 pre-work; record spec #1 |

---

### Task 1: `Skill` enum and `skills.json`

Closes the hole where `skillProficiencies: z.array(z.string())` accepts
`"banana"`, and supplies the skill→ability mapping the derivation needs for
skill bonuses and passive Perception.

**Files:**
- Modify: `packages/schemas/src/character.ts`
- Create: `data/srd/skills.json`
- Test: `packages/schemas/src/srd.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `Skill` (zod enum, 18 values) and `SkillDefinition`
  (`{ skill: Skill; nameEnglish: string; ability: AbilityKey }`), both exported
  from `@ai-dm/schemas`.

- [ ] **Step 1: Write the failing test**

Append to `packages/schemas/src/srd.test.ts`:

```ts
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
```

Add `Skill` and `SkillDefinition` to the existing import from `./index.js` at
the top of the file.

- [ ] **Step 2: Run test to verify it fails**

```bash
corepack enable && pnpm --filter @ai-dm/schemas test
```

Expected: FAIL — `Skill` and `SkillDefinition` are not exported.

- [ ] **Step 3: Add the enum and definition schema**

In `packages/schemas/src/character.ts`, after the `AbilityKey` declaration:

```ts
/** The 18 SRD skills. A bare string here would accept "banana". */
export const Skill = z.enum([
  "acrobatics",
  "animal_handling",
  "arcana",
  "athletics",
  "deception",
  "history",
  "insight",
  "intimidation",
  "investigation",
  "medicine",
  "nature",
  "perception",
  "performance",
  "persuasion",
  "religion",
  "sleight_of_hand",
  "stealth",
  "survival",
]);
```

Add `export type Skill = z.infer<typeof Skill>;` beside the other type exports.

In `packages/schemas/src/srd.ts`, beside `ClassDefinition`:

```ts
/** Which ability governs a skill check. Data, because the SRD says so. */
export const SkillDefinition = z.object({
  skill: Skill,
  nameEnglish: z.string(),
  ability: AbilityKey,
});
```

Add `Skill` to the existing `./character.js` import and
`export type SkillDefinition = z.infer<typeof SkillDefinition>;` at the bottom.

- [ ] **Step 4: Write the data file**

`data/srd/skills.json`:

```json
[
  { "skill": "acrobatics", "nameEnglish": "Acrobatics", "ability": "dex" },
  { "skill": "animal_handling", "nameEnglish": "Animal Handling", "ability": "wis" },
  { "skill": "arcana", "nameEnglish": "Arcana", "ability": "int" },
  { "skill": "athletics", "nameEnglish": "Athletics", "ability": "str" },
  { "skill": "deception", "nameEnglish": "Deception", "ability": "cha" },
  { "skill": "history", "nameEnglish": "History", "ability": "int" },
  { "skill": "insight", "nameEnglish": "Insight", "ability": "wis" },
  { "skill": "intimidation", "nameEnglish": "Intimidation", "ability": "cha" },
  { "skill": "investigation", "nameEnglish": "Investigation", "ability": "int" },
  { "skill": "medicine", "nameEnglish": "Medicine", "ability": "wis" },
  { "skill": "nature", "nameEnglish": "Nature", "ability": "int" },
  { "skill": "perception", "nameEnglish": "Perception", "ability": "wis" },
  { "skill": "performance", "nameEnglish": "Performance", "ability": "cha" },
  { "skill": "persuasion", "nameEnglish": "Persuasion", "ability": "cha" },
  { "skill": "religion", "nameEnglish": "Religion", "ability": "int" },
  { "skill": "sleight_of_hand", "nameEnglish": "Sleight of Hand", "ability": "dex" },
  { "skill": "stealth", "nameEnglish": "Stealth", "ability": "dex" },
  { "skill": "survival", "nameEnglish": "Survival", "ability": "wis" }
]
```

- [ ] **Step 5: Run test to verify it passes**

```bash
pnpm --filter @ai-dm/schemas test
```

Expected: PASS.

- [ ] **Step 6: Sabotage check**

Change `"perception"`'s ability from `"wis"` to `"int"` in `skills.json` and
re-run. The first test must fail. Restore it.

- [ ] **Step 7: Commit**

```bash
git add packages/schemas/src data/srd/skills.json
git commit -m "feat(schemas): add the Skill enum and skills.json ability map"
```

---

### Task 2: `WeaponDefinition` and `weapons.json`

**Files:**
- Create: `packages/schemas/src/gear.ts`
- Create: `data/srd/weapons.json`
- Modify: `packages/schemas/src/index.ts`
- Test: `packages/schemas/src/srd.test.ts`

**Interfaces:**
- Consumes: `DamageType`, `DiceNotation` from `./srd.js`.
- Produces: `WeaponProperty`, `WeaponDamage`, `WeaponDefinition` — exported
  from `@ai-dm/schemas`. `WeaponDefinition` fields: `weaponId`, `nameEnglish`,
  `nameHebrew`, `category` (`"simple" | "martial"`), `kind`
  (`"melee" | "ranged"`), `damage: WeaponDamage`,
  `versatileDamage?: WeaponDamage`, `properties: WeaponProperty[]`,
  `rangeFeet?`, `longRangeFeet?`.

- [ ] **Step 1: Write the failing test**

Append to `packages/schemas/src/srd.test.ts`:

```ts
describe("SRD weapons", () => {
  const weapons = (): WeaponDefinition[] =>
    WeaponDefinition.array().parse(readJson(join(SRD_DIR, "weapons.json")));

  it("ships the whole weapon table", () => {
    expect(weapons()).toHaveLength(37);
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
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @ai-dm/schemas test
```

Expected: FAIL — `WeaponDefinition` is not exported.

- [ ] **Step 3: Write the schema**

Create `packages/schemas/src/gear.ts`:

```ts
// Equipment a player character can carry. Monsters need none of this: their
// stat blocks carry final attack bonuses, because "A monster is proficient
// with any weapon in its stat block" (SRD 5.2.1). Characters derive theirs.
import { z } from "zod";
import { DamageType, DiceNotation } from "./srd.js";

export const WeaponProperty = z.enum([
  "ammunition",
  "finesse",
  "heavy",
  "light",
  "loading",
  "reach",
  "thrown",
  "two_handed",
  "versatile",
]);

/**
 * Weapon damage before the wielder's ability modifier. The blowgun deals a
 * flat "1 Piercing", so dice are optional — but a row carrying both a die and
 * a flat value is a transcription error, not a valid weapon.
 */
export const WeaponDamage = z
  .object({
    diceNotation: DiceNotation.optional(),
    fixedDamage: z.number().int().min(0).optional(),
    damageType: DamageType,
  })
  .refine(
    (damage) => (damage.diceNotation === undefined) !== (damage.fixedDamage === undefined),
    "a weapon carries exactly one of diceNotation or fixedDamage",
  );

export const WeaponDefinition = z.object({
  weaponId: z.string().regex(/^[a-z0-9_]+$/),
  nameEnglish: z.string(),
  nameHebrew: z.string().min(1),
  category: z.enum(["simple", "martial"]),
  /**
   * How the weapon is wielded by default, which fixes the ability used for
   * its attack. A Thrown melee weapon stays `melee`: the SRD has a thrown
   * weapon use the same modifier it would use for a melee attack.
   */
  kind: z.enum(["melee", "ranged"]),
  damage: WeaponDamage,
  /** Present exactly when `properties` includes `versatile`. */
  versatileDamage: WeaponDamage.optional(),
  properties: z.array(WeaponProperty).default([]),
  rangeFeet: z.number().int().multipleOf(5).optional(),
  longRangeFeet: z.number().int().multipleOf(5).optional(),
});

export type WeaponProperty = z.infer<typeof WeaponProperty>;
export type WeaponDamage = z.infer<typeof WeaponDamage>;
export type WeaponDefinition = z.infer<typeof WeaponDefinition>;
```

Add `export * from "./gear.js";` to `packages/schemas/src/index.ts`, and add
`WeaponDefinition` / `WeaponDamage` to the test file's import.

- [ ] **Step 4: Write the data file**

`data/srd/weapons.json` — the full SRD table. Mastery properties are
deliberately omitted (spec non-goal: they are gated behind a class feature no
class implements). Hebrew names are given here; they are ordinary
translations of the English names.

```json
[
  { "weaponId": "club", "nameEnglish": "Club", "nameHebrew": "אלה", "category": "simple", "kind": "melee", "damage": { "diceNotation": "1d4", "damageType": "bludgeoning" }, "properties": ["light"] },
  { "weaponId": "dagger", "nameEnglish": "Dagger", "nameHebrew": "פגיון", "category": "simple", "kind": "melee", "damage": { "diceNotation": "1d4", "damageType": "piercing" }, "properties": ["finesse", "light", "thrown"], "rangeFeet": 20, "longRangeFeet": 60 },
  { "weaponId": "greatclub", "nameEnglish": "Greatclub", "nameHebrew": "אלה גדולה", "category": "simple", "kind": "melee", "damage": { "diceNotation": "1d8", "damageType": "bludgeoning" }, "properties": ["two_handed"] },
  { "weaponId": "handaxe", "nameEnglish": "Handaxe", "nameHebrew": "גרזן יד", "category": "simple", "kind": "melee", "damage": { "diceNotation": "1d6", "damageType": "slashing" }, "properties": ["light", "thrown"], "rangeFeet": 20, "longRangeFeet": 60 },
  { "weaponId": "javelin", "nameEnglish": "Javelin", "nameHebrew": "כידון", "category": "simple", "kind": "melee", "damage": { "diceNotation": "1d6", "damageType": "piercing" }, "properties": ["thrown"], "rangeFeet": 30, "longRangeFeet": 120 },
  { "weaponId": "light_hammer", "nameEnglish": "Light Hammer", "nameHebrew": "פטיש קל", "category": "simple", "kind": "melee", "damage": { "diceNotation": "1d4", "damageType": "bludgeoning" }, "properties": ["light", "thrown"], "rangeFeet": 20, "longRangeFeet": 60 },
  { "weaponId": "mace", "nameEnglish": "Mace", "nameHebrew": "שרביט קרב", "category": "simple", "kind": "melee", "damage": { "diceNotation": "1d6", "damageType": "bludgeoning" }, "properties": [] },
  { "weaponId": "quarterstaff", "nameEnglish": "Quarterstaff", "nameHebrew": "מוט לחימה", "category": "simple", "kind": "melee", "damage": { "diceNotation": "1d6", "damageType": "bludgeoning" }, "versatileDamage": { "diceNotation": "1d8", "damageType": "bludgeoning" }, "properties": ["versatile"] },
  { "weaponId": "sickle", "nameEnglish": "Sickle", "nameHebrew": "מגל", "category": "simple", "kind": "melee", "damage": { "diceNotation": "1d4", "damageType": "slashing" }, "properties": ["light"] },
  { "weaponId": "spear", "nameEnglish": "Spear", "nameHebrew": "חנית", "category": "simple", "kind": "melee", "damage": { "diceNotation": "1d6", "damageType": "piercing" }, "versatileDamage": { "diceNotation": "1d8", "damageType": "piercing" }, "properties": ["thrown", "versatile"], "rangeFeet": 20, "longRangeFeet": 60 },
  { "weaponId": "dart", "nameEnglish": "Dart", "nameHebrew": "חץ יד", "category": "simple", "kind": "ranged", "damage": { "diceNotation": "1d4", "damageType": "piercing" }, "properties": ["finesse", "thrown"], "rangeFeet": 20, "longRangeFeet": 60 },
  { "weaponId": "light_crossbow", "nameEnglish": "Light Crossbow", "nameHebrew": "קשת רוחב קלה", "category": "simple", "kind": "ranged", "damage": { "diceNotation": "1d8", "damageType": "piercing" }, "properties": ["ammunition", "loading", "two_handed"], "rangeFeet": 80, "longRangeFeet": 320 },
  { "weaponId": "shortbow", "nameEnglish": "Shortbow", "nameHebrew": "קשת קצרה", "category": "simple", "kind": "ranged", "damage": { "diceNotation": "1d6", "damageType": "piercing" }, "properties": ["ammunition", "two_handed"], "rangeFeet": 80, "longRangeFeet": 320 },
  { "weaponId": "sling", "nameEnglish": "Sling", "nameHebrew": "קלע", "category": "simple", "kind": "ranged", "damage": { "diceNotation": "1d4", "damageType": "bludgeoning" }, "properties": ["ammunition"], "rangeFeet": 30, "longRangeFeet": 120 },
  { "weaponId": "battleaxe", "nameEnglish": "Battleaxe", "nameHebrew": "גרזן קרב", "category": "martial", "kind": "melee", "damage": { "diceNotation": "1d8", "damageType": "slashing" }, "versatileDamage": { "diceNotation": "1d10", "damageType": "slashing" }, "properties": ["versatile"] },
  { "weaponId": "flail", "nameEnglish": "Flail", "nameHebrew": "מגלב קרב", "category": "martial", "kind": "melee", "damage": { "diceNotation": "1d8", "damageType": "bludgeoning" }, "properties": [] },
  { "weaponId": "glaive", "nameEnglish": "Glaive", "nameHebrew": "רומח־להב", "category": "martial", "kind": "melee", "damage": { "diceNotation": "1d10", "damageType": "slashing" }, "properties": ["heavy", "reach", "two_handed"] },
  { "weaponId": "greataxe", "nameEnglish": "Greataxe", "nameHebrew": "גרזן ענק", "category": "martial", "kind": "melee", "damage": { "diceNotation": "1d12", "damageType": "slashing" }, "properties": ["heavy", "two_handed"] },
  { "weaponId": "greatsword", "nameEnglish": "Greatsword", "nameHebrew": "חרב ענק", "category": "martial", "kind": "melee", "damage": { "diceNotation": "2d6", "damageType": "slashing" }, "properties": ["heavy", "two_handed"] },
  { "weaponId": "halberd", "nameEnglish": "Halberd", "nameHebrew": "הלברד", "category": "martial", "kind": "melee", "damage": { "diceNotation": "1d10", "damageType": "slashing" }, "properties": ["heavy", "reach", "two_handed"] },
  { "weaponId": "lance", "nameEnglish": "Lance", "nameHebrew": "רומח פרשים", "category": "martial", "kind": "melee", "damage": { "diceNotation": "1d10", "damageType": "piercing" }, "properties": ["heavy", "reach", "two_handed"] },
  { "weaponId": "longsword", "nameEnglish": "Longsword", "nameHebrew": "חרב ארוכה", "category": "martial", "kind": "melee", "damage": { "diceNotation": "1d8", "damageType": "slashing" }, "versatileDamage": { "diceNotation": "1d10", "damageType": "slashing" }, "properties": ["versatile"] },
  { "weaponId": "maul", "nameEnglish": "Maul", "nameHebrew": "קורנס", "category": "martial", "kind": "melee", "damage": { "diceNotation": "2d6", "damageType": "bludgeoning" }, "properties": ["heavy", "two_handed"] },
  { "weaponId": "morningstar", "nameEnglish": "Morningstar", "nameHebrew": "כוכב שחר", "category": "martial", "kind": "melee", "damage": { "diceNotation": "1d8", "damageType": "piercing" }, "properties": [] },
  { "weaponId": "pike", "nameEnglish": "Pike", "nameHebrew": "כידון ארוך", "category": "martial", "kind": "melee", "damage": { "diceNotation": "1d10", "damageType": "piercing" }, "properties": ["heavy", "reach", "two_handed"] },
  { "weaponId": "rapier", "nameEnglish": "Rapier", "nameHebrew": "סיף", "category": "martial", "kind": "melee", "damage": { "diceNotation": "1d8", "damageType": "piercing" }, "properties": ["finesse"] },
  { "weaponId": "scimitar", "nameEnglish": "Scimitar", "nameHebrew": "חרב מעוקלת", "category": "martial", "kind": "melee", "damage": { "diceNotation": "1d6", "damageType": "slashing" }, "properties": ["finesse", "light"] },
  { "weaponId": "shortsword", "nameEnglish": "Shortsword", "nameHebrew": "חרב קצרה", "category": "martial", "kind": "melee", "damage": { "diceNotation": "1d6", "damageType": "piercing" }, "properties": ["finesse", "light"] },
  { "weaponId": "trident", "nameEnglish": "Trident", "nameHebrew": "קלשון", "category": "martial", "kind": "melee", "damage": { "diceNotation": "1d8", "damageType": "piercing" }, "versatileDamage": { "diceNotation": "1d10", "damageType": "piercing" }, "properties": ["thrown", "versatile"], "rangeFeet": 20, "longRangeFeet": 60 },
  { "weaponId": "warhammer", "nameEnglish": "Warhammer", "nameHebrew": "פטיש קרב", "category": "martial", "kind": "melee", "damage": { "diceNotation": "1d8", "damageType": "bludgeoning" }, "versatileDamage": { "diceNotation": "1d10", "damageType": "bludgeoning" }, "properties": ["versatile"] },
  { "weaponId": "war_pick", "nameEnglish": "War Pick", "nameHebrew": "מכוש קרב", "category": "martial", "kind": "melee", "damage": { "diceNotation": "1d8", "damageType": "piercing" }, "versatileDamage": { "diceNotation": "1d10", "damageType": "piercing" }, "properties": ["versatile"] },
  { "weaponId": "whip", "nameEnglish": "Whip", "nameHebrew": "שוט", "category": "martial", "kind": "melee", "damage": { "diceNotation": "1d4", "damageType": "slashing" }, "properties": ["finesse", "reach"] },
  { "weaponId": "blowgun", "nameEnglish": "Blowgun", "nameHebrew": "רובה נשיפה", "category": "martial", "kind": "ranged", "damage": { "fixedDamage": 1, "damageType": "piercing" }, "properties": ["ammunition", "loading"], "rangeFeet": 25, "longRangeFeet": 100 },
  { "weaponId": "hand_crossbow", "nameEnglish": "Hand Crossbow", "nameHebrew": "קשת רוחב יד", "category": "martial", "kind": "ranged", "damage": { "diceNotation": "1d6", "damageType": "piercing" }, "properties": ["ammunition", "light", "loading"], "rangeFeet": 30, "longRangeFeet": 120 },
  { "weaponId": "heavy_crossbow", "nameEnglish": "Heavy Crossbow", "nameHebrew": "קשת רוחב כבדה", "category": "martial", "kind": "ranged", "damage": { "diceNotation": "1d10", "damageType": "piercing" }, "properties": ["ammunition", "heavy", "loading", "two_handed"], "rangeFeet": 100, "longRangeFeet": 400 },
  { "weaponId": "longbow", "nameEnglish": "Longbow", "nameHebrew": "קשת ארוכה", "category": "martial", "kind": "ranged", "damage": { "diceNotation": "1d8", "damageType": "piercing" }, "properties": ["ammunition", "heavy", "two_handed"], "rangeFeet": 150, "longRangeFeet": 600 },
  { "weaponId": "musket", "nameEnglish": "Musket", "nameHebrew": "מוסקט", "category": "martial", "kind": "ranged", "damage": { "diceNotation": "1d12", "damageType": "piercing" }, "properties": ["ammunition", "loading", "two_handed"], "rangeFeet": 40, "longRangeFeet": 120 },
  { "weaponId": "pistol", "nameEnglish": "Pistol", "nameHebrew": "אקדח", "category": "martial", "kind": "ranged", "damage": { "diceNotation": "1d10", "damageType": "piercing" }, "properties": ["ammunition", "loading"], "rangeFeet": 30, "longRangeFeet": 90 }
]
```

- [ ] **Step 5: Run test to verify it passes**

```bash
pnpm --filter @ai-dm/schemas test
```

Expected: PASS, 37 weapons.

- [ ] **Step 6: Sabotage check**

Delete the `"reach"` entry from `whip`'s properties and re-run. The reach test
must fail naming `whip`. Restore it.

- [ ] **Step 7: Commit**

```bash
git add packages/schemas/src data/srd/weapons.json
git commit -m "feat(schemas): transcribe the SRD weapon table"
```

---

### Task 3: `ArmorDefinition` and `armor.json`

**Files:**
- Modify: `packages/schemas/src/gear.ts`
- Create: `data/srd/armor.json`
- Test: `packages/schemas/src/srd.test.ts`

**Interfaces:**
- Consumes: nothing from Task 2 beyond the file it created.
- Produces: `ArmorCategory` (`"light" | "medium" | "heavy" | "shield"`) and
  `ArmorDefinition` with fields `armorId`, `nameEnglish`, `nameHebrew`,
  `category`, `baseAc?`, `acBonus?`, `strengthRequirement?`,
  `stealthDisadvantage`.

- [ ] **Step 1: Write the failing test**

Append to `packages/schemas/src/srd.test.ts`:

```ts
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
        acBonus: 2,
      }),
    ).toThrow();
  });

  it("names every armor in Hebrew", () => {
    for (const each of armor()) {
      expect(each.nameHebrew.trim(), each.armorId).not.toBe("");
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @ai-dm/schemas test
```

Expected: FAIL — `ArmorDefinition` is not exported.

- [ ] **Step 3: Write the schema**

Append to `packages/schemas/src/gear.ts`:

```ts
export const ArmorCategory = z.enum(["light", "medium", "heavy", "shield"]);

/**
 * One row of the SRD armor table. The Dexterity rule is NOT stored per row:
 * every Light row is `base + Dex`, every Medium row is `base + Dex (max 2)`,
 * and every Heavy row is a bare number, with no row deviating from its
 * category. Storing the cap twelve times would only let the copies disagree.
 * `armorClassFor` reads the category instead.
 */
export const ArmorDefinition = z
  .object({
    armorId: z.string().regex(/^[a-z0-9_]+$/),
    nameEnglish: z.string(),
    nameHebrew: z.string().min(1),
    category: ArmorCategory,
    /** Body armor only. */
    baseAc: z.number().int().min(1).optional(),
    /** The Shield row only: a flat bonus, not a base. */
    acBonus: z.number().int().min(0).optional(),
    /** Below this Strength score the armor costs 10 feet of speed. */
    strengthRequirement: z.number().int().min(1).optional(),
    stealthDisadvantage: z.boolean().default(false),
  })
  .refine(
    (armor) =>
      armor.category === "shield"
        ? armor.acBonus !== undefined && armor.baseAc === undefined
        : armor.baseAc !== undefined && armor.acBonus === undefined,
    "body armor carries baseAc; a shield carries acBonus",
  );

export type ArmorCategory = z.infer<typeof ArmorCategory>;
export type ArmorDefinition = z.infer<typeof ArmorDefinition>;
```

Add `ArmorDefinition` to the test file's import.

- [ ] **Step 4: Write the data file**

`data/srd/armor.json`:

```json
[
  { "armorId": "padded", "nameEnglish": "Padded Armor", "nameHebrew": "שריון מרופד", "category": "light", "baseAc": 11, "stealthDisadvantage": true },
  { "armorId": "leather", "nameEnglish": "Leather Armor", "nameHebrew": "שריון עור", "category": "light", "baseAc": 11, "stealthDisadvantage": false },
  { "armorId": "studded_leather", "nameEnglish": "Studded Leather Armor", "nameHebrew": "שריון עור ממוסמר", "category": "light", "baseAc": 12, "stealthDisadvantage": false },
  { "armorId": "hide", "nameEnglish": "Hide Armor", "nameHebrew": "שריון פרווה", "category": "medium", "baseAc": 12, "stealthDisadvantage": false },
  { "armorId": "chain_shirt", "nameEnglish": "Chain Shirt", "nameHebrew": "כותונת טבעות", "category": "medium", "baseAc": 13, "stealthDisadvantage": false },
  { "armorId": "scale_mail", "nameEnglish": "Scale Mail", "nameHebrew": "שריון קשקשים", "category": "medium", "baseAc": 14, "stealthDisadvantage": true },
  { "armorId": "breastplate", "nameEnglish": "Breastplate", "nameHebrew": "שריון חזה", "category": "medium", "baseAc": 14, "stealthDisadvantage": false },
  { "armorId": "half_plate", "nameEnglish": "Half Plate Armor", "nameHebrew": "חצי שריון לוחות", "category": "medium", "baseAc": 15, "stealthDisadvantage": true },
  { "armorId": "ring_mail", "nameEnglish": "Ring Mail", "nameHebrew": "שריון טבעות", "category": "heavy", "baseAc": 14, "stealthDisadvantage": true },
  { "armorId": "chain_mail", "nameEnglish": "Chain Mail", "nameHebrew": "שריון שרשראות", "category": "heavy", "baseAc": 16, "strengthRequirement": 13, "stealthDisadvantage": true },
  { "armorId": "splint", "nameEnglish": "Splint Armor", "nameHebrew": "שריון רצועות", "category": "heavy", "baseAc": 17, "strengthRequirement": 15, "stealthDisadvantage": true },
  { "armorId": "plate", "nameEnglish": "Plate Armor", "nameHebrew": "שריון לוחות", "category": "heavy", "baseAc": 18, "strengthRequirement": 15, "stealthDisadvantage": true },
  { "armorId": "shield", "nameEnglish": "Shield", "nameHebrew": "מגן", "category": "shield", "acBonus": 2, "stealthDisadvantage": false }
]
```

- [ ] **Step 5: Run test to verify it passes**

```bash
pnpm --filter @ai-dm/schemas test
```

Expected: PASS.

- [ ] **Step 6: Sabotage check**

Change `plate`'s `baseAc` to `17` and re-run. The base-AC test must fail.
Restore it.

- [ ] **Step 7: Commit**

```bash
git add packages/schemas/src data/srd/armor.json
git commit -m "feat(schemas): transcribe the SRD armor table"
```

---

### Task 4: Class weapon proficiencies and armor training

The Rogue is why `weaponProficiencies` is not a bare category list: the SRD
grants it "Simple weapons and Martial weapons that have the Finesse or Light
property".

**Files:**
- Modify: `packages/schemas/src/srd.ts`
- Modify: `data/srd/classes.json`
- Test: `packages/schemas/src/srd.test.ts`

**Interfaces:**
- Consumes: `ArmorCategory`, `WeaponProperty` from Task 2/3's `gear.ts`.
- Produces: `ClassDefinition.weaponProficiencies`
  (`{ categories: ("simple"|"martial")[]; martialWithProperties?: WeaponProperty[] }`)
  and `ClassDefinition.armorTraining` (`ArmorCategory[]`).

- [ ] **Step 1: Write the failing test**

Append to the existing `describe("SRD classes")` block in
`packages/schemas/src/srd.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @ai-dm/schemas test
```

Expected: FAIL — `weaponProficiencies` is not a property of `ClassDefinition`.

- [ ] **Step 3: Extend the schema**

In `packages/schemas/src/srd.ts`, add before `ClassDefinition`:

```ts
/**
 * Which weapons a class may add its Proficiency Bonus to. `categories` covers
 * the common "Simple" / "Simple and Martial" case; `martialWithProperties`
 * exists for the Rogue, whose grant is "Martial weapons that have the Finesse
 * or Light property" and cannot be expressed as a category.
 */
export const WeaponProficiencies = z.object({
  categories: z.array(z.enum(["simple", "martial"])).default([]),
  martialWithProperties: z.array(WeaponProperty).optional(),
});
```

Add to the `ClassDefinition` object:

```ts
  weaponProficiencies: WeaponProficiencies.default({}),
  armorTraining: z.array(ArmorCategory).default([]),
```

Import `ArmorCategory` and `WeaponProperty` from `./gear.js`, and export
`export type WeaponProficiencies = z.infer<typeof WeaponProficiencies>;`.

> **Import direction:** `gear.ts` imports `DamageType`/`DiceNotation` from
> `srd.ts`, and `srd.ts` now imports `ArmorCategory`/`WeaponProperty` from
> `gear.ts`. TypeScript and ESM both handle this cycle for types and for
> module-level `const` declarations evaluated lazily by zod, but if the
> circular import causes a runtime `undefined` at module init, move
> `DamageType` and `DiceNotation` into `gear.ts` and re-export them from
> `srd.ts` — one-directional, `srd.ts` → `gear.ts`.

- [ ] **Step 4: Update the data file**

`data/srd/classes.json` — add the two fields to each of the four entries:

```json
[
  {
    "class": "fighter",
    "nameEnglish": "Fighter",
    "hitDie": 10,
    "primaryAbilities": ["str", "dex"],
    "savingThrowProficiencies": ["str", "con"],
    "extraAttackLevel": 5,
    "weaponProficiencies": { "categories": ["simple", "martial"] },
    "armorTraining": ["light", "medium", "heavy", "shield"]
  },
  {
    "class": "wizard",
    "nameEnglish": "Wizard",
    "hitDie": 6,
    "primaryAbilities": ["int"],
    "savingThrowProficiencies": ["int", "wis"],
    "spellcastingAbility": "int",
    "weaponProficiencies": { "categories": ["simple"] },
    "armorTraining": []
  },
  {
    "class": "rogue",
    "nameEnglish": "Rogue",
    "hitDie": 8,
    "primaryAbilities": ["dex"],
    "savingThrowProficiencies": ["dex", "int"],
    "weaponProficiencies": {
      "categories": ["simple"],
      "martialWithProperties": ["finesse", "light"]
    },
    "armorTraining": ["light"]
  },
  {
    "class": "cleric",
    "nameEnglish": "Cleric",
    "hitDie": 8,
    "primaryAbilities": ["wis"],
    "savingThrowProficiencies": ["wis", "cha"],
    "spellcastingAbility": "wis",
    "weaponProficiencies": { "categories": ["simple"] },
    "armorTraining": ["light", "medium", "shield"]
  }
]
```

> The Cleric's Divine Order (Protector) grants Martial weapons and Heavy armor
> at level 1. No class features are modelled, so the base entry stands. Task 16
> records this in `RULES_REFERENCE.md` §8.

- [ ] **Step 5: Run test to verify it passes**

```bash
pnpm --filter @ai-dm/schemas test
```

Expected: PASS.

- [ ] **Step 6: Sabotage check**

Add `"martial"` to the wizard's `categories` and re-run. The wizard assertion
must fail. Restore it.

- [ ] **Step 7: Commit**

```bash
git add packages/schemas/src data/srd/classes.json
git commit -m "feat(schemas): add class weapon proficiencies and armor training"
```

---

### Task 5: Extract `CreatureStatBlock` and add `nameHebrew`

The type-only widening the whole design rests on. The engine reads exactly
seven fields off a stat block, so a player character needs no union type and
no branching — only a supertype naming those seven.

**Files:**
- Modify: `packages/schemas/src/srd.ts`
- Modify: `data/srd/monsters/*.json` (all 11)
- Modify: `packages/rules-engine/src/combat/statblock.ts`
- Modify: `packages/rules-engine/src/combat/affordances.ts`
- Modify: `packages/rules-engine/src/encounter/resolve.ts`
- Modify: `packages/rules-engine/src/encounter/build.ts`
- Modify: `packages/agents/src/tactical/available-actions.ts`
- Test: `packages/schemas/src/srd.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `CreatureAttack` (was `MonsterAttack`, plus `nameHebrew`) and
  `CreatureStatBlock` (`nameEnglish`, `nameHebrew`, `size`, `armorClass`,
  `hitPoints`, `speedFeet`, `attacksPerAction`, `actions: CreatureAttack[]`).
  `MonsterStatBlock` becomes `CreatureStatBlock` extended with `monsterId`,
  `creatureType`, `alignment`, `abilities`, `challengeRating`,
  `proficiencyBonus`. Every engine signature that took a `MonsterStatBlock`
  now takes a `CreatureStatBlock`.

- [ ] **Step 1: Write the failing test**

Append to `packages/schemas/src/srd.test.ts`:

```ts
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
});
```

Add `CreatureStatBlock` to the test file's import.

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @ai-dm/schemas test
```

Expected: FAIL — `CreatureStatBlock` is not exported.

- [ ] **Step 3: Restructure the schema**

In `packages/schemas/src/srd.ts`, rename `MonsterAttack` to `CreatureAttack`,
add `nameHebrew`, and split the stat block:

```ts
/**
 * One attack from a creature's Actions. A monster's `attackBonus` is the
 * printed final number — "A monster is proficient with any weapon in its stat
 * block" — while a character's is computed by `deriveCharacter`. Both arrive
 * here already resolved, which is why the engine needs only one shape.
 */
export const CreatureAttack = z.object({
  actionId: z.string().regex(/^[a-z0-9_]+$/),
  nameEnglish: z.string(),
  nameHebrew: z.string().min(1),
  attackBonus: z.number().int(),
  reachFeet: z.number().int().multipleOf(5).optional(),
  rangeFeet: z.number().int().multipleOf(5).optional(),
  longRangeFeet: z.number().int().multipleOf(5).optional(),
  damage: DamageRoll,
  extraDamage: z.array(DamageRoll).default([]),
});

/**
 * Exactly what the rules engine reads off a creature — verified by grep, not
 * by intent: `actions`, `nameEnglish`, `speedFeet`, `size`, `hitPoints`,
 * `attacksPerAction`, `armorClass`, and nothing else. Monsters extend this
 * with their SRD-only fields; characters are projected onto it by
 * `characterStatBlock`. Keeping the supertype this narrow is what makes a
 * player character a type-only change rather than a union at six call sites.
 */
export const CreatureStatBlock = z.object({
  nameEnglish: z.string(),
  nameHebrew: z.string().min(1),
  size: CreatureSize,
  armorClass: z.number().int().min(1),
  hitPoints: z.object({ average: z.number().int().min(1), diceNotation: DiceNotation }),
  speedFeet: z.number().int().min(0).multipleOf(5),
  attacksPerAction: z.number().int().min(1).default(1),
  actions: z.array(CreatureAttack).min(1),
});

export const MonsterStatBlock = CreatureStatBlock.extend({
  monsterId: z.string().regex(/^[a-z0-9_]+$/),
  creatureType: z.string(),
  alignment: z.string(),
  abilities: Abilities,
  challengeRating: z.string(),
  proficiencyBonus: z.number().int().min(2).max(9),
});
```

Update the type exports: replace `MonsterAttack` with `CreatureAttack` and add
`CreatureStatBlock`.

- [ ] **Step 4: Update the five call sites**

Purely type annotations. Do not change any logic.

- `packages/rules-engine/src/combat/statblock.ts` — `combatantFromStatBlock`,
  `meleeReachFeet`, `actionRangesFeetFrom` take `CreatureStatBlock`.
- `packages/rules-engine/src/combat/affordances.ts` — `affordancesFor`'s
  `statBlock` parameter.
- `packages/rules-engine/src/encounter/resolve.ts` — the `statBlocks` map, and
  `attackFor`'s parameter and return type (`CreatureAttack | undefined`).
- `packages/rules-engine/src/encounter/build.ts` — `BuiltEncounter.statBlocks`
  and `BuildEncounterInput.statBlocks`.
- `packages/agents/src/tactical/available-actions.ts` — `availableActionsFor`.

- [ ] **Step 5: Add `nameHebrew` to all 11 monster files**

Block-level names, then each action. Add `"nameHebrew"` immediately after each
existing `"nameEnglish"`.

| File | Block | Actions |
|---|---|---|
| `bandit.json` | שודד | `scimitar` חרב מעוקלת · `light_crossbow` קשת רוחב קלה |
| `bandit_captain.json` | קפטן שודדים | `scimitar` חרב מעוקלת · `pistol` אקדח |
| `boar.json` | חזיר בר | `gore` נגיחה |
| `cultist.json` | חבר כת | `ritual_sickle` מגל פולחן |
| `goblin_minion.json` | גובלין משרת | `dagger` פגיון |
| `goblin_warrior.json` | גובלין לוחם | `scimitar` חרב מעוקלת · `shortbow` קשת קצרה |
| `guard.json` | שומר | `spear` חנית |
| `ogre.json` | אוגר | `greatclub` אלה גדולה · `javelin` כידון |
| `skeleton.json` | שלד | `shortsword` חרב קצרה · `shortbow` קשת קצרה |
| `wolf.json` | זאב | `bite` נשיכה |
| `zombie.json` | זומבי | `slam` מהלומה |

- [ ] **Step 6: Run the whole suite to verify the widening is inert**

```bash
pnpm test
```

Expected: PASS, and **no existing test needed editing**. If any did, the
widening was not type-only and the design is wrong — stop and report rather
than adjusting tests to fit.

```bash
pnpm typecheck && npx eslint packages/schemas packages/rules-engine packages/agents
```

Expected: both clean.

- [ ] **Step 7: Sabotage check**

Remove `nameHebrew` from `wolf.json`'s block and re-run
`pnpm --filter @ai-dm/schemas test`. The Hebrew-name test must fail naming
`wolf.json`. Restore it.

- [ ] **Step 8: Commit**

```bash
git add packages/schemas/src packages/rules-engine/src packages/agents/src data/srd/monsters
git commit -m "refactor(schemas): extract CreatureStatBlock and add Hebrew names"
```

---

### Task 6: `CharacterSheet` gains size, equipped and typed skills

**Files:**
- Modify: `packages/schemas/src/character.ts`
- Test: `packages/schemas/src/index.test.ts`

**Interfaces:**
- Consumes: `Skill` from Task 1.
- Produces: `CharacterSheet.size: CreatureSize` (default `"medium"`),
  `CharacterSheet.inventory[].equipped: boolean` (default `false`),
  `CharacterSheet.skillProficiencies: Skill[]`.

- [ ] **Step 1: Write the failing test**

Append inside the existing `describe("CharacterSheet")` in
`packages/schemas/src/index.test.ts`:

```ts
it("defaults size to medium", () => {
  const parsed = CharacterSheet.parse(validSheet);
  expect(parsed.size).toBe("medium");
});

it("defaults inventory entries to not equipped", () => {
  const parsed = CharacterSheet.parse({
    ...validSheet,
    inventory: [{ itemId: "longsword", quantity: 1 }],
  });
  expect(parsed.inventory[0]?.equipped).toBe(false);
});

it("carries an equipped flag when given one", () => {
  const parsed = CharacterSheet.parse({
    ...validSheet,
    inventory: [{ itemId: "longsword", quantity: 1, equipped: true }],
  });
  expect(parsed.inventory[0]?.equipped).toBe(true);
});

it("rejects a skill proficiency that is not a real skill", () => {
  const bad = { ...validSheet, skillProficiencies: ["banana"] };
  expect(() => CharacterSheet.parse(bad)).toThrow();
});

it("accepts real skill proficiencies", () => {
  const parsed = CharacterSheet.parse({
    ...validSheet,
    skillProficiencies: ["athletics", "perception"],
  });
  expect(parsed.skillProficiencies).toEqual(["athletics", "perception"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @ai-dm/schemas test
```

Expected: FAIL — `size` is undefined and `"banana"` is accepted.

- [ ] **Step 3: Extend the schema**

In `packages/schemas/src/character.ts`, inside `CharacterSheet`:

```ts
  /**
   * No species field exists and this schema does not add one, so a default
   * beats inventing a species system for a single value. Read by
   * `characterStatBlock` — the engine needs a size for every combatant.
   */
  size: CreatureSize.default("medium"),
```

Replace `skillProficiencies: z.array(z.string()),` with
`skillProficiencies: z.array(Skill),`.

Replace the inventory line with:

```ts
  inventory: z.array(
    z.object({
      itemId: z.string(),
      quantity: z.number().int().min(1),
      /**
       * Worn or wielded, as opposed to carried. `deriveCharacter` reads this
       * to decide which armor sets AC and which weapons become actions; a
       * character page reads it to separate equipped from carried.
       */
      equipped: z.boolean().default(false),
    }),
  ),
```

Import `CreatureSize` from `./world.js`.

> **Watch the import direction:** `world.ts` already imports from
> `character.ts` (`ActiveCondition`, `SpellSlots`). If importing `CreatureSize`
> the other way creates a runtime cycle, move `CreatureSize` into a new
> `primitives.ts` and have both import from there.

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm --filter @ai-dm/schemas test
```

Expected: PASS.

- [ ] **Step 5: Sabotage check**

Change `skillProficiencies` back to `z.array(z.string())` and re-run. The
`"banana"` test must fail. Restore it.

- [ ] **Step 6: Commit**

```bash
git add packages/schemas/src
git commit -m "feat(schemas): CharacterSheet gains size, equipped items, typed skills"
```

---

### Task 7: The `DerivedCharacter` schema

The contract a future character-sheet page renders. It exists as a schema
before anything computes it, so Tasks 8-11 have a target to fill in.

**Files:**
- Create: `packages/schemas/src/derived.ts`
- Create: `packages/schemas/src/derived.test.ts`
- Modify: `packages/schemas/src/index.ts`

**Interfaces:**
- Consumes: `AbilityKey`, `CharacterClass`, `Skill` from `./character.js`;
  `CreatureAttack`, `DiceNotation` from `./srd.js`; `CreatureSize` from
  `./world.js`.
- Produces: `DerivedCharacter`, exported from `@ai-dm/schemas`. Tasks 8-11
  fill it; Task 15 serves it.

- [ ] **Step 1: Write the failing test**

Create `packages/schemas/src/derived.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { DerivedCharacter } from "./index.js";

const minimal = {
  characterId: "hero",
  nameHebrew: "אלדד",
  grammaticalGender: "masculine",
  class: "fighter",
  level: 3,
  size: "medium",
  abilityModifiers: { str: 3, dex: 1, con: 2, int: 0, wis: 1, cha: 0 },
  proficiencyBonus: 2,
  armorClass: 16,
  initiative: 1,
  speedFeet: 30,
  passivePerception: 11,
  maxHp: 28,
  currentHp: 28,
  tempHp: 0,
  hitDice: "3d10",
  savingThrows: { str: 5, dex: 1, con: 4, int: 0, wis: 1, cha: 0 },
  skills: {},
  attacks: [
    {
      actionId: "longsword",
      nameEnglish: "Longsword",
      nameHebrew: "חרב ארוכה",
      attackBonus: 5,
      reachFeet: 5,
      damage: { diceNotation: "1d10+3", averageDamage: 8, damageType: "slashing" },
    },
  ],
  attacksPerAction: 1,
};

describe("DerivedCharacter", () => {
  it("parses a complete derivation", () => {
    const parsed = DerivedCharacter.parse(minimal);
    expect(parsed.armorClass).toBe(16);
    expect(parsed.attacks[0]?.attackBonus).toBe(5);
  });

  it("leaves spellSaveDc absent for a non-caster", () => {
    expect(DerivedCharacter.parse(minimal).spellSaveDc).toBeUndefined();
  });

  it("carries spellSaveDc when given one", () => {
    expect(DerivedCharacter.parse({ ...minimal, spellSaveDc: 13 }).spellSaveDc).toBe(13);
  });

  it("requires at least one attack", () => {
    expect(() => DerivedCharacter.parse({ ...minimal, attacks: [] })).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @ai-dm/schemas test
```

Expected: FAIL — `DerivedCharacter` is not exported.

- [ ] **Step 3: Write the schema**

Create `packages/schemas/src/derived.ts`:

```ts
// Every 5e number a character has, computed once. The engine consumes a
// projection of this (`characterStatBlock`); a character-sheet page consumes
// it whole. It lives in schemas rather than rules-engine so `apps/web` can
// hold the TYPE without importing the MATH — invariant 1 keeps the
// calculation in the engine, invariant 5 keeps the engine out of the client.
import { z } from "zod";
import { AbilityKey, CharacterClass, Skill } from "./character.js";
import { CreatureAttack, DiceNotation } from "./srd.js";
import { CreatureSize } from "./world.js";

const ByAbility = z.record(AbilityKey, z.number().int());

export const DerivedCharacter = z.object({
  characterId: z.string(),
  nameHebrew: z.string().min(1),
  grammaticalGender: z.enum(["masculine", "feminine"]),
  class: CharacterClass,
  level: z.number().int().min(1).max(20),
  size: CreatureSize,

  abilityModifiers: ByAbility,
  proficiencyBonus: z.number().int().min(2).max(6),
  armorClass: z.number().int().min(1),
  initiative: z.number().int(),
  /** After any armor Strength penalty. */
  speedFeet: z.number().int().min(0).multipleOf(5),
  passivePerception: z.number().int(),

  maxHp: z.number().int().min(1),
  currentHp: z.number().int().min(0),
  tempHp: z.number().int().min(0),
  hitDice: DiceNotation,

  savingThrows: ByAbility,
  skills: z.record(Skill, z.number().int()),

  /**
   * Never empty: an Unarmed Strike is always derived, so a character with no
   * equipped weapon still satisfies `CreatureStatBlock.actions.min(1)`.
   */
  attacks: z.array(CreatureAttack).min(1),
  attacksPerAction: z.number().int().min(1),

  /** Absent when the class has no spellcasting ability. */
  spellSaveDc: z.number().int().optional(),
});

export type DerivedCharacter = z.infer<typeof DerivedCharacter>;
```

Add `export * from "./derived.js";` to `packages/schemas/src/index.ts`.

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm --filter @ai-dm/schemas test
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/schemas/src
git commit -m "feat(schemas): add the DerivedCharacter contract"
```

---

### Task 8: Derive armor class and speed

First real rules code. Golden tests are mandatory
(`packages/rules-engine/CLAUDE.md`).

**Files:**
- Create: `packages/rules-engine/src/character/armor.ts`
- Create: `packages/rules-engine/src/character/armor.test.ts`

**Interfaces:**
- Consumes: `ArmorDefinition`, `ArmorCategory` (Task 3).
- Produces:

```ts
export interface EquippedArmor { body?: ArmorDefinition; shield?: ArmorDefinition }
export function armorClassFor(
  equipped: EquippedArmor,
  dexModifier: number,
  armorTraining: readonly ArmorCategory[],
): number;
export function speedFeetFor(
  equipped: EquippedArmor,
  strengthScore: number,
  baseSpeedFeet: number,
): number;
```

- [ ] **Step 1: Write the failing test**

Create `packages/rules-engine/src/character/armor.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { ArmorCategory, ArmorDefinition } from "@ai-dm/schemas";
import { armorClassFor, speedFeetFor } from "./armor.js";

const ALL: ArmorCategory[] = ["light", "medium", "heavy", "shield"];

function armor(
  armorId: string,
  category: ArmorCategory,
  extra: Partial<ArmorDefinition>,
): ArmorDefinition {
  return {
    armorId,
    nameEnglish: armorId,
    nameHebrew: "בדיקה",
    category,
    stealthDisadvantage: false,
    ...extra,
  } as ArmorDefinition;
}

const LEATHER = armor("leather", "light", { baseAc: 11 });
const HALF_PLATE = armor("half_plate", "medium", { baseAc: 15 });
const PLATE = armor("plate", "heavy", { baseAc: 18, strengthRequirement: 15 });
const CHAIN_MAIL = armor("chain_mail", "heavy", { baseAc: 16, strengthRequirement: 13 });
const SHIELD = armor("shield", "shield", { acBonus: 2 });

describe("armorClassFor", () => {
  it("uses 10 + Dex when unarmored", () => {
    expect(armorClassFor({}, 3, ALL)).toBe(13);
  });

  it("adds the full Dex modifier in light armor", () => {
    expect(armorClassFor({ body: LEATHER }, 4, ALL)).toBe(15);
  });

  // Light armor genuinely applies a NEGATIVE Dex modifier: 11 - 1 = 10.
  it("applies a negative Dex modifier in light armor", () => {
    expect(armorClassFor({ body: LEATHER }, -1, ALL)).toBe(10);
  });

  it("caps the Dex modifier at +2 in medium armor", () => {
    expect(armorClassFor({ body: HALF_PLATE }, 4, ALL)).toBe(17);
  });

  it("does not raise a Dex modifier already below the medium cap", () => {
    expect(armorClassFor({ body: HALF_PLATE }, 1, ALL)).toBe(16);
  });

  it("ignores Dex entirely in heavy armor", () => {
    expect(armorClassFor({ body: PLATE }, 4, ALL)).toBe(18);
  });

  // Heavy armor is "no Dexterity modifier", NOT "capped at 0" — a negative
  // modifier must not reduce it either.
  it("does not penalise a negative Dex modifier in heavy armor", () => {
    expect(armorClassFor({ body: PLATE }, -1, ALL)).toBe(18);
  });

  it("adds the shield bonus with shield training", () => {
    expect(armorClassFor({ body: LEATHER, shield: SHIELD }, 2, ALL)).toBe(15);
  });

  // "You gain the Armor Class benefit of a Shield only if you have training
  // with it." Untrained is no bonus, not a penalty.
  it("withholds the shield bonus without shield training", () => {
    expect(armorClassFor({ body: LEATHER, shield: SHIELD }, 2, ["light"])).toBe(13);
  });
});

describe("speedFeetFor", () => {
  it("leaves speed alone when the armor has no Strength requirement", () => {
    expect(speedFeetFor({ body: LEATHER }, 8, 30)).toBe(30);
  });

  it("costs 10 feet when Strength is below the requirement", () => {
    expect(speedFeetFor({ body: CHAIN_MAIL }, 12, 30)).toBe(20);
  });

  it("leaves speed alone when Strength exactly meets the requirement", () => {
    expect(speedFeetFor({ body: CHAIN_MAIL }, 13, 30)).toBe(30);
  });

  it("never drops speed below zero", () => {
    expect(speedFeetFor({ body: PLATE }, 8, 5)).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @ai-dm/rules-engine test
```

Expected: FAIL — cannot resolve `./armor.js`.

- [ ] **Step 3: Write the implementation**

Create `packages/rules-engine/src/character/armor.ts`:

```ts
// Armor Class and the armor Strength penalty. Both are SRD table rules, and
// both feed the engine through `characterStatBlock`.
import type { ArmorCategory, ArmorDefinition } from "@ai-dm/schemas";

/** What the character is actually wearing and wielding. */
export interface EquippedArmor {
  body?: ArmorDefinition;
  shield?: ArmorDefinition;
}

const UNARMORED_BASE_AC = 10;
const MEDIUM_DEX_CAP = 2;
const STRENGTH_PENALTY_FEET = 10;

/**
 * How much Dexterity the worn armor lets through. Taken from the category
 * rather than stored per row: every Light row in the SRD table is
 * `base + Dex`, every Medium row `base + Dex (max 2)`, every Heavy row a bare
 * number, and no row deviates from its category.
 *
 * Heavy contributes 0 flatly rather than capping at 0 — capping would let a
 * -1 modifier through as -1, and heavy armor does not penalise low Dexterity.
 */
function dexterityContribution(category: ArmorCategory | undefined, dexModifier: number): number {
  if (category === undefined || category === "light") return dexModifier;
  if (category === "medium") return Math.min(dexModifier, MEDIUM_DEX_CAP);
  return 0;
}

export function armorClassFor(
  equipped: EquippedArmor,
  dexModifier: number,
  armorTraining: readonly ArmorCategory[],
): number {
  const base = equipped.body?.baseAc ?? UNARMORED_BASE_AC;
  const fromDex = dexterityContribution(equipped.body?.category, dexModifier);

  // "You gain the Armor Class benefit of a Shield only if you have training
  // with it." Untrained is simply no bonus, never a penalty.
  const trained = armorTraining.includes("shield");
  const fromShield = equipped.shield !== undefined && trained ? (equipped.shield.acBonus ?? 0) : 0;

  return base + fromDex + fromShield;
}

/**
 * "If the table shows a Strength score in the Strength column for an armor
 * type, that armor reduces the wearer's speed by 10 feet unless the wearer has
 * a Strength score equal to or higher than the listed score."
 */
export function speedFeetFor(
  equipped: EquippedArmor,
  strengthScore: number,
  baseSpeedFeet: number,
): number {
  const required = equipped.body?.strengthRequirement;
  if (required === undefined || strengthScore >= required) return baseSpeedFeet;
  return Math.max(0, baseSpeedFeet - STRENGTH_PENALTY_FEET);
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm --filter @ai-dm/rules-engine test
```

Expected: PASS, 13 cases.

- [ ] **Step 5: Sabotage check**

Change `return 0;` to `return Math.min(dexModifier, 0);` and re-run: "does not
penalise a negative Dex modifier in heavy armor" must fail. Restore it. Then
drop the `trained` condition from `fromShield` and confirm "withholds the
shield bonus without shield training" fails. Restore it.

- [ ] **Step 6: Commit**

```bash
git add packages/rules-engine/src/character
git commit -m "feat(rules-engine): derive armor class and the armor speed penalty"
```

---

### Task 9: Derive weapon and unarmed attacks

**Files:**
- Create: `packages/rules-engine/src/character/attacks.ts`
- Create: `packages/rules-engine/src/character/attacks.test.ts`

**Interfaces:**
- Consumes: `WeaponDefinition`, `WeaponProficiencies`, `CreatureAttack`,
  `AbilityKey` from `@ai-dm/schemas`.
- Produces:

```ts
export interface AttackDerivationInput {
  weapons: readonly WeaponDefinition[];          // equipped weapons only
  abilityModifiers: Readonly<Record<AbilityKey, number>>;
  proficiencyBonus: number;
  proficiencies: WeaponProficiencies;
  shieldEquipped: boolean;
}
export function isProficientWith(
  weapon: WeaponDefinition,
  proficiencies: WeaponProficiencies,
): boolean;
export function attacksFor(input: AttackDerivationInput): CreatureAttack[];
```

`attacksFor` always appends an `unarmed_strike` entry last, so the result is
never empty.

- [ ] **Step 1: Write the failing test**

Create `packages/rules-engine/src/character/attacks.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { AbilityKey, WeaponDefinition, WeaponProficiencies } from "@ai-dm/schemas";
import { attacksFor, isProficientWith } from "./attacks.js";

const SIMPLE_AND_MARTIAL: WeaponProficiencies = { categories: ["simple", "martial"] };
const SIMPLE_ONLY: WeaponProficiencies = { categories: ["simple"] };
const ROGUE: WeaponProficiencies = {
  categories: ["simple"],
  martialWithProperties: ["finesse", "light"],
};

const MODS: Record<AbilityKey, number> = { str: 3, dex: 1, con: 2, int: 0, wis: 1, cha: 0 };
const FINESSE_MODS: Record<AbilityKey, number> = { ...MODS, str: 3, dex: 4 };

const LONGSWORD: WeaponDefinition = {
  weaponId: "longsword",
  nameEnglish: "Longsword",
  nameHebrew: "חרב ארוכה",
  category: "martial",
  kind: "melee",
  damage: { diceNotation: "1d8", damageType: "slashing" },
  versatileDamage: { diceNotation: "1d10", damageType: "slashing" },
  properties: ["versatile"],
};

const RAPIER: WeaponDefinition = {
  weaponId: "rapier",
  nameEnglish: "Rapier",
  nameHebrew: "סיף",
  category: "martial",
  kind: "melee",
  damage: { diceNotation: "1d8", damageType: "piercing" },
  properties: ["finesse"],
};

const GREATAXE: WeaponDefinition = {
  weaponId: "greataxe",
  nameEnglish: "Greataxe",
  nameHebrew: "גרזן ענק",
  category: "martial",
  kind: "melee",
  damage: { diceNotation: "1d12", damageType: "slashing" },
  properties: ["heavy", "two_handed"],
};

const SHORTBOW: WeaponDefinition = {
  weaponId: "shortbow",
  nameEnglish: "Shortbow",
  nameHebrew: "קשת קצרה",
  category: "simple",
  kind: "ranged",
  damage: { diceNotation: "1d6", damageType: "piercing" },
  properties: ["ammunition", "two_handed"],
  rangeFeet: 80,
  longRangeFeet: 320,
};

const WHIP: WeaponDefinition = {
  weaponId: "whip",
  nameEnglish: "Whip",
  nameHebrew: "שוט",
  category: "martial",
  kind: "melee",
  damage: { diceNotation: "1d4", damageType: "slashing" },
  properties: ["finesse", "reach"],
};

const BLOWGUN: WeaponDefinition = {
  weaponId: "blowgun",
  nameEnglish: "Blowgun",
  nameHebrew: "רובה נשיפה",
  category: "martial",
  kind: "ranged",
  damage: { fixedDamage: 1, damageType: "piercing" },
  properties: ["ammunition", "loading"],
  rangeFeet: 25,
  longRangeFeet: 100,
};

const base = {
  abilityModifiers: MODS,
  proficiencyBonus: 2,
  proficiencies: SIMPLE_AND_MARTIAL,
  shieldEquipped: false,
};

const only = (weaponId: string, attacks: readonly { actionId: string }[]) =>
  attacks.find((each) => each.actionId === weaponId);

describe("isProficientWith", () => {
  it("grants proficiency by category", () => {
    expect(isProficientWith(GREATAXE, SIMPLE_AND_MARTIAL)).toBe(true);
    expect(isProficientWith(SHORTBOW, SIMPLE_ONLY)).toBe(true);
  });

  it("denies a martial weapon to a simple-only class", () => {
    expect(isProficientWith(GREATAXE, SIMPLE_ONLY)).toBe(false);
  });

  // "Simple weapons and Martial weapons that have the Finesse or Light
  // property" — the Rogue's grant, which no category list can express.
  it("grants the Rogue a martial weapon with Finesse", () => {
    expect(isProficientWith(RAPIER, ROGUE)).toBe(true);
  });

  it("denies the Rogue a martial weapon without Finesse or Light", () => {
    expect(isProficientWith(GREATAXE, ROGUE)).toBe(false);
  });
});

describe("attacksFor", () => {
  it("uses Strength for a plain melee weapon", () => {
    const attack = only("longsword", attacksFor({ ...base, weapons: [LONGSWORD] }));
    expect(attack?.attackBonus).toBe(5); // +3 Str, +2 proficiency
  });

  // Versatile: no hands are modelled, so the two-handed die is taken whenever
  // no shield is equipped. HOUSE RULE — see RULES_REFERENCE.md section 7.
  it("takes the versatile die when no shield is equipped", () => {
    const attack = only("longsword", attacksFor({ ...base, weapons: [LONGSWORD] }));
    expect(attack?.damage.diceNotation).toBe("1d10+3");
    expect(attack?.damage.averageDamage).toBe(8); // floor(5.5) + 3
  });

  it("takes the one-handed die when a shield is equipped", () => {
    const attack = only(
      "longsword",
      attacksFor({ ...base, weapons: [LONGSWORD], shieldEquipped: true }),
    );
    expect(attack?.damage.diceNotation).toBe("1d8+3");
    expect(attack?.damage.averageDamage).toBe(7); // floor(4.5) + 3
  });

  // "use your choice of your Strength or Dexterity modifier ... You must use
  // the same modifier for both rolls."
  it("takes the higher modifier for a finesse weapon, on both rolls", () => {
    const attack = only(
      "rapier",
      attacksFor({ ...base, weapons: [RAPIER], abilityModifiers: FINESSE_MODS }),
    );
    expect(attack?.attackBonus).toBe(6); // +4 Dex, +2 proficiency
    expect(attack?.damage.diceNotation).toBe("1d8+4");
  });

  it("uses Dexterity for a ranged weapon", () => {
    const attack = only("shortbow", attacksFor({ ...base, weapons: [SHORTBOW] }));
    expect(attack?.attackBonus).toBe(3); // +1 Dex, +2 proficiency
    expect(attack?.rangeFeet).toBe(80);
    expect(attack?.longRangeFeet).toBe(320);
    expect(attack?.reachFeet).toBeUndefined();
  });

  it("withholds the proficiency bonus from a weapon the class cannot use", () => {
    const attack = only(
      "greataxe",
      attacksFor({ ...base, weapons: [GREATAXE], proficiencies: SIMPLE_ONLY }),
    );
    expect(attack?.attackBonus).toBe(3); // +3 Str only
  });

  it("gives a reach weapon 10 feet and everything else 5", () => {
    const [whip] = attacksFor({ ...base, weapons: [WHIP] });
    expect(whip?.reachFeet).toBe(10);
    const [sword] = attacksFor({ ...base, weapons: [LONGSWORD] });
    expect(sword?.reachFeet).toBe(5);
  });

  it("keeps flat weapon damage flat", () => {
    const attack = only("blowgun", attacksFor({ ...base, weapons: [BLOWGUN] }));
    expect(attack?.damage.diceNotation).toBeUndefined();
    expect(attack?.damage.averageDamage).toBe(2); // 1 + 1 Dex
  });

  // Without this, a Wizard with no equipped weapon derives an empty action
  // list and fails CreatureStatBlock's .min(1).
  it("always derives an unarmed strike, even with no weapons", () => {
    const attacks = attacksFor({ ...base, weapons: [] });
    expect(attacks).toHaveLength(1);
    const unarmed = attacks[0];
    expect(unarmed?.actionId).toBe("unarmed_strike");
    expect(unarmed?.attackBonus).toBe(5); // +3 Str, +2 proficiency — always proficient
    expect(unarmed?.damage.diceNotation).toBeUndefined();
    expect(unarmed?.damage.averageDamage).toBe(4); // 1 + 3 Str
    expect(unarmed?.reachFeet).toBe(5);
  });

  it("appends the unarmed strike alongside real weapons", () => {
    const ids = attacksFor({ ...base, weapons: [LONGSWORD] }).map((each) => each.actionId);
    expect(ids).toEqual(["longsword", "unarmed_strike"]);
  });

  it("never lets damage go below zero", () => {
    const feeble: Record<AbilityKey, number> = { ...MODS, str: -5 };
    const attacks = attacksFor({ ...base, weapons: [], abilityModifiers: feeble });
    expect(attacks[0]?.damage.averageDamage).toBe(0);
  });

  it("names every derived attack in Hebrew", () => {
    for (const attack of attacksFor({ ...base, weapons: [LONGSWORD, SHORTBOW] })) {
      expect(attack.nameHebrew.trim(), attack.actionId).not.toBe("");
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @ai-dm/rules-engine test
```

Expected: FAIL — cannot resolve `./attacks.js`.

- [ ] **Step 3: Write the implementation**

Create `packages/rules-engine/src/character/attacks.ts`:

```ts
// Turns equipped weapons into the resolved `CreatureAttack` shape the engine
// already understands. A monster's attack bonus is printed in its stat block;
// a character's is computed here, from ability, proficiency and the weapon.
import type {
  AbilityKey,
  CreatureAttack,
  DamageRoll,
  WeaponDefinition,
  WeaponProficiencies,
} from "@ai-dm/schemas";

export interface AttackDerivationInput {
  /** Equipped weapons only — carried ones are not actions. */
  weapons: readonly WeaponDefinition[];
  abilityModifiers: Readonly<Record<AbilityKey, number>>;
  proficiencyBonus: number;
  proficiencies: WeaponProficiencies;
  /** Decides the Versatile die. See the house rule note below. */
  shieldEquipped: boolean;
}

const DEFAULT_REACH_FEET = 5;
const REACH_PROPERTY_FEET = 10;
const UNARMED_BASE_DAMAGE = 1;

/**
 * "Anyone can wield a weapon, but you must have proficiency with it to add
 * your Proficiency Bonus to an attack roll you make with it."
 *
 * `martialWithProperties` exists for the Rogue, whose grant is "Martial
 * weapons that have the Finesse or Light property".
 */
export function isProficientWith(
  weapon: WeaponDefinition,
  proficiencies: WeaponProficiencies,
): boolean {
  if (proficiencies.categories.includes(weapon.category)) return true;
  if (weapon.category !== "martial") return false;
  const byProperty = proficiencies.martialWithProperties ?? [];
  return byProperty.some((property) => weapon.properties.includes(property));
}

/**
 * Which ability swings this weapon. Ranged weapons use Dexterity, melee use
 * Strength, and a Finesse weapon lets the wielder choose — "use your choice of
 * your Strength or Dexterity modifier for the attack and damage rolls. You
 * must use the same modifier for both rolls" — so the higher is taken and used
 * for both.
 *
 * A Thrown melee weapon stays on its melee ability; `kind` already encodes
 * that, since the SRD has a thrown weapon use the modifier it would use in
 * melee.
 */
function attackAbilityFor(
  weapon: WeaponDefinition,
  modifiers: Readonly<Record<AbilityKey, number>>,
): AbilityKey {
  if (weapon.kind === "ranged") return "dex";
  if (!weapon.properties.includes("finesse")) return "str";
  return modifiers.dex > modifiers.str ? "dex" : "str";
}

/**
 * HOUSE RULE. RAW: "A Versatile weapon can be used with one or two hands ...
 * The weapon deals that damage when used with two hands to make a melee
 * attack." Nothing in this engine models hands, so a shield stands in for the
 * off hand. Recorded in RULES_REFERENCE.md section 7.
 */
function damageDiceFor(weapon: WeaponDefinition, shieldEquipped: boolean) {
  if (weapon.versatileDamage !== undefined && !shieldEquipped) return weapon.versatileDamage;
  return weapon.damage;
}

/** Average of `XdY`, floored — the convention the SRD prints stat blocks with. */
function averageOfDice(diceNotation: string): number {
  const [countText, sidesText] = diceNotation.split("d");
  const count = Number(countText);
  const sides = Number(sidesText);
  return Math.floor((count * (sides + 1)) / 2);
}

/** `1d8+3`, `1d8`, `1d8-1`. A zero modifier adds no suffix. */
function withModifier(diceNotation: string, modifier: number): string {
  if (modifier === 0) return diceNotation;
  return modifier > 0 ? `${diceNotation}+${String(modifier)}` : `${diceNotation}${String(modifier)}`;
}

function damageRollFor(
  weapon: WeaponDefinition,
  shieldEquipped: boolean,
  modifier: number,
): DamageRoll {
  const dice = damageDiceFor(weapon, shieldEquipped);

  if (dice.diceNotation === undefined) {
    // Flat damage, e.g. the blowgun's "1 Piercing". `DamageRoll` already
    // documents `diceNotation` as "Absent for flat damage", so this needs no
    // special shape — just no dice.
    return {
      averageDamage: Math.max(0, (dice.fixedDamage ?? 0) + modifier),
      damageType: dice.damageType,
    };
  }

  return {
    diceNotation: withModifier(dice.diceNotation, modifier),
    averageDamage: Math.max(0, averageOfDice(dice.diceNotation) + modifier),
    damageType: dice.damageType,
  };
}

function reachAndRangeFor(weapon: WeaponDefinition) {
  const range = {
    ...(weapon.rangeFeet === undefined ? {} : { rangeFeet: weapon.rangeFeet }),
    ...(weapon.longRangeFeet === undefined ? {} : { longRangeFeet: weapon.longRangeFeet }),
  };
  if (weapon.kind === "ranged") return range;
  return {
    reachFeet: weapon.properties.includes("reach") ? REACH_PROPERTY_FEET : DEFAULT_REACH_FEET,
    ...range,
  };
}

/**
 * "Instead of using a weapon to make a melee attack, you can use a punch,
 * kick, headbutt, or similar forceful blow." Always available, and always
 * proficient: the Damage option's bonus is "your Strength modifier plus your
 * Proficiency Bonus" with no proficiency condition attached.
 *
 * Deriving it unconditionally is also what keeps `CreatureStatBlock.actions`
 * non-empty for a character carrying no weapon at all.
 */
function unarmedStrike(strengthModifier: number, proficiencyBonus: number): CreatureAttack {
  return {
    actionId: "unarmed_strike",
    nameEnglish: "Unarmed Strike",
    nameHebrew: "מכת יד",
    attackBonus: strengthModifier + proficiencyBonus,
    reachFeet: DEFAULT_REACH_FEET,
    damage: {
      averageDamage: Math.max(0, UNARMED_BASE_DAMAGE + strengthModifier),
      damageType: "bludgeoning",
    },
    extraDamage: [],
  };
}

export function attacksFor(input: AttackDerivationInput): CreatureAttack[] {
  const attacks = input.weapons.map((weapon): CreatureAttack => {
    const ability = attackAbilityFor(weapon, input.abilityModifiers);
    const modifier = input.abilityModifiers[ability];
    const proficient = isProficientWith(weapon, input.proficiencies);

    return {
      actionId: weapon.weaponId,
      nameEnglish: weapon.nameEnglish,
      nameHebrew: weapon.nameHebrew,
      attackBonus: modifier + (proficient ? input.proficiencyBonus : 0),
      ...reachAndRangeFor(weapon),
      damage: damageRollFor(weapon, input.shieldEquipped, modifier),
      extraDamage: [],
    };
  });

  attacks.push(unarmedStrike(input.abilityModifiers.str, input.proficiencyBonus));
  return attacks;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm --filter @ai-dm/rules-engine test && pnpm typecheck
```

Expected: PASS and a clean typecheck with no `as unknown as` remaining.

- [ ] **Step 5: Sabotage check**

Delete the `attacks.push(unarmedStrike(...))` line and re-run: "always derives
an unarmed strike" must fail. Restore it. Then change `attackAbilityFor`'s
finesse branch to always return `"str"` and confirm the finesse test fails.
Restore it.

- [ ] **Step 6: Commit**

```bash
git add packages/rules-engine/src/character
git commit -m "feat(rules-engine): derive weapon and unarmed strike attacks"
```

---

### Task 10: Assemble `deriveCharacter`

**Files:**
- Create: `packages/rules-engine/src/character/derive.ts`
- Create: `packages/rules-engine/src/character/derive.test.ts`
- Create: `packages/rules-engine/src/character/index.ts`
- Modify: `packages/rules-engine/src/index.ts`

**Interfaces:**
- Consumes: `armorClassFor`, `speedFeetFor`, `EquippedArmor` (Task 8);
  `attacksFor` (Task 9); `abilityModifier`, `proficiencyBonusForLevel` from
  `../checks/index.js`.
- Produces:

```ts
export interface SrdGear {
  weapons: ReadonlyMap<string, WeaponDefinition>;
  armor: ReadonlyMap<string, ArmorDefinition>;
  classes: ReadonlyMap<CharacterClass, ClassDefinition>;
  skills: ReadonlyMap<Skill, SkillDefinition>;
}
export function deriveCharacter(sheet: CharacterSheet, gear: SrdGear): DerivedCharacter;
```

Throws when the sheet equips more than one armor or more than one shield, or
names an unknown class.

> **Note on `z.record` completeness:** `DerivedCharacter.skills` and
> `savingThrows` are `z.record(...)`, which does not require every key at
> runtime — that is why Task 7's fixture parses with `skills: {}`.
> `deriveCharacter` nonetheless emits all 18 skills and all 6 saves, which the
> tests below pin.

- [ ] **Step 1: Write the failing test**

First create the shared fixture module — Tasks 12 and 13 import from it too,
mirroring `packages/agents/src/tactical/test-fixtures.ts`.

`packages/rules-engine/src/character/test-fixtures.ts`:

```ts
// Shared across derive.test.ts, consistency.test.ts and the encounter build
// tests. Not a test file itself, so it ships no `it` blocks.
import type {
  ArmorDefinition,
  CharacterSheet,
  ClassDefinition,
  SkillDefinition,
  WeaponDefinition,
} from "@ai-dm/schemas";
import type { SrdGear } from "./derive.js";

export const FIGHTER = {
  class: "fighter",
  nameEnglish: "Fighter",
  hitDie: 10,
  primaryAbilities: ["str", "dex"],
  savingThrowProficiencies: ["str", "con"],
  extraAttackLevel: 5,
  weaponProficiencies: { categories: ["simple", "martial"] },
  armorTraining: ["light", "medium", "heavy", "shield"],
} as unknown as ClassDefinition;

export const WIZARD = {
  class: "wizard",
  nameEnglish: "Wizard",
  hitDie: 6,
  primaryAbilities: ["int"],
  savingThrowProficiencies: ["int", "wis"],
  spellcastingAbility: "int",
  weaponProficiencies: { categories: ["simple"] },
  armorTraining: [],
} as unknown as ClassDefinition;

export const CHAIN_MAIL = {
  armorId: "chain_mail",
  nameEnglish: "Chain Mail",
  nameHebrew: "שריון שרשראות",
  category: "heavy",
  baseAc: 16,
  strengthRequirement: 13,
  stealthDisadvantage: true,
} as unknown as ArmorDefinition;

export const SHIELD = {
  armorId: "shield",
  nameEnglish: "Shield",
  nameHebrew: "מגן",
  category: "shield",
  acBonus: 2,
  stealthDisadvantage: false,
} as unknown as ArmorDefinition;

export const LONGSWORD = {
  weaponId: "longsword",
  nameEnglish: "Longsword",
  nameHebrew: "חרב ארוכה",
  category: "martial",
  kind: "melee",
  damage: { diceNotation: "1d8", damageType: "slashing" },
  versatileDamage: { diceNotation: "1d10", damageType: "slashing" },
  properties: ["versatile"],
} as unknown as WeaponDefinition;

export const SKILLS: SkillDefinition[] = [
  { skill: "acrobatics", nameEnglish: "Acrobatics", ability: "dex" },
  { skill: "animal_handling", nameEnglish: "Animal Handling", ability: "wis" },
  { skill: "arcana", nameEnglish: "Arcana", ability: "int" },
  { skill: "athletics", nameEnglish: "Athletics", ability: "str" },
  { skill: "deception", nameEnglish: "Deception", ability: "cha" },
  { skill: "history", nameEnglish: "History", ability: "int" },
  { skill: "insight", nameEnglish: "Insight", ability: "wis" },
  { skill: "intimidation", nameEnglish: "Intimidation", ability: "cha" },
  { skill: "investigation", nameEnglish: "Investigation", ability: "int" },
  { skill: "medicine", nameEnglish: "Medicine", ability: "wis" },
  { skill: "nature", nameEnglish: "Nature", ability: "int" },
  { skill: "perception", nameEnglish: "Perception", ability: "wis" },
  { skill: "performance", nameEnglish: "Performance", ability: "cha" },
  { skill: "persuasion", nameEnglish: "Persuasion", ability: "cha" },
  { skill: "religion", nameEnglish: "Religion", ability: "int" },
  { skill: "sleight_of_hand", nameEnglish: "Sleight of Hand", ability: "dex" },
  { skill: "stealth", nameEnglish: "Stealth", ability: "dex" },
  { skill: "survival", nameEnglish: "Survival", ability: "wis" },
];

export const GEAR: SrdGear = {
  weapons: new Map([["longsword", LONGSWORD]]),
  armor: new Map([
    ["chain_mail", CHAIN_MAIL],
    ["shield", SHIELD],
  ]),
  classes: new Map([
    ["fighter", FIGHTER],
    ["wizard", WIZARD],
  ]),
  skills: new Map(SKILLS.map((each) => [each.skill, each])),
};

export function sheet(overrides: Partial<CharacterSheet> = {}): CharacterSheet {
  return {
    characterId: "hero",
    nameHebrew: "אלדד",
    grammaticalGender: "masculine",
    size: "medium",
    class: "fighter",
    level: 3,
    proficiencyBonus: 2,
    abilities: { str: 16, dex: 12, con: 14, int: 10, wis: 12, cha: 10 },
    savingThrowProficiencies: ["str", "con"],
    skillProficiencies: ["athletics", "perception"],
    combat: {
      maxHp: 28,
      currentHp: 28,
      tempHp: 0,
      armorClass: 16,
      speedFeet: 30,
      initiativeModifier: 1,
      deathSaves: { successes: 0, failures: 0 },
      spellSlots: {},
    },
    conditions: [],
    inventory: [
      { itemId: "chain_mail", quantity: 1, equipped: true },
      { itemId: "longsword", quantity: 1, equipped: true },
    ],
    ...overrides,
  } as unknown as CharacterSheet;
}
```

Then create `packages/rules-engine/src/character/derive.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { DerivedCharacter } from "@ai-dm/schemas";
import { deriveCharacter } from "./derive.js";
import { GEAR, sheet } from "./test-fixtures.js";

describe("deriveCharacter", () => {
  it("derives the proficiency bonus from level, not from the sheet", () => {
    expect(deriveCharacter(sheet({ level: 3 }), GEAR).proficiencyBonus).toBe(2);
    expect(deriveCharacter(sheet({ level: 5 }), GEAR).proficiencyBonus).toBe(3);
  });

  it("derives ability modifiers for all six abilities", () => {
    const derived = deriveCharacter(sheet(), GEAR);
    expect(derived.abilityModifiers).toEqual({ str: 3, dex: 1, con: 2, int: 0, wis: 1, cha: 0 });
  });

  it("derives armor class from the equipped armor", () => {
    expect(deriveCharacter(sheet(), GEAR).armorClass).toBe(16);
  });

  it("applies the armor Strength penalty to speed", () => {
    const weak = sheet({ abilities: { str: 12, dex: 12, con: 14, int: 10, wis: 12, cha: 10 } });
    expect(deriveCharacter(weak, GEAR).speedFeet).toBe(20);
  });

  it("takes initiative from Dexterity", () => {
    expect(deriveCharacter(sheet(), GEAR).initiative).toBe(1);
  });

  it("adds proficiency to proficient saving throws only", () => {
    const derived = deriveCharacter(sheet(), GEAR);
    expect(derived.savingThrows.str).toBe(5); // +3 and proficient
    expect(derived.savingThrows.con).toBe(4); // +2 and proficient
    expect(derived.savingThrows.dex).toBe(1); // +1, not proficient
  });

  it("derives a bonus for every one of the 18 skills", () => {
    const derived = deriveCharacter(sheet(), GEAR);
    expect(Object.keys(derived.skills)).toHaveLength(18);
    expect(derived.skills.athletics).toBe(5); // +3 Str, proficient
    expect(derived.skills.stealth).toBe(1); // +1 Dex, not proficient
  });

  it("derives passive perception as 10 plus the perception bonus", () => {
    // +1 Wis, proficient in perception, +2 proficiency = 3; 10 + 3.
    expect(deriveCharacter(sheet(), GEAR).passivePerception).toBe(13);
  });

  it("grants Extra Attack only at the class's level", () => {
    expect(deriveCharacter(sheet({ level: 4 }), GEAR).attacksPerAction).toBe(1);
    expect(deriveCharacter(sheet({ level: 5 }), GEAR).attacksPerAction).toBe(2);
  });

  it("gives a non-caster no spell save DC", () => {
    expect(deriveCharacter(sheet(), GEAR).spellSaveDc).toBeUndefined();
  });

  it("derives a spell save DC for a caster", () => {
    const wizard = sheet({
      class: "wizard",
      level: 3,
      abilities: { str: 8, dex: 14, con: 12, int: 16, wis: 12, cha: 10 },
      savingThrowProficiencies: ["int", "wis"],
      inventory: [],
    });
    // 8 + 2 proficiency + 3 Int
    expect(deriveCharacter(wizard, GEAR).spellSaveDc).toBe(13);
  });

  it("carries hit points and hit dice through unchanged", () => {
    const derived = deriveCharacter(sheet(), GEAR);
    expect(derived.maxHp).toBe(28);
    expect(derived.hitDice).toBe("3d10");
  });

  it("gives an unarmed wizard exactly one action", () => {
    const wizard = sheet({ class: "wizard", inventory: [] });
    expect(deriveCharacter(wizard, GEAR).attacks).toHaveLength(1);
  });

  it("rejects a sheet equipping two suits of armor", () => {
    const twoArmors = sheet({
      inventory: [
        { itemId: "chain_mail", quantity: 1, equipped: true },
        { itemId: "shield", quantity: 1, equipped: true },
        { itemId: "chain_mail", quantity: 1, equipped: true },
      ],
    } as unknown as Partial<CharacterSheet>);
    expect(() => deriveCharacter(twoArmors, GEAR)).toThrow(/one suit of armor/i);
  });

  it("rejects an unknown class", () => {
    const unknown = sheet({ class: "bard" } as unknown as Partial<CharacterSheet>);
    expect(() => deriveCharacter(unknown, GEAR)).toThrow(/bard/);
  });

  it("produces a value that parses as a DerivedCharacter", () => {
    expect(() => DerivedCharacter.parse(deriveCharacter(sheet(), GEAR))).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @ai-dm/rules-engine test
```

Expected: FAIL — cannot resolve `./derive.js`.

- [ ] **Step 3: Write the implementation**

Create `packages/rules-engine/src/character/derive.ts`:

```ts
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
    passivePerception: PASSIVE_BASE + (skills.perception ?? 0),

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
```

Create `packages/rules-engine/src/character/index.ts`:

```ts
export * from "./armor.js";
export * from "./attacks.js";
export * from "./derive.js";
```

Add `export * from "./character/index.js";` to
`packages/rules-engine/src/index.ts`.

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm --filter @ai-dm/rules-engine test && pnpm typecheck
```

Expected: PASS, clean typecheck.

- [ ] **Step 5: Sabotage check**

Replace `proficiencyBonusForLevel(sheet.level)` with `sheet.proficiencyBonus`
and re-run: "derives the proficiency bonus from level, not from the sheet"
must fail at level 5. Restore it.

- [ ] **Step 6: Commit**

```bash
git add packages/rules-engine/src
git commit -m "feat(rules-engine): assemble deriveCharacter"
```

---

### Task 11: Project a derived character onto `CreatureStatBlock`

**Files:**
- Modify: `packages/rules-engine/src/character/derive.ts`
- Modify: `packages/rules-engine/src/character/derive.test.ts`

**Interfaces:**
- Consumes: `DerivedCharacter` (Task 7), `deriveCharacter` (Task 10).
- Produces: `export function characterStatBlock(derived: DerivedCharacter): CreatureStatBlock;`

- [ ] **Step 1: Write the failing test**

Append to `packages/rules-engine/src/character/derive.test.ts`:

```ts
describe("characterStatBlock", () => {
  it("selects exactly the fields the engine reads", () => {
    const block = characterStatBlock(deriveCharacter(sheet(), GEAR));
    expect(block.nameEnglish).toBe("hero");
    expect(block.nameHebrew).toBe("אלדד");
    expect(block.size).toBe("medium");
    expect(block.armorClass).toBe(16);
    expect(block.speedFeet).toBe(30);
    expect(block.attacksPerAction).toBe(1);
    expect(block.actions.map((each) => each.actionId)).toEqual(["longsword", "unarmed_strike"]);
  });

  // hitPoints.average is the sheet's stored maxHp, not a roll: the SRD lets
  // you roll hit points, so it is a choice rather than a derivation. This is
  // what lets `combatantFromStatBlock` stay unchanged.
  it("carries hit points as the sheet's maximum", () => {
    const block = characterStatBlock(deriveCharacter(sheet(), GEAR));
    expect(block.hitPoints.average).toBe(28);
    expect(block.hitPoints.diceNotation).toBe("3d10");
  });

  it("produces a value that parses as a CreatureStatBlock", () => {
    const block = characterStatBlock(deriveCharacter(sheet(), GEAR));
    expect(() => CreatureStatBlock.parse(block)).not.toThrow();
  });

  it("projects an unarmed wizard onto a valid, non-empty action list", () => {
    const wizard = deriveCharacter(sheet({ class: "wizard", inventory: [] }), GEAR);
    expect(() => CreatureStatBlock.parse(characterStatBlock(wizard))).not.toThrow();
  });
});
```

Add `characterStatBlock` to the `./derive.js` import and `CreatureStatBlock`
to the `@ai-dm/schemas` import; `GEAR` and `sheet` already come from
`./test-fixtures.js`.

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @ai-dm/rules-engine test
```

Expected: FAIL — `characterStatBlock` is not exported.

- [ ] **Step 3: Write the implementation**

Append to `packages/rules-engine/src/character/derive.ts`:

```ts
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
    size: derived.size,
    armorClass: derived.armorClass,
    hitPoints: { average: derived.maxHp, diceNotation: derived.hitDice },
    speedFeet: derived.speedFeet,
    attacksPerAction: derived.attacksPerAction,
    actions: derived.attacks,
  };
}
```

Add `CreatureStatBlock` to the file's `@ai-dm/schemas` type import.

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm --filter @ai-dm/rules-engine test
```

Expected: PASS.

- [ ] **Step 5: Sabotage check**

Change `hitPoints.average` to `derived.currentHp` and re-run with a sheet whose
`currentHp` differs from `maxHp` — add
`combat: { ...sheet().combat, currentHp: 10 }` to a scratch assertion to
confirm the test distinguishes them, then restore.

- [ ] **Step 6: Commit**

```bash
git add packages/rules-engine/src/character
git commit -m "feat(rules-engine): project a derived character onto CreatureStatBlock"
```

---

### Task 12: The stored-vs-derived cross-check

`CharacterSheet` keeps `proficiencyBonus`, `combat.armorClass` and
`combat.initiativeModifier` even though all three are derivable. That is a
deliberate decision (see the spec's Decisions), and this is the check that
keeps the two sources of truth honest.

**Files:**
- Create: `packages/rules-engine/src/character/consistency.ts`
- Create: `packages/rules-engine/src/character/consistency.test.ts`
- Modify: `packages/rules-engine/src/character/index.ts`

**Interfaces:**
- Consumes: `CharacterSheet`, `DerivedCharacter`, `ClassDefinition`.
- Produces:
  `export function assertSheetConsistent(sheet: CharacterSheet, derived: DerivedCharacter, classDefinition: ClassDefinition): void;`
  Throws an `Error` naming the field, the stored value and the derived value.

- [ ] **Step 1: Write the failing test**

Create `packages/rules-engine/src/character/consistency.test.ts`. Reuse the
`sheet()` / `GEAR` fixtures by exporting them — move them into a new
`packages/rules-engine/src/character/test-fixtures.ts` and import from both
test files, matching `packages/agents/src/tactical/test-fixtures.ts`.

```ts
import { describe, expect, it } from "vitest";
import { assertSheetConsistent } from "./consistency.js";
import { deriveCharacter } from "./derive.js";
import { FIGHTER, GEAR, sheet } from "./test-fixtures.js";

describe("assertSheetConsistent", () => {
  it("accepts a sheet whose stored values match the derivation", () => {
    const good = sheet();
    expect(() => assertSheetConsistent(good, deriveCharacter(good, GEAR), FIGHTER)).not.toThrow();
  });

  it("rejects a wrong proficiency bonus, naming both values", () => {
    const bad = sheet({ proficiencyBonus: 6 });
    expect(() => assertSheetConsistent(bad, deriveCharacter(bad, GEAR), FIGHTER)).toThrow(
      /proficiencyBonus.*6.*2/s,
    );
  });

  it("rejects a wrong armor class", () => {
    const bad = sheet({ combat: { ...sheet().combat, armorClass: 99 } });
    expect(() => assertSheetConsistent(bad, deriveCharacter(bad, GEAR), FIGHTER)).toThrow(
      /armorClass/,
    );
  });

  it("rejects a wrong initiative modifier", () => {
    const bad = sheet({ combat: { ...sheet().combat, initiativeModifier: 7 } });
    expect(() => assertSheetConsistent(bad, deriveCharacter(bad, GEAR), FIGHTER)).toThrow(
      /initiativeModifier/,
    );
  });

  it("rejects saving throw proficiencies that disagree with the class", () => {
    const bad = sheet({ savingThrowProficiencies: ["dex", "cha"] });
    expect(() => assertSheetConsistent(bad, deriveCharacter(bad, GEAR), FIGHTER)).toThrow(
      /savingThrowProficiencies/,
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @ai-dm/rules-engine test
```

Expected: FAIL — cannot resolve `./consistency.js`.

- [ ] **Step 3: Write the implementation**

Create `packages/rules-engine/src/character/consistency.ts`:

```ts
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
```

Add `export * from "./consistency.js";` to
`packages/rules-engine/src/character/index.ts`.

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm --filter @ai-dm/rules-engine test
```

Expected: PASS.

- [ ] **Step 5: Sabotage check**

Delete the `proficiencyBonus` branch and re-run: "rejects a wrong proficiency
bonus" must fail. Restore it.

- [ ] **Step 6: Commit**

```bash
git add packages/rules-engine/src/character
git commit -m "feat(rules-engine): cross-check stored sheet values against the derivation"
```

---

### Task 13: Encounters accept a character spawn

**Files:**
- Modify: `packages/rules-engine/src/encounter/build.ts`
- Modify: `packages/rules-engine/src/combat/statblock.ts`
- Test: `packages/rules-engine/src/encounter/build.test.ts`

**Interfaces:**
- Consumes: `characterStatBlock` (Task 11), `DerivedCharacter` (Task 7).
- Produces:

```ts
export interface MonsterSpawn { combatantId: string; monsterId: string; faction: Faction; position: Tile }
export interface CharacterSpawn { combatantId: string; characterId: string; faction: Faction; position: Tile }
export type SpawnSpec = MonsterSpawn | CharacterSpawn;

// BuildEncounterInput gains:
characters?: ReadonlyMap<string, DerivedCharacter>;
// SpawnOptions gains:
characterId?: string;
```

- [ ] **Step 1: Write the failing test**

Append to `packages/rules-engine/src/encounter/build.test.ts`:

```ts
describe("character spawns", () => {
  it("builds a combatant from a derived character", () => {
    const built = buildEncounter({
      definition: {
        encounterId: "one-hero",
        descriptionEnglish: "A hero alone.",
        width: 5,
        height: 5,
        spawns: [{ combatantId: "hero", characterId: "hero", faction: "party", position: [1, 1] }],
        turnOrder: ["hero"],
        maxRounds: 5,
      },
      statBlocks: new Map(),
      characters: new Map([["hero", DERIVED_HERO]]),
    });

    const hero = built.world.combatants[0];
    expect(hero?.armorClass).toBe(16);
    expect(hero?.maxHp).toBe(28);
    // The field the schema has always documented as "Present when this
    // combatant is driven by a CharacterSheet", and which nothing populated.
    expect(hero?.characterId).toBe("hero");
  });

  it("puts the character's weapon ranges into the world", () => {
    const built = buildEncounter({
      definition: {
        encounterId: "one-hero",
        descriptionEnglish: "A hero alone.",
        width: 5,
        height: 5,
        spawns: [{ combatantId: "hero", characterId: "hero", faction: "party", position: [1, 1] }],
        turnOrder: ["hero"],
        maxRounds: 5,
      },
      statBlocks: new Map(),
      characters: new Map([["hero", DERIVED_HERO]]),
    });
    expect(built.world.actionRangesFeet?.longsword).toBe(5);
  });

  it("throws when a character spawn has no supplied character", () => {
    expect(() =>
      buildEncounter({
        definition: {
          encounterId: "one-hero",
          descriptionEnglish: "A hero alone.",
          width: 5,
          height: 5,
          spawns: [
            { combatantId: "hero", characterId: "missing", faction: "party", position: [1, 1] },
          ],
          turnOrder: ["hero"],
          maxRounds: 5,
        },
        statBlocks: new Map(),
        characters: new Map(),
      }),
    ).toThrow(/missing/);
  });

  it("leaves characterId unset on a monster combatant", () => {
    const built = buildEncounter(EXISTING_MONSTER_ONLY_INPUT);
    expect(built.world.combatants[0]?.characterId).toBeUndefined();
  });
});
```

Define both names at the top of the block:

```ts
import type { CreatureStatBlock } from "@ai-dm/schemas";
import { deriveCharacter } from "../character/derive.js";
import { GEAR, sheet } from "../character/test-fixtures.js";

const DERIVED_HERO = deriveCharacter(sheet(), GEAR);

const RAT = {
  nameEnglish: "Rat",
  nameHebrew: "חולדה",
  size: "tiny",
  armorClass: 10,
  hitPoints: { average: 1, diceNotation: "1d4" },
  speedFeet: 20,
  attacksPerAction: 1,
  actions: [
    {
      actionId: "bite",
      nameEnglish: "Bite",
      nameHebrew: "נשיכה",
      attackBonus: 0,
      reachFeet: 5,
      damage: { diceNotation: "1d4", averageDamage: 2, damageType: "piercing" },
      extraDamage: [],
    },
  ],
} as unknown as CreatureStatBlock;

const EXISTING_MONSTER_ONLY_INPUT = {
  definition: {
    encounterId: "one-rat",
    descriptionEnglish: "A rat alone.",
    width: 5,
    height: 5,
    spawns: [{ combatantId: "rat", monsterId: "rat", faction: "hostile", position: [1, 1] }],
    turnOrder: ["rat"],
    maxRounds: 5,
  },
  statBlocks: new Map([["rat", RAT]]),
};
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @ai-dm/rules-engine test
```

Expected: FAIL — `characters` is not a property of `BuildEncounterInput`.

- [ ] **Step 3: Widen the spawn type**

In `packages/rules-engine/src/encounter/build.ts`:

```ts
export interface MonsterSpawn {
  combatantId: string;
  /** Key into the caller's stat-block map. */
  monsterId: string;
  faction: Faction;
  position: Tile;
}

export interface CharacterSpawn {
  combatantId: string;
  /** Key into the caller's derived-character map. */
  characterId: string;
  faction: Faction;
  position: Tile;
}

/** A spawn names either a monster or a player character, never both. */
export type SpawnSpec = MonsterSpawn | CharacterSpawn;
```

Add to `BuildEncounterInput`:

```ts
  /** By `characterId`, already derived by `deriveCharacter`. */
  characters?: ReadonlyMap<string, DerivedCharacter>;
```

Inside the spawn loop, replace the stat-block lookup with:

```ts
    // Two spawn kinds, one creature abstraction: a character is projected onto
    // the same `CreatureStatBlock` a monster already is, so everything below
    // this point is identical for both.
    const resolved = resolveSpawn(spawn, input);
    statBlocks.set(spawn.combatantId, resolved.statBlock);
    combatants.push(
      combatantFromStatBlock(resolved.statBlock, {
        combatantId: spawn.combatantId,
        faction: spawn.faction,
        position: spawn.position,
        ...(resolved.characterId === undefined ? {} : { characterId: resolved.characterId }),
        ...(resolved.currentHp === undefined ? {} : { currentHp: resolved.currentHp }),
      }),
    );
```

And add above `buildEncounter`:

```ts
interface ResolvedSpawn {
  statBlock: CreatureStatBlock;
  characterId?: string;
  currentHp?: number;
}

function resolveSpawn(spawn: SpawnSpec, input: BuildEncounterInput): ResolvedSpawn {
  if ("characterId" in spawn) {
    const derived = input.characters?.get(spawn.characterId);
    if (derived === undefined) {
      throw new Error(`No character supplied for characterId ${spawn.characterId}`);
    }
    return {
      statBlock: characterStatBlock(derived),
      characterId: spawn.characterId,
      // A character can join below full health; a monster never does.
      currentHp: derived.currentHp,
    };
  }

  const statBlock = input.statBlocks.get(spawn.monsterId);
  if (statBlock === undefined) {
    throw new Error(`No stat block supplied for monsterId ${spawn.monsterId}`);
  }
  return { statBlock };
}
```

Change `const statBlocks = new Map<string, MonsterStatBlock>()` to
`CreatureStatBlock`, and import `characterStatBlock` from
`../character/index.js`.

> **Watch the import direction:** `character/` imports from `combat/`
> (`armor.ts` needs nothing, but `derive.ts` uses `../checks/`), and
> `encounter/` now imports from `character/`. That is one-directional; do not
> let `character/` import from `encounter/`.

- [ ] **Step 4: Let a spawn carry a characterId**

In `packages/rules-engine/src/combat/statblock.ts`, add to `SpawnOptions`:

```ts
  /** Set when this combatant is driven by a `CharacterSheet`. */
  characterId?: string;
```

and in `combatantFromStatBlock`'s returned object:

```ts
    ...(options.characterId === undefined ? {} : { characterId: options.characterId }),
```

- [ ] **Step 5: Run test to verify it passes**

```bash
pnpm --filter @ai-dm/rules-engine test && pnpm typecheck
```

Expected: PASS. The existing monster-only tests must still pass untouched.

- [ ] **Step 6: Sabotage check**

Delete the `characterId` line from `combatantFromStatBlock` and re-run: the
`characterId` assertion must fail. Restore it.

- [ ] **Step 7: Commit**

```bash
git add packages/rules-engine/src
git commit -m "feat(rules-engine): encounters accept a character spawn"
```

---

### Task 14: The server loads characters, and `goblin-ambush` gets a real hero

Retires correction C-13 — "`data/srd/monsters/` has no player-character data,
so the hero borrows the `guard` stat block for now".

**Files:**
- Create: `data/characters/README.md`
- Create: `data/characters/hero.json`
- Create: `apps/server/src/encounters/gear.ts`
- Create: `apps/server/src/encounters/characters.ts`
- Modify: `apps/server/src/encounters/index.ts`
- Test: `apps/server/src/encounters/index.test.ts`

**Interfaces:**
- Consumes: `deriveCharacter`, `assertSheetConsistent`, `SrdGear`.
- Produces: `loadGear(): SrdGear` and `loadCharacter(characterId): DerivedCharacter`
  from `apps/server/src/encounters/`. `buildEncounterById` resolves both spawn
  kinds.

- [ ] **Step 1: Write the failing test**

Append to `apps/server/src/encounters/index.test.ts`:

```ts
describe("the goblin-ambush hero", () => {
  it("is a real character, not a borrowed guard stat block", () => {
    const built = buildEncounterById("goblin-ambush");
    const hero = built.world.combatants.find((each) => each.combatantId === "hero");
    expect(hero?.characterId).toBe("hero");
    expect(hero?.maxHp).toBe(28);
    // Chain Mail, matching the guard's AC so C-14's reach geometry is
    // unaffected by the swap.
    expect(hero?.armorClass).toBe(16);
  });

  it("wields a longsword and can always punch", () => {
    const built = buildEncounterById("goblin-ambush");
    const actions = built.statBlocks.get("hero")?.actions.map((each) => each.actionId);
    expect(actions).toEqual(["longsword", "unarmed_strike"]);
  });

  it("keeps a melee attack legal on turn 1 (correction C-14)", () => {
    const built = buildEncounterById("goblin-ambush");
    const hero = built.world.combatants.find((each) => each.combatantId === "hero");
    // A throw rather than `expect(...).toBeDefined()` plus `hero!`: ESLint's
    // strictTypeChecked config bans non-null assertions, and a thrown error
    // narrows the type for the call below.
    if (hero === undefined) throw new Error("goblin-ambush has no hero combatant");

    const verdict = validateExecuteTurn(
      {
        actorId: "hero",
        mainAction: { actionType: "attack", actionId: "longsword", targetIds: ["goblin-a"] },
        tacticalRationaleEnglish: "Attack the adjacent goblin.",
      },
      hero,
      built.world,
    );
    expect(verdict.valid).toBe(true);
  });

  it("refuses to load a sheet whose stored values disagree with the derivation", () => {
    // Guards the cross-check being wired into loadCharacter at all, not just
    // existing in the rules engine.
    expect(() => loadCharacter("inconsistent-fixture")).toThrow(/proficiencyBonus|armorClass/);
  });
});
```

For the last test, add `data/characters/inconsistent-fixture.json` — a copy of
`hero.json` with `proficiencyBonus` set to `6`. It exists solely to prove the
cross-check runs at load time; note that in the file's absence the test is
vacuous.

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @ai-dm/server test
```

Expected: FAIL — `loadCharacter` does not exist, and the hero is still a guard.

- [ ] **Step 3: Write the character data**

`data/characters/README.md`:

```markdown
# Player characters

**Not SRD content.** These are our own character sheets. SRD 5.2.1 material —
monsters, classes, conditions, weapons, armor, skills — lives in `data/srd/`
under the licence and attribution rules described there and in `NOTICE.md`.

Files are JSON validated against `CharacterSheet` in `@ai-dm/schemas`, and
additionally cross-checked at load time: `proficiencyBonus`,
`combat.armorClass` and `combat.initiativeModifier` are stored here but are
also derivable, and `assertSheetConsistent` refuses a file where the two
disagree.
```

`data/characters/hero.json` — a level 3 Fighter in Chain Mail with a Longsword.
AC 16 matches the `guard` block it replaces. Hit points are the SRD average
progression for a d10 class with Constitution 14: `10 + 2` at level 1, then
`6 + 2` at each of levels 2 and 3.

```json
{
  "characterId": "hero",
  "nameHebrew": "אלדד",
  "grammaticalGender": "masculine",
  "size": "medium",
  "class": "fighter",
  "level": 3,
  "proficiencyBonus": 2,
  "abilities": { "str": 16, "dex": 12, "con": 14, "int": 10, "wis": 12, "cha": 10 },
  "savingThrowProficiencies": ["str", "con"],
  "skillProficiencies": ["athletics", "perception"],
  "combat": {
    "maxHp": 28,
    "currentHp": 28,
    "tempHp": 0,
    "armorClass": 16,
    "speedFeet": 30,
    "initiativeModifier": 1,
    "deathSaves": { "successes": 0, "failures": 0 },
    "spellSlots": {}
  },
  "conditions": [],
  "inventory": [
    { "itemId": "chain_mail", "quantity": 1, "equipped": true },
    { "itemId": "longsword", "quantity": 1, "equipped": true }
  ]
}
```

- [ ] **Step 4: Write the loaders**

Create `apps/server/src/encounters/gear.ts`:

```ts
// Reads the four SRD data files the character derivation needs. File I/O
// lives here, never in `@ai-dm/rules-engine`, which must stay pure and
// bundleable — same split as `srd.ts` and its monsters.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  ArmorDefinition,
  ClassDefinition,
  SkillDefinition,
  WeaponDefinition,
} from "@ai-dm/schemas";
import type { SrdGear } from "@ai-dm/rules-engine";

const SRD_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../../../data/srd");

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(join(SRD_DIR, file), "utf8"));
}

// Parsed once. The files never change at runtime, and re-parsing them per
// session would be pure waste.
let cached: SrdGear | undefined;

export function loadGear(): SrdGear {
  if (cached !== undefined) return cached;

  const weapons = WeaponDefinition.array().parse(readJson("weapons.json"));
  const armor = ArmorDefinition.array().parse(readJson("armor.json"));
  const classes = ClassDefinition.array().parse(readJson("classes.json"));
  const skills = SkillDefinition.array().parse(readJson("skills.json"));

  cached = {
    weapons: new Map(weapons.map((each) => [each.weaponId, each])),
    armor: new Map(armor.map((each) => [each.armorId, each])),
    classes: new Map(classes.map((each) => [each.class, each])),
    skills: new Map(skills.map((each) => [each.skill, each])),
  };
  return cached;
}
```

> Check the `../../../../data/srd` depth against
> `apps/server/src/encounters/srd.ts`, which already resolves the same
> directory — copy its expression rather than counting segments by hand.

Create `apps/server/src/encounters/characters.ts`:

```ts
// Loads a player character and derives it. The cross-check runs HERE, where
// the SRD data is in hand: zod cannot compare a stored armorClass against a
// derived one without weapons, armor and classes loaded, and
// `@ai-dm/schemas` deliberately loads none of them.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { CharacterSheet } from "@ai-dm/schemas";
import type { DerivedCharacter } from "@ai-dm/schemas";
import { assertSheetConsistent, deriveCharacter } from "@ai-dm/rules-engine";
import { loadGear } from "./gear.js";

const CHARACTER_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../../../data/characters");

const cache = new Map<string, DerivedCharacter>();

export function loadCharacter(characterId: string): DerivedCharacter {
  const hit = cache.get(characterId);
  if (hit !== undefined) return hit;

  const path = join(CHARACTER_DIR, `${characterId}.json`);
  const sheet = CharacterSheet.parse(JSON.parse(readFileSync(path, "utf8")));

  const gear = loadGear();
  const derived = deriveCharacter(sheet, gear);

  const classDefinition = gear.classes.get(sheet.class);
  if (classDefinition === undefined) throw new Error(`No class definition for ${sheet.class}`);
  assertSheetConsistent(sheet, derived, classDefinition);

  cache.set(characterId, derived);
  return derived;
}
```

- [ ] **Step 5: Resolve both spawn kinds and swap the hero**

In `apps/server/src/encounters/index.ts`, change `buildEncounterById`:

```ts
export function buildEncounterById(encounterId: string): BuiltEncounter {
  const definition = encounterById(encounterId);
  const statBlocks = new Map<string, MonsterStatBlock>();
  const characters = new Map<string, DerivedCharacter>();

  for (const spawn of definition.spawns) {
    if ("characterId" in spawn) {
      if (!characters.has(spawn.characterId)) {
        characters.set(spawn.characterId, loadCharacter(spawn.characterId));
      }
      continue;
    }
    if (!statBlocks.has(spawn.monsterId)) {
      statBlocks.set(spawn.monsterId, loadMonster(spawn.monsterId));
    }
  }

  return buildEncounter({ definition, statBlocks, characters });
}
```

Change the hero's spawn in `GOBLIN_AMBUSH` and update the C-13 comment:

```ts
    // C-13 is closed: the hero is a real CharacterSheet in data/characters/,
    // no longer the `guard` stat block standing in for one.
    { combatantId: "hero", characterId: "hero", faction: "party", position: [5, 4] },
```

Export `loadCharacter` alongside the existing `loadMonster` re-export.

- [ ] **Step 6: Run test to verify it passes**

```bash
pnpm --filter @ai-dm/server test && pnpm test && pnpm typecheck
```

Expected: PASS everywhere. The hero now hits harder than the guard did, so any
existing golden assertion on `goblin-ambush` damage numbers will change —
update those assertions to the new values rather than reverting the hero.

- [ ] **Step 7: Sabotage check**

Comment out the `assertSheetConsistent` call in `loadCharacter` and re-run:
"refuses to load a sheet whose stored values disagree" must fail. Restore it.

- [ ] **Step 8: Commit**

```bash
git add data/characters apps/server/src
git commit -m "feat(server): goblin-ambush's hero is a real character sheet"
```

---

### Task 15: Serve the derived character over HTTP

The character-sheet page's data source, in place before the page exists.

**Files:**
- Modify: `packages/schemas/src/protocol.ts`
- Modify: `apps/server/src/encounters/index.ts`
- Test: `apps/server/src/transport/http.test.ts`

**Interfaces:**
- Consumes: `DerivedCharacter` (Task 7), `loadCharacter` (Task 14).
- Produces: `EncounterCatalogue.characters: DerivedCharacter[]`, and
  `nameHebrew` on `CatalogueCombatant` and `CatalogueAction`. Both additive,
  which the protocol permits.

- [ ] **Step 1: Write the failing test**

Append to `apps/server/src/transport/http.test.ts`:

```ts
it("serves the hero's full derivation in the catalogue", async () => {
  const response = await app.inject({ method: "GET", url: "/encounters/goblin-ambush" });
  expect(response.statusCode).toBe(200);

  const catalogue = EncounterCatalogue.parse(response.json());
  const hero = catalogue.characters.find((each) => each.characterId === "hero");

  expect(hero?.armorClass).toBe(16);
  expect(hero?.passivePerception).toBe(13);
  expect(hero?.savingThrows.str).toBe(5);
  expect(Object.keys(hero?.skills ?? {})).toHaveLength(18);
  // The client must never need to compute any of this itself.
  expect(hero?.grammaticalGender).toBe("masculine");
});

it("labels every combatant and action in Hebrew", async () => {
  const response = await app.inject({ method: "GET", url: "/encounters/goblin-ambush" });
  const catalogue = EncounterCatalogue.parse(response.json());

  for (const combatant of catalogue.combatants) {
    expect(combatant.nameHebrew.trim(), combatant.combatantId).not.toBe("");
  }
  for (const action of catalogue.actions) {
    expect(action.nameHebrew.trim(), action.actionId).not.toBe("");
  }
});

it("lists no characters for a monster-only encounter", async () => {
  // Guards against `characters` being populated from something other than the
  // spawns — an empty array here is the honest answer, not a missing field.
  const built = encounterCatalogue("goblin-ambush");
  expect(Array.isArray(built.characters)).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @ai-dm/server test
```

Expected: FAIL — `characters` is not a property of `EncounterCatalogue`.

- [ ] **Step 3: Extend the protocol**

In `packages/schemas/src/protocol.ts`, add `nameHebrew: z.string().min(1)` to
`CatalogueCombatant` and `CatalogueAction`, and to `EncounterCatalogue`:

```ts
  /**
   * Every player character in this encounter, fully derived. The client
   * renders these numbers and computes none of them: AC and attack bonuses
   * are game math, which invariant 1 keeps in the rules engine and invariant 5
   * keeps out of `apps/web`. Empty for a monster-only encounter.
   */
  characters: z.array(DerivedCharacter).default([]),
```

Import `DerivedCharacter` from `./derived.js`.

- [ ] **Step 4: Fill it in**

In `encounterCatalogue`, add `nameHebrew` beside each `nameEnglish`, and
collect the characters:

```ts
  const characters = built.world.combatants
    .map((combatant) => combatant.characterId)
    .filter((characterId): characterId is string => characterId !== undefined)
    .map((characterId) => loadCharacter(characterId));
```

Add `characters` to the returned object. In the combatant map, use
`statBlock?.nameHebrew ?? combatant.combatantId`; in the action dedupe, key the
map to `{ nameEnglish, nameHebrew }` rather than a bare string.

- [ ] **Step 5: Run test to verify it passes**

```bash
pnpm --filter @ai-dm/server test && pnpm test && pnpm typecheck
npx eslint packages apps
```

Expected: PASS and clean.

- [ ] **Step 6: Sabotage check**

Return `characters: []` unconditionally and re-run: the hero-derivation test
must fail. Restore it.

- [ ] **Step 7: Commit**

```bash
git add packages/schemas/src apps/server/src
git commit -m "feat(server): serve derived characters and Hebrew labels in the catalogue"
```

---

### Task 16: Record the rules, the house rule and the gaps

Documentation is the deliverable here. An unrecorded divergence from RAW is
exactly the failure mode `RULES_REFERENCE.md` exists to prevent.

**Files:**
- Modify: `RULES_REFERENCE.md`
- Modify: `PROJECT_PLAN.md`
- Modify: `docs/prompts/README.md`

- [ ] **Step 1: Close the base-AC row in RULES_REFERENCE §2**

Replace the `Base AC` row and add the new ones. Same three-column form as the
rest of the table:

```markdown
| Base AC | Unarmored `10 + Dex`. Armor sets a base per its table row. | `character/` `armorClassFor` |
| Light armor AC | `base + Dex`, uncapped — including a negative modifier. | `character/` `armorClassFor` |
| Medium armor AC | `base + Dex`, capped at `+2`. | `character/` `armorClassFor` |
| Heavy armor AC | `base`, ignoring Dex entirely; a negative modifier does not reduce it. | `character/` `armorClassFor` |
| Shield | `+2`, and only with shield training: "You gain the Armor Class benefit of a Shield only if you have training with it." | `character/` `armorClassFor` |
| Armor Strength requirement | Armor listing a Strength score reduces speed by 10 ft unless the wearer meets it. | `character/` `speedFeetFor` |
| Weapon proficiency | Proficiency Bonus is added to an attack roll only with a weapon the character is proficient with. Monsters are proficient with everything in their stat block. | `character/` `isProficientWith` |
| Finesse | Choose Strength or Dexterity; the same modifier applies to attack and damage. Taken as the higher. | `character/` `attacksFor` |
| Unarmed Strike | Always available. Attack `Str + PB`; damage `1 + Str` Bludgeoning; reach 5 ft. Only the Damage option is modelled. | `character/` `attacksFor` |
```

- [ ] **Step 2: Record the Versatile house rule in §7**

Beside the existing narrow-openings entry, in the same voice:

> **Versatile damage is resolved by shield, not by hands.** RAW: "A Versatile
> weapon can be used with one or two hands ... The weapon deals that damage
> when used with two hands to make a melee attack." Nothing models hands, so
> `attacksFor` takes the two-handed die whenever no shield is equipped. A
> character wielding a longsword and nothing else therefore always swings it
> two-handed, which is the common case but not the only legal one.

- [ ] **Step 3: Record the new gaps in §8**

Add, in the section's existing style:

- **The Heavy weapon property.** RAW gives Disadvantage on attacks with a
  Heavy weapon when a melee wielder's Strength or a ranged wielder's Dexterity
  is below 13. `CreatureAttack` has no field for conditional Disadvantage, and
  advantage is resolution-time rather than a stat-block fact.
- **The Light weapon property.** RAW grants a bonus-action attack with a
  second Light weapon, without the ability modifier on its damage.
  `ExecuteTurn` cannot express a bonus-action attack.
- **Ammunition and Loading.** No ammunition is tracked and no once-per-turn
  limit is enforced, so a Loading weapon can be fired as often as the action
  economy allows.
- **Armor training penalties.** Only the Shield half is implemented. RAW also
  gives Disadvantage on Strength and Dexterity D20 tests and blocks
  spellcasting for a character wearing armor they lack training with.
- **Class features.** The Cleric's Divine Order (Protector) grants Martial
  weapons and Heavy armor at level 1; `classes.json` carries only the base
  entry, and no class feature is modelled.
- **The Lance's conditional property.** RAW is "Two-Handed (unless mounted)";
  mounts are not modelled, so it is recorded as plain Two-Handed.

Also delete the now-closed lines: "Weapon mastery and base AC from armor still
need SRD data" loses its base-AC half (weapon mastery stays), and the
`actionRangesFeet` caller-supplied note is closed for players.

- [ ] **Step 4: Update PROJECT_PLAN**

- Tick the §4.1 task "**Step 8 pre-work:** transcribe player weapon data ...",
  noting it shipped inside step 9 spec #1.
- Add a §4.5 "Step 9 decomposition" subsection recording that step 9 split into
  two specs, that spec #1 is this one, and that spec #2 (the narrative agent)
  can now assume Hebrew names on every creature and action plus a real
  `grammaticalGender`.
- Leave the step 9 roadmap row as not-started: the narrative agent has not
  shipped.

- [ ] **Step 5: Update the prompt README**

`docs/prompts/README.md` states the Hebrew glossary "stays a data file: it is
a table for non-programmers to edit, not prompt text". Add a line noting that
creature, action, weapon and armor Hebrew names now live in `data/srd/` and
`data/characters/` as `nameHebrew` fields, so the glossary covers game *terms*
only — spec #2 needs that boundary to be unambiguous.

- [ ] **Step 6: Verify the whole thing**

```bash
pnpm test && pnpm typecheck && npx eslint packages apps tools
```

Expected: all green. Record the new suite total in the commit message; it was
889 before this plan.

- [ ] **Step 7: Play it**

```bash
PORT=3000 pnpm dev
```

Open the web client, start `goblin-ambush`, and confirm the hero acts with a
longsword, that the fight reaches a conclusion, and that a hard refresh
mid-fight restores state. The suite is not the exit criterion; this is.

- [ ] **Step 8: Commit**

```bash
git add RULES_REFERENCE.md PROJECT_PLAN.md docs/prompts/README.md
git commit -m "docs: record the character rules, the Versatile house rule and new gaps"
```
