// The mechanical trace behind the narrated outcome: attack rolls vs AC,
// damage dice, movement, grouped by turn. Player-facing (spec
// docs/superpowers/specs/2026-08-20-combat-roll-log-design.md) -- every
// number here comes straight from an AttackTrace the server already
// computed and validated; this component decides nothing about legality or
// outcome, only how to display it.
//
// The numeric/roll-trace fragment of each line is wrapped in <bdi>, the
// same mixed-direction isolation NarrativePane already applies to dice
// notation in free-form narrative text -- this is a denser LTR run (a full
// "18 + 5 = 23" comparison), so the whole trace is isolated rather than
// just a single dice substring.
import type { JSX } from "react";
import type { AttackTrace } from "@ai-dm/schemas";
import { actionLabel, he } from "../i18n.js";
import type { CatalogueCombatant } from "../net/api.js";
import type { CombatLogTurn } from "../state/store.js";

export interface CombatLogProps {
  turns: CombatLogTurn[];
  catalogue: CatalogueCombatant[];
}

const OUTCOME_LABEL: Record<AttackTrace["outcome"], string> = {
  hit: he.log.hit,
  critical_hit: he.log.criticalHit,
  miss: he.log.miss,
  critical_miss: he.log.criticalMiss,
};

/** `"+ 3"` / `"- 2"` — always signed, matching the original attack-roll
 *  convention (`modifier >= 0` reads as `"+ 0"`, never omitted), the one
 *  formatting rule shared by both the attack roll and every damage roll
 *  below. */
function signedModifier(modifier: number): string {
  return modifier >= 0 ? `+ ${String(modifier)}` : `- ${String(-modifier)}`;
}

/** Shows the dice actually rolled, not just the weapon's base notation —
 *  a critical hit doubles the dice (5e: dice only, never the modifier), so
 *  `notation` alone ("1d6+2") would read as impossible next to a total that
 *  reflects two dice ("1d6+2 = 13" looks like a bug, not a crit). Each
 *  `DamageRollTrace` entry (more than one only for an extra-damage rider,
 *  which no encounter shipped with this slice actually uses) gets its own
 *  "rolls + modifier = total" segment, joined with " · " to stay visually
 *  distinct from the "+" already inside each segment's own arithmetic. */
function formatDamageRolls(rolls: AttackTrace["damageRolls"]): string {
  return rolls
    .map((each) =>
      each.kind === "dice"
        ? `${each.rolls.join(" + ")} ${signedModifier(each.modifier)} = ${String(each.total)}`
        : String(each.total),
    )
    .join(" · ");
}

function AttackLine(props: { attack: AttackTrace; nameOf: (id: string) => string }): JSX.Element {
  const { attack, nameOf } = props;
  const { naturalRoll, rolls, total, targetArmorClass } = attack.attackRoll;
  const rollsText =
    rolls.length > 1 ? `${rolls.join(", ")} (${String(naturalRoll)})` : String(naturalRoll);
  const modifierText = signedModifier(total - naturalRoll);

  return (
    <p>
      <bdi>{nameOf(attack.attackerId)}</bdi> ← <bdi>{nameOf(attack.targetId)}</bdi> ·{" "}
      <bdi>
        {rollsText} {modifierText} = {total}
      </bdi>{" "}
      {he.log.vsArmor} <bdi>{targetArmorClass}</bdi> ←{" "}
      {/* Wrapped in <span>, not left as a bare text sibling: this <p> mixes
          many adjacent text nodes and <bdi> elements, and testing-library's
          getByText only reconstructs an element's *direct* text-node
          children (see NarrativePane's getNodeText behavior) -- a bare
          outcome string here is unreachable by exact-text queries because
          it is one fragment among many siblings, never a signal on its
          own. The wrapper is a plain <span>, not <bdi>: the outcome label
          is Hebrew, same direction as the surrounding prose, so there is no
          bidi fragment to isolate here -- only a query target to give an
          element boundary. */}
      <span>{OUTCOME_LABEL[attack.outcome]}</span>
      {attack.damageRolls.length > 0 && (
        <>
          {" "}
          · <bdi>{formatDamageRolls(attack.damageRolls)}</bdi> {he.log.damage}
        </>
      )}
    </p>
  );
}

export function CombatLog(props: CombatLogProps): JSX.Element {
  const nameOf = (id: string): string =>
    props.catalogue.find((each) => each.combatantId === id)?.nameEnglish ?? id;

  // `props.turns` stays oldest-first — that's what the store's `foldCombatLog`
  // depends on (`log.at(-1)` is "the group currently being filled") and what
  // every store-level test asserts against. The newest-first reading order is
  // a display-only concern, so it's applied here at render time instead.
  const displayTurns = [...props.turns].reverse();

  return (
    <section className="combat-log">
      <p className="label">{he.log.heading}</p>
      <div className="log-panel">
        {displayTurns.map((turn, index) => (
          // Composite key, matching NarrativePane/ErrorBanner's convention
          // in this codebase (never a bare index): turns can repeat the same
          // actorId across a fight, so actorId alone would collide.
          <div className="log-entry" key={`${String(index)}-${turn.actorId}`}>
            <p className="log-turn-header">
              — {he.log.turnOf} <bdi>{nameOf(turn.actorId)}</bdi> —
            </p>
            {turn.forfeited && <p>{he.log.forfeited}</p>}
            {turn.attacks.map((attack, attackIndex) => (
              <AttackLine
                key={`${String(attackIndex)}-${attack.attackerId}-${attack.targetId}`}
                attack={attack}
                nameOf={nameOf}
              />
            ))}
            {turn.movedFeet > 0 && (
              <p>
                <bdi>{nameOf(turn.actorId)}</bdi> {he.log.moved} <bdi>{turn.movedFeet}</bdi>{" "}
                {he.log.feet}
              </p>
            )}
            {!turn.forfeited && turn.attacks.length === 0 && turn.actionType !== undefined && (
              <p>{actionLabel(turn.actionType) ?? <bdi>{turn.actionType}</bdi>}</p>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
