// Wires the transports onto a Fastify instance. Separate from `main.ts` so a
// test can build an app without reading the environment or binding a port.
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import type { TurnPorts } from "./core/pipeline.js";
import { registerHttpRoutes } from "./transport/http.js";
import type { CampaignRegistry } from "./transport/http.js";
import { registerWebSocketRoute } from "./transport/ws.js";

export interface BuildAppInput {
  registry: CampaignRegistry;
  ports: TurnPorts;
  logLevel?: string;
}

export function buildApp(input: BuildAppInput): FastifyInstance {
  const app = Fastify({ logger: input.logLevel === undefined ? false : { level: input.logLevel } });
  void app.register(websocket);
  registerHttpRoutes(app, input.registry);
  void app.register((scoped, _opts, done) => {
    registerWebSocketRoute(scoped, { registry: input.registry, ports: input.ports });
    done();
  });
  return app;
}
