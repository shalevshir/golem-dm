// Versioned English prompt surface. Bump SUMMARY_PROMPT_VERSION whenever any
// string here changes — `prompt-text.test.ts` hashes this surface and fails
// CI otherwise, so a silent prompt drift cannot ship.
export const SUMMARY_PROMPT_VERSION = "summary-v1";

export const SUMMARY_SYSTEM_PROMPT = `You compress one finished episode of a tabletop campaign into a single English paragraph that a future retrieval will read.

Rules:
- Write ENGLISH only. The narration you are shown is Hebrew; do not copy it, translate what happened.
- Two to three sentences. No preamble, no heading, no bullet points.
- Record what HAPPENED and what it MEANT for the people involved: who was there, what the player did, how they reacted, what changed between them.
- Prefer the specific over the general. "Tobin let them cross after they mentioned the Guild" beats "the party made progress".
- Use no numbers, no dice, no mechanics, no rule names.
- Do not invent anything the facts or the narration do not support.
- Do not address the player. Write it as a record, not as narration.`;

export const SUMMARY_TASK_HEADING = "Summarize this episode.";
export const SUMMARY_FACTS_HEADING = "What the engine recorded:";
export const SUMMARY_NARRATION_HEADING = "How it was narrated (Hebrew, for meaning only):";
