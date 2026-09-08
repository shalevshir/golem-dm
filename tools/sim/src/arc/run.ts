// Walks a whole authored arc against a running server, playing the part of
// the player: read the affordances the server pushes, choose one, send it as
// free text, and record what the real intent router, GM tier and narrative
// agent did with it.
//
// This is the harness `--mode narrative` is NOT: that one calls
// `createHebrewNarrative().stream()` directly against a fixed corpus of
// briefs, deliberately measuring the agent alone. Here nothing is stubbed —
// every model in the loop is whichever one `apps/server`'s `main.ts` wired,
// and the numbers are properties of a played session rather than of one
// agent.
//
// Two things are therefore NOT reported here and cannot be: token cost and
// per-agent retries never cross the wire (they go to the server's own
// `MetricsPort`), so `report.json` carries client-observed latency instead.
import {
  IntentClassifiedPayload,
  NarrativeEmittedPayload,
  NarrativeMoveAppliedPayload,
  QuestNodeCompletedPayload,
  QuestNodeEnteredPayload,
  EncounterResolvedPayload,
  EncounterStartedPayload,
} from "@ai-dm/schemas";
import type { GameEvent } from "@ai-dm/schemas";
import { percentile } from "../run/metrics.js";
import { FrameLog, FrameTimeoutError } from "./client.js";
import type { Frame, SocketHandle } from "./client.js";

/**
 * Sent when the node is terminal and `canConclude` says the closing beat is
 * legal. The one Hebrew string this harness authors rather than echoes: every
 * other thing it sends is an edge's own `labelHebrew`, straight off a
 * `scene_affordances` frame.
 *
 * Hebrew here is invariant 2's `player_input.text` exception, not a new one —
 * the harness IS the player, and what a player types is the audit trail the
 * invariant explicitly sanctions.
 */
const CONCLUDE_TEXT = "לסיים כאן";

export type StepRouting =
  /** The router sent us where the chosen edge pointed. */
  | "hit"
  /** It traversed, but to a different node than the edge we picked. */
  | "miss"
  /** No traversal happened at all — classified `social`/`check`/`ooc`, or refused. */
  | "no_traversal";

export interface ArcStep {
  index: number;
  /** Where the player was standing when they typed. */
  fromNodeId: string;
  /** Verbatim, Hebrew: an edge's own `labelHebrew`, or `CONCLUDE_TEXT`. */
  sentText: string;
  /** The edge's `to`; null for a conclude step, which traverses nothing. */
  intendedNodeId: string | null;
  /** From `intent_classified` — what the real router made of the text. */
  classifiedCategory: string | null;
  classifiedTargetNodeId: string | null;
  /** From `quest_node_entered`. Null when nothing moved. */
  enteredNodeId: string | null;
  routing: StepRouting;
  /**
   * The `error` frame's message, when the server answered with one. The most
   * useful field in a failing run and the only place the reason exists — the
   * event log records the player's input but nothing about why the turn died,
   * so a harness that dropped this frame would report "no traversal" with no
   * way to tell a router misclassification from a missing API key.
   */
  serverError: string | null;
  /** Send to the next affordance frame, measured client-side. */
  latencyMs: number;
  narrations: readonly { source: string; text: string }[];
}

export interface ArcEncounter {
  encounterId: string;
  /** Hero turns this harness drove before the bracket closed. */
  heroTurns: number;
  /** From `encounter_resolved`; null if the run ended mid-fight. */
  outcome: string | null;
}

export type ArcFinish =
  /** The arc's terminal node was completed. */
  | "concluded"
  /** A node with no open edge and no legal conclusion — the arc cannot continue. */
  | "dead_end"
  /**
   * Every open edge out of a node was tried and none moved the player. Split
   * from `dead_end` (which is content saying no) because this is the pipeline
   * saying nothing: same node, same options, no progress.
   */
  | "stalled"
  /** Ran out of budget before the arc ended. Not a failure, just a cap. */
  | "step_cap"
  /** The server stopped handing control back. Usually the interesting one. */
  | "timeout";

