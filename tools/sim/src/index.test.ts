import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "./index.js";
import { buildReport, writeReport } from "./run/report.js";

interface ProbeRecordShape {
  adapterErrorCodes: readonly string[];
}

interface LiveReportShape {
  live: boolean;
  records: { probe: readonly ProbeRecordShape[] };
}

interface NarrativeReportShape {
  live: boolean;
  promptVersion: string;
  samples: readonly { hebrew: string; errorCode?: string }[];
  digitViolations: number;
  nonHebrewOutputs: number;
  overLengthOutputs: number;
  erroredSamples: number;
  usage: { costIsUnderreported: boolean };
}

describe("writeReport", () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("creates both the JSON and markdown files under the given directory", () => {
    dir = mkdtempSync(join(tmpdir(), "ai-dm-sim-"));
    const report = buildReport({
      runId: "test-run",
      generatedAt: "2026-08-17T00:00:00.000Z",
      gitCommit: "abc1234",
      live: false,
      seeds: [1],
      scenarioIds: ["melee-brawl"],
    });

    const { jsonPath, markdownPath } = writeReport(report, dir);

    expect(existsSync(jsonPath)).toBe(true);
    expect(existsSync(markdownPath)).toBe(true);
    expect(JSON.parse(readFileSync(jsonPath, "utf8")) as unknown).toMatchObject({
      runId: "test-run",
    });
    expect(readFileSync(markdownPath, "utf8")).toContain("test-run");
  });
});

describe("main — --live", () => {
  const originalArgv = process.argv;
  const originalExitCode = process.exitCode;
  const KEY_VARS = ["ANTHROPIC_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "OPENAI_API_KEY"] as const;
  const savedKeys = new Map<string, string | undefined>();
  let writtenReportDir: string | undefined;

  beforeEach(() => {
    // Deterministic regardless of the ambient shell: this test's whole point
    // is what happens with no credentials, so the absence must be enforced
    // here rather than assumed.
    for (const name of KEY_VARS) {
      savedKeys.set(name, process.env[name]);
      Reflect.deleteProperty(process.env, name);
    }
  });

  afterEach(() => {
    process.argv = originalArgv;
    process.exitCode = originalExitCode;
    for (const [name, value] of savedKeys) {
      if (value === undefined) Reflect.deleteProperty(process.env, name);
      else process.env[name] = value;
    }
    savedKeys.clear();
    if (writtenReportDir !== undefined) rmSync(writtenReportDir, { recursive: true, force: true });
    writtenReportDir = undefined;
    vi.restoreAllMocks();
  });

  it("reaches real provider SDK code with no keys set, not the retired stub message", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    process.argv = [
      "node",
      "index.js",
      "--live",
      "--mode",
      "probe",
      "--seeds",
      "1",
      "--scenarios",
      "melee-brawl",
      "--arms",
      "gemini-3.1-flash-lite@low",
    ];

    await main();

    // The retired build printed exactly this and exited 1 before reading any
    // credential. Reaching real SDK code looks different: `loadApiKey`
    // (`@ai-sdk/provider-utils`) throws synchronously before any network call
    // ever fires, the tactical agent's `provider_error` handling turns that
    // into a deterministic fallback rather than a crash, and the run
    // completes and writes a report — it does not print the stub message or
    // set a failing exit code.
    expect(errorSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("Live benchmarking is not wired to a provider in this build"),
    );
    expect(process.exitCode).toBeUndefined();

    const jsonLine = warnSpy.mock.calls
      .map((call) => String(call[0]))
      .find((line) => line.endsWith(".json"));
    if (jsonLine === undefined) throw new Error("expected a 'Wrote ...report.json' line");
    const jsonPath = jsonLine.replace(/^Wrote /, "");
    writtenReportDir = dirname(jsonPath);

    const report = JSON.parse(readFileSync(jsonPath, "utf8")) as LiveReportShape;
    expect(report.live).toBe(true);
    expect(report.records.probe.length).toBeGreaterThan(0);
    // Every turn hit the missing key: proof this reached real SDK code (a
    // scripted port has no concept of `provider_error`) rather than the old
    // build-time short-circuit.
    for (const record of report.records.probe) {
      expect(record.adapterErrorCodes).toContain("provider_error");
    }
  }, 15_000);

  it("reaches real provider SDK code for --mode narrative too, with no keys set", async () => {
    // Mirrors the probe test above, for the separate narrative branch added
    // in tools/sim/src/index.ts: `runNarrativeMode`'s live path builds a real
    // `createVercelPort()`, not a scripted one, so this is the one place the
    // wiring from `--live --mode narrative` through to a written report is
    // exercised at all outside a real (never run here) live measurement.
    // `vercel.ts`'s `streamText` wraps model resolution in its own try/catch,
    // so the missing key surfaces as an in-band `provider_error` chunk, the
    // same as the structured-call path above — not a thrown exception.
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    process.argv = ["node", "index.js", "--live", "--mode", "narrative"];

    await main();

    expect(errorSpy).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();

    const jsonLine = warnSpy.mock.calls
      .map((call) => String(call[0]))
      .find((line) => line.endsWith(".json"));
    if (jsonLine === undefined) throw new Error("expected a 'Wrote ...report.json' line");
    const jsonPath = jsonLine.replace(/^Wrote /, "");
    writtenReportDir = dirname(jsonPath);

    const report = JSON.parse(readFileSync(jsonPath, "utf8")) as NarrativeReportShape;
    expect(report.live).toBe(true);
    expect(report.samples.length).toBeGreaterThan(0);
    // Every stream ended in-band on the missing key before any text arrived:
    // proof this reached the real port rather than a scripted stand-in, the
    // same tell the probe test above reads off `adapterErrorCodes`.
    for (const sample of report.samples) {
      expect(sample.hebrew).toBe("");
      expect(sample.errorCode).toBe("provider_error");
    }
    expect(report.usage.costIsUnderreported).toBe(true);
    // The exact scenario the review found: with every one of these 9 streams
    // failing on a missing key, a harness that folded errored samples into
    // the discipline counters would report `nonHebrewOutputs` equal to the
    // sample count here — indistinguishable from a prompt that answered in
    // English every time. It must not.
    expect(report.erroredSamples).toBe(report.samples.length);
    expect(report.nonHebrewOutputs).toBe(0);
    expect(report.digitViolations).toBe(0);
    expect(report.overLengthOutputs).toBe(0);
  }, 15_000);
});

