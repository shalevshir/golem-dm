import { describe, expect, it, vi } from "vitest";
import { createAgentRuntime, createFakePort, DEFAULT_MODEL_ROUTING } from "@ai-dm/agents";
import type { HebrewNarrativeOptions, NarrativePort } from "@ai-dm/agents";
// Namespace type import, used only as `typeof AgentsModule` below — needed so
// `vi.importActual`'s type argument does not spell an inline `import(...)`
// type, which `@typescript-eslint/consistent-type-imports` forbids.
import type * as AgentsModule from "@ai-dm/agents";
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
  it("covers every beat kind, severity band, non-alive status, gender, and prior narration in its corpus", () => {
    const kinds = new Set(SCRIPTED_BRIEFS.flatMap((brief) => brief.beats.map((beat) => beat.kind)));
    expect(kinds).toEqual(new Set(["move", "attack", "other-action", "unresolved", "hold"]));

    const severities = new Set(
      SCRIPTED_BRIEFS.flatMap((brief) =>
        brief.beats.flatMap((beat) =>
          beat.kind === "attack" && beat.severity !== undefined ? [beat.severity] : [],
        ),
      ),
    );
    expect(severities).toEqual(new Set(["graze", "solid", "severe", "felling"]));

    // A masculine-only fixture would still pass every test above — the spec
    // singles this dimension out by name for exactly that reason. Checked
    // separately for actors and for attack targets: `deterministic.ts`
    // agrees the actor's OWN verb with the actor's gender and a falling
    // target's verb with the TARGET's gender, two distinct agreement points
    // a renderer could get right for one role and wrong for the other.
    const actorGenders = new Set(SCRIPTED_BRIEFS.map((brief) => brief.actor.gender));
    expect(actorGenders).toEqual(new Set(["masculine", "feminine"]));

    const targetGenders = new Set(
      SCRIPTED_BRIEFS.flatMap((brief) =>
        brief.beats.flatMap((beat) => (beat.kind === "attack" ? [beat.target.gender] : [])),
      ),
    );
    expect(targetGenders).toEqual(new Set(["masculine", "feminine"]));

    const statusAftersBeyondAlive = new Set(
      SCRIPTED_BRIEFS.flatMap((brief) =>
        brief.beats.flatMap((beat) =>
          beat.kind === "attack" && beat.statusAfter !== "alive" ? [beat.statusAfter] : [],
        ),
      ),
    );
    expect(statusAftersBeyondAlive).toEqual(new Set(["unconscious", "dead"]));

    expect(SCRIPTED_BRIEFS.some((brief) => brief.recentNarrations.length > 0)).toBe(true);
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
      now: (() => {
        let t = 0;
        return () => (t += 100);
      })(),
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
      now: (() => {
        let t = 0;
        return () => (t += 100);
      })(),
    });
    expect(report.nonHebrewOutputs).toBe(SCRIPTED_BRIEFS.length);
    expect(report.digitViolations).toBe(0);
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
      now: (() => {
        let t = 0;
        return () => (t += 100);
      })(),
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
      now: (() => {
        let t = 0;
        return () => (t += 100);
      })(),
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
      now: (() => {
        let t = 0;
        return () => (t += 100);
      })(),
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
      now: (() => {
        let t = 0;
        return () => (t += 100);
      })(),
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
      now: (() => {
        let t = 0;
        return () => (t += 100);
      })(),
    });
    expect(report.usage.promptTokens).toBe(USAGE.promptTokens * SCRIPTED_BRIEFS.length);
    expect(report.usage.completionTokens).toBe(USAGE.completionTokens * SCRIPTED_BRIEFS.length);
    expect(report.usage.costIsUnderreported).toBe(false);
    expect(report.usage.costUsd).not.toBeNull();
  });

  it("divides cost by the narrations that actually happened, not by the full errored+clean sample count", async () => {
    // Regression check for the review's finding: dividing by samples.length
    // (which includes the errored sample) would understate the cost of a
    // narration that actually happened. One errored sample among otherwise-
    // clean ones is the realistic shape — a single rate limit, not every
    // call failing at once.
    const report = await runNarrativeBenchmark({
      runtime: createAgentRuntime({
        routing: DEFAULT_MODEL_ROUTING,
        port: createFakePort({
          stream: [
            [
              {
                type: "error" as const,
                error: { code: "provider_error" as const, message: "boom" },
              },
            ],
            ...SCRIPTED_BRIEFS.slice(1).map(() => [
              { type: "text-delta" as const, text: "אלדד עומד במקומו." },
              { type: "finish" as const, text: "אלדד עומד במקומו.", usage: USAGE },
            ]),
          ],
        }),
      }),
      now: (() => {
        let t = 0;
        return () => (t += 100);
      })(),
    });

    expect(report.erroredSamples).toBe(1);
    const disciplineSampleCount = report.samples.length - report.erroredSamples;
    expect(report.usage.costUsd).not.toBeNull();
    const cost = report.usage.costUsd ?? 0;

    expect(report.usage.costPerNarrationUsd).toBeCloseTo(cost / disciplineSampleCount, 10);
    // The bug this guards against: dividing by the full sample count instead
    // (including the one that errored) would produce a visibly different,
    // smaller number — proven false here rather than merely proving the
    // correct value true, so a regression to the old divisor is caught even
    // if it happens to round to the same displayed figure at 4 decimals.
    expect(report.usage.costPerNarrationUsd).not.toBeCloseTo(cost / report.samples.length, 10);
  });

  it("excludes an errored stream from usage, every classification counter, and the TTFT percentiles", async () => {
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
      now: (() => {
        let t = 0;
        return () => (t += 100);
      })(),
    });
    // Fix round 1, finding 4: an errored attempt reporting no usage is the
    // expected shape of a failure, not a shortfall the reader needs a
    // separate "cost is under-reported" warning for — narrative-report.ts
    // already states the erroredSamples count on its own, right above the
    // Cost section. `costIsUnderreported` now stays false when every sample
    // in the run errored, since there was no non-errored attempt whose
    // usage could have gone missing.
    expect(report.usage.costIsUnderreported).toBe(false);
    // The exact bug the review found: an errored stream's empty text must
    // not be scored as a Hebrew-discipline violation, and its ttftMs — which,
    // with no token ever arriving, measures the gap to the ERROR — must not
    // be pooled into the latency percentiles.
    expect(report.erroredSamples).toBe(SCRIPTED_BRIEFS.length);
    expect(report.nonHebrewOutputs).toBe(0);
    expect(report.digitViolations).toBe(0);
    expect(report.overLengthOutputs).toBe(0);
    expect(report.ttftMsP50).toBe(0);
    expect(report.ttftMsP95).toBe(0);
    for (const sample of report.samples) {
      expect(sample.errorCode).toBe("provider_error");
      expect(sample.digitViolation).toBe(false);
      expect(sample.nonHebrew).toBe(false);
      expect(sample.overLength).toBe(false);
    }
  });

  it("excludes usage from a finish that carries both error and usage together, not just from an errored finish with no usage at all", async () => {
    // Fix round 1, finding 2: `NarrativeFinish` declares `usage` and `error`
    // as independent optional fields (hebrew.ts) — nothing in the type
    // forbids a provider from reporting both on the same finish. This case
    // cannot be constructed through the fake port used everywhere else in
    // this file: `StreamChunk`'s "finish" and "error" variants
    // (providers/port.ts) are mutually exclusive at the wire level, and
    // hebrew.ts's own streamNarration returns on whichever one arrives
    // first, so no sequence of fake-port chunks can make the real
    // createHebrewNarrative call onFinish with both set. Substituting
    // createHebrewNarrative itself, scoped to this one test via vi.doMock
    // plus a scoped re-import, is what actually exercises the guard rather
    // than arguing it would work.
    vi.resetModules();
    vi.doMock("@ai-dm/agents", async () => {
      const actual = await vi.importActual<typeof AgentsModule>("@ai-dm/agents");
      return {
        ...actual,
        createHebrewNarrative: (options: HebrewNarrativeOptions): NarrativePort => ({
          stream(): AsyncIterable<string> {
            // Replaying two precomputed values needs no await; the interface
            // still has to be an async generator because a real stream is
            // one (same reasoning as providers/testing/fake-port.ts's own
            // streamText double).
            // eslint-disable-next-line @typescript-eslint/require-await
            return (async function* (): AsyncGenerator<string> {
              yield "אלדד עומד במקומו.";
              options.onFinish?.({
                usage: USAGE,
                error: { code: "provider_error", message: "usage alongside an in-band error" },
                latencyMs: 5,
                promptVersion: "test",
              });
            })();
          },
        }),
      };
    });

    try {
      const { runNarrativeBenchmark: mockedRunNarrativeBenchmark } = await import("./narrative.js");

      const report = await mockedRunNarrativeBenchmark({
        runtime: createAgentRuntime({
          routing: DEFAULT_MODEL_ROUTING,
          port: createFakePort({ stream: [] }),
        }),
        now: (() => {
          let t = 0;
          return () => (t += 100);
        })(),
      });

      // Every sample carried BOTH an error and usage — none of it may enter
      // the totals, and none of it may be treated as "usage went missing"
      // either, since these are errored attempts, not clean ones with a
      // shortfall.
      expect(report.erroredSamples).toBe(report.samples.length);
      expect(report.usage.promptTokens).toBe(0);
      expect(report.usage.completionTokens).toBe(0);
      expect(report.usage.costIsUnderreported).toBe(false);
    } finally {
      vi.doUnmock("@ai-dm/agents");
      vi.resetModules();
    }
  });

  it("keeps a clean sample's own TTFT and classification when a different sample in the same run errored", async () => {
    // The more realistic live shape: one transient failure (a rate limit,
    // say) among otherwise-healthy streams, not every call failing at once.
    const report = await runNarrativeBenchmark({
      runtime: createAgentRuntime({
        routing: DEFAULT_MODEL_ROUTING,
        port: createFakePort({
          stream: [
            [
              {
                type: "error" as const,
                error: { code: "provider_error" as const, message: "boom" },
              },
            ],
            ...SCRIPTED_BRIEFS.slice(1).map(() => [
              { type: "text-delta" as const, text: "אלדד עומד במקומו." },
              { type: "finish" as const, text: "אלדד עומד במקומו.", usage: USAGE },
            ]),
          ],
        }),
      }),
      now: (() => {
        let t = 0;
        return () => (t += 100);
      })(),
    });
    expect(report.erroredSamples).toBe(1);
    expect(report.samples[0]?.errorCode).toBe("provider_error");
    expect(report.samples.slice(1).every((sample) => sample.errorCode === undefined)).toBe(true);
    expect(report.nonHebrewOutputs).toBe(0);
    expect(report.ttftMsP50).toBeGreaterThan(0);
  });
});
