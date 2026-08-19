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
      />,
    );
    expect(screen.getByText(/some_future_code/)).toBeInTheDocument();
  });

  it("renders nothing when there is nothing to report", () => {
    const { container } = render(
      <ErrorBanner error={null} rejection={null} onDismiss={() => undefined} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("renders every rejection reason in Hebrew", () => {
    render(
      <ErrorBanner
        error={null}
        rejection={{ reasons: ["target_out_of_reach"], messages: ["too far"] }}
        onDismiss={() => undefined}
      />,
    );
    expect(screen.getByText(he.rejections.target_out_of_reach)).toBeInTheDocument();
  });

  it("dismisses", async () => {
    const onDismiss = vi.fn();
    render(
      <ErrorBanner
        error={{ code: "internal_error", message: "boom" }}
        rejection={null}
        onDismiss={onDismiss}
      />,
    );
    await userEvent.click(screen.getByRole("button"));
    expect(onDismiss).toHaveBeenCalled();
  });
});
