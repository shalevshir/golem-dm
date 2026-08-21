import { describe, expect, it } from "vitest";
import { createAgentRuntime, createFakePort, DEFAULT_MODEL_ROUTING } from "@ai-dm/agents";
import { runNarrativeBenchmark, SCRIPTED_BRIEFS } from "./narrative.js";

// The brief's own fixture here named no field of the real `TokenUsage`
// ({ promptTokens, completionTokens, totalTokens } —
// packages/agents/src/providers/usage.ts). `vitest run` does not typecheck
// (esbuild transpiles without checking), so a mismatched fixture like the
// brief's original still runs green while quietly turning every usage sum
// into NaN; only `tsc --noEmit` would have caught it. Using the real shape
// here so this suite is a check against that, not a second instance of it.
const USAGE = { promptTokens: 900, completionTokens: 40, totalTokens: 940 };

describe("runNarrativeBenchmark", () => {
  it("covers every beat kind and severity band in its corpus", () => {
    const kinds = new Set(SCRIPTED_BRIEFS.flatMap((brief) => brief.beats.map((beat) => beat.kind)));
    expect(kinds).toEqual(new Set(["move", "attack", "other-action", "unresolved", "hold"]));

    const severities = new Set(
      SCRIPTED_BRIEFS.flatMap((brief) =>
        brief.beats.flatMap((beat) => (beat.kind === "attack" && beat.severity !== undefined ? [beat.severity] : [])),
      ),
    );
    expect(severities).toEqual(new Set(["graze", "solid", "severe", "felling"]));
  });

  it("counts a digit in the output as a violation", async () => {
    const report = await runNarrativeBenchmark({
      runtime: createAgentRuntime({
        routing: DEFAULT_MODEL_ROUTING,
        port: createFakePort({
          stream: SCRIPTED_BRIEFS.map(() => [
            { type: "text-delta" as const, text: "אלדד פוגע ב-7 נזק." },
            { type: "finish" as const, text: "אלדד פוגע ב-7 נזק.", usage: USAGE },
          ]),
        }),
      }),
      now: (() => { let t = 0; return () => (t += 100); })(),
    });
    expect(report.digitViolations).toBe(SCRIPTED_BRIEFS.length);
    expect(report.nonHebrewOutputs).toBe(0);
  });

  it("counts English output as a non-Hebrew violation", async () => {
    const report = await runNarrativeBenchmark({
      runtime: createAgentRuntime({
        routing: DEFAULT_MODEL_ROUTING,
        port: createFakePort({
          stream: SCRIPTED_BRIEFS.map(() => [
            { type: "text-delta" as const, text: "Eldad holds position." },
            { type: "finish" as const, text: "Eldad holds position.", usage: USAGE },
          ]),
        }),
      }),
      now: (() => { let t = 0; return () => (t += 100); })(),
    });
    expect(report.nonHebrewOutputs).toBe(SCRIPTED_BRIEFS.length);
  });

  it("reports the median time to the first token, not to the last", async () => {
    const report = await runNarrativeBenchmark({
      runtime: createAgentRuntime({
        routing: DEFAULT_MODEL_ROUTING,
        port: createFakePort({
          stream: SCRIPTED_BRIEFS.map(() => [
            { type: "text-delta" as const, text: "אלדד " },
            { type: "text-delta" as const, text: "עומד במקומו." },
            { type: "finish" as const, text: "אלדד עומד במקומו.", usage: USAGE },
          ]),
        }),
      }),
      now: (() => { let t = 0; return () => (t += 100); })(),
    });
    expect(report.samples).toHaveLength(SCRIPTED_BRIEFS.length);
    expect(report.ttftMsP50).toBeLessThan(report.ttftMsP95 + 1);
  });

  // The test above passes even under a time-to-LAST-token bug — every brief
  // gets the identical script, so every sample's TTFT lands on the same
  // value regardless of which chunk it was measured against, and p50 < p95+1
  // holds either way. This one pins an exact value that a first-vs-last
  // sabotage would change.
  it("measures ttft as the gap to the first chunk, not the last", async () => {
    // Three deltas before finish, so "first" and "last" token timing
    // diverge under this clock: one tick to `startedAt`, a second on the
    // FIRST delta (the true TTFT), then further ticks for the two later
    // deltas a time-to-LAST-token bug would pick up instead.
    // `firstTokenAt` is written at most once per brief (`??=` in the
    // implementation), so the correct value here is a flat 100 regardless
    // of how many deltas follow — a last-token bug would report 300.
    let t = 0;
    const now = (): number => (t += 100);
    const report = await runNarrativeBenchmark({
      runtime: createAgentRuntime({
        routing: DEFAULT_MODEL_ROUTING,
        port: createFakePort({
          stream: SCRIPTED_BRIEFS.map(() => [
            { type: "text-delta" as const, text: "א" },
            { type: "text-delta" as const, text: "ב" },
            { type: "text-delta" as const, text: "ג" },
            { type: "finish" as const, text: "אבג", usage: USAGE },
          ]),
        }),
      }),
      now,
    });
    expect(report.ttftMsP50).toBe(100);
    expect(report.ttftMsP95).toBe(100);
  });

  it("counts an output past the sentence limit as an over-length violation", async () => {
    // Four sentences, reused verbatim from
    // packages/agents/src/narrative/deterministic.test.ts's FORM_TABLE, so
    // no fresh Hebrew is authored just for this unit test.
    const report = await runNarrativeBenchmark({
      runtime: createAgentRuntime({
        routing: DEFAULT_MODEL_ROUTING,
        port: createFakePort({
          stream: SCRIPTED_BRIEFS.map(() => [
            {
              type: "text-delta" as const,
              text: "אלדד מתקדם. אלדד עומד במקומו. אלדד נוקט פעולה. אלדד מחטיא את גובלין לוחם.",
            },
            { type: "finish" as const, text: "", usage: USAGE },
          ]),
        }),
      }),
      now: (() => { let t = 0; return () => (t += 100); })(),
    });
    expect(report.overLengthOutputs).toBe(SCRIPTED_BRIEFS.length);
  });

  // Guards the boundary the sibling test above does not: an off-by-one
  // (`>=` in place of `>` against SENTENCE_LIMIT) would flag this too.
  it("does not count an output at the sentence limit as an over-length violation", async () => {
    const report = await runNarrativeBenchmark({
      runtime: createAgentRuntime({
        routing: DEFAULT_MODEL_ROUTING,
        port: createFakePort({
          stream: SCRIPTED_BRIEFS.map(() => [
            { type: "text-delta" as const, text: "אלדד מתקדם. אלדד עומד במקומו. אלדד נוקט פעולה." },
            { type: "finish" as const, text: "", usage: USAGE },
          ]),
        }),
      }),
      now: (() => { let t = 0; return () => (t += 100); })(),
    });
    expect(report.overLengthOutputs).toBe(0);
  });

  it("carries each sample's source brief and an English gloss of its beats for the downstream review sheet", async () => {
    const report = await runNarrativeBenchmark({
      runtime: createAgentRuntime({
        routing: DEFAULT_MODEL_ROUTING,
        port: createFakePort({
          stream: SCRIPTED_BRIEFS.map(() => [
            { type: "text-delta" as const, text: "אלדד עומד במקומו." },
            { type: "finish" as const, text: "אלדד עומד במקומו.", usage: USAGE },
          ]),
        }),
      }),
      now: (() => { let t = 0; return () => (t += 100); })(),
    });
    expect(report.samples).toHaveLength(SCRIPTED_BRIEFS.length);
    report.samples.forEach((sample, index) => {
      // Task 16 needs the brief's own identity, not just an index into a
      // corpus it would otherwise have to re-import in lockstep.
      expect(sample.source).toBe(SCRIPTED_BRIEFS[index]);
      expect(sample.beatsEnglish.length).toBeGreaterThan(0);
      expect(sample.hebrew).toBe("אלדד עומד במקומו.");
    });
  });

  it("sums token usage across every sample and reports usage as complete", async () => {
    const report = await runNarrativeBenchmark({
      runtime: createAgentRuntime({
        routing: DEFAULT_MODEL_ROUTING,
        port: createFakePort({
          stream: SCRIPTED_BRIEFS.map(() => [
            { type: "text-delta" as const, text: "אלדד עומד במקומו." },
            { type: "finish" as const, text: "אלדד עומד במקומו.", usage: USAGE },
          ]),
        }),
      }),
      now: (() => { let t = 0; return () => (t += 100); })(),
    });
    expect(report.usage.promptTokens).toBe(USAGE.promptTokens * SCRIPTED_BRIEFS.length);
    expect(report.usage.completionTokens).toBe(USAGE.completionTokens * SCRIPTED_BRIEFS.length);
    expect(report.usage.costIsUnderreported).toBe(false);
    expect(report.usage.costUsd).not.toBeNull();
  });

  it("marks usage as under-reported when a stream ends in a provider error", async () => {
    const report = await runNarrativeBenchmark({
      runtime: createAgentRuntime({
        routing: DEFAULT_MODEL_ROUTING,
        port: createFakePort({
          stream: SCRIPTED_BRIEFS.map(() => [
            {
              type: "error" as const,
              error: { code: "provider_error" as const, message: "socket closed" },
            },
          ]),
        }),
      }),
      now: (() => { let t = 0; return () => (t += 100); })(),
    });
    expect(report.usage.costIsUnderreported).toBe(true);
  });
});
