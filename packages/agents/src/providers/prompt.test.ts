import { describe, expect, it } from "vitest";
import { assemblePrompt } from "./prompt.js";

const threeTiers = {
  static: ["SYSTEM RULES", "HEBREW GLOSSARY"],
  semiStatic: ["CHARACTER SHEET"],
  dynamic: ["TURN STATE"],
} as const;

describe("assemblePrompt", () => {
  it("orders static before semi-static before dynamic", () => {
    const messages = assemblePrompt(threeTiers, "anthropic");

    expect(messages.map((message) => message.role)).toStrictEqual(["system", "system", "user"]);
    expect(messages[0]?.content).toBe("SYSTEM RULES\n\nHEBREW GLOSSARY");
    expect(messages[1]?.content).toBe("CHARACTER SHEET");
    expect(messages[2]?.content).toBe("TURN STATE");
  });

  // The whole point of the type: dynamic content inside the cached prefix
  // silently destroys the prompt-cache discount and nobody notices in review.
  it("keeps dynamic content out of the cached system prefix", () => {
    const systemText = assemblePrompt(threeTiers, "anthropic")
      .filter((message) => message.role === "system")
      .map((message) => message.content)
      .join("\n");

    expect(systemText).not.toContain("TURN STATE");
  });

  it("marks the last cached tier as the Anthropic cache breakpoint", () => {
    const messages = assemblePrompt(threeTiers, "anthropic");

    expect(messages[0]?.providerOptions).toBeUndefined();
    expect(messages[1]?.providerOptions).toStrictEqual({
      anthropic: { cacheControl: { type: "ephemeral" } },
    });
    expect(messages[2]?.providerOptions).toBeUndefined();
  });

  it("moves the breakpoint to the static tier when nothing is semi-static", () => {
    const messages = assemblePrompt({ static: ["SYSTEM RULES"], dynamic: ["TURN STATE"] }, "anthropic");

    expect(messages.map((message) => message.role)).toStrictEqual(["system", "user"]);
    expect(messages[0]?.providerOptions).toStrictEqual({
      anthropic: { cacheControl: { type: "ephemeral" } },
    });
  });

  it.each(["google", "openai"] as const)(
    "omits cache control for %s, which caches by prefix automatically",
    (provider) => {
      const messages = assemblePrompt(threeTiers, provider);

      for (const message of messages) {
        expect(message.providerOptions).toBeUndefined();
      }
    },
  );

  it("skips empty tiers rather than emitting blank messages", () => {
    const messages = assemblePrompt(
      { static: ["SYSTEM RULES"], semiStatic: [], dynamic: ["TURN STATE"] },
      "anthropic",
    );

    expect(messages).toHaveLength(2);
    expect(messages.map((message) => message.content)).toStrictEqual([
      "SYSTEM RULES",
      "TURN STATE",
    ]);
  });

  it("emits no user message when there is no dynamic tier", () => {
    const messages = assemblePrompt({ static: ["SYSTEM RULES"] }, "anthropic");

    expect(messages.map((message) => message.role)).toStrictEqual(["system"]);
  });

  it("joins several dynamic segments into one user message", () => {
    const messages = assemblePrompt(
      { static: ["SYSTEM RULES"], dynamic: ["COMBAT STATE", "PLAYER SAID"] },
      "anthropic",
    );

    expect(messages[1]?.content).toBe("COMBAT STATE\n\nPLAYER SAID");
  });
});