export interface ArcReport {
  campaignId: string;
  finish: ArcFinish;
  steps: readonly ArcStep[];
  encounters: readonly ArcEncounter[];
  visitedNodeIds: readonly string[];
  completedNodeIds: readonly string[];
  /** `narrative_emitted.source` tallied over the whole session. */
  narrationSources: Readonly<Record<string, number>>;
  gmMoves: readonly { kind: string; reasonEnglish: string }[];
  routerHits: number;
  routerMisses: number;
  routerNoTraversals: number;
  latencyMsP50: number;
  latencyMsP95: number;
}

export interface RunArcInput {
  socket: SocketHandle;
  campaignId: string;
  /** Cap on free-text sends. A long arc needs a bigger one than a long fight. */
  maxSteps?: number;
  /** Cap on hero combat turns across the whole run, so one stalled fight cannot hang it. */
  maxCombatTurns?: number;
  /** How long to wait for the server to hand control back after a send. */
  timeoutMs?: number;
  /** Injected for tests; wall clock otherwise. */
  now?: () => number;
}

type SceneAffordances = Extract<Frame, { type: "scene_affordances" }>;
type TurnAffordances = Extract<Frame, { type: "turn_affordances" }>;
type Affordances = SceneAffordances | TurnAffordances;

function isAffordance(frame: Frame): frame is Affordances {
  return frame.type === "scene_affordances" || frame.type === "turn_affordances";
}

/** The events one send produced: everything logged between it and the next affordance. */
function eventsIn(frames: readonly Frame[]): readonly GameEvent[] {
  return frames.flatMap((frame) => (frame.type === "event" ? [frame.event] : []));
}

function firstPayload<T>(
  events: readonly GameEvent[],
  type: GameEvent["type"],
  schema: { safeParse: (input: unknown) => { success: boolean; data?: T } },
): T | null {
  for (const event of events) {
    if (event.type !== type) continue;
    const parsed = schema.safeParse(event.payload);
    if (parsed.success && parsed.data !== undefined) return parsed.data;
  }
  return null;
}

/**
 * Which edge to take. Prefers somewhere new, so a walk explores the arc
 * rather than oscillating across the one edge the server happens to list
 * first — `the-weir` points back at nodes already seen in the shipped world.
 * Deterministic on purpose: two runs of the same server take the same path,
 * which is what makes two reports comparable.
 *
 * The cost of "first unvisited edge" is that one run covers one path through a
 * branching arc, and which path is decided by the order the content lists its
 * edges in — `data/world/arc.json` puts the investigative road out of
 * `saboteurs` ahead of the short one straight to the inn for exactly that
 * reason. Covering the other branches means either running again against
 * reordered content or a smarter chooser; neither is worth building until a
 * run has shown what the first path actually finds.
 */
function chooseEdge(
  affordances: SceneAffordances,
  visited: ReadonlySet<string>,
  attempted: ReadonlySet<string>,
): SceneAffordances["edges"][number] | null {
  // An edge already tried from this node that did not move the player will
  // not move them the second time either — retrying it just burns the step
  // budget on an identical failure, which is exactly what a first live run
  // against a keyless server did twelve times over.
  const open = affordances.edges.filter((edge) => edge.open && !attempted.has(edge.to));
  return open.find((edge) => !visited.has(edge.to)) ?? open[0] ?? null;
}

/**
 * The hero's combat turn, chosen from the affordances alone — never from the
 * rules engine. That is the whole point: the server has already run
 * `validateExecuteTurn` over every candidate it sent, so anything in this
 * frame is legal by construction, and a harness that re-derived legality
 * would be a second rules implementation (invariant 1).
 */
type ChosenAction = {
  actionType: TurnAffordances["actions"][number]["actionType"];
  actionId?: string;
  targetIds?: string[];
};

function chooseCombatAction(affordances: TurnAffordances): ChosenAction | null {
  const attack = affordances.actions.find(
    (action) => action.actionType === "attack" && action.targetableCombatantIds.length > 0,
  );
  if (attack !== undefined) {
    const target = attack.targetableCombatantIds[0];
    return {
      actionType: attack.actionType,
      ...(attack.actionId === undefined ? {} : { actionId: attack.actionId }),
      ...(target === undefined ? {} : { targetIds: [target] }),
    };
  }
  // Nothing in reach: take whatever needs no target (Dodge/Dash/Disengage)
  // rather than stalling the fight and burning the whole turn budget.
  const untargeted = affordances.actions.find((action) => !action.requiresTarget);
  if (untargeted === undefined) return null;
  return {
    actionType: untargeted.actionType,
    ...(untargeted.actionId === undefined ? {} : { actionId: untargeted.actionId }),
  };
}

