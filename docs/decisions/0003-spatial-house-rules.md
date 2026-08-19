# ADR-0003: Spatial house rules
Status: ACCEPTED (POC).
- Diagonals: 5 ft each (PHB default).
- LoS/cover: Bresenham center-to-center (house rule; RAW is corner-based, DMG 251).
- Cover grants AC bonus AND Dex-save bonus (+2 half, +5 three-quarters).

## Correction (2026-08-17) — verified against SRD 5.2.1

The decisions above stand unchanged; only their labelling was wrong. Two of the
three are **RAW in SRD 5.2.1, not house rules**:

- **Diagonals at 5 ft each is RAW.** Entering a square costs 1 square of
  movement whether it is orthogonally or diagonally adjacent. Chebyshev
  distance is therefore the correct measure, and grid range counting produces
  the same answer.
- **Cover granting both the AC bonus and the Dexterity saving throw bonus is
  RAW.** The SRD defines Half Cover as +2 to AC *and* Dexterity saving throws,
  and Three-Quarters Cover as +5 to both; Total Cover means the target cannot be
  targeted directly. Only the most protective degree applies.

**The Bresenham line of sight is the only genuine house rule here.** It stays
behind the `LineOfSightAlgorithm` interface in `packages/rules-engine/src/spatial/`
so corner-to-corner RAW can replace it later.

One rule this ADR omitted, now implemented: diagonal movement **cannot cross the
corner** of a wall or anything else that fills its space. See
[`RULES_REFERENCE.md`](../../RULES_REFERENCE.md) §5.

## Correction (2026-08-19) — narrow openings

Bresenham is **not** the only house rule after all. SRD 5.2.1's Difficult
Terrain list includes "a narrow opening sized for a creature one size smaller
than you" — RAW therefore lets a Large creature pass a one-square gap at
double movement cost. `findPath({size})` requires the whole space to fit and
hard-blocks the gap instead. That block stays for the POC (fractional-cost
squeeze paths complicate A* for little POC value), but it is a **second
genuine house rule**, recorded in `RULES_REFERENCE.md` §5 and §8. Found in
the 2026-08-19 audit against the SRD NotebookLM notebook (PROJECT_PLAN.md
§4.1).
