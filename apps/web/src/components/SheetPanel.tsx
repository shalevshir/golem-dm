// The player's own numbers, on screen instead of asked for.
//
// This exists because the narrator cannot answer "how much HP do I have?" —
// `SCENE_SYSTEM_PROMPT` forbids it from stating any number at all, so a
// player who asked got a deflection. The answer is a panel, not a paragraph:
// no model call, no latency, and correct by construction rather than by the
// model's good behaviour.
//
// It computes nothing. Every number here is derived server-side
// (`deriveCharacter`) and rendered as given — invariant 1 keeps the math in
// the rules engine, invariant 5 keeps the engine out of `apps/web`. The one
// thing this file decides is which of two HP sources is live, and that is a
// choice between two server-sent values, not arithmetic.
//
// `<details>` rather than a state-holding disclosure: it is keyboard
// accessible, screen-reader announced and remembers nothing, all for free.
import type { JSX } from "react";
import type { DerivedCharacter, DerivedInventoryItem } from "@ai-dm/schemas";
import { abilityLabel, classLabel, he, isFallbackLabel, skillLabel } from "../i18n.js";

export interface SheetPanelProps {
  /** Null until `GET /campaigns/:id/character` resolves. */
  character: DerivedCharacter | null;
  /**
   * Live current HP from the projection — `scene.heroHp` out of combat, the
   * hero's combatant row in a fight. Null when neither is available yet, in
   * which case the sheet's own load-time `currentHp` is shown instead.
   *
   * Passed in rather than read here because only `App.tsx` knows which of the
   * two projections is the live one this frame, and a panel that guessed
   * would show a stale number on exactly the turn it matters.
   */
  currentHp: number | null;
  /** Live temporary HP, same sourcing as `currentHp`. Absent out of combat. */
  tempHp?: number;
  /**
   * The fetch failed and nothing retries it. Distinguished from "not yet"
   * because a panel that says "loading" forever is a lie the player cannot
   * tell from a slow network.
   */
  unavailable?: boolean;
}

/**
 * A signed modifier reads as a bonus, not a quantity: "+3", "-1", "+0". Every
 * ability, save and skill number on a sheet is one of these.
 */
function signed(value: number): string {
  return value < 0 ? `−${String(Math.abs(value))}` : `+${String(value)}`;
}

/**
 * A Latin fragment inside RTL Hebrew — a dice expression, or a label that
 * fell through to its raw key. `dir="ltr"` inside `<bdi>` because `<bdi>`
 * alone only isolates: it lets the fragment keep its own direction, and for
 * an id like `sleight_of_hand` the browser's first-strong guess is already
 * LTR, but for `1d10` it is not, and a bare number-and-letter run next to
 * Hebrew is the classic mixed-direction bug this codebase calls out.
 */
function Ltr(props: { children: string }): JSX.Element {
  return (
    <bdi dir="ltr" className="ltr-fragment">
      {props.children}
    </bdi>
  );
}

/** One label/value row. The value may be a Latin fragment, so it is isolated. */
function Stat(props: { label: string; value: string; ltr?: boolean }): JSX.Element {
  return (
    <div className="sheet-stat">
      <span className="sheet-stat-label">{props.label}</span>
      <span className="sheet-stat-value">
        {props.ltr === true ? <Ltr>{props.value}</Ltr> : props.value}
      </span>
    </div>
  );
}

/** A label that may have fallen back to its Latin key, wrapped only if it did. */
function KeyLabel(props: { label: string; itemKey: string }): JSX.Element {
  return isFallbackLabel(props.label, props.itemKey) ? (
    <Ltr>{props.label}</Ltr>
  ) : (
    <>{props.label}</>
  );
}

function InventoryLine(props: { item: DerivedInventoryItem }): JSX.Element {
  const { item } = props;
  return (
    <li className={item.equipped ? "sheet-item sheet-item-equipped" : "sheet-item"}>
      {/* Ordinary gear (rope, rations) has no SRD row and therefore no Hebrew
          name, so the raw Latin `itemId` is the only thing left to show. */}
      {item.nameHebrew === undefined ? <Ltr>{item.itemId}</Ltr> : item.nameHebrew}
      {item.quantity > 1 ? <Ltr>{`×${String(item.quantity)}`}</Ltr> : null}
      {item.equipped ? <span className="sheet-equipped-tag">{he.sheet.equipped}</span> : null}
    </li>
  );
}

