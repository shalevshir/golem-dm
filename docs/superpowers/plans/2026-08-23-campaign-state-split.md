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

- [ ] **Step 1: Cut a branch and confirm the tree**

The §4.7 docs merged to `main` as `10ea06c`. Work from a branch off current `main`, not `main` itself:

```bash
git status --short                  # expect: clean apart from untracked .claude/
git log --oneline -1 -- docs/superpowers/plans/2026-08-23-campaign-state-split.md
git switch -c step-11-campaign-state-split main
```

If the tree is dirty with someone else's work, stop. This plan renames 36 files and will not merge cleanly with a concurrent edit — and `main` has been moving under this work: `41c778b` landed an unrelated conditions/rules-digest fix between the plan being written and executed. Measure the baseline yourself in Step 2 rather than trusting any count quoted elsewhere.

- [ ] **Step 2: Measure**

```bash
corepack enable
pnpm test 2>&1 | tail -5
pnpm typecheck && npx eslint packages apps tools && echo "LINT+TYPES OK"
```

Record the passed/files counts in the PR description. Both commands must exit 0 before anything moves.

---

## Task 2: Rename session to campaign, with no shape change

The wide, shallow half. `SessionState` keeps all eight fields and its meaning; only names change. If the suite is green afterwards, this task is correct — that is the property that makes 36 files reviewable.

**Files:** every file in the File Structure above except `src/reduce.ts`'s dispatch (Task 4) and the new event types (Task 3).

**Interfaces:**
- Produces: `CampaignState` (still the flat eight fields), `CampaignCreated`, `campaign_state` frame, `campaignId` on `JoinMessage`, `campaign_id` / `campaign_snapshots` in the schema.
- Consumes: nothing new.

- [ ] **Step 1: Schemas**

`SessionState` → `CampaignState` (shape unchanged, `sessionId` field → `campaignId`). `SessionCreated` → `CampaignCreated`. `JoinMessage.sessionId` → `campaignId`. The `session_state` frame's literal becomes `campaign_state`.

Leave `reduce`'s body alone beyond the field rename.

- [ ] **Step 2: Memory**

`schema.ts`: `session_id` → `campaign_id` (the composite PK becomes `(campaign_id, sequence)`), table `session_snapshots` → `campaign_snapshots`. Port, both stores, `validate.ts` and `contract.ts`: `sessionId` → `campaignId`, `SessionMismatchError` → `CampaignMismatchError`.

Regenerate the baseline migration rather than adding an ALTER — ADR-0004's second consequence:

```bash
rm -rf packages/memory/drizzle
corepack enable && pnpm --filter @ai-dm/memory db:generate
```

Anyone holding a local docker volume drops it. There is no other data anywhere: no Dockerfile, no hosting config.

- [ ] **Step 3: Server**

`src/core/session.ts` → `src/core/campaign.ts` (`git mv`, so the rename is visible in history rather than as a delete plus an add). `Session` → `Campaign`, `createSession` → `createCampaign`, `loadSession` → `loadCampaign`, `SessionRegistry` → `CampaignRegistry`. `POST /sessions` → `POST /campaigns`.

`recentNarrations` does not move and does not change (spec decision 7).

- [ ] **Step 4: Web**

`App.tsx`'s `SESSION_STORAGE_KEY` → `CAMPAIGN_STORAGE_KEY` and its value string; `state/persistence.ts`'s `LOG_STORAGE_KEY` value, its `sessionId` field and both function parameters; `net/api.ts`, `net/connection.ts`, `state/store.ts`, `state/conclusion.ts`, `components/Grid.tsx`.

Changing the two storage-key *values* is deliberate: a browser holding state under the old key must not have it read back against a campaign-shaped projection.

- [ ] **Step 5: Verify**

```bash
pnpm test && pnpm typecheck && npx eslint packages apps tools
```

Counts must equal Task 1's exactly. A changed count means something other than a rename happened.