export async function runArc(input: RunArcInput): Promise<ArcReport> {
  const {
    socket,
    campaignId,
    maxSteps = 40,
    maxCombatTurns = 60,
    timeoutMs = 60_000,
    now = () => Date.now(),
  } = input;

  const log = new FrameLog(socket);
  socket.send(JSON.stringify({ type: "join", campaignId }));
  await log.waitFor((frames) => frames.length > 0, "the join acknowledgement", timeoutMs);

  const steps: ArcStep[] = [];
  const encounters: ArcEncounter[] = [];
  const gmMoves: { kind: string; reasonEnglish: string }[] = [];
  const narrationSources: Record<string, number> = {};
  const visited = new Set<string>();
  const completed = new Set<string>();
  /** Per node, the edge targets already tried from it without moving. */
  const attempted = new Map<string, Set<string>>();

  let cursor = 0;
  let combatTurns = 0;
  let finish: ArcFinish = "step_cap";
  let lastSendWasConclude = false;

  const tally = (events: readonly GameEvent[]): readonly { source: string; text: string }[] => {
    const narrations: { source: string; text: string }[] = [];
    for (const event of events) {
      switch (event.type) {
        case "narrative_emitted": {
          const parsed = NarrativeEmittedPayload.safeParse(event.payload);
          if (!parsed.success) break;
          narrationSources[parsed.data.source] = (narrationSources[parsed.data.source] ?? 0) + 1;
          narrations.push({ source: parsed.data.source, text: parsed.data.text });
          break;
        }
        case "narrative_move_applied": {
          const parsed = NarrativeMoveAppliedPayload.safeParse(event.payload);
          if (parsed.success) {
            gmMoves.push({
              kind: parsed.data.move.kind,
              reasonEnglish: parsed.data.reasonEnglish,
            });
          }
          break;
        }
        case "quest_node_completed": {
          const parsed = QuestNodeCompletedPayload.safeParse(event.payload);
          if (parsed.success) completed.add(parsed.data.nodeId);
          break;
        }
        case "encounter_started": {
          const parsed = EncounterStartedPayload.safeParse(event.payload);
          if (parsed.success) {
            encounters.push({ encounterId: parsed.data.encounterId, heroTurns: 0, outcome: null });
          }
          break;
        }
        case "encounter_resolved": {
          const parsed = EncounterResolvedPayload.safeParse(event.payload);
          const open = encounters.at(-1);
          if (parsed.success && open !== undefined) open.outcome = parsed.data.outcome;
          break;
        }
        default:
          break;
      }
    }
    return narrations;
  };

  /** Blocks until the server hands control back, then returns that frame. */
  const nextAffordance = async (from: number, what: string): Promise<Affordances> => {
    await log.waitFor((frames) => frames.slice(from).some(isAffordance), what, timeoutMs);
    const found = log.since(from).find(isAffordance);
    if (found === undefined) throw new Error(`${what}: affordance vanished after resolving`);
    return found;
  };

  let current: Affordances;
  try {
    current = await nextAffordance(cursor, "the first affordance frame after join");
  } catch (error) {
    if (!(error instanceof FrameTimeoutError)) throw error;
    return report("timeout");
  }

  // Everything the join itself produced — the opening node's narration —
  // tallied only now, not straight after the join await: that await resolves
  // on the FIRST frame (the `campaign_state` ack), and the events behind it
  // are still in flight. The first affordance frame is the barrier that means
  // the server is done talking about the join.
  tally(eventsIn(log.frames.slice(0, log.frames.indexOf(current))));

  while (steps.length < maxSteps) {
    cursor = log.frames.indexOf(current) + 1;

    if (current.type === "turn_affordances") {
      if (combatTurns >= maxCombatTurns) {
        finish = "step_cap";
        break;
      }
      const action = chooseCombatAction(current);
      if (action === null) {
        finish = "dead_end";
        break;
      }
      combatTurns += 1;
      const open = encounters.at(-1);
      if (open !== undefined && open.outcome === null) open.heroTurns += 1;

      const sendAt = log.frames.length;
      socket.send(
        JSON.stringify({
          type: "structured_action",
          clientMessageId: `arc-combat-${String(combatTurns)}`,
          actorId: current.actorId,
          turn: {
            actorId: current.actorId,
            mainAction: action,
            tacticalRationaleEnglish: "Arc harness: take the first legal action offered.",
          },
        }),
      );

      let next: Affordances;
      try {
        next = await nextAffordance(sendAt, `the turn after combat turn ${String(combatTurns)}`);
      } catch (error) {
        if (!(error instanceof FrameTimeoutError)) throw error;
        tally(eventsIn(log.since(sendAt)));
        finish = "timeout";
        break;
      }
      tally(eventsIn(log.since(sendAt).slice(0, log.since(sendAt).indexOf(next))));
      current = next;
      continue;
    }

    visited.add(current.nodeId);
    const attemptedHere = attempted.get(current.nodeId) ?? new Set<string>();
    const edge = chooseEdge(current, visited, attemptedHere);

    if (edge === null && !current.canConclude) {
      finish = attemptedHere.size > 0 ? "stalled" : "dead_end";
      break;
    }

    const sentText = edge?.labelHebrew ?? CONCLUDE_TEXT;
    lastSendWasConclude = edge === null;
    const fromNodeId = current.nodeId;
    const sendAt = log.frames.length;
    const startedAt = now();

    socket.send(
      JSON.stringify({
        type: "free_text",
        clientMessageId: `arc-step-${String(steps.length + 1)}`,
        text: sentText,
      }),
    );

    let next: Affordances | null = null;
    try {
      next = await nextAffordance(sendAt, `the turn after step ${String(steps.length + 1)}`);
    } catch (error) {
      if (!(error instanceof FrameTimeoutError)) throw error;
    }

    const produced = log.since(sendAt);
    const upToNext = next === null ? produced : produced.slice(0, produced.indexOf(next));
    const events = eventsIn(upToNext);
    const narrations = tally(events);

    const serverError =
      upToNext.find((frame) => frame.type === "error")?.message ?? null;
    const classification = firstPayload(events, "intent_classified", IntentClassifiedPayload);
    const entered = firstPayload(events, "quest_node_entered", QuestNodeEnteredPayload);
    const enteredNodeId = entered?.nodeId ?? null;
    const intendedNodeId = edge?.to ?? null;
    if (enteredNodeId === null && edge !== null) {
      attemptedHere.add(edge.to);
      attempted.set(fromNodeId, attemptedHere);
    }

    steps.push({
      index: steps.length + 1,
      fromNodeId,
      sentText,
      intendedNodeId,
      classifiedCategory: classification?.classification.category ?? null,
      classifiedTargetNodeId:
        classification?.classification.category === "exploration"
          ? classification.classification.targetNodeId
          : null,
      enteredNodeId,
      serverError,
      routing:
        enteredNodeId === null
          ? "no_traversal"
          : enteredNodeId === intendedNodeId
            ? "hit"
            : "miss",
      latencyMs: now() - startedAt,
      narrations,
    });

    if (next === null) {
      // A conclude on the arc's last node ends the session, so the server has
      // nothing left to hand back — that silence is the arc finishing, not a
      // stall. Any other silence is a stall.
      finish = lastSendWasConclude && completed.has(fromNodeId) ? "concluded" : "timeout";
      break;
    }
    current = next;
  }

  return report(finish);

  function report(outcome: ArcFinish): ArcReport {
    const latencies = steps.map((step) => step.latencyMs);
    return {
      campaignId,
      finish: outcome,
      steps,
      encounters,
      visitedNodeIds: [...visited],
      completedNodeIds: [...completed],
      narrationSources,
      gmMoves,
      routerHits: steps.filter((step) => step.routing === "hit").length,
      routerMisses: steps.filter((step) => step.routing === "miss").length,
      routerNoTraversals: steps.filter((step) => step.routing === "no_traversal").length,
      latencyMsP50: percentile(latencies, 50),
      latencyMsP95: percentile(latencies, 95),
    };
  }
}
