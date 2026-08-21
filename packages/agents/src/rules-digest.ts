// Content is CC-BY-4.0; see NOTICE.md.
//
// A curated English summary of the 5e rules a prompt tier needs, pinned into
// the cache-stable prefix (PROJECT_PLAN.md section 4.1).
//
// Hand-written rather than generated from `data/srd/conditions.json`: a
// runtime file read is I/O in a package that must stay pure and breaks
// bundling, and codegen is machinery bought for one string — the same trade
// `tactical/prompt-text.ts` already settled. A test walks up to that data
// file and fails if a condition it defines is missing here, which catches the
// drift that actually happens.
//
// Every effect described below is checked against `RULES_REFERENCE.md`
// (§3 Cover, §5 Grid/movement/range, §6 Conditions, §7 recall traps) and,
// where those did not settle it, against the SRD 5.2.1 notebook directly —
// not against `conditions.json` alone. That file's own `effects` are missing
// two of Petrified's real ones (Resistance to all damage, Immunity to the
// Poisoned condition); this digest states them anyway because the notebook
// confirms them as SRD text, and only condition *names*, not effect prose,
// are what the drift test below checks against that file.
//
// English only (invariant 2).

/** Bump whenever any string in this file changes. A hash guard enforces it. */
export const RULES_DIGEST_VERSION = "2026-08-21.1";

export const RULES_DIGEST = `RULES REFERENCE (D&D 5th edition, 2024 rules)

Action economy. On its turn a creature may take one action, one Bonus Action
if a feature grants one, and movement up to its Speed, in any order. A
reaction can be taken on any turn, including its own; once taken, it cannot
be taken again until the start of its next turn.

Conditions and what they mean:
- Blinded: cannot see and automatically fails any ability check that requires sight; attacks against it have Advantage, its own have Disadvantage.
- Charmed: cannot attack the charmer or target it with damaging abilities or magic; the charmer has Advantage on social checks against it.
- Deafened: cannot hear and automatically fails any ability check that requires hearing.
- Frightened: Disadvantage on ability checks and attack rolls while the source is in sight; cannot willingly move closer to it.
- Grappled: Speed 0; Disadvantage on attacks against anyone but the grappler; the grappler can drag or carry it when it moves; ends by a successful Athletics or Acrobatics check to escape, if the grappler becomes Incapacitated, if the grappler releases it, or if the two are separated beyond the grapple's range.
- Incapacitated: no action, bonus action or reaction; concentration ends; cannot speak.
- Invisible: cannot be seen unaided; attacks against it have Disadvantage, its own have Advantage.
- Paralyzed: Incapacitated, Speed 0, fails Strength and Dexterity saves; attacks against it have Advantage and any hit from within 5 feet is a critical hit.
- Petrified: turned to solid substance, Incapacitated, Speed 0, fails Strength and Dexterity saves, resistant to all damage and immune to the Poisoned condition; attacks against it have Advantage.
- Poisoned: Disadvantage on attack rolls and ability checks.
- Prone: movement options are only to crawl or to spend half its Speed (rounded down) to stand; its own attack rolls have Disadvantage; attacks against it have Advantage from within 5 feet, otherwise Disadvantage.
- Restrained: Speed 0; Disadvantage on Dexterity saves; attacks against it have Advantage, its own have Disadvantage.
- Stunned: Incapacitated, fails Strength and Dexterity saves, attacks against it have Advantage.
- Unconscious: Incapacitated, Prone, Speed 0, fails Strength and Dexterity saves, drops what it holds, unaware of its surroundings; attacks against it have Advantage and any hit from within 5 feet is a critical hit.
- Exhaustion: cumulative levels from 1 to 6; each level reduces every D20 test by 2 and Speed by 5 feet. Level 6 is death. A Long Rest removes one level.

Cover. Half Cover gives +2 to Armor Class and Dexterity saving throws;
Three-Quarters Cover gives +5 to both; Total Cover means the target cannot be
targeted directly. Only the single best source of cover applies — it never
stacks.

Distance. One tile is 5 feet. Melee reach is 5 feet unless the weapon or the
creature's stat block says otherwise.
`;
