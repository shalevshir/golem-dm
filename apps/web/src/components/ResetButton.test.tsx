// The confirmation is the whole point of this component — a one-click reset
// would need no component at all — so that is what these test.
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ResetButton } from "./ResetButton.js";
import { he } from "../i18n.js";

describe("ResetButton", () => {
  it("does not reset on the first click", async () => {
    const onReset = vi.fn();
    render(<ResetButton onReset={onReset} />);

    await userEvent.click(screen.getByRole("button", { name: he.app.reset }));

    expect(onReset).not.toHaveBeenCalled();
    expect(screen.getByText(he.app.resetConfirm)).toBeTruthy();
  });

  it("resets once the player confirms", async () => {
    const onReset = vi.fn();
    render(<ResetButton onReset={onReset} />);

    await userEvent.click(screen.getByRole("button", { name: he.app.reset }));
    await userEvent.click(screen.getByRole("button", { name: he.actions.confirm }));

    expect(onReset).toHaveBeenCalledTimes(1);
  });

  it("goes back to asking nothing when the player cancels", async () => {
    const onReset = vi.fn();
    render(<ResetButton onReset={onReset} />);

    await userEvent.click(screen.getByRole("button", { name: he.app.reset }));
    await userEvent.click(screen.getByRole("button", { name: he.actions.cancel }));

    expect(onReset).not.toHaveBeenCalled();
    expect(screen.queryByText(he.app.resetConfirm)).toBeNull();
    expect(screen.getByRole("button", { name: he.app.reset })).toBeTruthy();
  });
});
