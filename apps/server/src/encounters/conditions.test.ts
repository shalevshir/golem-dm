import { describe, expect, it } from "vitest";
import { loadConditions } from "./conditions.js";

describe("loadConditions", () => {
  it("loads every SRD condition keyed by its id", () => {
    const conditions = loadConditions();
    expect(conditions.size).toBe(15);
    expect(conditions.get("prone")?.nameHebrew).toBe("שרוע");
  });

  it("returns the same cached instance on a second call", () => {
    expect(loadConditions()).toBe(loadConditions());
  });
});
