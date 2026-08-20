import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { he } from "../i18n.js";
import { ErrorBanner } from "./ErrorBanner.js";
import { NarrativePane } from "./NarrativePane.js";

describe("NarrativePane", () => {
  it("renders Hebrew narrative with dice notation isolated", () => {
    // The RTL rendering test apps/web/CLAUDE.md names explicitly: mixed
    // Hebrew and dice notation. Without <bdi> the trailing punctuation of an
    // LTR run reorders and "2d6+3." renders as ".2d6+3".
    const { container } = render(<NarrativePane text="החרב פוגעת ומסבה 2d6+3 נזק." />);
    expect(screen.getByText(/החרב פוגעת/)).toBeInTheDocument();
    expect(Array.from(container.querySelectorAll("bdi"), (each) => each.textContent)).toContain(
      "2d6+3",
    );
  });

  it("isolates a bare die expression too", () => {
    const { container } = render(<NarrativePane text="גלגול 1d20 מול שריון." />);
    expect(Array.from(container.querySelectorAll("bdi"), (each) => each.textContent)).toContain(
      "1d20",
    );
  });

  it("renders plain Hebrew with no isolation at all", () => {
    const { container } = render(<NarrativePane text="הגובלין נופל." />);
    expect(container.querySelectorAll("bdi")).toHaveLength(0);
  });
});

describe("ErrorBanner", () => {
  it("renders a known error code in Hebrew", () => {
    render(
      <ErrorBanner
        error={{ code: "unknown_session", message: "gone" }}
        rejection={null}
        onDismiss={() => undefined}
        onReconnect={() => undefined}
      />,
    );
    expect(screen.getByText(he.errors.unknown_session)).toBeInTheDocument();
  });

  it("falls back to the raw code for one it does not know", () => {
    render(
      <ErrorBanner
        error={{ code: "some_future_code", message: "x" }}
        rejection={null}
        onDismiss={() => undefined}
        onReconnect={() => undefined}
      />,
    );
    expect(screen.getByText(/some_future_code/)).toBeInTheDocument();
  });

  it("renders nothing when there is nothing to report", () => {
    const { container } = render(
      <ErrorBanner
        error={null}
        rejection={null}
        onDismiss={() => undefined}
        onReconnect={() => undefined}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("renders every rejection reason in Hebrew", () => {
    render(
      <ErrorBanner
        error={null}
        rejection={{ reasons: ["target_out_of_reach"], messages: ["too far"] }}
        onDismiss={() => undefined}
        onReconnect={() => undefined}
      />,
    );
    expect(screen.getByText(he.rejections.target_out_of_reach)).toBeInTheDocument();
  });

  it("renders both instances when the same rejection reason repeats", () => {
    // Reachable on the wire: `reasons` is a plain string array built from
    // `validation.rejections.map(each => each.reason)`, so two sub-actions
    // failing for the same reason produce a duplicate entry. A key collision
    // wouldn't drop a line here, but this pins that both still render.
    render(
      <ErrorBanner
        error={null}
        rejection={{
          reasons: ["target_out_of_reach", "target_out_of_reach"],
          messages: ["too far", "also too far"],
        }}
        onDismiss={() => undefined}
        onReconnect={() => undefined}
      />,
    );
    expect(screen.getAllByText(he.rejections.target_out_of_reach)).toHaveLength(2);
  });

  it("renders nothing for a not_your_turn error", () => {
    // Per the spec's error table, `not_your_turn` means a stale click — the
    // affordance frame already governs what is clickable, so surfacing this
    // to the player would be a UX regression, not useful information.
    const { container } = render(
      <ErrorBanner
        error={{ code: "not_your_turn", message: "stale click" }}
        rejection={null}
        onDismiss={() => undefined}
        onReconnect={() => undefined}
      />,
    );
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("dismisses", async () => {
    const onDismiss = vi.fn();
    render(
      <ErrorBanner
        error={{ code: "internal_error", message: "boom" }}
        rejection={null}
        onDismiss={onDismiss}
        onReconnect={() => undefined}
      />,
    );
    // Two buttons render for `internal_error` now (start-over and dismiss),
    // so the dismiss control has to be picked out by name.
    await userEvent.click(screen.getByRole("button", { name: "✕" }));
    expect(onDismiss).toHaveBeenCalled();
  });

  it("offers a reconnect control on internal_error, and not on other codes", async () => {
    // Spec's error table: `internal_error` → "Surface, and offer reconnect".
    // Every other code either has its own recovery path (`unknown_session`
    // resets automatically) or genuinely needs no reconnect, so the control
    // is scoped to this one code rather than shown for every error.
    const onReconnect = vi.fn();
    const { rerender } = render(
      <ErrorBanner
        error={{ code: "internal_error", message: "boom" }}
        rejection={null}
        onDismiss={() => undefined}
        onReconnect={onReconnect}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: he.app.reconnect }));
    expect(onReconnect).toHaveBeenCalled();

    rerender(
      <ErrorBanner
        error={{ code: "unknown_session", message: "gone" }}
        rejection={null}
        onDismiss={() => undefined}
        onReconnect={onReconnect}
      />,
    );
    expect(screen.queryByRole("button", { name: he.app.reconnect })).not.toBeInTheDocument();
  });
});
