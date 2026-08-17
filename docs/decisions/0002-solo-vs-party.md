# ADR-0002: Solo player vs party scope

Status: ACCEPTED (2026-08-17) — solo for the POC.

## Decision

One human-controlled player character. Every other combatant — allies and
enemies alike — is driven by the tactical agent or a scripted policy.

## Rationale

The roadmap already assumes solo. It keeps the turn pipeline single-threaded,
avoids multi-client WebSocket sync and turn arbitration in step 8, and lets the
narrative agent address a single, known character (which the Hebrew
`grammaticalGender` field on `CharacterSheet` already encodes).

## Consequences

- The initiative tracker still handles N combatants; only *input* is single-source.
  Nothing in the rules engine hard-codes a party size of one.
- Party play is not designed out — it is deferred. Revisit after the closed beta
  (roadmap step 11).
- Scope creep toward party play is an explicit risk in `PROJECT_PLAN.md` §5 and
  should be rejected until this ADR is superseded.
