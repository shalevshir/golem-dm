// Streaming Hebrew narrative. Tokens are rendered as they arrive — never
// blocked on turn completion (apps/web/CLAUDE.md).
//
// Dice notation is the most common LTR fragment in Hebrew narrative text, and
// mixed-direction text is the #1 Hebrew UI bug: without isolation, the period
// after "2d6+3" jumps to the wrong side. So die expressions are split out and
// wrapped in <bdi>.
import type { JSX } from "react";

/** `2d6+3`, `1d20`, `1d8-1`. Deliberately narrow: it isolates dice, not every
 *  Latin run, because over-isolating breaks nothing but adds noise to the DOM.
 *
 *  Global so `String.split` captures the matched groups as the parts array's
 *  odd-indexed elements — but a `/g` regex carries mutable `lastIndex` state
 *  between calls, so this instance is used ONLY for `.split` and never for a
 *  per-part `.test`/`.exec`. Reusing it for both is exactly the bug this
 *  component must avoid: `RegExp.prototype.test` on a `/g` regex advances
 *  `lastIndex` on every call, so consecutive calls on the same object give
 *  alternating true/false results — a plain non-dice part would falsely test
 *  true on one call and a real dice part would falsely test false on the
 *  next. `IS_DICE`, below, is a separate non-global instance made fresh for
 *  each `.test` call, which has no `lastIndex` to carry state in the first
 *  place.
 */
const DICE_SPLIT = /(\d+d\d+(?:[+-]\d+)?)/g;

/** Non-global by construction: no `lastIndex`, so every `.test` call is
 *  independent of every other. Matches a part in full (`^...$`) since parts
 *  from `DICE_SPLIT`'s capture group are already exactly a dice expression or
 *  exactly plain text, never a mix of the two. */
const IS_DICE = /^\d+d\d+(?:[+-]\d+)?$/;

export interface NarrativePaneProps {
  text: string;
}

export function NarrativePane(props: NarrativePaneProps): JSX.Element {
  const parts = props.text.split(DICE_SPLIT);

  return (
    <section className="narrative" aria-live="polite">
      <p>
        {parts.map((part, index) =>
          IS_DICE.test(part) ? (
            <bdi key={`${String(index)}-${part}`}>{part}</bdi>
          ) : (
            <span key={`${String(index)}-${part}`}>{part}</span>
          ),
        )}
      </p>
    </section>
  );
}
