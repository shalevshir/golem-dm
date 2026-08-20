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
 *  odd-indexed elements. This instance is used ONLY for `.split`, never for a
 *  per-part `.test`/`.exec` — that's `IS_DICE`, below. In this specific
 *  split-then-test structure, reusing one `/g` object for both would not
 *  actually misbehave: `String.split` with a capturing group guarantees a
 *  non-matching part always sits between any two matching ones, and
 *  `RegExp.prototype.test` resets `lastIndex` to 0 on every failed match — so
 *  a success-carried `lastIndex` is always cleared by the plain-text part
 *  between two dice parts before the next dice part gets tested. Keeping two
 *  regex objects removes the dependency on that calling order instead of
 *  relying on it; it costs nothing and doesn't ask a future reader to reason
 *  about `split`'s internals to convince themselves the code is safe.
 */
const DICE_SPLIT = /(\d+d\d+(?:[+-]\d+)?)/g;

/** Non-global by construction: it has no `lastIndex`, so every `.test` call
 *  is independent of every other regardless of call order — the safety comes
 *  from the missing `g` flag, not from freshness (this is a module-level
 *  constant created once, exactly like `DICE_SPLIT`). Matches a part in full
 *  (`^...$`) since parts from `DICE_SPLIT`'s capture group are already
 *  exactly a dice expression or exactly plain text, never a mix of the two.
 */
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
