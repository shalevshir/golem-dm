// One scripted server, no network: proves the walk reads affordances, sends
// the right thing, drives a combat bracket, and classifies routing. The
// server's replies are canned frames — this tests the HARNESS, never the
// pipeline, which is what `apps/server`'s own e2e suite is for.
import { describe, expect, it } from "vitest";
import type { SocketHandle } from "./client.js";
import { runArc } from "./run.js";

let sequence = 0;

function event(type: string, payload: Record<string, unknown>): unknown {
  sequence += 1;
  return {
    type: "event",
    event: {
      eventId: `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
      campaignId: "c1",
      sequence,
      timestamp: "2026-09-07T10:00:00.000Z",
      type,
      payload,
    },
  };
}

function narration(text: string, source: string): unknown {
  return event("narrative_emitted", {
    actorId: "hero",
    streamId: `s${String(sequence)}`,
    text,
    source,
    promptVersion: "v1",
  });
}

function sceneAffordances(
  nodeId: string,
  edges: { to: string; labelHebrew: string; open: boolean }[],
  canConclude: boolean,
): unknown {
  return { type: "scene_affordances", nodeId, edges, canConclude, forSequence: sequence };
}

const CAMPAIGN_STATE = {
  type: "campaign_state",
  sequence: 0,
  snapshot: {
    world: { campaignId: "c1", rootSeed: 42, appliedClientMessageIds: [], scene: null },
    encounter: null,
  },
};

/**
 * A socket whose "server" is a function from the message just sent to the
 * frames that answer it. Replies land asynchronously, so `runArc`'s waits are
 * real waits rather than a value already sitting in the log.
 */
function scriptedSocket(reply: (message: Record<string, unknown>) => unknown[]): {
  socket: SocketHandle;
  sent: Record<string, unknown>[];
} {
  const sent: Record<string, unknown>[] = [];
  let onMessage: (raw: string) => void = () => undefined;

  return {
    sent,
    socket: {
      send: (payload) => {
        const message = JSON.parse(payload) as Record<string, unknown>;
        sent.push(message);
        for (const frame of reply(message)) {
          setTimeout(() => {
            onMessage(JSON.stringify(frame));
          }, 0);
        }
      },
      close: () => undefined,
      onMessage: (handler) => {
        onMessage = handler;
      },
      onClose: () => undefined,
    },
  };
}

describe("runArc", () => {
  it("walks a scripted arc through a fight and reports routing, narration and finish", async () => {
    sequence = 0;
    const { socket, sent } = scriptedSocket((message) => {
      if (message["type"] === "join") {
        return [
          CAMPAIGN_STATE,
          narration("אתה עומד בשער.", "model"),
          sceneAffordances("arrival", [{ to: "weir", labelHebrew: "אל הסכר", open: true }], false),
        ];
      }

      if (message["type"] === "free_text") {
        const text = message["text"];
        if (text === "אל הסכר") {
          return [
            event("intent_classified", {
              clientMessageId: "x",
              actorId: "hero",
              classification: { category: "exploration", targetNodeId: "weir" },
              provider: "test",
              modelId: "test",
              promptVersion: "v1",
            }),
            event("quest_node_entered", { nodeId: "weir" }),
            narration("המים אפורים.", "model"),
            sceneAffordances("weir", [{ to: "ambush", labelHebrew: "לבדוק", open: true }], false),
          ];
        }
        if (text === "לבדוק") {
          return [
            event("intent_classified", {
              clientMessageId: "x",
              actorId: "hero",
              // The router sent the player somewhere the chosen edge did not
              // point — the "miss" this harness exists to count.
              classification: { category: "exploration", targetNodeId: "elsewhere" },
              provider: "test",
              modelId: "test",
              promptVersion: "v1",
            }),
            event("quest_node_entered", { nodeId: "elsewhere" }),
            // Board fields omitted: `EncounterStartedPayload` allows all
            // three or none, and the harness reads only `encounterId`.
            event("encounter_started", { encounterId: "goblin-ambush" }),
            {
              type: "turn_affordances",
              actorId: "hero",
              reachableTiles: [],
              actions: [
                {
                  actionType: "attack",
                  actionId: "longsword",
                  requiresTarget: true,
                  targetableCombatantIds: ["goblin-a"],
                },
              ],
              forSequence: sequence,
            },
          ];
        }
        // The conclude: the node completes and the server has nothing left to
        // hand back, which is how an arc ends rather than stalls.
        return [event("quest_node_completed", { nodeId: "elsewhere" })];
      }

      // structured_action: the fight ends and control returns to the scene.
      return [
        event("encounter_resolved", {
          encounterId: "goblin-ambush",
          outcome: "victory",
          survivorIds: ["hero"],
        }),
        narration("הקרב נגמר.", "deterministic"),
        sceneAffordances("elsewhere", [], true),
      ];
    });

    let tick = 0;
    const report = await runArc({
      socket,
      campaignId: "c1",
      timeoutMs: 200,
      now: () => (tick += 10),
    });

    expect(report.finish).toBe("concluded");
    expect(report.steps.map((step) => step.routing)).toEqual(["hit", "miss", "no_traversal"]);
    expect(report.routerHits).toBe(1);
    expect(report.routerMisses).toBe(1);
    expect(report.steps[1]?.classifiedTargetNodeId).toBe("elsewhere");
    expect(report.encounters).toEqual([
      { encounterId: "goblin-ambush", heroTurns: 1, outcome: "victory" },
    ]);
    expect(report.narrationSources).toEqual({ model: 2, deterministic: 1 });
    expect(report.completedNodeIds).toEqual(["elsewhere"]);
    expect(report.steps.map((step) => step.serverError)).toEqual([null, null, null]);

    // It sent the edge's own Hebrew label, never a paraphrase, and used a
    // structured action for the combat turn — free text is refused in combat.
    expect(sent.map((message) => message["type"])).toEqual([
      "join",
      "free_text",
      "free_text",
      "structured_action",
      "free_text",
    ]);
    expect(sent[1]?.["text"]).toBe("אל הסכר");
    expect(sent[4]?.["text"]).toBe("לסיים כאן");
  });

  it("stops as stalled rather than retrying an edge that never moves the player", async () => {
    sequence = 0;
    const edges = [
      { to: "b", labelHebrew: "אל ב", open: true },
      { to: "c", labelHebrew: "אל ג", open: true },
    ];
    const { socket, sent } = scriptedSocket((message) =>
      message["type"] === "join"
        ? [CAMPAIGN_STATE, sceneAffordances("a", edges, false)]
        : [
            // What a keyless server actually answers: the input is logged, the
            // turn dies, and the same affordances come back unchanged.
            event("player_input", { clientMessageId: "x", actorId: "hero", text: "…" }),
            { type: "error", clientMessageId: "x", code: "internal_error", message: "no key" },
            sceneAffordances("a", edges, false),
          ],
    );

    const report = await runArc({ socket, campaignId: "c1", maxSteps: 20, timeoutMs: 200 });

    expect(report.finish).toBe("stalled");
    // Two edges, tried once each — not twenty steps of the same failure.
    expect(report.steps).toHaveLength(2);
    expect(sent.filter((message) => message["type"] === "free_text")).toHaveLength(2);
    expect(report.steps.map((step) => step.sentText)).toEqual(["אל ב", "אל ג"]);
    expect(report.steps[0]?.serverError).toBe("no key");
  });

  it("reports a dead end when a node offers no open edge and no conclusion", async () => {
    sequence = 0;
    const { socket } = scriptedSocket((message) =>
      message["type"] === "join"
        ? [
            CAMPAIGN_STATE,
            sceneAffordances("stuck", [{ to: "locked", labelHebrew: "נעול", open: false }], false),
          ]
        : [],
    );

    const report = await runArc({ socket, campaignId: "c1", timeoutMs: 200 });

    expect(report.finish).toBe("dead_end");
    expect(report.steps).toEqual([]);
  });
});
