// Binds agent roles to their configured models. This is the whole of the
// role-awareness in the adapter: everything below it takes a resolved
// `ModelSpec`, everything above it names a role.
import type { AdapterResult } from "./errors.js";
import type {
  LanguageModelPort,
  StreamChunk,
  StructuredOutput,
  StructuredRequest,
  TextOutput,
  TextRequest,
} from "./port.js";
import type { AgentRole, ModelRouting, ModelSpec } from "./routing.js";
import { resolveModelSpec } from "./routing.js";

export interface AgentRuntimeOptions {
  routing: ModelRouting;
  port: LanguageModelPort;
}

export interface AgentRuntime {
  /**
   * The spec this runtime will actually call for a role. Exposed so a caller
   * that has to *name* the model — the tactical agent stamps it onto every
   * `action_rejected` payload — reads it from the thing making the call instead
   * of resolving a routing of its own. Two routings that disagree would put a
   * model that was never called into an append-only log, which is the one
   * dataset step 7b's benchmark is built from and is unrepairable after the
   * fact.
   */
  specFor(role: AgentRole): ModelSpec;

  structured<T>(
    role: AgentRole,
    request: StructuredRequest<T>,
  ): Promise<AdapterResult<StructuredOutput<T>>>;

  text(role: AgentRole, request: TextRequest): Promise<AdapterResult<TextOutput>>;

  stream(role: AgentRole, request: TextRequest): AsyncIterable<StreamChunk>;
}

export function createAgentRuntime({ routing, port }: AgentRuntimeOptions): AgentRuntime {
  return {
    specFor: (role) => resolveModelSpec(routing, role),
    structured: (role, request) => port.generateStructured(resolveModelSpec(routing, role), request),
    text: (role, request) => port.generateText(resolveModelSpec(routing, role), request),
    stream: (role, request) => port.streamText(resolveModelSpec(routing, role), request),
  };
}
