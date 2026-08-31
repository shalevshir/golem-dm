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

  // A terminal node has nowhere to go, and no frame has arrived before the
  // first turn. An empty "what can you do here" heading over no choices would
  // read as a bug rather than as an ending.
  it("renders nothing before the first frame or on a terminal node", () => {
    const { container: empty } = render(
      <SceneOptions affordances={null} disabled={false} onChoose={() => undefined} />,
    );
    expect(empty).toBeEmptyDOMElement();

    const { container: terminal } = render(
      <SceneOptions
        affordances={{ nodeId: "reckoning", edges: [] }}
        disabled={false}
        onChoose={() => undefined}
      />,
    );
    expect(terminal).toBeEmptyDOMElement();
  });
});
