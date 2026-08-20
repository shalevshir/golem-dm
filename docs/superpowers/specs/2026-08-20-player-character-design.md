# Player character in the engine: derived sheets and SRD gear data — design

Spec #1 of step 9. Step 9 is "narrative agent" in the roadmap, but the agent
needs a Hebrew-named hero with a grammatical gender to narrate about, and no
player character exists in this repo: `goblin-ambush`'s `hero` borrows the
`guard` monster stat block (correction C-13), and `CharacterSheet` — defined
in step 3 — is referenced by nothing but its own tests. This spec builds the
character; spec #2 builds the agent.

It also subsumes the "Step 8 pre-work" task in `PROJECT_PLAN.md` §4.1
(transcribe player weapon data and armor/base AC into `data/srd/`), which is
its prerequisite rather than a separate errand.

Exit criterion: `goblin-ambush`'s hero is a real `CharacterSheet` whose AC,
attacks, damage and speed are derived from equipped SRD gear, the fight still
plays to a conclusion in a browser, and `GET /encounters/goblin-ambush`
serves a `DerivedCharacter` that a future character-sheet page can render
without the client computing any 5e math.

## Context

Every rule below was checked against the SRD 5.2.1 notebook
(`3a0d4f39-93c2-48ee-b1d1-258c7f7583ab`, §4.1) rather than recalled. Three
drafted rules were wrong before that check and are corrected here: AC is
specified per armor row rather than per category, armor carries a Strength
requirement that costs 10 feet of speed, and the Shield's +2 is conditional
on training. `RULES_REFERENCE.md` §2 already records base AC as "not yet —
comes with SRD data"; this closes that row.

The load-bearing measurement for the design is this. The engine reads exactly
seven fields off a stat block, across every non-test file in the repo:

```
7  statBlock.actions        1  statBlock.speedFeet     1  statBlock.hitPoints
1  statBlock.nameEnglish    1  statBlock.size          1  statBlock.attacksPerAction
                                                       1  statBlock.armorClass
```

Never `abilities`, `proficiencyBonus`, `challengeRating`, `alignment`,
`creatureType` or `monsterId`. A player character therefore does not need a
union type, and does not need branches at the six call sites that take a stat
block today.

The SRD's own division of labour matches: "A monster is proficient with any
weapon in its stat block", so a monster's `attackBonus` is a printed final
number, while a character's is derived from ability, proficiency and gear.
Monsters arrive pre-derived; characters must be derived.

## Decisions

- **Three layers, not two.** `CharacterSheet` (choices) →
  `deriveCharacter()` → `DerivedCharacter` (all 5e math) → a thin selector
  producing the engine's `CreatureStatBlock`. The middle layer is the point:
  a character-sheet page needs the same AC, attack, save and skill numbers
  the engine needs, and computing them privately inside a combat projection
  would force the page to re-derive them — two implementations of 5e math,
  which invariants 1 and 4 both forbid.
- **The client never derives.** AC and attack bonuses are game math, so
  invariant 1 puts them in `rules-engine`, which `apps/web` may not import
  (invariant 5). The server derives and serves `DerivedCharacter`, exactly as
  it already computes affordances server-side rather than letting the client
  recompute legality. `DerivedCharacter` is a zod schema in `@ai-dm/schemas`
  so the client gets the type without the math, mirroring `TurnAffordances`.
- **Stored derived fields stay, and are cross-checked.** `proficiencyBonus`,
  `combat.armorClass` and `combat.initiativeModifier` remain on
  `CharacterSheet` and a load-time check fails loudly when a stored value
  disagrees with the derived one. This keeps zod parsing pure — `@ai-dm/schemas`
  loads no SRD data and must not start — and puts the comparison where SRD
  data already lives. The cost accepted knowingly: two sources of truth,
  reconciled by a check rather than by construction.
- **Character sheets are not SRD content.** They live in `data/characters/`,
  never `data/srd/`, so that directory's rule ("Only content from the SRD
  5.2.1 may be placed here") stays true by construction.