describe("main — --mode narrative --review-sheet", () => {
  const originalArgv = process.argv;
  const originalExitCode = process.exitCode;
  const KEY_VARS = ["ANTHROPIC_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "OPENAI_API_KEY"] as const;
  const savedKeys = new Map<string, string | undefined>();
  let writtenReportDir: string | undefined;

  beforeEach(() => {
    for (const name of KEY_VARS) {
      savedKeys.set(name, process.env[name]);
      Reflect.deleteProperty(process.env, name);
    }
  });

  afterEach(() => {
    process.argv = originalArgv;
    process.exitCode = originalExitCode;
    for (const [name, value] of savedKeys) {
      if (value === undefined) Reflect.deleteProperty(process.env, name);
      else process.env[name] = value;
    }
    savedKeys.clear();
    if (writtenReportDir !== undefined) rmSync(writtenReportDir, { recursive: true, force: true });
    writtenReportDir = undefined;
    vi.restoreAllMocks();
  });

  it("prints the review sheet to stdout (process.stdout.write), separate from the Wrote-file lines on stderr", async () => {
    // The scripted (non-live) path — the one this task must verify the
    // renderer end to end through, per its own scope boundary: no network,
    // no API key, the same NARRATIVE_SMOKE_TEXT every other smoke narrative
    // test reads. `process.stdout.write`, not `console.log`: this repo's
    // `no-console` lint rule only allows warn/error.
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    process.argv = ["node", "index.js", "--mode", "narrative", "--review-sheet"];

    await main();

    expect(process.exitCode).toBeUndefined();
    expect(writeSpy).toHaveBeenCalledTimes(1);
    const sheet = String(writeSpy.mock.calls[0]?.[0]);
    expect(sheet).toContain("# Hebrew review sheet");
    // The smoke port's own fixed reply (index.ts's NARRATIVE_SMOKE_TEXT) —
    // proof the sheet was built from this run's real samples, not a stub.
    expect(sheet).toContain("אלדד עומד במקומו.");
    expect(sheet).toContain("### Weapons");
    expect(sheet).toContain("### Conditions");

    const jsonLine = warnSpy.mock.calls
      .map((call) => String(call[0]))
      .find((line) => line.endsWith(".json"));
    if (jsonLine === undefined) throw new Error("expected a 'Wrote ...report.json' line");
    writtenReportDir = dirname(jsonLine.replace(/^Wrote /, ""));
  });

  it("does not print anything to stdout when --review-sheet is absent", async () => {
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    process.argv = ["node", "index.js", "--mode", "narrative"];

    await main();

    expect(writeSpy).not.toHaveBeenCalled();

    const jsonLine = warnSpy.mock.calls
      .map((call) => String(call[0]))
      .find((line) => line.endsWith(".json"));
    if (jsonLine === undefined) throw new Error("expected a 'Wrote ...report.json' line");
    writtenReportDir = dirname(jsonLine.replace(/^Wrote /, ""));
  });

  it("still prints a well-formed sheet under --live with no keys set, even with zero samples", async () => {
    // Mirrors the "main — --live" describe block's no-keys tests above: every
    // stream ends in-band on the missing key before any token arrives, so
    // buildReviewSheetInput's every sample is dropped as errored — this
    // proves the sheet degrades to "no samples" rather than throwing, and
    // still carries the name/glossary/condition tables, which come from
    // disk rather than the run.
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    process.argv = ["node", "index.js", "--live", "--mode", "narrative", "--review-sheet"];

    await main();

    expect(process.exitCode).toBeUndefined();
    expect(writeSpy).toHaveBeenCalledTimes(1);
    const sheet = String(writeSpy.mock.calls[0]?.[0]);
    expect(sheet).toContain("# Hebrew review sheet");
    expect(sheet).not.toContain("### Sample 1");
    expect(sheet).toContain("### Weapons");

    const jsonLine = warnSpy.mock.calls
      .map((call) => String(call[0]))
      .find((line) => line.endsWith(".json"));
    if (jsonLine === undefined) throw new Error("expected a 'Wrote ...report.json' line");
    writtenReportDir = dirname(jsonLine.replace(/^Wrote /, ""));
  }, 15_000);
});
