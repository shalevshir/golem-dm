// The out-of-combat input: an RTL free-text box that sends whatever the
// player types as a `free_text` message. It decides nothing about legality --
// the intent router and the scene engine do that server-side (invariant 1) --
// it only builds the text and hands it to `onSend`, exactly the same
// division `ActionBar` keeps between "presentation" and "legality".
import { useState } from "react";
import type { JSX, KeyboardEvent } from "react";
import { MAX_FREE_TEXT_LENGTH } from "@ai-dm/schemas";
import { he } from "../i18n.js";

export interface FreeTextBarProps {
  disabled: boolean;
  /** App builds the `free_text` ClientMessage; this only carries the text. */
  onSend: (text: string) => void;
}

export function FreeTextBar(props: FreeTextBarProps): JSX.Element {
  const [text, setText] = useState("");

  function submit(): void {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    props.onSend(trimmed);
    setText("");
  }

  return (
    <div className="free-text-bar">
      <input
        type="text"
        dir="rtl"
        maxLength={MAX_FREE_TEXT_LENGTH}
        placeholder={he.freeText.placeholder}
        value={text}
        disabled={props.disabled}
        onChange={(event) => {
          setText(event.target.value);
        }}
        onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
          if (event.key === "Enter") submit();
        }}
      />
      <button type="button" disabled={props.disabled} onClick={submit}>
        {he.freeText.send}
      </button>
    </div>
  );
}