export function SheetPanel(props: SheetPanelProps): JSX.Element {
  const { character } = props;

  if (character === null) {
    return (
      <section className="sheet-panel">
        <p className="sheet-loading">
          {props.unavailable === true ? he.sheet.unavailable : he.sheet.loading}
        </p>
      </section>
    );
  }

  // The projection wins whenever it has an answer: the sheet's `currentHp` is
  // whatever it was when the campaign loaded, so trusting it after a fight
  // would show full health to a bleeding player.
  const currentHp = props.currentHp ?? character.currentHp;
  const tempHp = props.tempHp ?? character.tempHp;

  return (
    // Collapsed until asked for. The summary carries name, class, level and
    // HP — the whole reason this panel exists — so opening it is for the
    // detail, and an expanded sheet would otherwise push the narration off
    // the first screen out of combat and crowd the board in a fight.
    <details className="sheet-panel">
      <summary className="sheet-summary">
        <span className="sheet-name">{character.nameHebrew}</span>
        <span className="sheet-subtitle">
          <KeyLabel label={classLabel(character.class)} itemKey={character.class} />
          {` · ${he.sheet.level} ${String(character.level)}`}
        </span>
        {/* Repeated in the summary on purpose: HP is the number the panel
            exists to answer, and it must be readable without opening it. */}
        <span className="sheet-hp">
          {he.sheet.hp} <Ltr>{`${String(currentHp)}/${String(character.maxHp)}`}</Ltr>
        </span>
      </summary>

      <div className="sheet-body">
        <div className="sheet-stats">
          <Stat label={he.sheet.armorClass} value={String(character.armorClass)} ltr />
          <Stat label={he.sheet.speed} value={String(character.speedFeet)} ltr />
          <Stat label={he.sheet.initiative} value={signed(character.initiative)} ltr />
          <Stat
            label={he.sheet.passivePerception}
            value={String(character.passivePerception)}
            ltr
          />
          <Stat label={he.sheet.proficiency} value={signed(character.proficiencyBonus)} ltr />
          <Stat label={he.sheet.hitDice} value={character.hitDice} ltr />
          {tempHp > 0 ? <Stat label={he.sheet.tempHp} value={String(tempHp)} ltr /> : null}
          {character.armorNameEnglish === undefined ? null : (
            <Stat label={he.sheet.armor} value={character.armorNameEnglish} ltr />
          )}
        </div>

        <h3>{he.sheet.abilities}</h3>
        <ul className="sheet-grid">
          {Object.entries(character.abilityModifiers).map(([ability, modifier]) => (
            <li key={ability}>
              <KeyLabel label={abilityLabel(ability)} itemKey={ability} />{" "}
              <Ltr>{signed(modifier)}</Ltr>
            </li>
          ))}
        </ul>

        <h3>{he.sheet.savingThrows}</h3>
        <ul className="sheet-grid">
          {Object.entries(character.savingThrows).map(([ability, bonus]) => (
            <li key={ability}>
              <KeyLabel label={abilityLabel(ability)} itemKey={ability} />{" "}
              <Ltr>{signed(bonus)}</Ltr>
            </li>
          ))}
        </ul>

        <h3>{he.sheet.skills}</h3>
        <ul className="sheet-grid sheet-skills">
          {Object.entries(character.skills).map(([skill, bonus]) => (
            <li key={skill}>
              <KeyLabel label={skillLabel(skill)} itemKey={skill} /> <Ltr>{signed(bonus)}</Ltr>
            </li>
          ))}
        </ul>

        <h3>{he.sheet.attacks}</h3>
        <ul className="sheet-list">
          {character.attacks.map((attack) => (
            <li key={attack.actionId}>
              {attack.nameHebrew} <Ltr>{signed(attack.attackBonus)}</Ltr>
            </li>
          ))}
        </ul>

        {/* Rendered even when empty is pointless, but an empty inventory is
            also not reachable today (every sheet carries something) — so the
            heading is not gated on a condition that is always true. */}
        <h3>{he.sheet.carried}</h3>
        <ul className="sheet-list">
          {character.inventory.map((item) => (
            <InventoryLine key={item.itemId} item={item} />
          ))}
        </ul>
      </div>
    </details>
  );
}
