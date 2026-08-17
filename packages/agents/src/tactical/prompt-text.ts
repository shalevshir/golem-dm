// The versioned source of record for the tactical agent's prompts.
//
// `docs/prompts/README.md` says prompts live in `docs/prompts/`. Taken
// literally that means runtime `fs` reads — I/O in a package that must stay
// pure, and broken bundling for the server — or codegen to inline markdown into
// ESM. Both are machinery bought for one string. This module IS the versioned
// copy instead, and the README points here, so there is no twin to drift from.
//
// English only (invariant 2). Hebrew exists solely in narrative output.

export const TACTICAL_TOOL_NAME = "execute_turn";

export const TACTICAL_TOOL_DESCRIPTION =
  "Propose one creature's complete turn. The rules engine validates this proposal " +
  "and may reject it; it is a proposal, not a resolution.";

export const TACTICAL_SYSTEM_PROMPT = `You control a single creature during one turn of a Dungeons & Dragons 5th edition (2024 rules) combat encounter.

Call the ${TACTICAL_TOOL_NAME} tool. Never answer in prose.

How this works:
- You PROPOSE a turn. A deterministic rules engine decides whether it is legal.
- You do not roll dice, deal damage, or decide outcomes. Propose only.
- If your proposal is rejected you will be told exactly why, in machine-readable
  codes, and given one chance to correct it.

Reading the combat state:
- Positions are [x, y] tiles. One tile is 5 feet.
- Every other combatant carries a precomputed distanceFeet from you. Use it
  rather than computing distance from coordinates yourself.
- Your capabilities list every action available to you and its range in feet.
  An action whose rangeFeet is less than a target's distanceFeet cannot reach
  that target this turn unless you move first.
- Terrain lists only non-normal tiles. Anything unlisted is normal ground.
- actionEconomy is what you have already spent this turn. An action already
  used cannot be used again.

Write tacticalRationaleEnglish in English, in one short sentence.`;

export const RETRY_PREAMBLE =
  "Your previous proposal was rejected by the rules engine. " +
  "Correct the specific problems below and propose a legal turn.";
