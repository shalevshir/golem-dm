// What the scene actually offers, out of combat. The counterpart to
// `ActionBar`: combat has always shown its options on a board with an action
// bar, while a scene showed a paragraph and an empty text box, leaving the
// node's edges discoverable only by guessing a phrasing the router would read
// as `exploration`.
//
// It decides nothing. The server sends the edges it computed with the same
// `availableEdges` call the router classifies against, and clicking one sends
// its label as ordinary `free_text` — the same path typing it by hand takes,
// through the router and the scene engine (invariant 1). The labels are
// therefore useful even to a player who never clicks: they are the phrasing
// the game understands, shown rather than guessed at.
import type { JSX } from "react";
import { he } from "../i18n.js";
import type { SceneAffordances } from "../state/store.js";

export interface SceneOptionsProps {
  affordances: SceneAffordances | null;
  disabled: boolean;
  /** Sends the label as `free_text`, exactly as if the player typed it. */
  onChoose: (labelHebrew: string) => void;
}

export function SceneOptions(props: SceneOptionsProps): JSX.Element | null {
  const { affordances } = props;
  // Before the first frame, and on a terminal node with nowhere left to go.
  // Rendering an empty "what can you do here" heading over no choices would
  // read as a bug rather than as an ending.
  if (affordances === null || affordances.edges.length === 0) return null;

  return (
    <section className="scene-options">
      <h2>{he.scene.optionsTitle}</h2>
      <div className="scene-option-buttons">
        {affordances.edges.map((edge) => (
          <button
            key={edge.to}
            type="button"
            // A closed edge is shown disabled rather than hidden: that the
            // arc has somewhere else to go, and that it is not open yet, is
            // more than an edge which silently does not exist tells anyone.
            disabled={props.disabled || !edge.open}
            onClick={() => {
              props.onChoose(edge.labelHebrew);
            }}
          >
            {edge.labelHebrew}
          </button>
        ))}
      </div>
    </section>
  );
}
