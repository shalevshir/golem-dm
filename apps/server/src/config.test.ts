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
    // Must-fix minor: the original version called `expect.unreachable()`
    // INSIDE the `try`, so if `loadConfig` ever stopped throwing, that call's
    // own thrown AssertionError landed in the very same `catch` below — and
    // its message ("expected ... not to be reached") contains no secret, so
    // both `.not.toContain` assertions still ran and passed. The test could
    // not distinguish "loadConfig threw for the right reason" from
    // "loadConfig never threw at all" (verified empirically: `expect.
    // assertions(2)`, the other candidate fix, does NOT catch this either —
    // both branches still execute exactly two assertions regardless). A
    // `caught` flag lets `expect.unreachable` run OUTSIDE the `try`/`catch`,
    // so its own throw is never swallowed by the same `catch` the real
    // assertions live in — that is what makes a silently-fixed `loadConfig`
    // fail this test loudly instead of passing for the wrong reason.
    const secret = "sk-marked-secret-value";
    let caught = false;
    try {
      loadConfig({ ANTHROPIC_API_KEY: secret, PORT: "not-a-port" });
    } catch (err) {
      caught = true;
      expect(err instanceof Error ? err.message : "").not.toContain(secret);
      expect(String(err)).not.toContain(secret);
    }
    if (!caught) {
      expect.unreachable("loadConfig should have thrown on the invalid PORT");
    }
  });

  it("reads DATABASE_URL when set", () => {
    expect(
      loadConfig({ ANTHROPIC_API_KEY: "k", DATABASE_URL: "postgres://u:p@h:5432/db" }).databaseUrl,
    ).toBe("postgres://u:p@h:5432/db");
  });

  it("treats a blank DATABASE_URL as absent", () => {
    // `.env.example` ships keys blank, and a `.env` loader materialises
    // `DATABASE_URL=` as "" rather than as missing. Blank must mean
    // in-memory, not a connection attempt to the empty string.
    expect(loadConfig({ ANTHROPIC_API_KEY: "k", DATABASE_URL: "" }).databaseUrl).toBeUndefined();
  });

  it("leaves databaseUrl undefined when unset", () => {
    expect(loadConfig({ ANTHROPIC_API_KEY: "k" }).databaseUrl).toBeUndefined();
  });
});
