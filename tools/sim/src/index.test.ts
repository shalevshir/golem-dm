import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "./index.js";
import { buildReport, writeReport } from "./run/report.js";

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

describe("main — --live short-circuit", () => {
  const originalArgv = process.argv;
  const originalExitCode = process.exitCode;

  afterEach(() => {
    process.argv = originalArgv;
    process.exitCode = originalExitCode;
    vi.restoreAllMocks();
  });

  it("refuses --live without making a network call or writing a report", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    process.argv = ["node", "index.js", "--live"];

    await main();

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Live benchmarking is not wired to a provider in this build"),
    );
    expect(process.exitCode).toBe(1);
  });
});
