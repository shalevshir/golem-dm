import { describe, expect, it } from "vitest";
import { z } from "zod";
import { adapterFailure, adapterSuccess } from "./errors.js";
import type { LanguageModelPort, StreamChunk } from "./port.js";
import { createFakePort } from "./testing/fake-port.js";
import { createTimingPort } from "./timing.js";

const spec = { provider: "google" as const, modelId: "gemini-3-flash" };
const usage = { promptTokens: 10, completionTokens: 4, totalTokens: 14 };
const prompt = { static: ["RULES"], dynamic: ["TURN STATE"] };

const structuredRequest = {
  prompt,
  schema: z.object({ actorId: z.string() }),
  toolName: "execute_turn",
  toolDescription: "Propose a turn.",
};

/** A scripted clock, so a timing assertion is exact rather than wall-clock flaky. */
function clockOf(...readings: number[]): () => number {
  const remaining = [...readings];
  return () => {
    const next = remaining.shift();
    if (next === undefined) throw new Error("Clock script exhausted");
    return next;
  };
}

describe("createTimingPort", () => {
  it("records how long a structured call took", async () => {
    const inner = createFakePort({ structured: [adapterSuccess({ value: { actorId: "gob-1" }, usage })] });
    const port = createTimingPort(inner, { now: clockOf(1000, 1350) });

    await port.generateStructured(spec, structuredRequest);

    expect(port.timings).toHaveLength(1);
    expect(port.timings[0]?.kind).toBe("structured");
    expect(port.timings[0]?.durationMs).toBe(350);
  });

  it("records how long a text call took", async () => {
    const inner = createFakePort({ text: [adapterSuccess({ text: "ok", usage })] });
    const port = createTimingPort(inner, { now: clockOf(1000, 1080) });

    await port.generateText(spec, { prompt });

    expect(port.timings[0]?.kind).toBe("text");
    expect(port.timings[0]?.durationMs).toBe(80);
  });

  it("times a failed call too, since a slow failure still spends the turn budget", async () => {
    const inner = createFakePort({ structured: [adapterFailure("provider_error", "429 rate limited")] });
    const port = createTimingPort(inner, { now: clockOf(1000, 9000) });

    const result = await port.generateStructured(spec, structuredRequest);

    expect(result.ok).toBe(false);
    expect(port.timings[0]?.durationMs).toBe(8000);
  });

  it("separates time-to-first-chunk from total stream duration", async () => {
    const inner = createFakePort({
      stream: [
        [
          { type: "text-delta", text: "הגובלין" },
          { type: "text-delta", text: " נופל" },
          { type: "finish", text: "הגובלין נופל", usage },
        ],
      ],
    });
    // start, first chunk, then completion.
    const port = createTimingPort(inner, { now: clockOf(1000, 2200, 4000) });

    const seen: StreamChunk[] = [];
    for await (const chunk of port.streamText(spec, { prompt })) {
      seen.push(chunk);
    }

    // Step 9's exit criterion is first token under 1.5s p50 — that number is
    // only measurable if first-chunk time is recorded separately from total.
    expect(seen).toHaveLength(3);
    expect(port.timings[0]?.kind).toBe("stream");
    expect(port.timings[0]?.firstChunkMs).toBe(1200);
    expect(port.timings[0]?.durationMs).toBe(3000);
  });

  it("leaves firstChunkMs absent when a stream yields nothing", async () => {
    const inner = createFakePort({ stream: [[]] });
    const port = createTimingPort(inner, { now: clockOf(1000, 1500) });

    const seen: StreamChunk[] = [];
    for await (const chunk of port.streamText(spec, { prompt })) {
      seen.push(chunk);
    }

    expect(seen).toHaveLength(0);
    expect(port.timings[0]?.durationMs).toBe(500);
    expect(port.timings[0]?.firstChunkMs).toBeUndefined();
  });

  it("returns the inner port's result unchanged", async () => {
    const inner = createFakePort({ structured: [adapterSuccess({ value: { actorId: "gob-1" }, usage })] });
    const port = createTimingPort(inner, { now: clockOf(1000, 1100) });

    const result = await port.generateStructured(spec, structuredRequest);

    if (!result.ok) throw new Error("expected success");
    expect(result.value.value).toStrictEqual({ actorId: "gob-1" });
    expect(result.value.usage).toStrictEqual(usage);
  });

  it("passes the spec and request through to the inner port untouched", async () => {
    const inner = createFakePort({ structured: [adapterSuccess({ value: { actorId: "gob-1" }, usage })] });
    const port = createTimingPort(inner, { now: clockOf(1000, 1100) });

    await port.generateStructured(spec, structuredRequest);

    expect(inner.calls[0]?.spec).toStrictEqual(spec);
    expect(inner.calls[0]?.request.prompt).toStrictEqual(prompt);
    expect(inner.calls[0]?.request.toolName).toBe("execute_turn");
  });

  it("records one entry per call, in call order", async () => {
    const inner = createFakePort({
      structured: [
        adapterFailure("no_tool_call", "answered in prose"),
        adapterSuccess({ value: { actorId: "gob-1" }, usage }),
      ],
    });
    const port = createTimingPort(inner, { now: clockOf(0, 100, 100, 450) });

    await port.generateStructured(spec, structuredRequest);
    await port.generateStructured(spec, structuredRequest);

    expect(port.timings.map((timing) => timing.durationMs)).toStrictEqual([100, 350]);
  });

  it("defaults to a real clock when none is injected", async () => {
    const inner = createFakePort({ structured: [adapterSuccess({ value: { actorId: "gob-1" }, usage })] });
    const port = createTimingPort(inner);

    await port.generateStructured(spec, structuredRequest);

    expect(port.timings[0]?.durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe("createTimingPort — measuring until settled", () => {
  // The scripted-clock tests above cannot catch a missing `await` inside the
  // decorator: they read the same two values whether the timer stops when the
  // call *starts* or when it *settles*. This one holds the call open and moves
  // the clock while it is in flight, so only a decorator that awaits sees 500.
  it("measures until the call settles, not until it starts", async () => {
    let clock = 0;
    let release = (): void => undefined;
    const inFlight = new Promise<void>((resolve) => {
      release = resolve;
    });

    // Driven through `generateText` rather than `generateStructured`: both go
    // through the same `timed` helper, and the non-generic signature keeps this
    // stub free of casts.
    const slowInner: LanguageModelPort = {
      generateStructured() {
        throw new Error("not used in this test");
      },
      async generateText() {
        await inFlight;
        return adapterSuccess({ text: "ok", usage });
      },
      streamText() {
        throw new Error("not used in this test");
      },
    };

    const port = createTimingPort(slowInner, { now: () => clock });
    const pending = port.generateText(spec, { prompt });

    clock = 500; // the provider is working; time passes
    release();
    await pending;

    expect(port.timings[0]?.durationMs).toBe(500);
  });
});
