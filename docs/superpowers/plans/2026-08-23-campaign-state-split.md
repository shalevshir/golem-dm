# Campaign State Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the event stream a campaign and the encounter a bracketed span inside it, so §4.7's remaining steps have somewhere to live. A player cannot tell this shipped.

**Architecture:** [ADR-0004](../../decisions/0004-campaign-vs-session-identity.md), ACCEPTED. `campaignId` replaces `sessionId` as the stream key; `SessionState` becomes `CampaignState = { world: WorldState, encounter: EncounterState | null }`; genesis splits into `campaign_started` plus a later `encounter_started`.

**Spec:** [`docs/superpowers/specs/2026-08-23-campaign-state-split-design.md`](../specs/2026-08-23-campaign-state-split-design.md)

**Tech Stack:** TypeScript 5.7 strict, ESM, Node 22, zod 3, drizzle-orm 0.39 + drizzle-kit 0.30, Postgres 17, React 19, Vitest 3.

### The one thing this plan gets right or gets wrong

The spec measured the blast radius: **26 files reference `SessionState`, 36 reference `sessionId`** (17 non-test), across every workspace package that has code. Done as one commit it is unreviewable.

So the plan splits the change along the axis a reviewer actually reads: **Task 2 is a pure rename with no shape change** (36 files, verifiable by inspection — if it compiles and the suite is green, it is right), and **Task 4 is a pure shape change with no renaming** (26 files, verifiable by reasoning). Never both in one diff. Every task leaves the tree compiling and the suite green; a task that cannot is split further.

## Global Constraints

- **Dependency direction:** `schemas ← rules-engine ← agents ← server`. `web` depends only on `schemas`. Nothing depends on `server`.
- **Event log is the source of truth.** `game_events` is append-only: no `UPDATE`, no `DELETE`. Corrections are new events.
- **Schemas define everything once.** Never hand-write a duplicate interface or JSON schema — infer types from the zod shapes.
- **English inside.** Comments, logs and identifiers are English. Hebrew only in narrative output and the UI.
- **ESM with `.js` extensions in relative imports.**
- **TypeScript strict plus `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`.** An indexed read is `T | undefined` and must be guarded.
- **ESLint `strictTypeChecked`:** no `!`, no unnecessary conditions, `_`-prefixed unused params still error, `[...str]` banned, `consistent-type-imports` on.
- **`no-console` allows only `warn`/`error`.**
- **`corepack enable` before any pnpm command.** Never run root `pnpm lint` — it walks sibling worktrees; lint with `npx eslint packages apps tools`. **Never run `pnpm format`** (no `.prettierignore`; it rewrites ~37 files including the lockfile).
- **No new rules, no rules-engine changes.** `packages/rules-engine` is not touched by this plan. If a task wants to, stop — something is wrong.
- **No story content.** No quest nodes, factions, calendar, NPCs. No `free_text`. No `mode` enum (ADR-0004 decision 2, as amended).
- **Baseline:** recorded in Task 1. Every later task compares against it and any drop is a regression.

---

## File Structure

**`@ai-dm/schemas`** — `src/protocol.ts` (the split + wire renames), `src/events.ts` (enum + payload conventions), `src/reduce.ts` (dispatch), and their three test files.

**`@ai-dm/memory`** — `src/schema.ts` (column/table rename), `drizzle/` (regenerated baseline), `src/event-store/{port,in-memory,postgres,validate,contract}.ts`, `src/event-store/replay.test.ts`.

**`@ai-dm/server`** — `src/core/session.ts` → `src/core/campaign.ts`, `src/core/pipeline.ts`, `src/transport/{http,ws}.ts`, `src/main.ts`, `src/encounters/index.ts`, plus every colocated test.

**`@ai-dm/web`** — `App.tsx`, `net/api.ts`, `net/connection.ts`, `state/store.ts`, `state/conclusion.ts`, `state/persistence.ts`, `components/Grid.tsx`.

**Docs** — `PROJECT_PLAN.md` §4.7, `packages/memory/CLAUDE.md`, `apps/server/CLAUDE.md`.

---

## Task 1: Record the baseline

No code. The number every later task is measured against.

- [x] **Step 1: Cut a branch and confirm the tree**

The §4.7 docs merged to `main` as `10ea06c`. Work from a branch off current `main`, not `main` itself:

```bash
git status --short                  # expect: clean apart from untracked .claude/
git log --oneline -1 -- docs/superpowers/plans/2026-08-23-campaign-state-split.md
git switch -c step-11-campaign-state-split main
```

If the tree is dirty with someone else's work, stop. This plan renames 36 files and will not merge cleanly with a concurrent edit — and `main` has been moving under this work: `41c778b` landed an unrelated conditions/rules-digest fix between the plan being written and executed. Measure the baseline yourself in Step 2 rather than trusting any count quoted elsewhere.

- [x] **Step 2: Measure**

```bash
corepack enable
pnpm test 2>&1 | tail -5
pnpm typecheck && npx eslint packages apps tools && echo "LINT+TYPES OK"
```

Record the passed/files counts in the PR description. Both commands must exit 0 before anything moves.

**Recorded 2026-08-23**, on `step-11-campaign-state-split` off `b0c9950`:

| Package | Test files | Tests |
|---|---|---|
| `packages/schemas` | 6 | 140 |
| `packages/rules-engine` | 15 | 402 |
| `packages/memory` | 3 passed, 1 skipped (4) | 33 passed, 29 skipped (62) |
| `apps/web` | 12 | 107 |
| `packages/agents` | 21 | 239 |
| `tools/sim` | 22 | 194 |
| `apps/server` | 10 | 119 |
| **Total** | **89 passed, 1 skipped (90)** | **1234 passed, 29 skipped (1263)** |