- **Hebrew names are data, added now.** `nameHebrew` on stat blocks, attacks,
  weapons and armor. Spec #2's narrator has nothing to name things with
  otherwise, and adding it later means re-touching every data file.

## Non-goals

- **Death saving throws.** RULES_REFERENCE §8's first gap, and the most
  natural next slice, but orthogonal to CharacterSheet plumbing and
  deliberately deferred. The hero keeps dying at 0 HP (correction C-31), so
  the server's stop condition and the client's `conclusionOf` are untouched.
- **Weapon mastery.** SRD-gated behind a class feature ("usable only by a
  character who has a feature, such as Weapon Mastery"), and no class
  features are implemented. Not transcribed, so nothing can read it.
- **Species, background, languages, feats, hit dice, attunement, currency,
  spells known.** A character page wants all of these eventually. None is
  needed for combat, and each is additive to `DerivedCharacter` rather than
  a change to it, so the derivation layer is what makes them cheap later.
- **Multiclassing.** `CharacterSheet.class` is a single class.
- **Spellcasting as actions.** `spellSaveDc` is derived and served, but no
  spell becomes an `actions[]` entry. `data/srd/` has no spell data.

## Schema changes (`@ai-dm/schemas`)

**`CreatureStatBlock`** — a new object carrying exactly what the engine
reads, plus `nameHebrew`:

| Field | Notes |
|---|---|
| `nameEnglish`, `nameHebrew` | `nameHebrew` new on both creature kinds |
| `size` | `CreatureSize` |
| `speedFeet` | already derived for characters — see armor Strength below |
| `armorClass` | |
| `hitPoints` | `{ average, diceNotation }` |
| `attacksPerAction` | |
| `actions` | `CreatureAttack[]` — `MonsterAttack` renamed, `nameHebrew` added |

`MonsterStatBlock` becomes `CreatureStatBlock` extended with `monsterId`,
`creatureType`, `alignment`, `abilities`, `challengeRating`,
`proficiencyBonus`. Engine signatures widen from `MonsterStatBlock` to
`CreatureStatBlock` in `combatantFromStatBlock`, `meleeReachFeet`,
`actionRangesFeetFrom`, `affordancesFor`, `applyTurn`'s `statBlocks` map,
`BuildEncounterInput`, and `availableActionsFor` in `@ai-dm/agents`. The
widening is **type-only**: every existing `MonsterStatBlock` still satisfies
it, no runtime behaviour changes, and no existing test needs editing.

**`CharacterSheet`** gains:

- `size: CreatureSize` defaulting to `"medium"`. There is no species field
  and this spec does not add one; a default beats inventing a species system
  for one value.
- `inventory[].equipped: boolean` defaulting to `false`. Needed to know which
  armor is worn and which weapons are actions — and it is what a character
  page shows as equipped versus carried. At most one equipped armor and one
  equipped shield, per "A creature can wear only one suit of armor at a time
  and wield only one Shield at a time" — enforced in `deriveCharacter`, not
  in zod, because classifying an `itemId` as armor requires SRD data that
  `@ai-dm/schemas` deliberately never loads.
- `skillProficiencies` retyped from `z.array(z.string())` — which accepts
  `"banana"` today — to `z.array(Skill)` over a new 18-value `Skill` enum.

**`DerivedCharacter`** — new, and the character page's contract:

```
characterId, nameHebrew, grammaticalGender, class, level, size
abilityModifiers: Record<AbilityKey, number>
proficiencyBonus, armorClass, initiative, speedFeet, passivePerception
maxHp, currentHp, tempHp
hitDice               // `${level}d${class.hitDie}`
savingThrows: Record<AbilityKey, number>
skills: Record<Skill, number>
attacks: CreatureAttack[]
attacksPerAction
spellSaveDc?          // absent for a non-caster
```

Hit points are carried, not derived: the SRD lets you roll them, so `maxHp`
is a stored choice. They are here because `characterStatBlock` needs them —
`CreatureStatBlock.hitPoints` is `{ average, diceNotation }`, filled as
`{ average: maxHp, diceNotation: hitDice }` — and because a character page
displays them.

## SRD data additions (`data/srd/`)

Three new files beside `classes.json` and `conditions.json`. Full tables, not
a POC subset: they are small, fixed and bounded, and partial transcription
leaves a permanent "which ones are missing?" question. All are adaptations of
CC-BY-4.0 SRD content, which the licence permits; `NOTICE.md` already covers
them and gains no additions.

**`weapons.json`** — the SRD weapon table. Per row: `weaponId`,
`nameEnglish`, `nameHebrew`, `category` (`simple` | `martial`), `kind`
(`melee` | `ranged`), `damage` (`diceNotation` + `damageType`), `properties`,
`versatileDamage?`, `reachFeet?`, `rangeFeet?`, `longRangeFeet?`. No
`averageDamage`: the average depends on the wielder's ability modifier, so it
is computed at derivation time rather than stored.

**`armor.json`** — the SRD armor table including Shield as a row. Per row:
`armorId`, `nameEnglish`, `nameHebrew`, `category`
(`light` | `medium` | `heavy` | `shield`), `baseAc` (or `acBonus` for the
shield), `strengthRequirement?`, `stealthDisadvantage`.

The Dexterity rule is taken from `category`, not stored per row: the SRD's AC
column is `base + Dex` for every Light row, `base + Dex (max 2)` for every
Medium row and a bare number for every Heavy row, with no row deviating from
its category. Storing the cap per row would encode the same three behaviours
eleven times and invite them to disagree. Note that Heavy is "no Dexterity
modifier", not "capped at 0" — heavy armor does not penalise a negative Dex
modifier, whereas Leather at Dex 8 is genuinely `11 - 1 = 10`.

**`monsters/*.json`** — the 11 existing files gain `nameHebrew` on the stat
block and on every entry in `actions`, roughly 35 strings in total. No other
field changes.

**`skills.json`** — 18 rows mapping each `Skill` to its governing
`AbilityKey`. Nothing in combat reads it; it exists so `skillProficiencies`
can be a real enum and so skill bonuses and passive Perception fall out of
the derivation for free.

**`classes.json`** gains two fields per class:

- `weaponProficiencies`: `("simple" | "martial")[]`. Without it a wizard
  holding a greataxe silently collects a proficiency bonus they do not have.
- `armorTraining`: `("light" | "medium" | "heavy" | "shield")[]`. Lacking
  shield training removes the +2 entirely, so this is load-bearing on AC, not
  decorative.

## Character data (`data/characters/`)

New directory, our own content, with its own `README.md` stating that it is
**not** SRD material and that SRD content belongs in `data/srd/`. Loaded by
`loadCharacter` in `apps/server/src/encounters/`, mirroring `loadMonster`.

`goblin-ambush`'s hero becomes a level 3 Fighter in Chain Mail with a
Longsword — AC 16, matching the `guard` block it replaces, so the encounter's
geometry and reach assumptions from correction C-14 are unaffected. Its
attack bonus and damage rise relative to the guard's spear; the encounter's
golden test records the new numbers rather than preserving the old ones.

## Rules engine: `deriveCharacter`

New module `packages/rules-engine/src/character/`. Pure, like the rest of the
engine: the caller reads the files and hands the parsed data in.

```
deriveCharacter(
  sheet: CharacterSheet,
  srd: { weapons, armor, classes, skills },
): DerivedCharacter

characterStatBlock(derived: DerivedCharacter): CreatureStatBlock
```

`abilityModifier` and `proficiencyBonusForLevel` already exist and are
exported from `checks/`; the derivation calls them rather than reimplementing
either.

### The derivation table

Every row verified against the notebook. Verbatim SRD text is quoted where
the wording is what settles the rule.

| Derived | Rule |
|---|---|
| ability modifier | `floor((score - 10) / 2)` — `checks/abilityModifier` |
| proficiency bonus | `2 + floor((level - 1) / 4)` — `checks/proficiencyBonusForLevel` |
| AC, unarmored | `10 + Dex` |
| AC, Light | `baseAc + Dex` |
| AC, Medium | `baseAc + min(Dex, 2)` |
| AC, Heavy | `baseAc` — Dex ignored entirely, including a negative one |
| AC, Shield | `+2`, **only with shield training**: "You gain the Armor Class benefit of a Shield only if you have training with it." |
| speed | `sheet.combat.speedFeet - 10` when the worn armor lists a Strength requirement above the character's Strength score; otherwise unchanged |
| initiative | Dex modifier (Initiative is a Dexterity check, RULES_REFERENCE §7) |
| attack ability | Str for melee, Dex for ranged; Finesse gives a choice — "use your choice of your Strength or Dexterity modifier for the attack and damage rolls. You must use the same modifier for both rolls" — resolved as the higher of the two |
| attack bonus | ability modifier + proficiency bonus, **proficiency bonus only when the class has proficiency with that weapon's category** |
| damage | weapon die + the same ability modifier used for the attack roll |
| `averageDamage` | `floor(dice average) + ability modifier`, floored at 0, matching the SRD's printed convention |
| attacksPerAction | 2 when the class has an `extraAttackLevel` and `level >=` it, else 1 |
| saving throws | ability modifier + proficiency bonus when proficient |
| skills | ability modifier + proficiency bonus when proficient |
| passive Perception | `10 + Perception skill bonus` |
| spell save DC | `8 + proficiency bonus + spellcasting ability modifier`; absent when the class has no `spellcastingAbility` |
| Unarmed Strike | always derived, in addition to equipped weapons: attack bonus `Str + proficiency bonus`, damage `1 + Str` Bludgeoning, reach 5 ft |

The Unarmed Strike row is not a convenience. `CreatureStatBlock.actions` is
`.min(1)`, so a character with no equipped weapon — a Wizard, most obviously
— would otherwise derive an empty action list and fail validation. It is also
simply correct: "Instead of using a weapon to make a melee attack, you can
use a punch, kick, headbutt, or similar forceful blow", with the Damage
option's bonus being "your Strength modifier plus your Proficiency Bonus" and
its damage "1 plus your Strength modifier". Only the Damage option is
derived; Grapple and Shove are saving-throw effects that `ExecuteTurn` cannot
express, and RULES_REFERENCE §7 already records their absence.

Its damage carries no `diceNotation`, which is exactly the flat-damage case
`DamageRoll` already documents.

### House rules and recorded gaps

Three things the notebook surfaced that this spec deliberately does not
implement. Each goes into `RULES_REFERENCE.md` — the house rule into §7
beside the existing narrow-opening entry, the gaps into §8 — because an
unrecorded divergence is the failure mode that section exists to prevent.

- **Versatile is resolved by shield, not by hands (house rule).** RAW: "The
  weapon deals that damage when used with two hands to make a melee attack."
  Nothing models hands. The rule adopted: a Versatile weapon uses its
  two-handed die when no shield is equipped. It is an inference, so it is
  recorded as a house rule rather than presented as RAW.
- **The Heavy weapon property is not modelled (gap).** RAW gives Disadvantage
  on attacks with a Heavy weapon when a melee wielder's Strength or a ranged
  wielder's Dexterity is below 13. `CreatureAttack` has no field for
  conditional Disadvantage, and advantage is a resolution-time concern rather
  than a stat-block one.
- **The Light weapon property is not modelled (gap).** RAW grants a
  bonus-action extra attack with a second Light weapon, without the ability
  modifier on its damage. `ExecuteTurn` has no bonus-action attack.

Also recorded, since it is now reachable: lacking armor training gives
Disadvantage on Strength and Dexterity D20 tests and prevents spellcasting.
Only the Shield half of that rule affects AC, which is the half implemented.

## The stored-vs-derived cross-check

`assertSheetConsistent(sheet, derived)` compares `proficiencyBonus`,
`combat.armorClass` and `combat.initiativeModifier` against their derived
values and throws naming the field, the stored value and the derived value.
It also compares `sheet.savingThrowProficiencies` against the class's, which
can disagree the same way.

It runs in `loadCharacter`, not in zod parsing: `@ai-dm/schemas` loads no data
files and must not start, and the derivation needs weapons, armor and classes
in hand. A malformed sheet therefore fails at session creation with a
diagnosable message rather than producing a hero whose sheet and behaviour
disagree.

## Encounter and server integration

- `EncounterDefinition.spawns` becomes a discriminated union:
  `{ combatantId, monsterId, faction, position }` |
  `{ combatantId, characterId, faction, position }`. The character branch sets
  `Combatant.characterId`, a field the schema already carries and documents as
  "Present when this combatant is driven by a `CharacterSheet`" but which
  nothing has ever populated.
- `buildEncounter` takes a `characters: ReadonlyMap<string, DerivedCharacter>`
  alongside `statBlocks`, and spawns from `characterStatBlock(...)`.
- `apps/server/src/encounters/` gains `loadCharacter` mirroring `loadMonster`,
  including the same parse-and-cache shape; `buildEncounterById` resolves both
  spawn kinds.
- `combatantFromStatBlock` needs no change **for hit points**:
  `characterStatBlock` sets `hitPoints.average` to the sheet's `maxHp`, and
  `SpawnOptions.currentHp` already exists for a character joining below full
  health. Its only change is one new optional `SpawnOptions.characterId`,
  copied through to `Combatant.characterId`.

## HTTP additions

`GET /encounters/:encounterId` gains `characters: DerivedCharacter[]` and
Hebrew names on its existing combatant and action entries. Both are additive,
which the protocol permits.

This is the character-sheet page's data source, in place before the page
exists. The page then becomes pure rendering: it already receives every
number it needs to display, and it computes none of them, so
`apps/web/CLAUDE.md`'s "ZERO game logic in the client" holds without the page
having to be designed around it.

## Testing

`packages/rules-engine/CLAUDE.md` requires golden tests for new rules code.

- **AC table**: unarmored; Leather at Dex 8 (negative modifier applies);
  Half Plate at Dex 18 (cap bites at +2); Plate at Dex 18 (Dex ignored);
  Plate at Dex 8 (still ignored, not penalised); with a shield and shield
  training; with a shield and **without** training (+0).
- **Speed**: Chain Mail at Str 12 (30 → 20 ft) and at Str 13 (unchanged).
- **Attacks**: Strength melee; Finesse taking the higher modifier and using
  the same modifier for damage; ranged using Dex; a martial weapon wielded by
  a class without martial proficiency getting **no** proficiency bonus;
  Versatile with and without a shield equipped.
- **attacksPerAction**: Fighter at level 4 (1) and level 5 (2); Wizard at
  level 20 (1).
- **Cross-check**: a sheet with a deliberately wrong `proficiencyBonus` fails
  to load, naming the field and both values.
- **Data integrity**: every file in `weapons.json`, `armor.json`,
  `skills.json`, `classes.json` and `monsters/` parses against its schema;
  every creature and every attack carries a non-empty `nameHebrew`.
- **Widening is inert**: the existing engine and agent suites pass unchanged.
  If any needs editing, the widening was not type-only and the design is
  wrong.
- **Encounter**: `goblin-ambush` builds with a character spawn, the hero's
  derived AC and attacks appear in the built world, and the melee-legal-on-
  turn-1 property from correction C-14 still holds.

§4.4's rule applies throughout: **delete the line a test protects and watch
it fail.** Seven tests in the step 8 web slice passed against the exact defect
they were written to catch; the sabotage check, not the green run, is the
evidence.

## Consequences for spec #2

Spec #2 (the Hebrew narrative agent) can then assume:

- Every combatant has a `nameHebrew`, and every action does too, so
  `NarrationInput` can carry Hebrew names instead of the English ones it
  carries today.
- The hero has a real `grammaticalGender`, so gendered narration has an
  actual input rather than a schema field nothing populates.
- `DerivedCharacter` is available server-side and is the natural
  semi-static prompt tier — a character card that changes per scene, not per
  turn, which is exactly the cache tier `providers/prompt.ts` defines.

Unchanged by this spec, and still spec #2's to solve: glossary delivery into
the static tier, the §4.1 rules digest, mid-stream failure policy, the
first-token p50 measurement, and the native-speaker Hebrew review.
