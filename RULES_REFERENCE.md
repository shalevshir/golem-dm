# RULES_REFERENCE.md — SRD 5.2.1 rules this engine implements

**Edition: 2024 rules, SRD 5.2.1** (ADR-0001). Attribution is mandatory — see
[`NOTICE.md`](NOTICE.md). Source PDF: https://www.dndbeyond.com/srd
(direct: `https://media.dndbeyond.com/compendium-images/srd/5.2/SRD_CC_v5.2.1.pdf`).

Every row below was checked against the SRD text on 2026-08-17, not from
recall. Rules are paraphrased; consult the SRD for exact wording. **Do not
"correct" anything here from memory of 2014 rules — check the SRD first.**

To re-verify, the fastest path is the **SRD NotebookLM notebook** —
`3a0d4f39-93c2-48ee-b1d1-258c7f7583ab` ("SRD 5.2.1 Markdown Project Release
Notes"), holding the 13 SRD chapter markdowns plus the official PDF. With the
NotebookLM MCP connected, `notebook_query` against that ID returns answers
with citations into the SRD text (see `PROJECT_PLAN.md` §4.1 — dev-time tool
only, never a runtime dependency). For exact wording, or offline, extract the
PDF:

```bash
pdftotext -layout SRD_CC_v5.2.1.pdf srd.txt
```

Sections 1–7 were re-audited against the notebook on 2026-08-19; two rows
were corrected (Temporary HP choice, narrow openings) — see §4, §5, §8.

---

## 1. Core d20 mechanics

| Rule | Behaviour | Implemented in |
|---|---|---|
| Ability modifier | `floor((score − 10) / 2)`. Table runs 3→−4 … 20→+5; formula extends past 20 for monsters. | `checks/` `abilityModifier` |
| Proficiency bonus | `2 + floor((level − 1) / 4)` → levels 1–4:+2, 5–8:+3, 9–12:+4, 13–16:+5, 17–20:+6. | `checks/` `proficiencyBonusForLevel` |
| Success test | Total **equals or exceeds** the DC. | `checks/` `resolveD20Test` |
| Advantage / disadvantage | Roll 2d20, take higher / lower. Never stacks — one instance is the same as three. | `dice/` `d20` |
| Expertise | Doubles the proficiency bonus. | `checks/` `totalModifier` |
| Passive score | `10 + check bonus`, **+5** with Advantage, **−5** with Disadvantage. No die is rolled. | `checks/` `passiveScore`; a character's Passive Perception is derived instead via `PASSIVE_BASE` in `character/` `deriveCharacter` (`passivePerception`) — the one a character actually goes through |
| Saving throw proficiency | Ability modifier, plus Proficiency Bonus when the class grants proficiency in that save. | `character/` `deriveCharacter` (`savingThrows`) |
| Skill bonus | Ability modifier of the skill's governing ability, plus Proficiency Bonus when proficient. | `character/` `deriveCharacter` (`skills`) |
| Spell save DC | `8 + Proficiency Bonus + spellcasting ability modifier`. Absent for a class with no spellcasting ability. | `character/` `deriveCharacter`'s `SPELL_SAVE_BASE` (`spellSaveDc`) — structurally the same formula as `checks/` `imposedSaveDc` |
| Hit dice | `<level>d<class hit die>`, e.g. `3d10` for a level-3 Fighter. Display notation only — `maxHp` is the sheet's stored, chosen value, not computed from this. | `character/` `deriveCharacter` (`hitDice`) |

### Trap: natural 20 / natural 1

Auto-hit and auto-miss apply to **attack rolls only**. A natural 20 on an
ability check or saving throw does **nothing** special — it is not an automatic
success. Death saves are the one exception (§4). `abilityCheck` and
`savingThrow` deliberately do not special-case the natural roll.

---

## 2. Attacks

| Rule | Behaviour | Implemented in |
|---|---|---|
| Attack roll | Hits when total ≥ target AC. | `combat/` `resolveAttack` |
| Natural 20 | Hits regardless of modifiers or AC; is a Critical Hit. | `combat/` `resolveAttack` |
| Natural 1 | Misses regardless of modifiers or AC. | `combat/` `resolveAttack` |
| Critical hit damage | Roll the attack's damage **dice** twice; add modifiers **once**, as normal. | `dice/` `roll(..., {critical:true})` |
| Base AC | Unarmored `10 + Dex`. Armor sets a base per its table row. | `character/` `armorClassFor` |
| Light armor AC | `base + Dex`, uncapped — including a negative modifier. | `character/` `armorClassFor` |
| Medium armor AC | `base + Dex`, capped at `+2`. | `character/` `armorClassFor` |
| Heavy armor AC | `base`, ignoring Dex entirely; a negative modifier does not reduce it. | `character/` `armorClassFor` |
| Shield | `+2`, and only with shield training: "You gain the Armor Class benefit of a Shield only if you have training with it." | `character/` `armorClassFor` |
| Armor Strength requirement | Armor listing a Strength score reduces speed by 10 ft unless the wearer meets it. | `character/` `speedFeetFor` |
| Weapon proficiency (character) | Proficiency Bonus is added to an attack roll only with a weapon the character is proficient with. | `character/` `isProficientWith` |
| Weapon proficiency (monster) | "A monster is proficient with any weapon in its stat block" — never computed; it is simply the printed `attackBonus`. | `schemas` `CreatureAttack` |
| Finesse | Choose Strength or Dexterity; the same modifier applies to attack and damage. Taken as the higher. | `character/` `attacksFor` |
| Unarmed Strike | Always available. Attack `Str + PB`; damage `1 + Str` Bludgeoning, floored at 0; reach 5 ft. Only the Damage option is modelled. | `character/` `attacksFor` |
| Attack action | Grants **one attack roll** with a weapon or an Unarmed Strike. Each target named is a separate roll, so two targets cost two attacks. | `combat/` `validateExecuteTurn` |
| Extra Attack | "Attack twice instead of once whenever you take the Attack action." | `Combatant.attacksPerAction`; derived for a character from `ClassDefinition.extraAttackLevel` in `character/` `deriveCharacter` |
| Reach | 5 ft unless a rule says otherwise. | `Combatant.reachFeet` |

---

## 3. Cover

Three degrees. If behind more than one source, **only the most protective
applies** — they never add together.

| Degree | Effect | Offered by |
|---|---|---|
| Half | **+2** to AC *and* Dexterity saving throws | **Another creature**, or an object covering at least half the target |
| Three-quarters | **+5** to AC *and* Dexterity saving throws | An **object** covering at least three-quarters |
| Total | **Cannot be targeted directly** at all | An **object** covering the whole target |

**A creature can only ever give Half Cover.** Three-Quarters and Total are
objects only, so someone standing in the way never makes a target illegal to
attack — it is worth +2 AC at resolution and nothing more. Any creature counts,
ally or enemy; the attacker and the target are not cover for the target.

Cover must lie *between*: "a target can benefit from cover only when an attack
or other effect originates on the opposite side of the cover."

Implemented in `combat/` `coverArmorClassBonus` and `coverAgainst` — the latter
is what a caller passes to `resolveAttack` — over `spatial/` `coverBetween`.
Both the AC bonus and the Dex-save bonus are **RAW**, not a house rule —
ADR-0003 describes them as house rules, which is inaccurate.

Creatures do **not** block line of sight; they grant cover instead, so
`hasLineOfSight` is deliberately terrain-only.

---

## 4. Damage, dying and death

| Rule | Behaviour | Implemented in |
|---|---|---|
| Temporary HP | Absorbed before real HP. Healing **cannot** restore them. They never stack — RAW lets the recipient **choose** which pool to keep ("you decide whether to keep the ones you have or to gain the new ones"); auto-keeping the higher will be our simplification when granting is implemented (today the engine only spends temp HP, never grants it). | `combat/` `applyDamage`, `applyHealing` |
| Massive damage | When damage drops you to 0 **and damage remains**, you die if the remainder ≥ your HP maximum. | `combat/` `applyDamage` → `instantDeath` |
| Monster death | A monster **dies instantly** at 0 HP — it does not fall unconscious or roll death saves. | `applyDamage(..., {diesAtZeroHp:true})` |
| Character at 0 HP | Falls Unconscious and rolls death saves (see §8). | `applyDamage` default |
| HP maximum of 0 | A creature whose HP *maximum* drops to 0 dies. | not implemented |
| Death saves | Roll d20: **10 or higher succeeds**. Three successes → Stable. Three failures → dead. Need not be consecutive. | `combat/` `rollDeathSave` |
| Death save nat 20 | Regain **1 HP** immediately. | `combat/` `rollDeathSave` |
| Death save nat 1 | Counts as **two** failures. | `combat/` `rollDeathSave` |
| Tally reset | Both counts reset to zero on regaining any HP or becoming Stable. | `combat/` `rollDeathSave` |
| Damage at 0 HP | One death-save failure; **two** if from a critical hit; instant death if the damage ≥ HP maximum. | **not implemented** |
| Stabilising | DC 10 Wisdom (Medicine) check. A Stable creature regains 1 HP after 1d4 hours. | not implemented |

---

## 5. Grid, movement and range

Diagonals cost the same as orthogonal steps — **this is RAW in 2024**, not a
house rule. Chebyshev distance is therefore correct.

| Rule | Behaviour | Implemented in |
|---|---|---|
| Square size | 5 ft. Speed ÷ 5 = squares. | `spatial/` `FEET_PER_TILE` |
| Entering a square | Costs 1 square, orthogonally **or** diagonally. | `spatial/` `findPath` |
| Difficult terrain | Costs **2** squares to enter. | `spatial/` `movementCostFeet` |
| Crawling | Each foot costs **1 extra foot**, or **2 extra feet** in Difficult Terrain — so 10 ft per open square and **15 ft** per difficult square. Note the difficult case is *not* twice the ordinary difficult cost. | `spatial/` `movementCostFeet(t, {crawling})` |
| Dash | Extra movement equal to your Speed, i.e. the budget doubles. | `combat/` `movementBudgetFeet` |
| Difficult terrain never stacks | "1 extra foot, **even if multiple things in a space count as Difficult Terrain**." A creature's space that is also difficult is still just doubled. | `spatial/` `findPath` |
| Creature size | Tiny 2½ ft · Small/Medium 5 ft · Large 10 ft (2×2) · Huge 15 ft (3×3) · Gargantuan 20 ft (4×4). Order matters — pass-through is stated in categories apart. | `schemas` `CreatureSize` |
| Creature space | A creature fills its whole space, anchored at the north-west square. Every square of it counts as occupied. | `spatial/` `occupiedTiles` |
| Moving a large creature | The **whole space** must fit in each position entered. 2024 has no dedicated squeezing rule, but the Difficult Terrain list includes "a narrow opening sized for a creature one size smaller than you" — so RAW lets a Large creature pass a one-square gap at double cost. Our hard block is a **house-rule simplification** (see §8). | `spatial/` `findPath({size})` |
| Passing through a creature | Allowed through an **ally**, an **Incapacitated** creature, a **Tiny** creature, or one **two sizes** larger or smaller. Otherwise blocked. | `combat/` `passabilityThrough` |
| Cost of a creature's space | **Difficult Terrain**, unless that creature is Tiny or your ally. | `combat/` `passabilityThrough` → `hindered` |
| Ending a move | You can't willingly end a move in a space occupied by another creature. | `combat/` `destination_occupied` |
| Corners | Diagonal movement **cannot cross the corner** of a wall or anything filling its space. | `spatial/` `cutsWallCorner` |
| Range | Count squares from a square adjacent to one thing, stopping in the other's space; shortest route. Measured between the **nearest squares** of the two spaces, so a Huge creature is reachable all along its edge. Reduces to Chebyshev for two single-square creatures. | `spatial/` `footprintDistanceFeet`, `tileDistanceFeet` |

The two broadest house rules are catalogued in §9. A third, narrower one
stays inline below, in the "Moving a large creature" row.

---

## 6. Conditions

**Exhaustion (2024 unified track)** — the 2014 six-row penalty table is gone.

- Cumulative levels; **you die at level 6**.
- Every d20 Test is reduced by **2 × level**.
- Speed is reduced by **5 ft × level**.
- A Long Rest removes one level.

Implemented in `combat/exhaustion.ts`.

**Conditions the turn validator enforces** (`combat/action-economy.ts`):

- **Incapacitated** — no Action, Bonus Action, or Reaction. Paralyzed,
  Petrified, Stunned and Unconscious each *include* Incapacitated, so all five
  block acting.
- **Speed 0** — Grappled, Restrained, Paralyzed, Petrified, Unconscious, and
  **only** those five. Distinguished from an empty budget by the
  `actor_cannot_move` rejection. **Stunned is not among them** — see §7.
- **Prone** — "your only movement options are to crawl or to spend an amount of
  movement equal to half your Speed (round down) to right yourself." Modelled as
  crawling, since `ExecuteTurn` has no way to propose standing up. Prone raises
  movement *cost*; it does not reduce Speed.

The remaining conditions are enumerated in `schemas` `Condition`, but their
mechanical effects are not implemented.

---

## 7. What 2024 changed — recall traps

These are where memory of 2014 will silently produce wrong code.

1. **Contests are gone.** The word appears once in the whole SRD, as flavour.
   Grapple and Shove are now a **saving throw** against DC `8 + ability modifier
   + proficiency bonus`. See `checks/` `imposedSaveDc`. There is deliberately no
   `contest()` helper.
2. **Surprise** is not a condition. A surprised creature has **Disadvantage on
   its Initiative roll** — nothing more.
3. **Exhaustion** is the flat −2/−5-per-level track above, not the old table.
4. **Hiding** requires the Hide action and a **DC 15** Dexterity (Stealth)
   check, granting the Invisible condition until you attack, cast, make noise,
   or are found.
5. **Initiative** is a Dexterity check.
6. **Stunned does not set Speed 0.** Its entry lists exactly three effects:
   Incapacitated, auto-failed Strength and Dexterity saves, and Advantage on
   attacks against you. 2014's Stunned said "can't move"; 2024's does not, and
   moving is not an action, so a Stunned creature can still move. Only
   Grappled, Paralyzed, Petrified, Restrained and Unconscious state Speed 0.
   `data/srd/conditions.json` is the check — a test asserts that exactly those
   five carry a "Speed 0" effect.
7. **Weapon mastery** exists in 2024 and is not implemented.

---

## 8. Known gaps

Not yet implemented, roughly in dependency order:

- Damage taken at 0 HP → death-save failures (§4)
- **Every combatant dies at 0 HP, PCs included.** `resolve.ts` pins
  `diesAtZeroHp: true` unconditionally rather than reading it off
  `characterId` (correction C-31). Death saves themselves are implemented
  and tested (`combat/` `rollDeathSave`, §4); what is missing is a driver —
  `resolve.ts`'s own comment says it plainly, "this file does not drive it."
  An Unconscious player character would strand the pipeline with nothing
  that ever calls `rollDeathSave`. Closes once something in the encounter
  pipeline drives it.
- Stabilising, and the 1d4-hour natural recovery (§4)
- HP maximum reduced to 0 (§4)
- Condition mechanical effects beyond those listed in §6
- Weapon mastery still needs SRD data. Player weapon ranges are no longer a
  gap: `actionRangesFeetFrom` now builds `CombatWorld.actionRangesFeet` from
  every spawned creature's stat block, monster and character alike. Spell
  ranges remain one — no spell action is ever derived, so a `cast_spell`
  proposal still falls back to the actor's melee reach.
- **Conditional damage riders.** `CreatureAttack.extraDamage` holds
  unconditional extras such as the cultist's Necrotic rider, but the goblin's
  "plus 2 (1d4) if the attack roll had Advantage" has nowhere to go.
- **The Heavy weapon property.** RAW gives Disadvantage on attacks with a
  Heavy weapon when a melee wielder's Strength or a ranged wielder's Dexterity
  is below 13. `CreatureAttack` has no field for conditional Disadvantage, and
  advantage is resolution-time rather than a stat-block fact.
- **The Light weapon property.** RAW grants a bonus-action attack with a
  second Light weapon, without the ability modifier on its damage.
  `ExecuteTurn`'s `bonusAction` field tracks only the action-economy slot
  (`abilityId`/`targetId`); `resolve.ts` never turns it into a resolved
  attack, so a two-weapon-fighting bonus attack has no damage or to-hit path.
- **Ammunition and Loading.** No ammunition is tracked and no once-per-turn
  limit is enforced, so a Loading weapon can be fired as often as the action
  economy allows.
- **Armor training penalties.** Only the Shield half is implemented. RAW also
  gives Disadvantage on Strength and Dexterity D20 tests and blocks
  spellcasting for a character wearing armor they lack training with.
- **Armor's Stealth Disadvantage.** `stealthDisadvantage` is `true` on 7 rows
  of `data/srd/armor.json`, but nothing reads the field outside the schema
  that defines it; RAW's Disadvantage on Dexterity (Stealth) checks while
  wearing that armor is never applied.
- **Class features.** The Cleric's Divine Order (Protector) grants Martial
  weapons and Heavy armor at level 1; `classes.json` carries only the base
  entry, and no class feature is modelled.
- **The Lance's conditional property.** RAW is "Two-Handed (unless mounted)";
  mounts are not modelled, so it is recorded as plain Two-Handed.
- **The Two-Handed weapon property itself is unenforced.** `two_handed` is
  carried by 13 rows of `data/srd/weapons.json` — the Lance above included —
  but nothing reads it outside the `WeaponProperty` enum that defines it
  (`packages/schemas/src/gear.ts`): a character can equip a Greatsword and a
  Shield at once and keep the Shield's +2 AC while swinging two-handed,
  which RAW forbids.
- **Monster traits, reactions and bonus actions.** Pack Tactics, Nimble Escape,
  Undead Fortitude and Parry are all absent — only the Actions block is
  captured, and only its attacks.
- Opportunity attacks, concentration checks
- Corner-to-corner RAW line of sight (currently the Bresenham house rule)
- **Tiny creatures sharing a square.** The SRD fits four Tiny creatures in one
  square; `occupiedTiles` gives every creature at least a full square, so two
  Tiny creatures cannot share one. Needs fractional occupancy to fix.
- **Cover for a large creature** is traced between the nearest squares of the
  two spaces. RAW lets the attacker pick any square of its space, which can
  find a cleaner line.
- **Cover is all-or-nothing per square.** A creature on the line gives Half
  Cover regardless of its size, and an object gives whatever its terrain type
  says. RAW asks how much of the target is actually covered.
- **"Ally" is faction equality.** `passabilityThrough` treats same-faction as
  allied. A `FactionRelation` score exists in `schemas` but is not consulted.
- **Standing up from Prone.** `ExecuteTurn` cannot express it, so a prone actor
  is always costed as crawling (§6).
- **Narrow openings.** RAW treats "a narrow opening sized for a creature one
  size smaller than you" as Difficult Terrain, so a Large creature can pass a
  one-square gap at double cost; `findPath({size})` hard-blocks it instead
  (§5).
- **Ending a turn in an occupied space involuntarily** gives the Prone
  condition unless the creature is Tiny or larger than the occupant. Forced
  movement is not modelled, so no code path can produce this yet — record it
  when one can.

---

## 9. House rules

Deliberate, permanent departures from RAW. The two broadest are collected
here; a third, narrower one is pointed to below rather than duplicated.

1. **Line of sight uses Bresenham centre-to-centre.** RAW is corner-to-corner.
   Kept behind the `LineOfSightAlgorithm` interface so it can be swapped
   (ADR-0003).
2. **Versatile damage is resolved by shield, not by hands.** RAW: "A
   Versatile weapon can be used with one or two hands ... The weapon deals
   that damage when used with two hands to make a melee attack." Nothing
   models hands, so `attacksFor` takes the two-handed die whenever no shield
   is equipped. A character wielding a longsword and nothing else therefore
   always swings it two-handed, which is the common case but not the only
   legal one.

   Two further cases follow from the same root cause — hands are not
   modelled — and both are worth stating plainly rather than leaving them
   implicit in the code:
   - A weapon that is **both** Versatile and Thrown — spear and trident, the
     only two such rows in the SRD — uses its two-handed die in **both**
     modes, so a thrown spear deals 1d8 where RAW gives 1d6: `CreatureAttack`
     carries exactly one `damage` value and thrown mode is not separately
     modelled.
   - The shield proxy also misses a dual-wielder: a shieldless character
     holding a longsword **and** a shortsword still gets the longsword's
     two-handed die (1d10), even though the off hand is occupied by the
     second weapon, not free. Only the shield slot is checked, never whether
     the off hand is actually free.

A third, narrower house rule — hard-blocking a Large creature from
squeezing through a one-square narrow opening, rather than RAW's option of
paying double movement for it — stays documented where it already lives,
in §5's "Moving a large creature" row and the matching gap entry in §8,
rather than duplicated as a third entry here.