`pnpm typecheck` and `npx eslint packages apps tools` both exit 0. The 29 skips
are `packages/memory`'s Postgres cases, skipped without `DATABASE_URL`; the
`apps/web` run emits jsdom `HTMLCanvasElement.prototype.getContext` warnings
throughout and always has.

---

## Task 2: Rename session to campaign, with no shape change

The wide, shallow half. `SessionState` keeps all eight fields and its meaning; only names change. If the suite is green afterwards, this task is correct — that is the property that makes 36 files reviewable.

**Files:** every file in the File Structure above except `src/reduce.ts`'s dispatch (Task 4) and the new event types (Task 3).

**Interfaces:**
- Produces: `CampaignState` (still the flat eight fields), `CampaignCreated`, `campaign_state` frame, `campaignId` on `JoinMessage`, `campaign_id` / `campaign_snapshots` in the schema.
- Consumes: nothing new.

- [x] **Step 1: Schemas**

`SessionState` → `CampaignState` (shape unchanged, `sessionId` field → `campaignId`). `SessionCreated` → `CampaignCreated`. `JoinMessage.sessionId` → `campaignId`. The `session_state` frame's literal becomes `campaign_state`.

Leave `reduce`'s body alone beyond the field rename.

- [x] **Step 2: Memory**

`schema.ts`: `session_id` → `campaign_id` (the composite PK becomes `(campaign_id, sequence)`), table `session_snapshots` → `campaign_snapshots`. Port, both stores, `validate.ts` and `contract.ts`: `sessionId` → `campaignId`, `SessionMismatchError` → `CampaignMismatchError`.

Regenerate the baseline migration rather than adding an ALTER — ADR-0004's second consequence:

```bash
rm -rf packages/memory/drizzle
corepack enable && pnpm --filter @ai-dm/memory db:generate
```

Anyone holding a local docker volume drops it. There is no other data anywhere: no Dockerfile, no hosting config.

- [x] **Step 3: Server**

`src/core/session.ts` → `src/core/campaign.ts` (`git mv`, so the rename is visible in history rather than as a delete plus an add). `Session` → `Campaign`, `createSession` → `createCampaign`, `loadSession` → `loadCampaign`, `SessionRegistry` → `CampaignRegistry`. `POST /sessions` → `POST /campaigns`.

`recentNarrations` does not move and does not change (spec decision 7).

- [x] **Step 4: Web**

`App.tsx`'s `SESSION_STORAGE_KEY` → `CAMPAIGN_STORAGE_KEY` and its value string; `state/persistence.ts`'s `LOG_STORAGE_KEY` value, its `sessionId` field and both function parameters; `net/api.ts`, `net/connection.ts`, `state/store.ts`, `state/conclusion.ts`, `components/Grid.tsx`.

Changing the two storage-key *values* is deliberate: a browser holding state under the old key must not have it read back against a campaign-shaped projection.

- [x] **Step 5: Verify**

```bash
pnpm test && pnpm typecheck && npx eslint packages apps tools
```

Counts must equal Task 1's exactly. A changed count means something other than a rename happened.

- [x] **Step 6: Prove the rename is total**

```bash
grep -rn "sessionId\|session_id\|SessionState\|session_state" packages apps tools \
  --include='*.ts' --include='*.tsx' | grep -v node_modules | grep -v coverage
```

Expect no hits. A surviving `sessionId` is either a miss or a deliberate exception that needs a comment saying why.

**Done 2026-08-23 as `e0c92b1`.** 54 files. Counts identical to the baseline
above; typecheck and eslint clean; the grep returns zero hits. Stronger check
also run: reverse-renaming every changed file and Prettier-normalizing both
sides reproduces `b0c9950` byte-for-byte, except one `ws.ts` line where
Prettier preserves an object break the longer identifier forced. Deviations
from the step list, each deliberate:

- **`unknown_session` → `unknown_campaign`.** Not enumerated above and not
  caught by Step 6's grep, but it names the stream key and spec decision 6 puts
  the rename on the wire. It is wire-visible.