- [ ] **Step 6: Prove the rename is total**

```bash
grep -rn "sessionId\|session_id\|SessionState\|session_state" packages apps tools \
  --include='*.ts' --include='*.tsx' | grep -v node_modules | grep -v coverage
```

Expect no hits. A surviving `sessionId` is either a miss or a deliberate exception that needs a comment saying why.

---

## Task 3: Declare the three campaign event types

Additive only. Nothing produces or consumes them yet, so the tree compiles and the suite is untouched.

**Files:** `packages/schemas/src/events.ts`, `src/events.test.ts`.

**Interfaces:**
- Produces: `campaign_started`, `encounter_started`, `encounter_resolved` in the `GameEvent` type enum; `CampaignStartedPayload`, `EncounterStartedPayload`, `EncounterResolvedPayload`.

- [ ] **Step 1: Extend the enum and add the payload conventions**

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

- [ ] **Step 2: Verify** — counts unchanged except the new payload-parse tests.

---

## Task 4: Split the projection

The deep, narrow half. No identifier renaming happens here; if a diff line changes a name rather than a shape, it belongs in Task 2.

**Files:** `packages/schemas/src/protocol.ts`, `src/reduce.ts`, `src/reduce.test.ts`, `src/protocol.test.ts`; `packages/memory/src/{schema,event-store/port,event-store/postgres,event-store/contract}.ts`; `apps/server/src/core/{campaign,pipeline}.ts`; `apps/web/src/{state/store,state/conclusion,components/Grid}.tsx|.ts`; all colocated tests.

**Interfaces:**
- Produces: `WorldState`, `EncounterState`, `CampaignState = { world, encounter }`.
- Consumes: `CampaignState` (flat) from Task 2, which it replaces.

- [ ] **Step 1: The three schemas**

Exactly the spec's Schema section. `WorldState` is `{ campaignId, rootSeed, appliedClientMessageIds }` and nothing else — the dials arrive in §4.7's steps 2–3, and a task that both restructures and fills the projection is not reviewable.

- [ ] **Step 2: `reduce` dispatches on scope**

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

- [ ] **Step 3: `encounter` is non-null everywhere, for now**

HTTP still starts an encounter at campaign creation, so nothing yet produces `encounter: null`. Task 5 introduces the bracket and Task 6 tests the guard. Callers read `campaign.state.encounter` and narrow it once at the top rather than re-narrowing per field.

Seeds are unchanged: `seedFor(campaign.state.world.rootSeed, campaign.nextSequence)` at both `pipeline.ts` call sites (ADR-0004 decision 4, as amended — the formula does not change).

- [ ] **Step 4: Web reads through `snapshot.encounter`**

`Grid.tsx` and `conclusion.ts` take an `EncounterState`, not a `CampaignState` — they are board components and should not see the world. `store.ts` narrows once.

- [ ] **Step 5: Verify** — counts equal Task 1's, plus whatever `reduce.test.ts` gained.

---

## Task 5: Genesis becomes two events

**Files:** `apps/server/src/core/campaign.ts` + test, `src/transport/http.ts` + test, `packages/schemas/src/events.ts`, `packages/memory/src/event-store/replay.test.ts`.

**Interfaces:**
- Produces: `createCampaign` (writes `campaign_started` at sequence 0, returns `encounter: null`), `startEncounter` (writes `encounter_started`, folds), `resolveEncounter` (writes `encounter_resolved`).
- Consumes: Task 3's payload schemas, Task 4's projection.

- [ ] **Step 1: Split `initialState`**

Into `initialWorldState` (from `campaign_started`'s payload) and `initialEncounterState` (from `encounter_started`'s `encounterId`, via `buildEncounterById`). Both rebuild rather than persist — the same reasoning as today's genesis comment at `campaign.ts`'s `createCampaign`, which is deliberate and must survive the move.

