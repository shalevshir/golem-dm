# Tactical benchmark — live-2026-08-19T07-28-03.487Z

- Mode: **live**
- Prompt version: `2026-08-17.1`
- Commit: `147fa3d`
- Pricing table dated: 2026-08-17
- Seeds: 1, 2, 3, 4, 5
- Scenarios: melee-brawl, ranged-approach, cover-corridor, ogre-charge
- Generated at: 2026-08-19T07:28:03.487Z (not part of the determinism claim)

## Probe mode — paired, picks the model

| Arm | Turns | First try | Legal after retry | Fallback | p50 ms | p95 ms | Tokens/turn | $/turn | $/30-turn session | Missing usage |
|---|---|---|---|---|---|---|---|---|---|---|
| `claude-sonnet-5@high` | 150 | 90.0% | 96.7% | 5 | 3486 | 7293 | 1129 | $0.0037 | $0.1118 | 0 |
| `claude-sonnet-5@low` | 150 | 89.3% | 96.7% | 5 | 3764 | 7851 | 1134 | $0.0037 | $0.1112 | 0 |
| `claude-sonnet-5@medium` | 150 | 87.3% | 95.3% | 7 | 3493 | 7217 | 1165 | $0.0038 | $0.1146 | 0 |
| `gemini-3.1-flash-lite@high` | 150 | 82.0% | 90.7% | 14 | 3363 | 273695 | 1475 | unpriced | unpriced | 0 |
| `gemini-3.1-flash-lite@low` | 150 | 68.7% | 86.0% | 21 | 863 | 1770 | 1659 | unpriced | unpriced | 0 |
| `gemini-3.1-flash-lite@medium` | 150 | 73.3% | 87.3% | 19 | 1895 | 5228 | 1593 | unpriced | unpriced | 0 |
| `gpt-5.4-mini@high` | 150 | 93.3% | 98.0% | 3 | 2827 | 16474 | 1625 | $0.0032 | $0.0963 | 0 |
| `gpt-5.4-mini@low` | 150 | 54.7% | 92.0% | 12 | 2209 | 6363 | 1724 | $0.0020 | $0.0601 | 0 |
| `gpt-5.4-mini@medium` | 150 | 88.7% | 98.7% | 2 | 2205 | 10266 | 1480 | $0.0024 | $0.0706 | 0 |
| `gpt-5.4-nano@high` | 150 | 91.3% | 98.7% | 2 | 2770 | 27819 | 1854 | $0.0011 | $0.0342 | 0 |
| `gpt-5.4-nano@low` | 150 | 75.3% | 93.3% | 10 | 2366 | 8892 | 1594 | $0.0006 | $0.0189 | 0 |
| `gpt-5.4-nano@medium` | 150 | 87.3% | 96.0% | 6 | 2723 | 13856 | 1699 | $0.0009 | $0.0270 | 0 |

Step 7's exit criterion is **legality >= 95% after retry**. Read it from the "Legal after retry" column: that is the fraction of turns the engine accepted without the deterministic fallback having to step in.

This legality figure is measured on the scripted baseline's state distribution: the probe corpus is snapshotted from a scripted-both-sides control encounter, not from the states a model would actually drive itself into. That is the right comparison for a paired, apples-to-apples read across arms — encounter mode below covers the model-driven distribution — but do not over-read this column as "legality in the wild".

## Encounter mode — unpaired, win rate only

| Arm | Encounters | Win rate | Dmg/round (hostile) | Non-attack actions | Turns | Legal after retry (confounded) | Unresolved actions |
|---|---|---|---|---|---|---|---|
| `claude-sonnet-5@high` | 20 | 70.0% | 5.1 | 9 | 160 | 88.1% | none |
| `claude-sonnet-5@low` | 20 | 65.0% | 4.9 | 12 | 153 | 91.5% | none |
| `claude-sonnet-5@medium` | 20 | 75.0% | 5.6 | 9 | 150 | 92.0% | none |
| `gemini-3.1-flash-lite@high` | 20 | 70.0% | 5.1 | 8 | 164 | 93.3% | none |
| `gemini-3.1-flash-lite@low` | 20 | 75.0% | 5.1 | 12 | 166 | 92.8% | none |
| `gemini-3.1-flash-lite@medium` | 20 | 60.0% | 5.2 | 8 | 162 | 90.1% | none |
| `gpt-5.4-mini@high` | 20 | 65.0% | 5.3 | 7 | 153 | 98.7% | none |
| `gpt-5.4-mini@low` | 20 | 60.0% | 4.8 | 4 | 162 | 93.2% | none |
| `gpt-5.4-mini@medium` | 20 | 65.0% | 5.4 | 4 | 149 | 99.3% | none |
| `gpt-5.4-nano@high` | 20 | 60.0% | 5.0 | 4 | 162 | 96.9% | none |
| `gpt-5.4-nano@low` | 20 | 50.0% | 5.4 | 1 | 138 | 95.7% | none |
| `gpt-5.4-nano@medium` | 20 | 65.0% | 5.2 | 5 | 161 | 96.9% | none |

"Unresolved actions" is **encounter-only**: probe mode resolves nothing by design, so that field is structurally always empty there and is omitted from the probe table above rather than shown as a false-clean empty list.

"Legal after retry (confounded)" is diagnostic only — it is measured on the model-driven state distribution this arm happened to play itself into, not on the paired probe corpus. Step 7's >= 95%-after-retry exit criterion is read off the probe table's "Legal after retry" column above, never off this one.

Win rate and damage per round are measured against the scripted baseline. Read them with the resolver's declared gaps in view. **Dodge has no mechanical effect** in this harness, so a model that Dodges wisely is penalised, as is the deterministic fallback — the "Non-attack actions" column counts exactly those turns so neither figure is ever read without it in view. Attacks are also always resolved at `"normal"` mode — condition-driven advantage or disadvantage is never applied (currently unreachable, since nothing in the sim inflicts conditions) — and a swing at a target that already died earlier in the same turn is dropped rather than redirected to a new target.
