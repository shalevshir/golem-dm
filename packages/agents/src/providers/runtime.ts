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
import type { AgentRole, ModelRouting } from "./routing.js";
import { resolveModelSpec } from "./routing.js";

export interface AgentRuntimeOptions {
  routing: ModelRouting;
  port: LanguageModelPort;
}

export interface AgentRuntime {
  structured<T>(
    role: AgentRole,
    request: StructuredRequest<T>,
  ): Promise<AdapterResult<StructuredOutput<T>>>;

  text(role: AgentRole, request: TextRequest): Promise<AdapterResult<TextOutput>>;

  stream(role: AgentRole, request: TextRequest): AsyncIterable<StreamChunk>;
}

export function createAgentRuntime({ routing, port }: AgentRuntimeOptions): AgentRuntime {
  return {
    structured: (role, request) => port.generateStructured(resolveModelSpec(routing, role), request),
    text: (role, request) => port.generateText(resolveModelSpec(routing, role), request),
    stream: (role, request) => port.streamText(resolveModelSpec(routing, role), request),
  };
}
