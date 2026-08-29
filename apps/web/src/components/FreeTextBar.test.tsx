import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MAX_FREE_TEXT_LENGTH } from "@ai-dm/schemas";
import { he } from "../i18n.js";
import { FreeTextBar } from "./FreeTextBar.js";

describe("FreeTextBar", () => {
  it("renders an RTL input with the Hebrew placeholder and send label", () => {
    render(<FreeTextBar disabled={false} onSend={() => undefined} />);

    const input = screen.getByPlaceholderText(he.freeText.placeholder);
    expect(input).toHaveAttribute("dir", "rtl");
    expect(input).toHaveAttribute("maxLength", String(MAX_FREE_TEXT_LENGTH));
    expect(screen.getByRole("button", { name: he.freeText.send })).toBeInTheDocument();
  });

  it("respects the disabled prop on both the input and the send button", () => {
    render(<FreeTextBar disabled onSend={() => undefined} />);

    expect(screen.getByPlaceholderText(he.freeText.placeholder)).toBeDisabled();
    expect(screen.getByRole("button", { name: he.freeText.send })).toBeDisabled();
  });

  it("calls onSend with the trimmed text on Enter and clears itself", async () => {
    const onSend = vi.fn();
    render(<FreeTextBar disabled={false} onSend={onSend} />);

    const input = screen.getByPlaceholderText(he.freeText.placeholder);
    await userEvent.type(input, "  לך לשוק  {Enter}");

    expect(onSend).toHaveBeenCalledWith("לך לשוק");
    expect(input).toHaveValue("");
  });

  it("refuses an empty (or whitespace-only) submit", async () => {
    const onSend = vi.fn();
    render(<FreeTextBar disabled={false} onSend={onSend} />);

    const input = screen.getByPlaceholderText(he.freeText.placeholder);
    await userEvent.type(input, "   {Enter}");
    expect(onSend).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: he.freeText.send }));
    expect(onSend).not.toHaveBeenCalled();
  });
});