- [ ] **Step 2: `loadCampaign` folds both**

Reads the log, rebuilds the world from sequence 0, and rebuilds each encounter's initial state from its own `encounter_started` before folding the rest onto it.

- [ ] **Step 3: Drop `session_snapshot` from the enum**

Nothing writes it now. Its only use was genesis and its name described the table, not the event. Removing it will fail `reduce`'s exhaustiveness check in the good way.

- [ ] **Step 4: HTTP creates then starts**

`POST /campaigns` calls `createCampaign` and then `startEncounter`, so the client-visible flow is unchanged. That temporary coupling is the seam §4.7's step 4 removes — leave a comment saying so.

---

## Task 6: The bracket invariants

**Files:** `packages/schemas/src/reduce.test.ts`.

- [ ] **Step 1: Combat outside a bracket throws** — `state_delta_applied` and `scene_changed` folded onto `encounter: null`.
- [ ] **Step 2: A second `encounter_started` inside an open bracket throws.** Non-overlap is what makes `EncounterState | null` correct rather than a map.
- [ ] **Step 3: `encounter_resolved` clears the bracket and leaves `world` intact**, including `appliedClientMessageIds`.

---

## Task 7: The coverage that proves the point

**Files:** `apps/server/src/core/campaign.test.ts`, `packages/memory/src/event-store/replay.test.ts`, `apps/server/src/e2e.test.ts`.

- [ ] **Step 1: One campaign, two encounters** — start, resolve, start again. The second board is fresh; the world's idempotency set survives the boundary. This is the whole point of the task and the first test that could not have been written before it.
- [ ] **Step 2: Replay across a bracket** — the charter's append→replay→identical-projection round-trip, over a campaign spanning two encounters. Postgres-only, `skipIf` without `DATABASE_URL`, as the existing one is.
- [ ] **Step 3: Seed determinism across a boundary** — the same campaign seed and log produce the same rolls in the second encounter on a re-run.
- [ ] **Step 4: A campaign with no encounter yet** projects `encounter: null` and serves a `campaign_state` frame without one.

---

## Task 8: The web resume consequence, and the docs sweep

**Files:** `apps/web/src/state/persistence.ts` + test; `PROJECT_PLAN.md`, `packages/memory/CLAUDE.md`, `apps/server/CLAUDE.md`.

- [ ] **Step 1: Assert the cross-encounter guard**

`persistence.ts` stores display state keyed by campaign id and compares on the way back in (`0b8e10f`). Keyed by campaign rather than session, that check now spans encounters, so a restored roll log could describe a fight the campaign has already left. `applyFrame`'s sequence equality should already reject it — the stored sequence cannot match a post-`encounter_resolved` projection. **Assert it explicitly rather than inferring it**, with a test that stores a log mid-encounter, resolves, and expects the restored log to be dropped.

- [ ] **Step 2: Sweep by shape, not wording**

`packages/memory/CLAUDE.md:5` and `:12` name `session_snapshots` and the PK `(session_id, sequence)`; `:12` also still says "no campaign concept exists yet", which this plan makes false. `apps/server/CLAUDE.md` describes a session-scoped log.

A comment describing a session-scoped projection is stale whether or not it uses the word "session" — match the claim, not the string.

- [ ] **Step 3: Final verification**

```bash
corepack enable
pnpm test && pnpm typecheck && npx eslint packages apps tools
docker compose -f apps/server/docker-compose.yml up -d
DATABASE_URL=postgres://aidm:aidm@localhost:5432/aidm pnpm --filter @ai-dm/memory db:migrate
DATABASE_URL=postgres://aidm:aidm@localhost:5432/aidm pnpm test
```

The Postgres run must show `packages/memory` executing its suite rather than skipping. CI triggers only on `push:main` and `pull_request`, so open the PR to get a real run — the step-10 branch shipped reviewed-but-unexecuted for exactly this reason.
