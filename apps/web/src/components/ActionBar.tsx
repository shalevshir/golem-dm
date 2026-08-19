// Action selection and commit. Every button here came from a
// `turn_affordances` frame; this component decides nothing about legality,
// only about presentation and the two-step target pick.
import { useState } from "react";
import type { JSX } from "react";
import type { ActionAffordance } from "@ai-dm/schemas";
import { he } from "../i18n.js";
import type { CatalogueAction, CatalogueCombatant } from "../net/api.js";

export interface ActionBarProps {
  actions: ActionAffordance[];
  catalogue: CatalogueAction[];
  combatants: CatalogueCombatant[];
  disabled: boolean;
  onCommit: (action: ActionAffordance, targetId?: string) => void;
}

const UNIVERSAL_LABELS: Record<string, string | undefined> = {
  dodge: he.actions.dodge,
  dash: he.actions.dash,
  disengage: he.actions.disengage,
};

export function ActionBar(props: ActionBarProps): JSX.Element {
  const [pending, setPending] = useState<ActionAffordance | null>(null);

  function labelFor(action: ActionAffordance): JSX.Element {
    const universal =
      action.actionId === undefined ? UNIVERSAL_LABELS[action.actionType] : undefined;
    if (universal !== undefined) return <span>{universal}</span>;

    // English name inside an RTL document — no Hebrew name data exists (the
    // SRD is English, ADR 0001), so <bdi> is mandatory here, not optional.
    const named = props.catalogue.find((each) => each.actionId === action.actionId);
    return <bdi>{named?.nameEnglish ?? action.actionId ?? action.actionType}</bdi>;
  }

  if (pending !== null) {
    return (
      <div className="action-bar">
        {pending.targetableCombatantIds.map((targetId) => {
          const named = props.combatants.find((each) => each.combatantId === targetId);
          return (
            <button
              key={targetId}
              type="button"
              disabled={props.disabled}
              onClick={() => {
                setPending(null);
                props.onCommit(pending, targetId);
              }}
            >
              <bdi>{named?.nameEnglish ?? targetId}</bdi>
            </button>
          );
        })}
        <button
          type="button"
          onClick={() => {
            setPending(null);
          }}
        >
          {he.actions.cancel}
        </button>
      </div>
    );
  }

  return (
    <div className="action-bar">
      {props.actions.map((action) => (
        <button
          key={`${action.actionType}:${action.actionId ?? ""}`}
          type="button"
          // An action needing a target with none in range renders DISABLED
          // rather than absent: `requiresTarget` exists precisely so the
          // player can see the option and understand why it is unavailable.
          disabled={
            props.disabled || (action.requiresTarget && action.targetableCombatantIds.length === 0)
          }
          onClick={() => {
            if (action.requiresTarget) {
              setPending(action);
              return;
            }
            props.onCommit(action, undefined);
          }}
        >
          {labelFor(action)}
        </button>
      ))}
    </div>
  );
}
