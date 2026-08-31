import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { he } from "../i18n.js";
import type { SceneAffordances } from "../state/store.js";
import { SceneOptions } from "./SceneOptions.js";

const ARRIVAL: SceneAffordances = {
  nodeId: "arrival",
  edges: [
    { to: "guild-offer", labelHebrew: "להקשיב לנציג הגילדה", open: true },
    { to: "warden-warning", labelHebrew: "להקשיב לשומר הנהר", open: false },
  ],
  canConclude: false,
};

/** The last node of the arc, its closing beat not yet rung. */
const RECKONING_PENDING: SceneAffordances = {
  nodeId: "reckoning",
  edges: [],
  canConclude: true,
};

/** The same node once concluded: nothing left, and the game should say so. */
const RECKONING_DONE: SceneAffordances = {
  nodeId: "reckoning",
  edges: [],
  canConclude: false,
};

describe("SceneOptions", () => {
  it("shows every edge the scene offers, in Hebrew", () => {
    render(<SceneOptions affordances={ARRIVAL} disabled={false} onChoose={() => undefined} />);

    expect(screen.getByRole("heading", { name: he.scene.optionsTitle })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "להקשיב לנציג הגילדה" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "להקשיב לשומר הנהר" })).toBeInTheDocument();
  });

  // Shown-but-disabled, never hidden: that the arc has somewhere else to go,
  // and that it is not open yet, is more than a missing button conveys.
  it("shows a closed edge disabled rather than hiding it", () => {
    render(<SceneOptions affordances={ARRIVAL} disabled={false} onChoose={() => undefined} />);

    expect(screen.getByRole("button", { name: "להקשיב לנציג הגילדה" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "להקשיב לשומר הנהר" })).toBeDisabled();
  });

  // The label IS the message. Clicking takes the same path as typing it by
  // hand — router, then scene engine — so the component decides no legality.
  it("sends the chosen edge's Hebrew label as the player's own words", async () => {
    const onChoose = vi.fn();
    render(<SceneOptions affordances={ARRIVAL} disabled={false} onChoose={onChoose} />);

    await userEvent.click(screen.getByRole("button", { name: "להקשיב לנציג הגילדה" }));

    expect(onChoose).toHaveBeenCalledWith("להקשיב לנציג הגילדה");
  });

  it("disables every choice while a send is in flight", () => {
    render(<SceneOptions affordances={ARRIVAL} disabled onChoose={() => undefined} />);

    expect(screen.getByRole("button", { name: "להקשיב לנציג הגילדה" })).toBeDisabled();
  });

  it("renders nothing before the first frame arrives", () => {
    const { container } = render(
      <SceneOptions affordances={null} disabled={false} onChoose={() => undefined} />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  // The end of the arc, and the reason this component has a third state. A
  // terminal node has no edges, so rendering edges alone made the options
  // silently vanish — from the player's seat, indistinguishable from the game
  // breaking. Live: reaching `reckoning` left an empty panel and the closing
  // beat unrung, with nothing on screen saying which had happened.
  it("offers the closing beat on a terminal node whose ending has not fired", async () => {
    const onChoose = vi.fn();
    render(
      <SceneOptions affordances={RECKONING_PENDING} disabled={false} onChoose={onChoose} />,
    );

    await userEvent.click(screen.getByRole("button", { name: he.scene.conclude }));

    expect(onChoose).toHaveBeenCalledWith(he.scene.conclude);
    expect(screen.queryByText(he.scene.storyOver)).not.toBeInTheDocument();
  });

  it("says the story is over once the closing beat has fired", () => {
    render(<SceneOptions affordances={RECKONING_DONE} disabled={false} onChoose={() => undefined} />);

    expect(screen.getByText(he.scene.storyOver)).toBeInTheDocument();
    // Nothing left to press — an enabled button here would invite a turn that
    // the engine would only refuse.
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  // `canConclude` is the server's judgment, not `edges.length`: a mid-arc node
  // never offers the ending even though this component only ever sees a list.
  it("never offers the closing beat mid-arc", () => {
    render(<SceneOptions affordances={ARRIVAL} disabled={false} onChoose={() => undefined} />);

    expect(screen.queryByRole("button", { name: he.scene.conclude })).not.toBeInTheDocument();
  });
});
