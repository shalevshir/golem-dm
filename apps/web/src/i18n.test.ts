import { describe, expect, it } from "vitest";
import { actionLabel, errorMessage, he, rejectionMessage } from "./i18n.js";

describe("i18n", () => {
  it("renders a known server error code in Hebrew", () => {
    expect(errorMessage("unknown_campaign")).toBe(he.errors.unknown_campaign);
    expect(errorMessage("unknown_campaign")).not.toBe("unknown_campaign");
  });

  it("falls back to the raw code for an unknown error code", () => {
    // `ServerErrorCode` can widen — the client must render one it has never
    // seen rather than showing nothing.
    expect(errorMessage("some_future_code")).toBe("some_future_code");
  });

  it("falls back to the raw code for an unknown one", () => {
    // Rejection reasons are open strings on the wire — the type lives
    // downstream in the rules engine — so the client must render one it has
    // never seen rather than showing nothing.
    expect(rejectionMessage("some_future_reason")).toBe("some_future_reason");
  });

  it("renders a known rejection reason in Hebrew", () => {
    expect(rejectionMessage("target_out_of_reach")).toBe(he.rejections.target_out_of_reach);
  });
});

describe("actionLabel", () => {
  it("returns the Hebrew label for a universal (no-actionId) action", () => {
    expect(actionLabel("dodge")).toBe(he.actions.dodge);
    expect(actionLabel("dash")).toBe(he.actions.dash);
    expect(actionLabel("disengage")).toBe(he.actions.disengage);
  });

  it("returns undefined for an action type with no universal label", () => {
    expect(actionLabel("attack")).toBeUndefined();
  });
});
