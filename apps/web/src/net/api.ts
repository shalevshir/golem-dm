// The two HTTP calls the client makes. Both are same-origin relative paths:
// the Vite dev server proxies them to the API, so no CORS surface exists and
// no base URL needs configuring.
//
// The catalogue's shape is NOT redeclared here. `EncounterCatalogue` and its
// members are zod schemas in `@ai-dm/schemas` (invariant 4: schemas define
// everything once — never hand-write a duplicate interface), and both ends of
// this request read that one definition. `nameEnglish` is English because
// there is no Hebrew name data anywhere in the repo and the SRD is English
// (ADR 0001) — which is why every render of it is wrapped in `<bdi>`.
import type { z } from "zod";
import { EncounterCatalogue, SessionCreated } from "@ai-dm/schemas";
import type { CatalogueAction, CatalogueCombatant } from "@ai-dm/schemas";

// Re-exported so the components can import their prop types from one place
// without each reaching into the schemas package for a type it only renders.
export type { CatalogueAction, CatalogueCombatant };

export async function createSession(encounterId: string): Promise<string> {
  const response = await fetch("/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ encounterId }),
  });
  if (!response.ok) throw new Error(`POST /sessions failed with ${String(response.status)}`);
  // Parsed, never cast — the server hand-builds this response from typed
  // data, but the client only has untrusted JSON off the wire until this
  // line, exactly the same reasoning `fetchCatalogue` applies below.
  return SessionCreated.parse(await response.json()).sessionId;
}

export async function fetchCatalogue(
  encounterId: string,
): Promise<z.infer<typeof EncounterCatalogue>> {
  const response = await fetch(`/encounters/${encodeURIComponent(encounterId)}`);
  if (!response.ok) {
    throw new Error(`GET /encounters/${encounterId} failed with ${String(response.status)}`);
  }
  // Parsed, never cast — the same rule `net/connection.ts` applies to every
  // inbound frame. A cast here would suppress exactly the check that proves
  // the server and client agree about this contract.
  return EncounterCatalogue.parse(await response.json());
}
