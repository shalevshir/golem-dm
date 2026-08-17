# RULES_REFERENCE.md — SRD 5.2.1 rules this engine implements

**Edition: 2024 rules, SRD 5.2.1** (ADR-0001). Attribution is mandatory — see
[`NOTICE.md`](NOTICE.md). Source PDF: https://www.dndbeyond.com/srd
(direct: `https://media.dndbeyond.com/compendium-images/srd/5.2/SRD_CC_v5.2.1.pdf`).

Every row below was checked against the SRD text on 2026-08-17, not from
recall. Rules are paraphrased; consult the SRD for exact wording. **Do not
"correct" anything here from memory of 2014 rules — check the SRD first.**

To re-verify, download the PDF and extract it:

```bash
pdftotext -layout SRD_CC_v5.2.1.pdf srd.txt
```

---

## 1. Core d20 mechanics

| Rule | Behaviour | Implemented in |
|---|---|---|
| Ability modifier | `floor((score − 10) / 2)`. Table runs 3→−4 … 20→+5; formula extends past 20 for monsters. | `checks/` `abilityModifier` |
| Proficiency bonus | `2 + floor((level − 1) / 4)` → levels 1–4:+2, 5–8:+3, 9–12:+4, 13–16:+5, 17–20:+6. | `checks/` `proficiencyBonusForLevel` |
| Success test | Total **equals or exceeds** the DC. | `checks/` `resolveD20Test` |
| Advantage / disadvantage | Roll 2d20, take higher / lower. Never stacks — one instance is the same as three. | `dice/` `d20` |
| Expertise | Doubles the proficiency bonus. | `checks/` `totalModifier` |
| Passive score | `10 + check bonus`, **+5** with Advantage, **−5** with Disadvantage. No die is rolled. | `checks/` `passiveScore` |

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
| Base AC | `10 + Dexterity modifier`, then modified by armor etc. | not yet — comes with SRD data (step 5) |
| Attack action | Grants **one attack roll** with a weapon or an Unarmed Strike. Each target named is a separate roll, so two targets cost two attacks. | `combat/` `validateExecuteTurn` |
| Extra Attack | "Attack twice instead of once whenever you take the Attack action." | `Combatant.attacksPerAction` |
| Reach | 5 ft unless a rule says otherwise. | `Combatant.reachFeet` |

---

## 3. Cover

Three degrees. If behind more than one source, **only the most protective
applies** — they never add together.

| Degree | Effect |
|---|---|
| Half | **+2** to AC *and* Dexterity saving throws |
| Three-quarters | **+5** to AC *and* Dexterity saving throws |
| Total | **Cannot be targeted directly** at all |

Implemented in `combat/` `coverArmorClassBonus` and `spatial/` `coverBetween`.
Both the AC bonus and the Dex-save bonus are **RAW**, not a house rule —
ADR-0003 describes them as house rules, which is inaccurate.

---

## 4. Damage, dying and death

| Rule | Behaviour | Implemented in |
|---|---|---|
| Temporary HP | Absorbed before real HP. Healing **cannot** restore them. They never stack — keep the higher pool, not the sum. | `combat/` `applyDamage`, `applyHealing` |
| Massive damage | When damage drops you to 0 **and damage remains**, you die if the remainder ≥ your HP maximum. | `combat/` `applyDamage` → `instantDeath` |
| Monster death | A monster **dies instantly** at 0 HP — it does not fall unconscious or roll death saves. | `applyDamage(..., {diesAtZeroHp:true})` |
| Character at 0 HP | Falls Unconscious and rolls death saves. | `applyDamage` default |
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
| Corners | Diagonal movement **cannot cross the corner** of a wall or anything filling its space. | `spatial/` `cutsWallCorner` |
| Range | Count squares from a square adjacent to one thing, stopping in the other's space; shortest route. Equivalent to Chebyshev. | `spatial/` `tileDistanceFeet` |

**House rule (the only one):** line of sight uses Bresenham centre-to-centre.
RAW is corner-to-corner. Kept behind the `LineOfSightAlgorithm` interface so it
can be swapped (ADR-0003).

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
- **Speed 0** — Grappled, Restrained, Paralyzed, Petrified, Stunned,
  Unconscious. Distinguished from an empty budget by the `actor_cannot_move`
  rejection.
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
6. **Weapon mastery** exists in 2024 and is not implemented — it arrives with
   the SRD data pass (step 5).

---

## 8. Known gaps

Not yet implemented, roughly in dependency order:

- Damage taken at 0 HP → death-save failures (§4)
- Stabilising, and the 1d4-hour natural recovery (§4)
- HP maximum reduced to 0 (§4)
- Condition mechanical effects beyond those listed in §6
- Weapon mastery, base AC from armor, weapon/spell ranges — all need SRD data.
  Ranges are injected meanwhile via `CombatWorld.actionRangesFeet`, defaulting
  to the actor's melee reach.
- Opportunity attacks, concentration checks
- Corner-to-corner RAW line of sight (currently the Bresenham house rule)
- **Creature-aware pathing.** `findPath` routes through occupied squares; only a
  movement segment's *destination* is checked for occupancy. RAW you may move
  through an ally freely but through an enemy only if it is Tiny or two size
  categories apart — which needs a `size` field on `Combatant`.
- **Creatures granting cover.** `coverBetween` reads terrain only; RAW another
  creature in the line can give Half Cover.
- **Standing up from Prone.** `ExecuteTurn` cannot express it, so a prone actor
  is always costed as crawling (§6).
