import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

describe("loadConfig", () => {
  it("accepts a minimal environment", () => {
    const config = loadConfig({ ANTHROPIC_API_KEY: "sk-test" });
    expect(config.port).toBe(3000);
    expect(config.logLevel).toBe("info");
  });

  it("parses PORT as a number", () => {
    expect(loadConfig({ ANTHROPIC_API_KEY: "sk-test", PORT: "8080" }).port).toBe(8080);
  });

  it("fails fast when no provider key is present", () => {
    expect(() => loadConfig({})).toThrow(/at least one provider API key/);
  });

  it("rejects a non-numeric PORT rather than defaulting", () => {
    expect(() => loadConfig({ ANTHROPIC_API_KEY: "sk-test", PORT: "http" })).toThrow();
  });

  it("rejects an unknown LOG_LEVEL", () => {
    expect(() => loadConfig({ ANTHROPIC_API_KEY: "sk-test", LOG_LEVEL: "chatty" })).toThrow();
  });
});