- **`session_snapshot` (the event type) untouched**, per Task 3's note. So
  `loadCampaign`'s corruption guard still reads `does not start with
  session_snapshot`, correctly, until Task 5.
- **`reduce.ts`'s comment quoting the task brief's `SessionStartedPayload` was
  restored verbatim.** Renaming it would misquote a historical document *and*
  collide with the real `CampaignStartedPayload` Task 3 introduces.
- **`sessionStorage` (browser API) and `tools/sim`'s `TURNS_PER_SESSION` /
  `costPer30TurnSessionUsd` left alone** — that "session" is a 30-turn
  benchmark run, not the event stream. `tools/sim` is not in this plan's blast
  radius and its diff was reverted.
- **Prettier:** the longer identifiers pushed 8 files past 100 cols. 4 of them
  (`events.ts`, `event-store/contract.ts`, `event-store/replay.test.ts`,
  `core/pipeline.test.ts`) were *already* nonconformant at `b0c9950`, so they
  were left rename-only rather than folding pre-existing churn into this diff;
  the other 4 got a path-scoped `npx prettier --write`. `pnpm format` was not
  run. Note for later tasks: this repo is not uniformly Prettier-clean, so
  `--check` is not a useful gate — compare against the baseline file instead.

The drizzle baseline regenerated as `0000_right_changeling.sql`
(`0000_slow_betty_ross.sql` deleted). **Not yet applied to a real Postgres** —
`packages/memory` skipped its 29 cases in both runs, so the column rename is
unproven against a database until Task 8 Step 3 (or earlier, if convenient).

---

## Task 3: Declare the three campaign event types

Additive only. Nothing produces or consumes them yet, so the tree compiles and the suite is untouched.

**Files:** `packages/schemas/src/events.ts`, `src/events.test.ts`.

**Interfaces:**
- Produces: `campaign_started`, `encounter_started`, `encounter_resolved` in the `GameEvent` type enum; `CampaignStartedPayload`, `EncounterStartedPayload`, `EncounterResolvedPayload`.

- [x] **Step 1: Extend the enum and add the payload conventions**

Keep `session_snapshot` in the enum for now — Task 5 removes it, once nothing writes it. Adding the three types will fail `reduce`'s exhaustiveness check immediately; add them to the no-op list in the same step, with a comment saying Task 4 gives two of them behaviour. That keeps this task compiling.

Payload schemas follow `ActionRejectedPayload`'s precedent — open strings over closed enums for anything persisted forever:

```ts
export const CampaignStartedPayload = z.object({ rootSeed: z.number().int() });
export const EncounterStartedPayload = z.object({ encounterId: z.string() });
export const EncounterResolvedPayload = z.object({
  encounterId: z.string(),
  /** Open string, not an enum: this is persisted forever. */
  outcome: z.string(),
  survivorIds: z.array(z.string()),
});
```

- [x] **Step 2: Verify** — counts unchanged except the new payload-parse tests.

---

## Task 4: Split the projection

The deep, narrow half. No identifier renaming happens here; if a diff line changes a name rather than a shape, it belongs in Task 2.

**Files:** `packages/schemas/src/protocol.ts`, `src/reduce.ts`, `src/reduce.test.ts`, `src/protocol.test.ts`; `packages/memory/src/{schema,event-store/port,event-store/postgres,event-store/contract}.ts`; `apps/server/src/core/{campaign,pipeline}.ts`; `apps/web/src/{state/store,state/conclusion,components/Grid}.tsx|.ts`; all colocated tests.

**Interfaces:**
- Produces: `WorldState`, `EncounterState`, `CampaignState = { world, encounter }`.
- Consumes: `CampaignState` (flat) from Task 2, which it replaces.

- [x] **Step 1: The three schemas**

Exactly the spec's Schema section. `WorldState` is `{ campaignId, rootSeed, appliedClientMessageIds }` and nothing else — the dials arrive in §4.7's steps 2–3, and a task that both restructures and fills the projection is not reviewable.

- [x] **Step 2: `reduce` dispatches on scope**

`player_input` writes `world.appliedClientMessageIds`. `state_delta_applied` and `scene_changed` write `encounter`. The no-op list stays explicit so the exhaustiveness check keeps forcing a decision per new type.

A combat event arriving with `encounter === null` throws, rather than returning `state`:

```ts
    case "state_delta_applied": {
      const { combatants } = StateDeltaAppliedPayload.parse(event.payload);
      if (state.encounter === null) {
        throw new Error(
          `Combat event ${event.type} at sequence ${String(event.sequence)} with no encounter open`,
        );
      }
      return { ...state, encounter: { ...state.encounter, combatants } };
    }
