// The one player-facing way out of a story: discard this campaign and begin a
// new one.
//
// Two clicks, not one. Everything else in this UI is either reversible or
// costs a turn; this throws the whole arc away, and the player who wanted it
// loses nothing by confirming while the player who grazed it loses hours. An
// inline confirmation rather than `window.confirm`: a native dialog is not
// styleable, not RTL-aware, and not renderable in a test.
//
// It decides nothing about what a reset IS — it asks, and calls back. The
// campaign teardown lives in `App.tsx`, next to the state it has to clear.
import { useState } from "react";
import type { JSX } from "react";
import { he } from "../i18n.js";

export interface ResetButtonProps {
  /** Discard the current campaign and start a fresh one. */
  onReset: () => void;
}

export function ResetButton(props: ResetButtonProps): JSX.Element {
  const [confirming, setConfirming] = useState(false);

  if (!confirming) {
    return (
      <button
        type="button"
        className="reset"
        onClick={() => {
          setConfirming(true);
        }}
      >
        {he.app.reset}
      </button>
    );
  }

  return (
    <span className="reset-confirm">
      {he.app.resetConfirm}
      <button
        type="button"
        className="reset-yes"
        onClick={() => {
          // Left armed, not disarmed: this component unmounts and remounts
          // with the new campaign anyway, and a reset that visibly did
          // nothing (because the confirmation collapsed a frame before the
          // new story arrived) reads as a broken button.
          props.onReset();
        }}
      >
        {he.actions.confirm}
      </button>
      <button
        type="button"
        onClick={() => {
          setConfirming(false);
        }}
      >
        {he.actions.cancel}
      </button>
    </span>
  );
}
