// Fastify + WebSocket entrypoint.
// Turn pipeline: client msg -> (intent if free-text) -> rules engine ->
// tactical/narrative agents -> stream narrative -> append events -> ack.
// State is a projection of the append-only event log (see @ai-dm/schemas GameEvent).
// TODO(step 8): boot server, WS session handler, event-log persistence, replay-on-reconnect.
export {};
