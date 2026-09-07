// `--mode arc`'s one impure step: open the sockets, run the walk, write the
// artifacts. Split out of `index.ts` so `runArc` itself stays testable with an
// injected socket and no network at all.
import { createCampaign, connectWebSocket } from "./client.js";
import { writeArcReport } from "./report.js";
import { runArc } from "./run.js";

/** The world `apps/server` authors. One world today; a flag when there are two. */
const WORLD_ID = "emberfall";

export interface RunArcModeInput {
  runId: string;
  generatedAt: string;
  gitCommit: string;
  /** HTTP origin of a RUNNING server, e.g. `http://127.0.0.1:3000`. */
  serverUrl: string;
  maxSteps: number;
  runsDir: string;
}

export async function runArcMode(
  input: RunArcModeInput,
): Promise<{ jsonPath: string; markdownPath: string }> {
  const campaignId = await createCampaign(input.serverUrl, WORLD_ID);
  const wsUrl = `${input.serverUrl.replace(/^http/, "ws")}/ws`;
  const socket = await connectWebSocket(wsUrl);

  try {
    const report = await runArc({ socket, campaignId, maxSteps: input.maxSteps });
    return writeArcReport(
      {
        ...report,
        runId: input.runId,
        generatedAt: input.generatedAt,
        gitCommit: input.gitCommit,
        serverUrl: input.serverUrl,
        worldId: WORLD_ID,
      },
      input.runsDir,
    );
  } finally {
    socket.close();
  }
}
