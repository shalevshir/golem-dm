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
//
// Three states, and the last two are why this component exists at all. A
// terminal node has no edges, so rendering only edges meant the options
// silently vanished at the end of the arc — indistinguishable, from the
// player's seat, from the game breaking. `canConclude` is what tells "press
// this to finish" apart from "this story is over", and the server decides
// which it is.
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
  // Before the first frame there is nothing to say yet — not even that the
  // story is over, which would be a lie for one render.
  if (affordances === null) return null;

  const finished = affordances.edges.length === 0 && !affordances.canConclude;

  return (
    <section className="scene-options">
      <h2>{he.scene.optionsTitle}</h2>
      {finished ? (
        <p className="scene-story-over">{he.scene.storyOver}</p>
      ) : (
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
          {affordances.canConclude ? (
            <button
              type="button"
              className="scene-conclude"
              disabled={props.disabled}
              onClick={() => {
                props.onChoose(he.scene.conclude);
              }}
            >
              {he.scene.conclude}
            </button>
          ) : null}
        </div>
      )}
    </section>
  );
}
