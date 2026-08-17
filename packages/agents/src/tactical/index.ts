// Enemy tactical agent: proposes ExecuteTurn via tool call.
// Resilience loop (never trust the proposal):
//   1. rules-engine validates  2. on rejection, retry ONCE with the
//   machine-readable reason    3. on second failure, deterministic fallback
//   (attack nearest legal target, else dodge). Log every rejection to the
//   event stream for offline analysis.
//
// The loop is straight-line rather than a counted `while`. "Never a third model
// call" is then a property of the source you can read off the page, instead of
// a bound a reviewer has to audit — and deleting the second call site kills a
// named test rather than quietly changing a number.
import type { CombatWorld, TurnPlan, TurnRejection } from "@ai-dm/rules-engine";
import { validateExecuteTurn } from "@ai-dm/rules-engine";
import type { ActionRejectedPayload, ExecuteTurn } from "@ai-dm/schemas";
import { ExecuteTurn as ExecuteTurnSchema } from "@ai-dm/schemas";
import type { AdapterError } from "../providers/errors.js";
import type { TokenUsage } from "../providers/port.js";
import type { ModelRouting } from "../providers/routing.js";
import { resolveModelSpec } from "../providers/routing.js";
import type { AgentRuntime } from "../providers/runtime.js";
import type { AttemptNumber } from "./action-rejected.js";
import { adapterRejection, engineRejection } from "./action-rejected.js";
import { deterministicFallback } from "./fallback.js";
import type { RetryFeedback } from "./prompt.js";
import { buildTacticalPrompt } from "./prompt.js";
import { TACTICAL_TOOL_DESCRIPTION, TACTICAL_TOOL_NAME } from "./prompt-text.js";
import type { SnapshotAction } from "./snapshot.js";
import { buildCapabilityCard, buildSnapshot } from "./snapshot.js";

export * from "./action-rejected.js";
export * from "./fallback.js";
export * from "./prompt.js";
export * from "./prompt-text.js";
export * from "./snapshot.js";

export interface TacticalAgentOptions {
  runtime: AgentRuntime;
  /** Read for the provider and model id stamped onto rejection payloads. */
  routing: ModelRouting;
}

export interface ProposeTurnInput {
  world: CombatWorld;
  actorId: string;
  availableActions?: readonly SnapshotAction[];
  turnOrder?: readonly string[];
  /** The server's 10s turn budget. */
  abortSignal?: AbortSignal;
}

/** Where the returned turn came from. For metrics — never for correctness. */
export type TurnProposalSource = "model" | "retry" | "fallback";

export interface TurnProposalSuccess {
  ok: true;
  turn: ExecuteTurn;
  /** Always a real plan, whatever the source: the fallback is validated too. */
  plan: TurnPlan;
  source: TurnProposalSource;
  rejections: readonly ActionRejectedPayload[];
  usage: readonly TokenUsage[];
}

export interface TurnProposalFailure {
  ok: false;
  kind: "aborted" | "no_legal_turn";
  rejections: readonly ActionRejectedPayload[];
  usage: readonly TokenUsage[];
}

export type TurnProposalResult = TurnProposalSuccess | TurnProposalFailure;

export interface TacticalAgent {
  proposeTurn(input: ProposeTurnInput): Promise<TurnProposalResult>;
}

/** What one attempt tells the pipeline to do next. */
type AttemptOutcome =
  | { kind: "valid"; turn: ExecuteTurn; plan: TurnPlan }
  | { kind: "retryable"; feedback: RetryFeedback }
  | { kind: "fallback" }
  | { kind: "aborted" };

function engineFeedback(
  rejections: readonly TurnRejection[],
  proposedTurn: ExecuteTurn,
): RetryFeedback {
  return {
    stage: "engine",
    codes: rejections.map((rejection) => rejection.reason),
    messages: rejections.map((rejection) => rejection.message),
    proposedTurn,
  };
}

function adapterFeedback(error: AdapterError): RetryFeedback {
  const issues = error.issues ?? [];
  return {
    // No proposal ever reached the engine on this path, so the model must be
    // told to call the tool — not to correct a turn it never proposed.
    stage: "adapter",
    codes: [error.code],
    // Quoting the zod issues is the whole reason schema_validation_failed is a
    // separate code from no_tool_call.
    messages:
      issues.length === 0
        ? [error.message]
        : issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
  };
}

export function createTacticalAgent({ runtime, routing }: TacticalAgentOptions): TacticalAgent {
  const spec = resolveModelSpec(routing, "tactical");

  return {
    async proposeTurn(input: ProposeTurnInput): Promise<TurnProposalResult> {
      const actor = input.world.combatants.find((each) => each.combatantId === input.actorId);
      if (actor === undefined) throw new Error(`No combatant ${input.actorId} in this encounter`);

      const snapshot = buildSnapshot({
        world: input.world,
        actorId: input.actorId,
        ...(input.turnOrder === undefined ? {} : { turnOrder: input.turnOrder }),
      });
      const card = buildCapabilityCard(actor, input.availableActions ?? []);

      const rejections: ActionRejectedPayload[] = [];
      const usage: TokenUsage[] = [];

      const attempt = async (
        number: AttemptNumber,
        feedback?: RetryFeedback,
      ): Promise<AttemptOutcome> => {
        const result = await runtime.structured("tactical", {
          prompt: buildTacticalPrompt({
            snapshot,
            card,
            ...(feedback === undefined ? {} : { feedback }),
          }),
          schema: ExecuteTurnSchema,
          toolName: TACTICAL_TOOL_NAME,
          toolDescription: TACTICAL_TOOL_DESCRIPTION,
          ...(input.abortSignal === undefined ? {} : { abortSignal: input.abortSignal }),
        });

        if (!result.ok) {
          rejections.push(adapterRejection(input.actorId, number, result.error, spec));
          switch (result.error.code) {
            case "aborted":
              return { kind: "aborted" };
            case "provider_error":
              // The SDK's maxRetries already spent the transport budget; a
              // second call would be the same failing call.
              return { kind: "fallback" };
            case "no_tool_call":
            case "schema_validation_failed":
              return { kind: "retryable", feedback: adapterFeedback(result.error) };
          }
        }

        usage.push(result.value.usage);
        const turn = result.value.value;
        const validation = validateExecuteTurn(turn, actor, input.world);
        if (validation.valid) return { kind: "valid", turn, plan: validation.plan };

        rejections.push(engineRejection(input.actorId, number, validation.rejections, turn, spec));
        return { kind: "retryable", feedback: engineFeedback(validation.rejections, turn) };
      };

      // Exactly two call sites, and no loop. This is the invariant.
      const first = await attempt(1);
      if (first.kind === "valid") {
        return { ok: true, turn: first.turn, plan: first.plan, source: "model", rejections, usage };
      }
      if (first.kind === "aborted") return { ok: false, kind: "aborted", rejections, usage };

      if (first.kind === "retryable") {
        const second = await attempt(2, first.feedback);
        if (second.kind === "valid") {
          return {
            ok: true,
            turn: second.turn,
            plan: second.plan,
            source: "retry",
            rejections,
            usage,
          };
        }
        if (second.kind === "aborted") return { ok: false, kind: "aborted", rejections, usage };
      }

      const fallback = deterministicFallback(actor, input.world, {
        ...(input.availableActions === undefined
          ? {}
          : { availableActions: input.availableActions }),
      });
      if (fallback === null) return { ok: false, kind: "no_legal_turn", rejections, usage };

      return {
        ok: true,
        turn: fallback.turn,
        plan: fallback.plan,
        source: "fallback",
        rejections,
        usage,
      };
    },
  };
}
