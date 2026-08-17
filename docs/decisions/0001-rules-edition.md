# ADR-0001: Rules edition

Status: ACCEPTED (2026-08-17) — 2024 rules, SRD 5.2.1.

Options considered: 2014 (SRD 5.1) vs 2024 (SRD 5.2.1).

## Decision

Implement the 2024 ruleset against SRD 5.2.1 (CC-BY-4.0).

## Rationale

Matches the licensing note already committed in `data/srd/README.md`, and is the
edition new players will expect. Choosing 5.1 would have required rewriting that
licensing scope.

## Consequences

Edition-sensitive rules follow 2024 wording:

- **Weapon mastery** — mastery properties exist; deferred until the SRD data pass
  (step 5) since no weapon data is loaded yet.
- **Exhaustion** — single unified track, 6 levels, each level applies a
  cumulative −2 to d20 tests and −5 ft speed. (2014's per-level table is not used.)
- **Surprise** — no "surprised" condition; surprise grants disadvantage on the
  initiative roll instead.
- **Hiding** — requires the Hide action and a DC 15 Dexterity (Stealth) check;
  grants the Invisible condition until you attack, cast, make noise, or are found.
- **Death saves** — a natural 20 restores 1 HP; three failures is death. Unchanged
  in substance from 2014.
- **Critical hits** — only weapon/damage dice double, not modifiers.
