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

  it("treats a blank key as absent when another key is present", () => {
    expect(() => loadConfig({ ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "sk-test" })).not.toThrow();
  });

  it("fails fast when the only key present is blank", () => {
    expect(() => loadConfig({ ANTHROPIC_API_KEY: "" })).toThrow(/at least one provider API key/);
  });

  it("rejects a non-numeric PORT rather than defaulting", () => {
    expect(() => loadConfig({ ANTHROPIC_API_KEY: "sk-test", PORT: "http" })).toThrow(/PORT/);
  });

  it("rejects an unknown LOG_LEVEL", () => {
    expect(() => loadConfig({ ANTHROPIC_API_KEY: "sk-test", LOG_LEVEL: "chatty" })).toThrow(
      /LOG_LEVEL/,
    );
  });

  it("never includes a provider key's value in a thrown error message", () => {
    const secret = "sk-marked-secret-value";
    try {
      loadConfig({ ANTHROPIC_API_KEY: secret, PORT: "not-a-port" });
      expect.unreachable("loadConfig should have thrown on the invalid PORT");
    } catch (err) {
      expect(err instanceof Error ? err.message : "").not.toContain(secret);
      expect(String(err)).not.toContain(secret);
    }
  });
});