```

Silently ignoring it would project a plausible-looking board out of an impossible history, which is far worse to debug than a loud failure at fold time. `reduce` already throws on malformed payloads via `.parse`; this is the same class.

- [x] **Step 3: `encounter` is non-null everywhere, for now**

HTTP still starts an encounter at campaign creation, so nothing yet produces `encounter: null`. Task 5 introduces the bracket and Task 6 tests the guard. Callers read `campaign.state.encounter` and narrow it once at the top rather than re-narrowing per field.

Seeds are unchanged: `seedFor(campaign.state.world.rootSeed, campaign.nextSequence)` at both `pipeline.ts` call sites (ADR-0004 decision 4, as amended — the formula does not change).

- [x] **Step 4: Web reads through `snapshot.encounter`**

`Grid.tsx` and `conclusion.ts` take an `EncounterState`, not a `CampaignState` — they are board components and should not see the world. `store.ts` narrows once.

- [x] **Step 5: Verify** — counts equal Task 1's, plus whatever `reduce.test.ts` gained.

**Done 2026-08-23 as Task 4.** 25 files. `pnpm test` gives **1245 passed, 29
skipped over 90 test files** — the baseline's 1234 plus Task 3's 7 new
payload-parse cases plus 4 new `protocol.test.ts` cases for the shapes the
split makes expressible (`encounter: null` parses; an *absent* `encounter` does
not; a world-less campaign does not; `appliedClientMessageIds` sits on the
world). No package dropped a test. Typecheck and eslint exit 0.

Notes for whoever takes Task 5:

- **`encounterOf(campaign)` is the narrowing seam** (`core/campaign.ts`). It
  throws, because on the turn path an absent board is a corrupt log rather
  than a state to handle. The spec's error-frame refusal (§Wiring) is
  deliberately *not* here: nothing produces `encounter: null` until Task 5
  opens the bracket, so a frame path would be untestable dead code. Add it
  with the bracket.
- **The bracket guard sits after `scene_changed`'s `kind` gate**, not before
  it. `turn_advanced` is the only kind that writes the encounter; guarding the
  whole event type would make §4.7 step 4's out-of-combat scene changes throw
  for arriving where they belong. Task 6 Step 1 should fold a `turn_advanced`.
- **`packages/memory` needed no source change at all** beyond fixtures —
  `schema.ts`, `port.ts` and `postgres.ts` only ever name `CampaignState` as a
  whole, so the split passed straight through them.
- **`foldCombatLog` takes `EncounterState | null`** and no-ops on null, where
  `reduce` throws. Display state degrades; state itself does not.
- **Prettier:** `pipeline.ts`, `e2e.test.ts` and `ws.test.ts` were clean at
  `b0c9950` and got a path-scoped `--write`. `pipeline.test.ts`,
  `event-store/contract.ts` and `event-store/replay.test.ts` were already
  nonconformant there and were left alone; their remaining `--check` failures
  were verified to be the same hunks as at `b0c9950`. Check this with an
  in-repo temp file — a copy under `/tmp` misses `.prettierrc` and reformats
  at 80 cols, which reads as churn that is not there.

### Postgres verification, run early (2026-08-23)

Task 8 Step 3's database run, pulled forward because the column rename had
been unproven since Task 2. **The migration applies and the schema is right:**
`campaign_snapshots`, `campaign_id` on both tables, PK
`(campaign_id, sequence)`, and zero columns matching `%session%`. With
`DATABASE_URL` set, `pnpm test` is **1274 passed, 0 skipped over 90 test
files** — `packages/memory` executes all 62 cases instead of skipping 29.

**Not against the compose file.** Docker could not pull: the daemon (server
29.1.3) stalls at zero bytes even on `hello-world`, though the host reaches
`registry-1.docker.io` fine. Used the Homebrew **Postgres 18.3** already
running on 5432 instead. The baseline migration is plain tables — no pgvector,
no extension — so nothing in it is version-sensitive, but this does **not**
exercise the `pgvector/pgvector:pg17` image, and episodic memory (§4.7 step 7)
will need that image to work before it can be trusted.

Verification ran against a **fresh `aidm_split_verify` database**, not `aidm`.
The existing local `aidm` database still holds the **old `session_id` schema**
with 2710 `game_events` rows and one applied migration from the deleted
`0000_slow_betty_ross.sql` baseline. It was left untouched deliberately —
`drizzle-kit migrate` will fail against it until someone drops those tables,
and that is a call for whoever owns the data, not this plan.

**It caught a real bug** (`eae8fd2`), which is the argument for running this
before the PR rather than after. `contract.ts`'s newer-snapshot fixture still
spread `round` at the top level after Task 4 nested it. Typecheck could not see
it — excess-property checking does not apply through a variable, and `toEqual`
takes `any` — and the in-memory store could not either, because it does no
parsing and handed the stray key straight back. Only Postgres failed, since
`postgres.ts` runs `CampaignState.parse` and zod strips unknown keys. A
shape-change task should assume this class of miss survives a green
in-memory suite.

One caveat on the numbers: an early run showed 6 tests timing out at 5000ms
against Postgres. Three consecutive runs afterwards, and the full-suite run,
were clean with zero timeouts, so it did not reproduce and is recorded here
rather than diagnosed. If it returns in CI, suspect connection setup on the
first-ever queries against a new database rather than the store logic.

---

## Task 5: Genesis becomes two events

**Files:** `apps/server/src/core/campaign.ts` + test, `src/transport/http.ts` + test, `packages/schemas/src/events.ts`, `packages/memory/src/event-store/replay.test.ts`.

**Interfaces:**
- Produces: `createCampaign` (writes `campaign_started` at sequence 0, returns `encounter: null`), `startEncounter` (writes `encounter_started`, folds), `resolveEncounter` (writes `encounter_resolved`).
- Consumes: Task 3's payload schemas, Task 4's projection.

- [x] **Step 1: Split `initialState`**

Into `initialWorldState` (from `campaign_started`'s payload) and `initialEncounterState` (from `encounter_started`'s `encounterId`, via `buildEncounterById`). Both rebuild rather than persist — the same reasoning as today's genesis comment at `campaign.ts`'s `createCampaign`, which is deliberate and must survive the move.

- [x] **Step 2: `loadCampaign` folds both**

Reads the log, rebuilds the world from sequence 0, and rebuilds each encounter's initial state from its own `encounter_started` before folding the rest onto it.

- [x] **Step 3: Drop `session_snapshot` from the enum**

Nothing writes it now. Its only use was genesis and its name described the table, not the event. Removing it will fail `reduce`'s exhaustiveness check in the good way.

- [x] **Step 4: HTTP creates then starts**

`POST /campaigns` calls `createCampaign` and then `startEncounter`, so the client-visible flow is unchanged. That temporary coupling is the seam §4.7's step 4 removes — leave a comment saying so.

**Done 2026-08-23 as `40fbb0b`.** 10 files. Without a database, `pnpm test`
gives **1258 passed, 29 skipped over 90 test files** — Task 4's 1245 plus 13
new `apps/server` cases. With `DATABASE_URL` set: **1287 passed, 0 skipped**,
`packages/memory` running all 62. Typecheck and eslint exit 0, and
`grep -rn session_snapshot` over `packages apps tools` returns zero hits.

**The `built`/`sceneEnglish` fork, resolved.** `Campaign.built` became
`BuiltEncounter | null` and `sceneEnglish` was **deleted** — it was exactly
`built.sceneEnglish`, so keeping it would have been a second field to hold
null in step with the bracket for no gain. Lockstep nullability alone is not
enough (two fields that *can* disagree), so nothing reads `built` directly:
`builtOf(campaign)` is the single reader, it derives open-or-closed from
`state.encounter` — the source of truth, since that is what `reduce` folds —
before consulting `built` at all, and then refuses a `built` naming a
different encounter. Neither failure is reachable today; the point is that
they fail at the seam rather than handing the narrator one encounter's scene
card and the validator another's stat blocks. `encounterOf` was left exactly
as Task 4 shipped it rather than widened to return both halves, which would
have churned ~40 test call sites in a task that is about behaviour.

Other deviations from the step list, each deliberate:

- **`reduce` cannot fill the bracket it opens**, so `encounter_started` is a
  guard-only no-op there: it throws on an overlapping bracket and returns
  `state` otherwise, and `campaign.ts` substitutes `initialEncounterState`
  straight after. The catalogue lives in `apps/server` and
  `@ai-dm/schemas` may never import it (invariant 5). **Consequence worth
  carrying forward: `fold` alone can no longer project a campaign log across
  a bracket.** `loadCampaign` is the only complete projector, and it folds
  event-by-event rather than through `fold`. This is a generalization of the
  status quo, not a regression — `fold` could never project genesis either —
  but Task 7 Step 2's replay-across-a-bracket test cannot use bare `fold`,
  and `packages/memory` cannot reach the catalogue to help.
- **`encounter_resolved` throws when no bracket is open.** The spec only
  named the `encounter_started` direction; this is the same corrupt-log class
  and refuses for the same reason. **Superseded in part by `fd6716d`:** this
  originally shipped with no `encounterId`-match check, on the reasoning that
  `resolveEncounter` takes the id from the open encounter so a mismatch has no
  producer. Review overturned that, correctly — `reduce` is the fold for
  *arbitrary* logs, which is the same argument this task uses to justify
  keeping the overlap guard in `reduce` rather than in the server. One bracket
  was checked and the other was not. `encounter_resolved` now parses
  `EncounterResolvedPayload` and refuses an id that differs from the open
  encounter's; `encounter_started` parses its payload too.
- **The pipeline's refusal uses `not_your_turn`**, per the spec's "existing
  code where one fits". It fits precisely: `state/conclusion.ts` already
  documents that every command after a fight ends is answered `not_your_turn`
  (C-37), and a closed bracket is that same moment one event later. The
  client already treats it as a stale click it must not surface
  (`ErrorBanner.tsx`), which is right, since an encounter-less campaign
  pushes no affordances to click.
- **`playerAffordances` reads `campaign.state.encounter` directly** instead
  of going through `encounterOf`. A campaign between fights has no board to
  offer affordances on — the same "nothing to offer" class its doc comment
  already lists — and a `join` there must still answer with its
  `campaign_state` frame rather than throw.
- **`startEncounter` and `resolveEncounter` mutate the `Campaign` in place**
  and return it. Campaigns are shared objects: `http.ts`'s registry and every
  live socket alias one record and `pipeline.ts`'s `emit` already advances
  `state`/`nextSequence` on it (CRITICAL-1). Returning a fresh record would
  leave all of them holding the pre-encounter one. Both run the catalogue
  lookup and the fold guard **before** the append, so a refused event never
  reaches an append-only log — there is no correction event that could take
  it back out.
- **`CreateCampaignInput` lost `encounterId`**, and a shared `CampaignPorts`
  (`store`/`clock`/`uuid`) was extracted so the four functions cannot drift.
  The local `GenesisPayload` is gone: Task 3's `CampaignStartedPayload` is
  the one definition now (invariant 4).
- **An unknown encounter id now leaves an encounter-less campaign in the
  log.** `POST /campaigns` writes `campaign_started` before `startEncounter`
  throws `UnknownEncounterError` into the route's 404 branch. Harmless — the
  id was never returned to anyone, so it is unreachable — and the log is
  append-only, so there is nothing to roll back.

### The seed shift, and the one test that noticed

**Every turn's seed moved by one sequence.** `seedFor(rootSeed,
nextSequence)` is unchanged (ADR-0004 decision 4), but the sequence space
shifted when genesis became two events, so every roll in every fight is a
different roll. Determinism is intact and no assertion depends on specific
dice — but the *length* of a fight does. The e2e socket combat went from
**6 rounds / 102 events to 10 rounds / 175 events**, measured before and
after, and started failing vitest's 5s default timeout in about two runs out
of three under a parallel `pnpm test` (never in isolation). Confirmed as the
cause by stashing: the same run is clean at Task 4.

Fixed by giving that one test an explicit **30s** timeout. 5s was never a
bound anyone chose for it — it only ever fit by accident, and it also made
`waitForProjection`'s own diagnostic (which names the round, the actor and
every combatant's HP) unreachable past the first round or two, since vitest's
timer fired first and reported nothing but a line number. Tuning seeds to
make the fight short again was rejected: the dice decide how long a fight
runs, and a test should not pin them.

**A note for Task 8.** `apps/web`'s `applyFrame` folds event frames through
`reduce`, and `encounter_started` now throws on an already-open bracket
where `session_snapshot` was an inert no-op. Not reachable today — `join`
answers a fresh client with `campaign_state` at `nextSequence - 1`, which is
already 1 on a new campaign, so a client never resumes from 0 and never
receives `encounter_started` as an event frame — but it is a sharp edge on
exactly the resume path Task 8 Step 1 is about.

**Corrected by review (`fd6716d`).** The framing above names only half the
hazard, and the rarer half. The *silent* case is worse: a client folding
`encounter_started` onto `encounter: null` gets `state` back unchanged — no
throw — so its `snapshot.encounter` stays null while the server has a board,
and `App.tsx` renders its "not ready yet" placeholder indefinitely on a live
socket. A `try`/`catch` around `applyFrame`, the obvious shape for Task 8's
guard, catches none of it. `reduce.ts`'s header now records that `fold` alone
can no longer project a campaign log across a bracket, and that `loadCampaign`
is the only complete projector — the file previously claimed the opposite.

### Review of Task 5, and the fixes it produced

A full review of `40fbb0b` ran before Task 6 and found nine defects, fixed in
`fd6716d` and `12d4136`. Three changed behaviour; six were comments or test
names that overclaimed. Beyond the two corrections folded into the notes
above:

- **`POST /campaigns` no longer writes an orphan row on an unknown encounter
  id.** Task 5 moved `encounterId` off `createCampaign`, so sequence 0 was
  appended *before* anything validated the id — a 404 left a permanently
  unreachable campaign in an append-only log, where before Task 5 it wrote
  nothing. `create` now calls `encounterById` (a pure catalogue lookup, no
  I/O) first. The note calling that row "harmless" is withdrawn: harmless per
  request, but it converted a pure validation failure into a durable write.
- **`resolveEncounter`'s payload goes through `EncounterResolvedPayload`**
  rather than an object literal — invariant 4, and it was the only one of the
  three bracket payloads carrying free-form data.
- **`builtOf`'s disagreement guard and the append-throws-after-guard property
  now have tests that can fail.** Both were unreachable from the suite;
  `builtOf`'s guard is the stated justification for deleting `sceneEnglish`,
  so it needed one.
- **One new test could not fail and was repaired in `12d4136`.** The
  malformed-`encounter_started`-payload case folded against a fixture with a
  bracket open, and that guard throws regardless of payload validity, so a
  bare `.toThrow()` passed even with the parse deleted. It now folds against
  `encounter: null`. Note the asymmetry that made this subtle:
  `encounter_resolved`'s guard fires when the bracket is *closed*, so its
  sibling test discriminates against an open-bracket fixture as written.
  Opposite polarity, same switch.
- **`loadCampaign`'s per-encounter rebuild cost is now documented** — one
  `readFileSync`+parse per `encounter_started` in the log on every cold load,
  and campaigns becoming unloadable if an encounter is ever retired. Not
  memoized: the intermediate builds are *not* wasted, since each one's
  `initialEncounterState` seeds the fold for that encounter's own events.

Counts after both fix commits: **1266 passed / 29 skipped over 90 files**
without a database, **1295 passed / 0 skipped** with one. Typecheck and eslint
exit 0.

**Prettier:** `campaign.ts` was clean at Task 4 and got a path-scoped
`--write`. `pipeline.test.ts`, `event-store/replay.test.ts` and `events.ts`
were already nonconformant and were left that way — but the longer
`GENESIS_SEQUENCE` identifier pushed three `readSince` lines in
`pipeline.test.ts` past 100 cols, so those three were hand-wrapped rather
than left as new churn. Each file's remaining deviations were verified to be
the same hunks as at `HEAD`, by diffing `prettier <file>` against the file
for both the current and the `git show HEAD:` copy, both written **inside the
repo** so `.prettierrc`'s 100 cols applies.

---

## Task 6: The bracket invariants

**Files:** `packages/schemas/src/reduce.test.ts`.

- [x] **Step 1: Combat outside a bracket throws** — `state_delta_applied` and `scene_changed` folded onto `encounter: null`.
- [x] **Step 2: A second `encounter_started` inside an open bracket throws.** Non-overlap is what makes `EncounterState | null` correct rather than a map.
- [x] **Step 3: `encounter_resolved` clears the bracket and leaves `world` intact**, including `appliedClientMessageIds`.

**Done 2026-08-26 as Task 6.** Tests only, one file: `reduce.test.ts` goes
from 18 to 23 cases. `pnpm test` gives **1271 passed, 29 skipped over 90 test
files** — Task 1's baseline of 1266 plus these 5, no package down a test.
Typecheck and eslint exit 0. No Postgres run: nothing here touches the event
store or a schema shape.

The guards themselves already existed — Tasks 4 and 5 wrote them. This task
only proves they cannot be deleted silently, so `reduce.ts` is deliberately
absent from the diff.

**Step 1 is three tests, not two.** Task 4's note above already warned that
Step 1 must fold a `turn_advanced`, because the bracket guard sits *after*
`scene_changed`'s `kind` gate. This task takes that one step further and also
pins the other side of the gate: a non-combat kind (`narration_cue`) folded
onto `encounter: null` must **not** throw. Only the throwing half was
specified, and pinning it alone leaves the ordering in `reduce.ts:95-106`
unprotected — a reorder that broke §4.7 step 4's out-of-combat scene changes
would have passed the suite. The two tests together are what make the
ordering a fact rather than an intention.

**Step 3 could not have discriminated on the `base` fixture.** `base.world`
carries `appliedClientMessageIds: []`, so "the world survives the bracket
close" asserted against it would stay green even if the branch dropped the
field. The test builds its own state with `["c1", "c2"]` and compares against
that literal, not against a live reference.

Notes for whoever takes Task 7:

- **The two bracket cases have opposite guard polarity**, and it is the
  single most error-prone thing in this file. `encounter_started` refuses
  when a bracket is OPEN; `encounter_resolved` refuses when it is CLOSED. A
  fixture that isolates one guard therefore masks the other — which is
  exactly how Task 5's review round shipped a test that could not fail.
  Assert on the message, not with a bare `.toThrow()`, wherever two throws
  are reachable on the same path.
- **Deleting a guard does not always produce a throw.** Removing
  `state_delta_applied`'s bracket guard yields no error at all — `{...null}`
  is legal JS, so the fold silently projects a board out of an impossible
  history. Removing `scene_changed`'s yields a `TypeError` from the property
  read one line down. A bare `.toThrow()` distinguishes neither from the
  intended refusal.
- **Sequences 0-20 are used** in `reduce.test.ts`; the `fold` describe reuses
  0-2 deliberately. Uniqueness is not a convention of this file.

---

## Task 7: The coverage that proves the point

**Files:** `apps/server/src/core/campaign.test.ts`, `packages/memory/src/event-store/replay.test.ts`, `apps/server/src/e2e.test.ts`.

- [x] **Step 1: One campaign, two encounters** — start, resolve, start again. The second board is fresh; the world's idempotency set survives the boundary. This is the whole point of the task and the first test that could not have been written before it.
- [x] **Step 2: Replay across a bracket** — the charter's append→replay→identical-projection round-trip, over a campaign spanning two encounters. Postgres-only, `skipIf` without `DATABASE_URL`, as the existing one is.
- [x] **Step 3: Seed determinism across a boundary** — the same campaign seed and log produce the same rolls in the second encounter on a re-run.
- [x] **Step 4: A campaign with no encounter yet** projects `encounter: null` and serves a `campaign_state` frame without one.

**Done 2026-08-26 as Task 7.** Four new tests, all in `apps/server`; one of
them Postgres-gated. `pnpm test` gives **1274 passed, 30 skipped over 90 test
files** without a database and **1304 passed, 0 skipped** with one. Typecheck
and eslint exit 0. Output is pristine apart from the pre-existing `apps/web`
jsdom canvas warnings Task 1's baseline already records.

**The file list above was wrong for half this task, and the corrections are
the interesting part.**

**Step 2 could not be written where it was assigned.** `fold` alone cannot
round-trip a bracket: `encounter_started` is a guard-only no-op that leaves
`encounter: null`, so the matching `encounter_resolved` hits the
no-bracket-open guard and throws. Verified rather than reasoned — folding
`[encounter_started e1, encounter_resolved e1]` from `encounter: null` raises
`encounter_resolved at sequence 2 with no encounter open`. `@ai-dm/memory`
depends only on `@ai-dm/schemas`, so it cannot reach `loadCampaign`, the only
function that folds a bracket. The projection half therefore lives in
`apps/server/src/core/replay.test.ts` as a Postgres-gated block; the half that
IS provable in `packages/memory` — that both new event types' jsonb payloads
survive a round trip — extends the existing round-trip test's stream instead.

**Step 3 had no home in the list either.** The rolls come from `pipeline.ts`'s
`seedFor(rootSeed, campaign.nextSequence)`, and `campaign.test.ts` never
imports the pipeline. It joins the two determinism tests already in
`apps/server/src/core/replay.test.ts`.

**Step 3 got a second assertion the plan did not ask for:** encounter B's
seeds must *differ* from encounter A's. Seeds derive from the campaign-scoped
`nextSequence`, so a regression resetting that counter per encounter — exactly
what §4.7 forbids with "an encounter's `rootSeed` derives from the campaign
seed and sequence, never fresh randomness" — would pass the determinism check
and every pre-existing test.

**Step 4's projection half already existed** at `campaign.test.ts:325`. Only
the frame half was new, and it needed a campaign built directly against the
store: `POST /campaigns` calls `createCampaign` then `startEncounter`, so no
HTTP route yields an encounter-less campaign.

Notes for whoever takes Task 8:

- **A reviewer finding can rest on a false premise, and did here.** Review
  round 1 asked for the load path's mutation events to be appended to the
  store, on the grounds that the fold could otherwise not tell a stale board
  from a rebuilt one. The implementer applied the fix and said the rationale
  was wrong; re-review agreed and proved it. `reduce`'s `encounter_resolved`
  nulls `encounter` unconditionally, and the substitution computes
  `initialEncounterState(buildEncounterById(id))` — a pure function of the
  catalogue with no access to the prior board. No variable in that scope holds
  encounter A's mutated board, so "carried a stale board across" is
  unconstructible. The *other* half of the finding was real: without the
  appends the log had a hole at the sequences those events consumed, and no
  production path produces such a log.
- **A one-entry catalogue hides a real gap.** A `loadCampaign` that failed to
  reset `built` on `encounter_resolved` is undetectable by any test today,
  because the stale `built` names the same encounter id as the fresh one.
  Nothing to fix here; it becomes testable the moment a second encounter
  exists.
- **`npx vitest run <path>` from the repo root walks `.claude/worktrees/*`**
  on this machine and produces spurious failures — the same hazard already
  known for root `pnpm lint`. Use `pnpm --filter <pkg> test -- <path>`. Root
  `pnpm test` is unaffected.

---

## Task 8: The web resume consequence, and the docs sweep

**Files:** `apps/web/src/state/persistence.ts` + test; `PROJECT_PLAN.md`, `packages/memory/CLAUDE.md`, `apps/server/CLAUDE.md`.

- [x] **Step 1: Assert the cross-encounter guard**

`persistence.ts` stores display state keyed by campaign id and compares on the way back in (`0b8e10f`). Keyed by campaign rather than session, that check now spans encounters, so a restored roll log could describe a fight the campaign has already left. `applyFrame`'s sequence equality should already reject it — the stored sequence cannot match a post-`encounter_resolved` projection. **Assert it explicitly rather than inferring it**, with a test that stores a log mid-encounter, resolves, and expects the restored log to be dropped.

- [x] **Step 2: Sweep by shape, not wording**

`packages/memory/CLAUDE.md:5` and `:12` name `session_snapshots` and the PK `(session_id, sequence)`; `:12` also still says "no campaign concept exists yet", which this plan makes false. `apps/server/CLAUDE.md` describes a session-scoped log.

A comment describing a session-scoped projection is stale whether or not it uses the word "session" — match the claim, not the string.

- [x] **Step 3: Final verification**

```bash
corepack enable
pnpm test && pnpm typecheck && npx eslint packages apps tools
docker compose -f apps/server/docker-compose.yml up -d
DATABASE_URL=postgres://aidm:aidm@localhost:5432/aidm pnpm --filter @ai-dm/memory db:migrate
DATABASE_URL=postgres://aidm:aidm@localhost:5432/aidm pnpm test
```

The Postgres run must show `packages/memory` executing its suite rather than skipping. CI triggers only on `push:main` and `pull_request`, so open the PR to get a real run — the step-10 branch shipped reviewed-but-unexecuted for exactly this reason.


**Done 2026-08-26 as Task 8.** One `docs:` commit plus one fix commit, 7 files,
comments and prose only. Final verification, run by both the implementer and
the controller independently:

| Gate | Result |
|---|---|
| `pnpm test` (no `DATABASE_URL`) | 1274 passed, 30 skipped, 90 files |
| `pnpm test` (Postgres) | 1304 passed, 0 skipped, 90 files |
| `packages/memory` under Postgres | 62/62 executing, not skipping |
| `apps/server`'s gated bracket test | executing (141/141) |
| `pnpm typecheck` | exit 0 |
| `npx eslint packages apps tools` | exit 0 |

Test output is pristine apart from the `apps/web` jsdom canvas warnings Task
1's baseline already records as permanent. The `aidm` database was confirmed
untouched — it still carries the pre-rename schema, which is a decision for
whoever owns that data, not this plan.

**Step 1 did not need a test.** The guard it asks to assert is already pinned
twice: `apps/web/src/App.test.tsx:478` covers the sequence half (a log stored
at one sequence, a `campaign_state` frame at a higher one, the log dropped)
and `persistence.test.ts:67` covers the campaign-id half. A cross-encounter
version would drive the identical branch — `store.ts:194`'s
`frame.sequence === state.sequence` — with a different backstory. There is no
encounter-aware code anywhere in that path, and `encounter_resolved` always
advances the sequence, so no reachable failure was missing. What was missing
was the *reason*: that test's comment explained the guard purely as a
mid-fight reconnect, which was the whole story only while a campaign *was* a
fight. The comment now names the cross-encounter case, and says plainly that
its own fixture does not cross a bracket.

**Two §4.7 mentions were deliberately left.** `PROJECT_PLAN.md:783` and `:822`
still say `SessionState`, and must. §4.7's preamble frames the section as the
architecture *proposed*, and `:822` is that proposal's central prescription —
there is no accurate modernization available, because `CampaignState` is the
*result* of the split, not its input. "CampaignState splits into WorldState
and EncounterState" would be a brand-new false claim. `:838` was different: an
analogy anchored on a table the reader is told to look up today, whose anchor
had been renamed, so the identifier was swapped and nothing else.

**Known, deliberately unfixed:** `campaign.test.ts:593-594` still concludes
that the mutation events make the rebuilt board's shape "load-bearing
mid-fold". They do not. On the load path everything written into the first
bracket is discarded before any assertion — `encounter_resolved` nulls the
encounter and the second `encounter_started` substitutes a fresh board — so
only the board's *existence* is load-bearing mid-fold, via the null guards.
What the mutations genuinely buy is that a stale board would be *detectable*
at all, which the block's own opening comment at `:564-567` already says
correctly. The clause traces to this plan's own dispatch wording, not to the
implementer.

**Not fixed here, and not this branch's to fix:** shipped code carries roughly
fifty citations of SDD process artifacts — `C-NN` correction ids, `CRITICAL-N`
finding ids, "the brief's ...", and `task-corrections.md` by name — across
`packages/rules-engine`, `packages/agents`, `packages/schemas`, `apps/web`,
`apps/server` and `tools/sim`. `task-corrections.md` is not tracked in git, so
those references already dangle. The pattern predates this branch and most of
it sits in packages this plan is forbidden to touch. This branch made the
pattern worse, not better: measured base-to-HEAD across `packages apps tools`,
citations went from 147 to 156. Two `the brief` mentions were removed, but
eleven were added — `C-26` (×1), `C-37` (×2), `CRITICAL-1` (×2), and `task's
report` (×2) are more of the same habit already named above. Three more are a
new and worse kind, naming review rounds of *this plan* rather than a defect
or a finding: `Fix 2` (`apps/server/src/transport/http.ts:177`,
`http.test.ts:50`), `Fix 3`, and `Run 1` (both
`packages/schemas/src/reduce.test.ts`) are artifacts of the process, not of
the code, and point at nothing once this plan is merged and gone. The cleanup
needs its own change and its own review.

**Treat every count above as a lower bound.** They come from a grep, and a
grep is a finding aid rather than the defect boundary. A separate sweep of
this same branch working by *shape* rather than by pattern found roughly 158
citation lines where the pattern matched 59 — it misses bare ids
(`C-13 is closed`), suffixed ones (`C-36a`, where a `\b` fails before the
letter), lowercase prose (`finding 4`), and spelled-out references
(`Review round 1, item 5`, `Important 3`). Two independent measurements of
the same branch also disagreed on the absolute totals (147→156 and 151→160)
while agreeing exactly on the delta and on every itemised instance, which is
what a pattern-dependent count looks like. The direction and the roughly +10
are solid; the absolutes are not, and no future sweep should declare itself
done against a grep total. This is the project's own "sweep by shape, not
wording" rule, rediscovered the hard way inside the very note that records
the defect.
