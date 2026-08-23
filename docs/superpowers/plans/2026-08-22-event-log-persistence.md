# Event-Log Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the append-only event log a Postgres implementation, so a session survives the process that created it and a mid-encounter restart still resumes in the browser.

**Architecture:** The `EventStore` contract, its errors, and the in-memory implementation move out of `apps/server` into `@ai-dm/memory`, joined by a Postgres implementation and one shared conformance suite that both must satisfy. A pure `findAppendConflict` owns the validation order both stores obey. The schema is declared in drizzle's `pgTable` DSL and the migration is generated from it. The server selects a store from `DATABASE_URL` and otherwise keeps its in-memory path exactly as it is.

**Tech Stack:** TypeScript 5.7 strict, ESM, Node 22, drizzle-orm 0.39 + drizzle-kit 0.30, `postgres` 3.4 driver, Postgres 17 + pgvector image, zod 3, Vitest 3.

**Spec:** [`docs/superpowers/specs/2026-08-22-event-log-persistence-design.md`](../specs/2026-08-22-event-log-persistence-design.md)

### Three refinements this plan makes to the spec

1. **`contract.ts` is not re-exported from `src/index.ts`.** It imports `vitest`. The spec says "`src/index.ts` must re-export all of it"; that applies to `port.ts`, `in-memory.ts` and `postgres.ts` only. The two test files import the suite by relative path, since they live in the same package.
2. **`@ai-dm/memory` owns the connection.** It exports `connectPostgresEventStore(url)` returning a handle with `store` / `probe` / `close`, so `drizzle-orm` and `postgres` stay out of `apps/server`'s manifest — which is what `packages/memory/CLAUDE.md`'s "the only package that talks to the database" actually requires. `createPostgresEventStore(db)` is still exported, for tests that share one connection.
3. **Conflict re-derivation keys on SQLSTATE `23505`, not `constraint_name`.** The spec reached for `constraint_name` to avoid parsing a localized `detail` string. Keying on the SQLSTATE and then re-running `findAppendConflict` against a fresh read is strictly simpler: no constraint-name literal to keep in sync with drizzle's naming, and `game_events` has exactly one unique constraint, so a `23505` on it cannot mean anything else.

## Global Constraints

- **Dependency direction:** `schemas ← rules-engine ← agents ← server`. `web` depends only on `schemas`. **Nothing depends on `server`** — this is why the contract moves.
- **Event log is the source of truth.** `game_events` is append-only: no `UPDATE`, no `DELETE`, ever. Corrections are new events.
- **Schemas define everything once.** `GameEvent` and `SessionState` in `@ai-dm/schemas` are the authority. Never hand-write a duplicate interface or a duplicate enum of event types.
- **English inside.** All code comments, logs and identifiers are English.
- **ESM with `.js` extensions in relative imports.** `"type": "module"` everywhere.
- **TypeScript strict plus `exactOptionalPropertyTypes: true` and `noUncheckedIndexedAccess: true`** (`tsconfig.base.json`). An optional property that must accept `undefined` is written `foo?: string | undefined`. An indexed read is `T | undefined` and must be guarded.
- **ESLint `strictTypeChecked`:** no non-null assertions (`!`), no unnecessary conditions, `_`-prefixed unused params still error, `[...str]` is banned. `consistent-type-imports` is on — type-only imports use `import type`.
- **`no-console` allows only `warn`/`error`.** Use the Fastify logger.
- **`corepack enable` before any pnpm command.** Never run root `pnpm lint` (it walks sibling worktrees) — lint with `npx eslint packages apps tools`. **Never run `pnpm format`** (no `.prettierignore`; it rewrites ~37 files including the lockfile).
- **No new event types, no schema changes to `GameEvent` or `SessionState`.** This plan persists them; it does not alter them.
- **Baseline to preserve:** `pnpm test` 1196 passed / 86 files, `pnpm typecheck` exit 0, `npx eslint packages apps tools` exit 0. Re-measure before Task 1 and treat any drop as a regression.
- **Postgres-backed tests skip when `DATABASE_URL` is unset**, so `pnpm test` stays green without docker. They must actually run in CI.

---

## File Structure

**`@ai-dm/memory`** — gains the whole storage boundary

- `drizzle.config.ts` — *new.* dialect, schema path, out dir, `dbCredentials` from `process.env.DATABASE_URL`. Outside `src/`, so outside the package tsconfig; added to ESLint's ignore list.
- `drizzle/` — *new, generated and committed.* One `.sql` migration plus `meta/` snapshots.
- `src/schema.ts` — *new.* `gameEvents` and `sessionSnapshots` in the `pgTable` DSL. The single source for both the migration and the queries.
- `src/schema.test.ts` — *new.* Asserts the generated migration matches the DSL's intent.
- `src/event-store/port.ts` — *new (moved).* `EventStore`, `EventSnapshot`, `SequenceConflictError`, `SessionMismatchError`, `EventStoreUnavailableError`.
- `src/event-store/validate.ts` — *new.* `findAppendConflict`. Pure, no I/O.
- `src/event-store/in-memory.ts` — *new (moved).* `createInMemoryEventStore`.
- `src/event-store/contract.ts` — *new.* `describeEventStoreContract`. Imports vitest; never re-exported from `index.ts`.
- `src/event-store/in-memory.test.ts` — *new (moved).* Runs the suite.
- `src/event-store/postgres.ts` — *new.* `createPostgresEventStore(db)` and `connectPostgresEventStore(url)`.
- `src/event-store/postgres.test.ts` — *new.* Runs the suite under `skipIf`.
- `src/event-store/replay.test.ts` — *new.* The charter's round-trip, Postgres-only.
- `src/index.ts` — *modify.* Re-export `port`, `in-memory`, `postgres`, `schema`.
- `package.json` — *modify.* No new deps; `test` script drops `--passWithNoTests`.
- `CLAUDE.md` — *modify.* Narrow the table list to what exists.

**`@ai-dm/server`** — loses a file, gains a store choice

- `src/core/event-store.ts` — *delete.* Moved.
- `src/core/event-store.test.ts` — *delete.* Became the shared suite.
- `src/config.ts` + `src/config.test.ts` — *modify.* `DATABASE_URL`.
- `src/main.ts` — *modify.* Store selection, boot probe, boot log, shutdown.
- `src/core/pipeline.ts` + `src/core/pipeline.test.ts` — *modify.* Handle `EventStoreUnavailableError`.
- `src/transport/http.ts` + `src/transport/http.test.ts` — *modify.* Memoize the in-flight load.
- `src/core/session.ts`, `src/core/session.test.ts`, `src/core/replay.test.ts`, `src/e2e.test.ts`, `src/transport/ws.test.ts` — *modify.* Import path only.
- `.env.example`, `CLAUDE.md` — *modify.*

**Repo root**

- `.github/workflows/ci.yml` — *modify.* Postgres service, `DATABASE_URL`, migrate step.
- `eslint.config.js` — *modify.* Ignore `packages/memory/drizzle.config.ts` and `packages/memory/drizzle/`.
- `PROJECT_PLAN.md` — *modify.* §4.6 and the step 10 row.

---

## Task 1: Move the contract into `@ai-dm/memory`

Pure relocation plus one extraction. No behaviour changes — the same tests must pass, run from a new place against the same implementation.

**Files:**
- Create: `packages/memory/src/event-store/port.ts`
- Create: `packages/memory/src/event-store/validate.ts`
- Create: `packages/memory/src/event-store/in-memory.ts`
- Create: `packages/memory/src/event-store/contract.ts`
- Create: `packages/memory/src/event-store/in-memory.test.ts`
- Modify: `packages/memory/src/index.ts`
- Modify: `packages/memory/package.json` (test script)
- Delete: `apps/server/src/core/event-store.ts`, `apps/server/src/core/event-store.test.ts`
- Modify (imports only): `apps/server/src/main.ts`, `src/core/session.ts`, `src/core/pipeline.ts`, `src/transport/http.ts`, `src/core/session.test.ts`, `src/core/pipeline.test.ts`, `src/transport/http.test.ts`, `src/core/replay.test.ts`, `src/e2e.test.ts`, `src/transport/ws.test.ts`

**Interfaces:**
- Produces: `EventStore`, `EventSnapshot`, `SequenceConflictError`, `SessionMismatchError`, `EventStoreUnavailableError`, `createInMemoryEventStore()`, `findAppendConflict(sessionId, events, taken)`, `describeEventStoreContract(label, makeStore)` — all from `@ai-dm/memory`, except `describeEventStoreContract` which is imported by relative path within the package.

- [ ] **Step 1: Record the baseline**

```bash
corepack enable
pnpm test 2>&1 | tail -5
pnpm typecheck && npx eslint packages apps tools && echo "LINT+TYPES OK"
```

Expected: 1196 passed, 86 files; both commands exit 0. If the numbers differ, stop and reconcile before touching anything — every later step compares against this.

- [ ] **Step 2: Create the port**

Create `packages/memory/src/event-store/port.ts`. The two error classes and the interface are moved **verbatim** from `apps/server/src/core/event-store.ts` — the doc comments are the contract and must survive the move word for word. Only the file header changes (it used to point forward to this file) and `EventStoreUnavailableError` is new.

```ts
// The event log's storage boundary, and the two implementations' shared
// contract. `append` is an atomic batch that conflicts on
// (sessionId, sequence), which is exactly `game_events`' primary key — the
// Postgres store gets that atomicity from a transaction, the in-memory one
// from validating the whole batch before mutating anything.
import type { GameEvent, SessionState } from "@ai-dm/schemas";

export class SequenceConflictError extends Error {
  readonly sessionId: string;
  readonly sequence: number;

  constructor(sessionId: string, sequence: number) {
    super(`Event ${String(sequence)} already exists for session ${sessionId}`);
    this.name = "SequenceConflictError";
    this.sessionId = sessionId;
    this.sequence = sequence;
  }
}

/**
 * Raised when an event's own `sessionId` disagrees with the session it was
 * appended to. The log must never hold a row whose own payload contradicts
 * the stream containing it — a Postgres implementation that derives
 * `session_id` from the row rather than the call argument would silently
 * diverge from this one otherwise.
 */
export class SessionMismatchError extends Error {
  readonly sessionId: string;
  readonly eventSessionId: string;

  constructor(sessionId: string, eventSessionId: string) {
    super(
      `Event has sessionId "${eventSessionId}", which does not match the session "${sessionId}" it was appended to`,
    );
    this.name = "SessionMismatchError";
    this.sessionId = sessionId;
    this.eventSessionId = eventSessionId;
  }
}

/**
 * Every other way a durable store can fail: a dropped connection, a lock or
 * statement timeout, a deadlock, or a stored row that no longer parses as a
 * `GameEvent`. It exists so the store's failure surface stays a closed set of
 * three classes — `pipeline.ts` special-cases exactly those and rethrows
 * anything else, and an unhandled rejection there reaches a transport
 * catch-all that restores no player affordances.
 *
 * The in-memory store never raises this. It is not a bug that it doesn't:
 * the shared contract permits it, it does not require it.
 */
export class EventStoreUnavailableError extends Error {
  readonly operation: string;

  constructor(operation: string, cause: unknown) {
    // `{ cause }` rather than a redeclared field: `Error.cause` already
    // exists in the ES2022 lib, and redeclaring it would need `override`
    // under `noImplicitOverride`.
    super(`Event store unavailable during ${operation}`, { cause });
    this.name = "EventStoreUnavailableError";
    this.operation = operation;
  }
}

/** A projected `SessionState`, cached at the log `sequence` it reflects. */
export interface EventSnapshot {
  sequence: number;
  state: SessionState;
}

export interface EventStore {
  /**
   * Atomic over the batch. A turn emits several events and a crash mid-turn
   * must not leave half a turn in the log, so either all of them land or none.
   * Rejects with `SequenceConflictError` on a sequence collision (including a
   * duplicate within the batch itself) or `SessionMismatchError` if an
   * event's own `sessionId` disagrees with `sessionId`. Either rejection
   * leaves the store exactly as it was before the call.
   */
  append(sessionId: string, events: readonly GameEvent[]): Promise<void>;
  /** Everything with `sequence > afterSequence`, in ascending order. */
  readSince(sessionId: string, afterSequence: number): Promise<GameEvent[]>;
  latestSnapshot(sessionId: string): Promise<EventSnapshot | null>;
  /**
   * Keeps only the newest snapshot: a call whose `sequence` is less than or
   * equal to the one already stored is a no-op. Snapshots are a cache, never
   * authority — `fold(events)` must equal the snapshot at every snapshot
   * point, so this exists purely to speed up reconnect.
   */
  putSnapshot(sessionId: string, sequence: number, state: SessionState): Promise<void>;
}
```

- [ ] **Step 3: Extract the validator**

Create `packages/memory/src/event-store/validate.ts`. This is the pure rule both stores obey — including the ordering, which is the whole reason it exists.

```ts
import type { GameEvent } from "@ai-dm/schemas";
import { SequenceConflictError, SessionMismatchError } from "./port.js";

/**
 * The append precondition, shared by both stores so neither can drift from
 * it. Order is observable and therefore part of the contract: each event's
 * `sessionId` is checked before its `sequence`, walking the batch in order,
 * so a batch whose first event conflicts and whose second mismatches raises
 * `SequenceConflictError` — not the other way round.
 *
 * `taken` holds the sequences already present for this session. The returned
 * error is thrown by the caller; returning it rather than throwing keeps this
 * function usable inside a transaction callback, where the throw is what
 * triggers the rollback.
 */
export function findAppendConflict(
  sessionId: string,
  events: readonly GameEvent[],
  taken: ReadonlySet<number>,
): SequenceConflictError | SessionMismatchError | null {
  const seen = new Set(taken);
  for (const event of events) {
    if (event.sessionId !== sessionId) {
      return new SessionMismatchError(sessionId, event.sessionId);
    }
    if (seen.has(event.sequence)) {
      return new SequenceConflictError(sessionId, event.sequence);
    }
    seen.add(event.sequence);
  }
  return null;
}
```

- [ ] **Step 4: Move the in-memory store onto the validator**

Create `packages/memory/src/event-store/in-memory.ts`. Same behaviour as the original; the inline validation loop becomes a `findAppendConflict` call.

```ts
import type { GameEvent, SessionState } from "@ai-dm/schemas";
import type { EventSnapshot, EventStore } from "./port.js";
import { findAppendConflict } from "./validate.js";

interface SessionLog {
  events: GameEvent[];
  snapshot: EventSnapshot | null;
}

export function createInMemoryEventStore(): EventStore {
  const logs = new Map<string, SessionLog>();

  function logFor(sessionId: string): SessionLog {
    const existing = logs.get(sessionId);
    if (existing !== undefined) return existing;
    const created: SessionLog = { events: [], snapshot: null };
    logs.set(sessionId, created);
    return created;
  }

  return {
    // No `async`/`await` needed anywhere here — the store is entirely
    // synchronous under the hood — so every method below returns
    // `Promise.resolve(...)` or `Promise.reject(...)` directly rather than
    // being declared `async` with nothing to await (see
    // @typescript-eslint/require-await).
    append(sessionId, events) {
      // Read the existing events without creating a map entry for an
      // unknown session — `logFor` (which does create one) is only called
      // once validation has fully passed, below. Otherwise a rejected batch
      // against a session nobody has written to yet would leave an empty
      // log record behind: not observable through the four public methods,
      // but not "literally unchanged" either, and a rolled-back SQL INSERT
      // would leave nothing.
      const existingEvents = logs.get(sessionId)?.events ?? [];
      const taken = new Set(existingEvents.map((each) => each.sequence));

      // Validate the whole batch before mutating anything — that is what
      // makes this atomic, and what the Postgres store gets from its
      // transaction.
      const conflict = findAppendConflict(sessionId, events, taken);
      if (conflict !== null) return Promise.reject(conflict);

      const log = logFor(sessionId);
      log.events.push(...events);
      log.events.sort((a, b) => a.sequence - b.sequence);
      return Promise.resolve();
    },

    readSince(sessionId, afterSequence) {
      const events =
        logs.get(sessionId)?.events.filter((each) => each.sequence > afterSequence) ?? [];
      return Promise.resolve(events);
    },

    latestSnapshot(sessionId) {
      const snapshot = logs.get(sessionId)?.snapshot ?? null;
      // A copy, never the store's own record: a caller mutating the result
      // must not be able to reach into the cache. Mirrors `readSince`, which
      // never hands back the live `events` array either.
      return Promise.resolve(snapshot === null ? null : { ...snapshot });
    },

    putSnapshot(sessionId, sequence, state) {
      const log = logFor(sessionId);
      if (log.snapshot === null || log.snapshot.sequence < sequence) {
        log.snapshot = { sequence, state };
      }
      return Promise.resolve();
    },
  };
}
```

- [ ] **Step 5: Write the shared conformance suite**

Create `packages/memory/src/event-store/contract.ts`. This is the moved test file, restructured so a second implementation can be held to it, with the session ids minted **inside the suite** — several cases need two distinct ids, and against Postgres every case shares one table.

```ts
import { describe, expect, it } from "vitest";
import type { GameEvent, SessionState } from "@ai-dm/schemas";
import { SequenceConflictError, SessionMismatchError } from "./port.js";
import type { EventStore } from "./port.js";

let counter = 0;
/** A session id no other test case in this process has used. */
function freshSessionId(): string {
  counter += 1;
  return `contract-${String(counter)}-${String(Date.now())}`;
}

function event(sessionId: string, sequence: number): GameEvent {
  return {
    eventId: `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
    sessionId,
    sequence,
    timestamp: "2026-08-19T10:00:00.000Z",
    type: "player_input",
    // Only JSON-round-trip-safe values: a jsonb column drops a key whose
    // value is `undefined`, turns `NaN` into `null` and a `Date` into a
    // string, none of which the in-memory store does. Keeping payloads
    // plain is what lets one suite hold both stores to the same equality.
    payload: { note: `event ${String(sequence)}` },
  };
}

function stateFor(sessionId: string): SessionState {
  return {
    sessionId,
    rootSeed: 1,
    encounterId: "e1",
    grid: { width: 1, height: 1, tiles: [["normal"]] },
    combatants: [],
    turnOrder: [],
    currentActorIndex: 0,
    round: 1,
    appliedClientMessageIds: [],
  };
}

/**
 * Every promise `port.ts` makes, asserted against any implementation.
 *
 * Assertions are on value, never on object identity: only the in-memory
 * store could ever satisfy identity, so asserting it would bake a
 * one-implementation detail into a shared contract.
 */
export function describeEventStoreContract(label: string, makeStore: () => EventStore): void {
  describe(label, () => {
    it("reads back what it appended, in sequence order", async () => {
      const store = makeStore();
      const s = freshSessionId();
      await store.append(s, [event(s, 0), event(s, 1)]);
      const read = await store.readSince(s, -1);
      expect(read.map((each) => each.sequence)).toEqual([0, 1]);
    });

    it("reads back the whole event, payload included", async () => {
      const store = makeStore();
      const s = freshSessionId();
      const appended = event(s, 0);
      await store.append(s, [appended]);
      expect(await store.readSince(s, -1)).toEqual([appended]);
    });

    it("reads only events after the given sequence", async () => {
      const store = makeStore();
      const s = freshSessionId();
      await store.append(s, [event(s, 0), event(s, 1), event(s, 2)]);
      expect((await store.readSince(s, 0)).map((each) => each.sequence)).toEqual([1, 2]);
    });

    it("returns an empty list for an unknown session", async () => {
      expect(await makeStore().readSince(freshSessionId(), -1)).toEqual([]);
    });

    it("returns an empty list past the tail of a known session", async () => {
      const store = makeStore();
      const s = freshSessionId();
      await store.append(s, [event(s, 0), event(s, 1)]);
      expect(await store.readSince(s, 99)).toEqual([]);
    });

    it("returns a fresh array from readSince, not a live reference", async () => {
      const store = makeStore();
      const s = freshSessionId();
      await store.append(s, [event(s, 0)]);
      const first = await store.readSince(s, -1);
      first.push(event(s, 99));
      expect((await store.readSince(s, -1)).map((each) => each.sequence)).toEqual([0]);
    });

    it("accepts an empty batch", async () => {
      const store = makeStore();
      const s = freshSessionId();
      await expect(store.append(s, [])).resolves.toBeUndefined();
      expect(await store.readSince(s, -1)).toEqual([]);
    });

    it("rejects a duplicate sequence", async () => {
      const store = makeStore();
      const s = freshSessionId();
      await store.append(s, [event(s, 0)]);
      await expect(store.append(s, [event(s, 0)])).rejects.toBeInstanceOf(SequenceConflictError);
    });

    it("rejects a duplicate sequence within the same batch", async () => {
      const store = makeStore();
      const s = freshSessionId();
      await expect(store.append(s, [event(s, 0), event(s, 0)])).rejects.toBeInstanceOf(
        SequenceConflictError,
      );
      expect(await store.readSince(s, -1)).toEqual([]);
    });

    it("rejects an event whose own sessionId disagrees with the append target", async () => {
      const store = makeStore();
      const s = freshSessionId();
      const other = freshSessionId();
      await expect(
        store.append(s, [{ ...event(s, 0), sessionId: other }]),
      ).rejects.toBeInstanceOf(SessionMismatchError);
      // Neither the target session nor the event's own session gained a
      // record — a rejected batch must leave no trace on either side.
      expect(await store.readSince(s, -1)).toEqual([]);
      expect(await store.readSince(other, -1)).toEqual([]);
    });

    it("checks sessionId before sequence, in batch order", async () => {
      const store = makeStore();
      const s = freshSessionId();
      const other = freshSessionId();
      await store.append(s, [event(s, 0)]);
      // Event 0 conflicts; event 1 mismatches. The conflict is reached
      // first, so that is the error — the precedence `findAppendConflict`
      // exists to pin down.
      await expect(
        store.append(s, [event(s, 0), { ...event(s, 1), sessionId: other }]),
      ).rejects.toBeInstanceOf(SequenceConflictError);
    });

    it("appends a batch atomically — a conflict anywhere writes nothing", async () => {
      const store = makeStore();
      const s = freshSessionId();
      await store.append(s, [event(s, 0)]);
      await expect(store.append(s, [event(s, 1), event(s, 0)])).rejects.toBeInstanceOf(
        SequenceConflictError,
      );
      // The good half of the batch must not have landed: a crash mid-turn
      // may not leave half a turn in the log.
      expect((await store.readSince(s, -1)).map((each) => each.sequence)).toEqual([0]);
    });

    it("keeps sessions isolated", async () => {
      const store = makeStore();
      const s = freshSessionId();
      const other = freshSessionId();
      await store.append(s, [event(s, 0)]);
      await store.append(other, [event(other, 0)]);
      expect(await store.readSince(s, -1)).toHaveLength(1);
    });

    it("has no snapshot until one is written", async () => {
      expect(await makeStore().latestSnapshot(freshSessionId())).toBeNull();
    });

    it("returns the newest snapshot, state included", async () => {
      const store = makeStore();
      const s = freshSessionId();
      const newer = { ...stateFor(s), round: 4 };
      await store.putSnapshot(s, 50, stateFor(s));
      await store.putSnapshot(s, 100, newer);
      // The full payload, not just the sequence — losing the state blob on
      // the way through is the likeliest failure mode of a SQL-backed
      // implementation (JSONB serialization).
      expect(await store.latestSnapshot(s)).toEqual({ sequence: 100, state: newer });
    });

    it("ignores a snapshot whose sequence does not improve on the current one", async () => {
      const store = makeStore();
      const s = freshSessionId();
      await store.putSnapshot(s, 100, stateFor(s));
      await store.putSnapshot(s, 50, { ...stateFor(s), round: 4 });
      expect(await store.latestSnapshot(s)).toEqual({ sequence: 100, state: stateFor(s) });
    });

    it("ignores a snapshot at the sequence already stored", async () => {
      const store = makeStore();
      const s = freshSessionId();
      await store.putSnapshot(s, 100, stateFor(s));
      await store.putSnapshot(s, 100, { ...stateFor(s), round: 9 });
      expect(await store.latestSnapshot(s)).toEqual({ sequence: 100, state: stateFor(s) });
    });

    it("keeps snapshots isolated per session", async () => {
      const store = makeStore();
      const s = freshSessionId();
      await store.putSnapshot(s, 50, stateFor(s));
      expect(await store.latestSnapshot(freshSessionId())).toBeNull();
    });
  });
}
```

- [ ] **Step 6: Point a test file at the suite**

Create `packages/memory/src/event-store/in-memory.test.ts`:

```ts
import { createInMemoryEventStore } from "./in-memory.js";
import { describeEventStoreContract } from "./contract.js";

describeEventStoreContract("in-memory EventStore", createInMemoryEventStore);
```

- [ ] **Step 7: Export the new surface**

Replace `packages/memory/src/index.ts`:

```ts
export * from "./world-state.js";
export * from "./episodic.js";
export * from "./event-store/port.js";
export * from "./event-store/in-memory.js";
export * from "./event-store/validate.js";
```

`contract.ts` is deliberately absent: it imports `vitest`, and this file is the package's production entry point.

- [ ] **Step 8: Let the package's tests count**

In `packages/memory/package.json`, change the test script from `vitest run --passWithNoTests` to `vitest run`. The package has tests now, and `--passWithNoTests` would hide their disappearance.

- [ ] **Step 9: Run the moved suite**

```bash
pnpm --filter @ai-dm/memory test
```

Expected: 18 tests pass. If `readSince` returns events out of order or the empty-batch case fails, the `findAppendConflict` extraction changed behaviour — compare against the original loop before going further.

- [ ] **Step 10: Delete the old files and repoint every importer**

```bash
git rm apps/server/src/core/event-store.ts apps/server/src/core/event-store.test.ts
```

Then in each of the ten files below, replace the `./event-store.js` / `../core/event-store.js` import with `@ai-dm/memory`. Keep `import type` where it is already a type-only import (`consistent-type-imports` is enforced):

| File | Current | Becomes |
|---|---|---|
| `src/main.ts` | `import { createInMemoryEventStore } from "./core/event-store.js";` | `import { createInMemoryEventStore } from "@ai-dm/memory";` |
| `src/core/session.ts` | `import type { EventStore } from "./event-store.js";` | `import type { EventStore } from "@ai-dm/memory";` |
| `src/core/pipeline.ts` | `import { SequenceConflictError, SessionMismatchError } from "./event-store.js";`<br>`import type { EventStore } from "./event-store.js";` | same names, from `"@ai-dm/memory"` |
| `src/transport/http.ts` | `import type { EventStore } from "../core/event-store.js";` | `import type { EventStore } from "@ai-dm/memory";` |
| `src/core/session.test.ts`, `src/core/pipeline.test.ts`, `src/transport/http.test.ts`, `src/core/replay.test.ts`, `src/e2e.test.ts`, `src/transport/ws.test.ts` | whatever they import from the old path | same names, from `"@ai-dm/memory"` |

Find any you missed:

```bash
grep -rn "event-store" apps/server/src | grep -v node_modules
```

Expected: only prose references in `core/pipeline.test.ts` and `core/replay.test.ts` remain (Task 10 handles those). No `import` line may match.

- [ ] **Step 11: Run everything**

```bash
pnpm test 2>&1 | tail -5
pnpm typecheck && npx eslint packages apps tools && echo "LINT+TYPES OK"
```

Expected: the same 1196 passed, but across 86 files with the counts shifted between `@ai-dm/server` and `@ai-dm/memory` (server loses 13, memory gains 18, so 1201 total is also correct — the suite gained five cases). Both commands exit 0.

- [ ] **Step 12: Commit**

```bash
git add -A
git commit -m "refactor: move the EventStore contract into @ai-dm/memory

The Postgres implementation cannot import an interface defined in
apps/server (invariant 5: nothing depends on server). Moving the contract
takes the in-memory store with it, extracts the batch-validation order
into a pure findAppendConflict both stores will share, and turns the old
test file into a conformance suite a second implementation can be held to."
```

---

## Task 2: Make both stores hand back objects the caller owns

The in-memory store returns `{ ...snapshot }` — shallow, so `.state` is the store's own object — and `readSince` returns the very `GameEvent` objects that were appended. A Postgres store returns freshly parsed objects. The contract has to be true in both, and it is currently true in neither.

**Files:**
- Modify: `packages/memory/src/event-store/contract.ts`
- Modify: `packages/memory/src/event-store/in-memory.ts`

**Interfaces:**
- Consumes: `createInMemoryEventStore`, `describeEventStoreContract` from Task 1.
- Produces: no new names. Strengthens the contract every later implementation must satisfy.

- [ ] **Step 1: Write the failing ownership tests**

Add to `describeEventStoreContract` in `contract.ts`, inside the `describe` block:

```ts
    it("does not expose the stored snapshot state to a caller's mutation", async () => {
      const store = makeStore();
      const s = freshSessionId();
      await store.putSnapshot(s, 50, stateFor(s));

      const first = await store.latestSnapshot(s);
      expect(first).not.toBeNull();
      if (first === null) return;
      first.state.round = 99;

      const second = await store.latestSnapshot(s);
      expect(second?.state.round).toBe(1);
    });

    it("does not let a caller mutate the state it handed to putSnapshot", async () => {
      const store = makeStore();
      const s = freshSessionId();
      const state = stateFor(s);
      await store.putSnapshot(s, 50, state);
      // `pipeline.ts` passes its live `session.state` here and keeps
      // mutating it afterwards, so a store holding that object by reference
      // would silently rewrite a snapshot that was already taken.
      state.round = 99;

      expect((await store.latestSnapshot(s))?.state.round).toBe(1);
    });

    it("does not expose stored events to a caller's mutation", async () => {
      const store = makeStore();
      const s = freshSessionId();
      await store.append(s, [event(s, 0)]);

      const first = await store.readSince(s, -1);
      const mutated = first[0];
      expect(mutated).toBeDefined();
      if (mutated === undefined) return;
      mutated.payload.note = "tampered";

      const second = await store.readSince(s, -1);
      expect(second[0]?.payload.note).toBe("event 0");
    });
```

The `if (... === null) return;` guards are there because `noUncheckedIndexedAccess` and strict null checks make the alternative a non-null assertion, which ESLint bans.

- [ ] **Step 2: Run them and watch them fail**

```bash
pnpm --filter @ai-dm/memory test
```

Expected: 3 failures, all in `in-memory EventStore` — `expected 99 to be 1` twice and `expected 'tampered' to be 'event 0'` once.

- [ ] **Step 3: Clone on the way in and on the way out**

In `packages/memory/src/event-store/in-memory.ts`, replace the `readSince`, `latestSnapshot` and `putSnapshot` implementations:

```ts
    readSince(sessionId, afterSequence) {
      const events =
        logs.get(sessionId)?.events.filter((each) => each.sequence > afterSequence) ?? [];
      // A deep copy, not just a fresh array: the Postgres store parses rows
      // into new objects, so a caller that mutates a returned event must see
      // the same nothing happen in both stores. Cost is one clone per
      // replayed batch, which happens once per reconnect.
      return Promise.resolve(events.map((each) => structuredClone(each)));
    },

    latestSnapshot(sessionId) {
      const snapshot = logs.get(sessionId)?.snapshot ?? null;
      // `{ ...snapshot }` used to be enough for the array, but `state` is an
      // object the caller could reach into. Same reasoning as `readSince`.
      return Promise.resolve(snapshot === null ? null : structuredClone(snapshot));
    },

    putSnapshot(sessionId, sequence, state) {
      const log = logFor(sessionId);
      if (log.snapshot === null || log.snapshot.sequence < sequence) {
        // Cloned on the way in too: `pipeline.ts` hands us its live
        // `session.state` and keeps mutating it after this returns.
        log.snapshot = { sequence, state: structuredClone(state) };
      }
      return Promise.resolve();
    },
```

`append` keeps the caller's objects — they are cloned on the way out, which is where exposure would happen.

- [ ] **Step 4: Run them and watch them pass**

```bash
pnpm --filter @ai-dm/memory test
```

Expected: 21 tests pass.

- [ ] **Step 5: Run everything**

```bash
pnpm test 2>&1 | tail -5
pnpm typecheck && npx eslint packages apps tools && echo "LINT+TYPES OK"
```

Expected: all green. The server suite exercises the store heavily through the pipeline; a failure here means something depended on the aliasing.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "fix: make the in-memory store hand back copies, not its own objects

latestSnapshot's shallow spread left .state reachable, and readSince
returned the appended objects themselves. A parsed Postgres result never
does either, so the shared contract could not have been true in both.
Three new contract cases pin it down."
```

---

## Task 3: Declare the schema and generate the migration

**Files:**
- Create: `packages/memory/src/schema.ts`
- Create: `packages/memory/src/schema.test.ts`
- Create: `packages/memory/drizzle.config.ts`
- Create (generated): `packages/memory/drizzle/*.sql`, `packages/memory/drizzle/meta/*`
- Modify: `packages/memory/src/index.ts`
- Modify: `eslint.config.js`

**Interfaces:**
- Produces: `gameEvents`, `sessionSnapshots` (drizzle tables) from `@ai-dm/memory`; `gameEvents.$inferSelect` / `$inferInsert` row types used by Task 4.

- [ ] **Step 1: Declare the tables**

Create `packages/memory/src/schema.ts`:

```ts
// The schema's single source. `drizzle-kit generate` diffs this file against
// the snapshots in `drizzle/meta` to produce the migration SQL — the SQL is
// output, never hand-edited (packages/memory/CLAUDE.md: "Schema changes only
// via generated migrations").
import { integer, jsonb, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import type { SessionState } from "@ai-dm/schemas";

export const gameEvents = pgTable(
  "game_events",
  {
    sessionId: text("session_id").notNull(),
    sequence: integer("sequence").notNull(),
    // `text`, not `uuid`: `z.string().uuid()` is case-insensitive while
    // Postgres's uuid type normalizes to lowercase, so an uppercase eventId
    // would come back changed from one store and unchanged from the other.
    eventId: text("event_id").notNull(),
    // `text`, not `timestamptz`: `z.string().datetime()` accepts arbitrary
    // sub-second precision, which a round trip through timestamptz and a JS
    // Date truncates to milliseconds. Ordering is by `sequence`, never by
    // time, so the column has no query duty to justify that.
    timestamp: text("timestamp").notNull(),
    // `text`, not a PG enum: the zod enum is the authority (invariant 4), and
    // an enum here would mean a migration per new event type.
    type: text("type").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    // Operational only — when the row actually landed, as opposed to the
    // event's own claimed timestamp.
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // The conflict semantics. Because it is one constraint, a duplicate within
  // a single multi-row INSERT violates it too.
  (table) => [primaryKey({ columns: [table.sessionId, table.sequence] })],
);

export const sessionSnapshots = pgTable("session_snapshots", {
  sessionId: text("session_id").primaryKey(),
  sequence: integer("sequence").notNull(),
  state: jsonb("state").$type<SessionState>().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
```

- [ ] **Step 2: Add the drizzle-kit config**

Create `packages/memory/drizzle.config.ts`:

```ts
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./drizzle",
  // Only `db:migrate` needs credentials; `db:generate` diffs offline. An
  // unset DATABASE_URL therefore fails at migrate time with a connection
  // error rather than here.
  dbCredentials: { url: process.env.DATABASE_URL ?? "" },
});
```

This file sits outside `src/`, so it is outside the package tsconfig's `include` (`["src"]`, with `rootDir: "src"`). drizzle-kit compiles it itself, so it needs no tsconfig entry — but ESLint's `projectService` will fail on a TS file belonging to no project.

In `eslint.config.js`, extend the ignores on line 7:

```js
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/*.gen.ts",
      // Compiled by drizzle-kit, not by any package tsconfig, so the
      // type-aware rules have no project to resolve it against.
      "packages/memory/drizzle.config.ts",
      "packages/memory/drizzle/**",
    ],
  },
```

- [ ] **Step 3: Generate the migration**

```bash
pnpm --filter @ai-dm/memory db:generate
```

Expected: drizzle-kit writes `packages/memory/drizzle/0000_<random_name>.sql` plus `drizzle/meta/0000_snapshot.json` and `drizzle/meta/_journal.json`. Read the SQL and confirm it contains `CREATE TABLE "game_events"`, a `CONSTRAINT "game_events_session_id_sequence_pk" PRIMARY KEY("session_id","sequence")`, and `CREATE TABLE "session_snapshots"` with `"session_id" text PRIMARY KEY`.

If the command errors with "config not found", check the file is at `packages/memory/drizzle.config.ts` and named exactly that.

- [ ] **Step 4: Write the test that the migration matches the intent**

Create `packages/memory/src/schema.test.ts`. This runs without a database — it reads the generated SQL, which is the artifact CI applies.

```ts
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The generated migration is what CI actually applies, so it — not the DSL —
// is what these assertions read. A regenerated migration that quietly drops
// the composite primary key would take the conflict semantics with it.
const drizzleDir = join(import.meta.dirname, "..", "drizzle");

function migrationSql(): string {
  const files = readdirSync(drizzleDir).filter((name) => name.endsWith(".sql"));
  return files.map((name) => readFileSync(join(drizzleDir, name), "utf8")).join("\n");
}

describe("generated migration", () => {
  it("creates both tables", () => {
    const sql = migrationSql();
    expect(sql).toContain(`CREATE TABLE "game_events"`);
    expect(sql).toContain(`CREATE TABLE "session_snapshots"`);
  });

  it("gives game_events a composite primary key on (session_id, sequence)", () => {
    // This is the conflict semantics: it is what makes a duplicate sequence
    // — including one inside a single multi-row INSERT — a 23505.
    expect(migrationSql()).toContain(`PRIMARY KEY("session_id","sequence")`);
  });

  it("stores event_id and timestamp as text", () => {
    const sql = migrationSql();
    // Both deliberately not their "natural" PG types: uuid normalizes case
    // and timestamptz truncates sub-millisecond precision, either of which
    // would diverge from the in-memory store.
    expect(sql).toMatch(/"event_id" text NOT NULL/);
    expect(sql).toMatch(/"timestamp" text NOT NULL/);
  });

  it("stores payload and state as jsonb", () => {
    const sql = migrationSql();
    expect(sql).toMatch(/"payload" jsonb NOT NULL/);
    expect(sql).toMatch(/"state" jsonb NOT NULL/);
  });
});
```

- [ ] **Step 5: Run it**

```bash
pnpm --filter @ai-dm/memory test
```

Expected: 25 tests pass (21 contract + 4 schema). If an assertion fails on quoting or casing, adjust the expectation to the SQL drizzle-kit actually emitted — the generator's formatting is the authority here, not this plan's guess at it.

- [ ] **Step 6: Export the tables**

Add to `packages/memory/src/index.ts`:

```ts
export * from "./schema.js";
```

- [ ] **Step 7: Run everything**

```bash
pnpm test 2>&1 | tail -5
pnpm typecheck && npx eslint packages apps tools && echo "LINT+TYPES OK"
```

Expected: all green. If ESLint reports "file not found in project" for `drizzle.config.ts`, the ignore entry in Step 2 is wrong or missing.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(memory): declare game_events and session_snapshots, generate the migration

Schema lives in drizzle's pgTable DSL and the SQL is generated from it, per
the package charter. There was no drizzle.config.ts in the repo, so neither
db:generate nor db:migrate could ever have run.

event_id is text (z.string().uuid() is case-insensitive, PG's uuid is not)
and timestamp is text (timestamptz truncates the sub-millisecond precision
z.string().datetime() accepts) — both to keep the two stores identical."
```

---

## Task 4: The Postgres store

**Files:**
- Create: `packages/memory/src/event-store/postgres.ts`
- Create: `packages/memory/src/event-store/postgres.test.ts`
- Modify: `packages/memory/src/index.ts`

**Interfaces:**
- Consumes: `EventStore`, `SequenceConflictError`, `SessionMismatchError`, `EventStoreUnavailableError` (Task 1); `findAppendConflict` (Task 1); `gameEvents`, `sessionSnapshots` (Task 3); `describeEventStoreContract` (Tasks 1–2).
- Produces:
  - `createPostgresEventStore(db: PostgresJsDatabase): EventStore`
  - `connectPostgresEventStore(url: string): PostgresEventStoreHandle`
  - `interface PostgresEventStoreHandle { store: EventStore; probe(): Promise<void>; close(): Promise<void>; }`

- [ ] **Step 1: Write the failing test**

Create `packages/memory/src/event-store/postgres.test.ts`:

```ts
import { afterAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { createPostgresEventStore } from "./postgres.js";
import { describeEventStoreContract } from "./contract.js";

const url = process.env.DATABASE_URL;

// Skipped without a database so `pnpm test` stays green on a machine with no
// docker running. CI sets DATABASE_URL, so these do run on every push — see
// .github/workflows/ci.yml.
describe.skipIf(url === undefined)("postgres EventStore", () => {
  // Non-null narrowing rather than `!`: ESLint bans the assertion, and
  // skipIf does not narrow the type for the compiler.
  const connectionString = url ?? "";
  const sql = postgres(connectionString);
  const db = drizzle(sql);
  const store = createPostgresEventStore(db);

  afterAll(async () => {
    await sql.end();
  });

  // One store instance across every case: the contract suite mints a unique
  // session id per case, which is what keeps them isolated on a shared table
  // and lets them run in parallel without truncation.
  describeEventStoreContract("contract", () => store);

  it("reports the conflicting sequence, not a guess", async () => {
    const sessionId = `pg-detail-${String(Date.now())}`;
    const event = (sequence: number) => ({
      eventId: `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
      sessionId,
      sequence,
      timestamp: "2026-08-19T10:00:00.000Z",
      type: "player_input" as const,
      payload: {},
    });
    await store.append(sessionId, [event(0), event(1)]);

    // The batch's lowest sequence is 1, but the one that actually conflicts
    // is 0 — a store that reported the batch head would put a wrong number
    // in a public field that reaches the client.
    await expect(store.append(sessionId, [event(5), event(0)])).rejects.toMatchObject({
      name: "SequenceConflictError",
      sequence: 0,
    });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
docker compose -f apps/server/docker-compose.yml up -d
export DATABASE_URL=postgres://aidm:aidm@localhost:5432/aidm
pnpm --filter @ai-dm/memory db:migrate
pnpm --filter @ai-dm/memory test
```

Expected: failure resolving `./postgres.js` — the module does not exist yet. If `db:migrate` fails to connect, give the container a few seconds and retry; if it reports no migrations, Task 3's `drizzle/` output is missing.

- [ ] **Step 3: Implement the store**

Create `packages/memory/src/event-store/postgres.ts`:

```ts
import { and, asc, eq, gt, inArray, lt, sql as raw } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
// One import, not two: `@ai-dm/schemas` exports `GameEvent` as both the zod
// schema (used here as `GameEvent.parse`) and the inferred type, and a single
// named import brings both.
import { GameEvent, SessionState } from "@ai-dm/schemas";
import { EventStoreUnavailableError, SequenceConflictError, SessionMismatchError } from "./port.js";
import type { EventSnapshot, EventStore } from "./port.js";
import { gameEvents, sessionSnapshots } from "../schema.js";
import { findAppendConflict } from "./validate.js";

/** Postgres' unique_violation. `game_events` has exactly one unique
 * constraint — its primary key — so on that table this can only ever mean a
 * sequence collision. Keying on the SQLSTATE avoids both a constraint-name
 * literal that must track drizzle's naming and the localized `detail` string,
 * which is emitted in the server's `lc_messages` and suppressed outright when
 * the role lacks column privileges. */
const UNIQUE_VIOLATION = "23505";

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code: unknown = (error as Record<string, unknown>).code;
  return typeof code === "string" ? code : undefined;
}

function toGameEvent(row: typeof gameEvents.$inferSelect): GameEvent {
  // Parsed, not cast: a row written under an older shape must fail loudly
  // here rather than flow into `fold` as an untyped object. `createdAt` is
  // deliberately not passed — it is operational, not part of the event.
  return GameEvent.parse({
    eventId: row.eventId,
    sessionId: row.sessionId,
    sequence: row.sequence,
    timestamp: row.timestamp,
    type: row.type,
    payload: row.payload,
  });
}

function toRow(event: GameEvent): typeof gameEvents.$inferInsert {
  return {
    sessionId: event.sessionId,
    sequence: event.sequence,
    eventId: event.eventId,
    timestamp: event.timestamp,
    type: event.type,
    payload: event.payload,
  };
}

export function createPostgresEventStore(db: PostgresJsDatabase): EventStore {
  async function takenSequences(
    executor: PostgresJsDatabase,
    sessionId: string,
    sequences: readonly number[],
  ): Promise<Set<number>> {
    const rows = await executor
      .select({ sequence: gameEvents.sequence })
      .from(gameEvents)
      .where(and(eq(gameEvents.sessionId, sessionId), inArray(gameEvents.sequence, [...sequences])));
    return new Set(rows.map((row) => row.sequence));
  }

  /**
   * Turns a lost insert race into the same error the pre-check would have
   * produced, by reading the log again now that the winner has committed.
   * Runs outside the failed transaction, which is aborted.
   */
  async function deriveConflict(
    sessionId: string,
    events: readonly GameEvent[],
    cause: unknown,
  ): Promise<Error> {
    const taken = await takenSequences(db, sessionId, events.map((each) => each.sequence));
    return findAppendConflict(sessionId, events, taken) ?? new EventStoreUnavailableError("append", cause);
  }

  return {
    async append(sessionId, events) {
      // Nothing to do, and nothing to open a transaction for.
      if (events.length === 0) return;
      const sequences = events.map((each) => each.sequence);

      try {
        await db.transaction(async (tx) => {
          // Every query in here must use `tx`, never the outer `db`: the
          // latter takes a different pooled connection and would deadlock
          // against this transaction's own uncommitted insert.
          const taken = await takenSequences(tx, sessionId, sequences);
          const conflict = findAppendConflict(sessionId, events, taken);
          // Thrown, not returned — the throw is what rolls the transaction
          // back, which is what makes "a rejection leaves the store exactly
          // as it was" true.
          if (conflict !== null) throw conflict;
          await tx.insert(gameEvents).values(events.map(toRow));
        });
      } catch (error) {
        if (error instanceof SequenceConflictError || error instanceof SessionMismatchError) {
          throw error;
        }
        if (errorCode(error) === UNIQUE_VIOLATION) {
          throw await deriveConflict(sessionId, events, error);
        }
        throw new EventStoreUnavailableError("append", error);
      }
    },

    async readSince(sessionId, afterSequence) {
      try {
        const rows = await db
          .select()
          .from(gameEvents)
          .where(and(eq(gameEvents.sessionId, sessionId), gt(gameEvents.sequence, afterSequence)))
          .orderBy(asc(gameEvents.sequence));
        return rows.map(toGameEvent);
      } catch (error) {
        // Covers a ZodError from `toGameEvent` as well as any driver
        // failure: both leave the caller unable to read the log, and
        // `pipeline.ts` needs one class to branch on.
        throw new EventStoreUnavailableError("readSince", error);
      }
    },

    async latestSnapshot(sessionId): Promise<EventSnapshot | null> {
      try {
        const rows = await db
          .select()
          .from(sessionSnapshots)
          .where(eq(sessionSnapshots.sessionId, sessionId))
          .limit(1);
        const row = rows[0];
        if (row === undefined) return null;
        return { sequence: row.sequence, state: SessionState.parse(row.state) };
      } catch (error) {
        throw new EventStoreUnavailableError("latestSnapshot", error);
      }
    },

    async putSnapshot(sessionId, sequence, state) {
      try {
        await db
          .insert(sessionSnapshots)
          .values({ sessionId, sequence, state })
          .onConflictDoUpdate({
            target: sessionSnapshots.sessionId,
            set: { sequence, state, updatedAt: raw`now()` },
            // Makes a stale *or equal* sequence a silent no-op rather than an
            // error, matching the in-memory store's `snapshot.sequence <
            // sequence` guard exactly. A false predicate skips the row; it
            // does not raise.
            setWhere: lt(sessionSnapshots.sequence, sequence),
          });
      } catch (error) {
        throw new EventStoreUnavailableError("putSnapshot", error);
      }
    },
  };
}

export interface PostgresEventStoreHandle {
  store: EventStore;
  /** A trivial query, so a bad URL fails at boot rather than on the first
   * player's first turn. */
  probe(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Opens the connection and builds a store on it. This exists so `drizzle-orm`
 * and `postgres` stay out of `apps/server`'s dependency list —
 * `packages/memory/CLAUDE.md` scopes this package as the only one that talks
 * to the database, and a server importing the driver directly would make that
 * false.
 */
export function connectPostgresEventStore(url: string): PostgresEventStoreHandle {
  const sql = postgres(url);
  const db = drizzle(sql);
  return {
    store: createPostgresEventStore(db),
    async probe() {
      await sql`select 1`;
    },
    async close() {
      await sql.end();
    },
  };
}
```

- [ ] **Step 4: Run the suite against Postgres**

```bash
pnpm --filter @ai-dm/memory test
```

Expected: 47 tests pass — 21 contract cases twice (in-memory and Postgres), 4 schema, 1 conflict-detail. Likely failures and what they mean:

- *`payload` comes back as a string, or the insert errors on invalid json input* — a `jsonb` column is being fed a stringified object. Check `schema.ts` declares `jsonb(...)`, not `text(...)`.
- *The equal-sequence snapshot case fails* — `setWhere` is missing or using `lte`; it must be `lt`.
- *The atomicity case leaves a partial batch* — a query inside the transaction is using `db` instead of `tx`.
- *The precedence case raises `SessionMismatchError`* — `findAppendConflict` is being called per-event rather than over the batch.

- [ ] **Step 5: Export it**

Add to `packages/memory/src/index.ts`:

```ts
export * from "./event-store/postgres.js";
```

- [ ] **Step 6: Confirm the skip path still works**

```bash
unset DATABASE_URL
pnpm test 2>&1 | tail -5
pnpm typecheck && npx eslint packages apps tools && echo "LINT+TYPES OK"
```

Expected: green, with the Postgres describe block reported as skipped. This is the state a contributor without docker sees, and it must never be a failure.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(memory): add the Postgres event store

One transaction per append: read the sequences the batch claims, run the
shared validator, insert. A thrown conflict rolls back, which is what makes
'a rejection leaves the store exactly as it was' true.

A lost insert race (SQLSTATE 23505) is re-derived by reading the log again
and re-running the validator, so SequenceConflictError.sequence is the
sequence that actually conflicted rather than the batch head. Every other
driver failure, and any ZodError from parsing a stored row, is wrapped in
EventStoreUnavailableError so the store's failure surface stays a closed
set of three classes."
```

---

## Task 5: The charter's replay round-trip

`packages/memory/CLAUDE.md` requires an "append→replay→identical-projection round-trip". Task 4 proved the store's mechanics; this proves the property the event-sourcing invariant rests on.

**Files:**
- Create: `packages/memory/src/event-store/replay.test.ts`

**Interfaces:**
- Consumes: `createPostgresEventStore` (Task 4); `fold`, `GameEvent`, `SessionState` from `@ai-dm/schemas`.

- [ ] **Step 1: Write the failing test**

Create `packages/memory/src/event-store/replay.test.ts`:

```ts
import { afterAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { fold } from "@ai-dm/schemas";
import type { GameEvent, SessionState } from "@ai-dm/schemas";
import { createPostgresEventStore } from "./postgres.js";

const url = process.env.DATABASE_URL;

describe.skipIf(url === undefined)("replay round-trip over Postgres", () => {
  const sql = postgres(url ?? "");
  const store = createPostgresEventStore(drizzle(sql));

  afterAll(async () => {
    await sql.end();
  });

  // Built from @ai-dm/schemas alone rather than from replay.test.ts's
  // goblin-ambush fixture, which lives in apps/server and is out of reach
  // under invariant 5. What is being proved here is the fold identity, and
  // that does not need a real encounter.
  function genesisState(sessionId: string): SessionState {
    return {
      sessionId,
      rootSeed: 7,
      encounterId: "e1",
      grid: { width: 2, height: 2, tiles: [["normal", "normal"], ["normal", "normal"]] },
      combatants: [],
      turnOrder: [],
      currentActorIndex: 0,
      round: 1,
      appliedClientMessageIds: [],
    };
  }

  function stream(sessionId: string): GameEvent[] {
    const genesis: GameEvent = {
      eventId: "00000000-0000-4000-8000-000000000000",
      sessionId,
      sequence: 0,
      timestamp: "2026-08-22T10:00:00.000Z",
      // `reduce` treats session_snapshot as a no-op, which is exactly what
      // makes "fold from snapshot plus events equals fold from zero" hold.
      type: "session_snapshot",
      payload: {},
    };
    const deltas = Array.from({ length: 60 }, (_, index): GameEvent => ({
      eventId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      sessionId,
      sequence: index + 1,
      timestamp: "2026-08-22T10:00:00.000Z",
      type: "state_delta_applied",
      payload: { round: index + 1 },
    }));
    return [genesis, ...deltas];
  }

  it("folds to the same state from zero and from a snapshot", async () => {
    const sessionId = `replay-${String(Date.now())}`;
    const events = stream(sessionId);
    await store.append(sessionId, events);

    const fromZero = fold(genesisState(sessionId), await store.readSince(sessionId, -1));

    // The cadence pipeline.ts uses: snapshot at 50, then replay the tail.
    await store.putSnapshot(sessionId, 50, fold(genesisState(sessionId), events.slice(0, 51)));
    const snapshot = await store.latestSnapshot(sessionId);
    expect(snapshot).not.toBeNull();
    if (snapshot === null) return;
    const fromSnapshot = fold(snapshot.state, await store.readSince(sessionId, snapshot.sequence));

    expect(fromSnapshot).toEqual(fromZero);
  });

  it("survives a full round trip through the database unchanged", async () => {
    const sessionId = `roundtrip-${String(Date.now())}`;
    const events = stream(sessionId);
    await store.append(sessionId, events);
    // Not just the projection — the events themselves. A jsonb payload or a
    // truncated timestamp that changed in transit would show here first.
    expect(await store.readSince(sessionId, -1)).toEqual(events);
  });
});
```

- [ ] **Step 2: Run it**

```bash
export DATABASE_URL=postgres://aidm:aidm@localhost:5432/aidm
pnpm --filter @ai-dm/memory test
```

Expected: 49 tests pass. If the second test fails on `timestamp`, the column is `timestamptz` rather than `text` — go back to Task 3. If it fails on `payload`, a jsonb round trip changed a value; check the payloads here are plain JSON.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "test(memory): the charter's append-replay-identical-projection round-trip

Folding from zero and folding from a snapshot plus its tail produce the
same SessionState, and the events themselves come back byte-identical
through jsonb and text columns."
```

---

## Task 6: Server store selection

**Files:**
- Modify: `apps/server/src/config.ts`
- Modify: `apps/server/src/config.test.ts`
- Modify: `apps/server/src/main.ts`

**Interfaces:**
- Consumes: `connectPostgresEventStore`, `createInMemoryEventStore` from `@ai-dm/memory`.
- Produces: `ServerConfig.databaseUrl?: string | undefined`.

- [ ] **Step 1: Write the failing config test**

Add to `apps/server/src/config.test.ts`:

```ts
  it("reads DATABASE_URL when set", () => {
    expect(
      loadConfig({ ANTHROPIC_API_KEY: "k", DATABASE_URL: "postgres://u:p@h:5432/db" }).databaseUrl,
    ).toBe("postgres://u:p@h:5432/db");
  });

  it("treats a blank DATABASE_URL as absent", () => {
    // `.env.example` ships keys blank, and a `.env` loader materialises
    // `DATABASE_URL=` as "" rather than as missing. Blank must mean
    // in-memory, not a connection attempt to the empty string.
    expect(loadConfig({ ANTHROPIC_API_KEY: "k", DATABASE_URL: "" }).databaseUrl).toBeUndefined();
  });

  it("leaves databaseUrl undefined when unset", () => {
    expect(loadConfig({ ANTHROPIC_API_KEY: "k" }).databaseUrl).toBeUndefined();
  });
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm --filter @ai-dm/server test src/config.test.ts
```

Expected: TypeScript error — `databaseUrl` does not exist on `ServerConfig`.

- [ ] **Step 3: Add the field**

In `apps/server/src/config.ts`, add to `RawEnv` after `LOG_LEVEL`:

```ts
  // Absent means the in-memory event store: sessions do not survive a
  // restart. It carries a password, so it is never logged.
  DATABASE_URL: optionalSecret,
```

Extend the interface and the return:

```ts
export interface ServerConfig {
  port: number;
  logLevel: z.infer<typeof LogLevel>;
  // `| undefined` is explicit because `tsconfig.base.json` sets
  // `exactOptionalPropertyTypes`, under which a plain `databaseUrl?: string`
  // would not accept the transform's output.
  databaseUrl?: string | undefined;
}
```

```ts
  return {
    port: parsed.PORT ?? 3000,
    logLevel: parsed.LOG_LEVEL ?? "info",
    databaseUrl: parsed.DATABASE_URL,
  };
```

- [ ] **Step 4: Run it and watch it pass**

```bash
pnpm --filter @ai-dm/server test src/config.test.ts
```

Expected: all config tests pass.

- [ ] **Step 5: Select the store in main.ts**

In `apps/server/src/main.ts`, replace the import on line 20 and the construction on line 27.

Import (with the other package imports, above the relative ones):

```ts
import { connectPostgresEventStore, createInMemoryEventStore } from "@ai-dm/memory";
import type { EventStore, PostgresEventStoreHandle } from "@ai-dm/memory";
```

Replace `const store = createInMemoryEventStore();` with:

```ts
// Chosen before `buildApp`, because both `createSessionRegistry` and `ports`
// need it — which is also why the boot log below goes through `logHolder`
// rather than `app.log`, which does not exist yet.
const postgresHandle: PostgresEventStoreHandle | null =
  config.databaseUrl === undefined ? null : connectPostgresEventStore(config.databaseUrl);
if (postgresHandle !== null) {
  // Fails at boot rather than on the first player's first turn — the same
  // reasoning `loadConfig` applies to provider keys.
  await postgresHandle.probe();
}
const store: EventStore = postgresHandle?.store ?? createInMemoryEventStore();
```

After `logHolder.current = app.log;`, add the boot line:

```ts
if (postgresHandle === null) {
  // A valid configuration, and a lossy one. The only thing distinguishing a
  // deliberate dev run from a misconfigured deploy is this line.
  app.log.warn("event log: in-memory — sessions are lost on restart");
} else {
  app.log.info("event log: postgres");
}
```

After `await app.listen(...)`, add the shutdown path — the file has none today:

```ts
// The process had no shutdown path before there was a connection to close.
// Both signals, because a container stop sends SIGTERM and a terminal sends
// SIGINT, and a half-closed pool keeps the process alive in either case.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    void (async () => {
      await app.close();
      await postgresHandle?.close();
    })();
  });
}
```

- [ ] **Step 6: Verify both paths by hand**

```bash
unset DATABASE_URL
PORT=3000 ANTHROPIC_API_KEY=x pnpm --filter @ai-dm/server dev
```

Expected: the log contains `event log: in-memory — sessions are lost on restart`. Stop with Ctrl-C and confirm the process exits rather than hanging.

```bash
docker compose -f apps/server/docker-compose.yml up -d
PORT=3000 ANTHROPIC_API_KEY=x DATABASE_URL=postgres://aidm:aidm@localhost:5432/aidm \
  pnpm --filter @ai-dm/server dev
```

Expected: `event log: postgres`, then a normal listen. Then check the failure mode:

```bash
PORT=3000 ANTHROPIC_API_KEY=x DATABASE_URL=postgres://aidm:aidm@localhost:9999/aidm \
  pnpm --filter @ai-dm/server dev
```

Expected: the process exits on the probe with a connection error, **before** logging that it is listening.

- [ ] **Step 7: Run everything**

```bash
pnpm test 2>&1 | tail -5
pnpm typecheck && npx eslint packages apps tools && echo "LINT+TYPES OK"
```

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(server): select the event store from DATABASE_URL

Set means Postgres, probed at boot so a bad URL fails there rather than on
the first player's first turn. Absent means the in-memory store, warned
about at boot because it is a valid configuration that silently loses
history. Adds the SIGTERM/SIGINT shutdown path the process never had."
```

---

## Task 7: Keep the board alive when the store fails

`pipeline.ts` special-cases exactly two error classes, and that special case is what re-yields `playerAffordances()`. A durable store adds a third; unhandled, it reaches `ws.ts`'s catch-all, which restores nothing — the C-1 soft-lock in a new costume.

**Files:**
- Modify: `apps/server/src/core/pipeline.ts`
- Modify: `apps/server/src/core/pipeline.test.ts`

**Interfaces:**
- Consumes: `EventStoreUnavailableError` from `@ai-dm/memory` (Task 1).

- [ ] **Step 1: Write the failing test**

Add to `apps/server/src/core/pipeline.test.ts`, in the same `describe` block as the existing `SequenceConflictError` test (around line 704). It reuses that file's own helpers — `freshSession`, `dodge`, `portsWith`, `drain` — and asserts the same two-frame shape:

```ts
  // The third class, new with a durable store: a dropped connection, a lock
  // or statement timeout, a deadlock, or a stored row that no longer parses.
  // Unhandled it reaches ws.ts's catch-all, which sends internal_error and
  // restores nothing — the C-1 soft-lock by a third route.
  it("turns an EventStoreUnavailableError from the store into an internal_error frame", async () => {
    const store = createInMemoryEventStore();
    const session = await freshSession(store);
    const failing: EventStore = {
      ...store,
      append: () => Promise.reject(new EventStoreUnavailableError("append", new Error("boom"))),
    };

    const frames = await drain(handleCommand(session, dodge("hero"), portsWith(failing)));

    expect(frames[0]).toEqual({
      type: "error",
      clientMessageId: "c1",
      code: "internal_error",
      message: expect.any(String) as string,
    });
    const last = frames.at(-1);
    expect(last?.type).toBe("turn_affordances");
    expect(last?.type === "turn_affordances" && last.actorId).toBe("hero");
    expect(frames).toHaveLength(2);
    // Append-and-yield stayed one operation: the failed append never bumped
    // nextSequence.
    expect(session.nextSequence).toBe(1);
  });
```

Add `EventStoreUnavailableError` to the file's existing `@ai-dm/memory` import (Task 1 already repointed it there).

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm --filter @ai-dm/server test src/core/pipeline.test.ts
```

Expected: the test throws rather than yielding frames — the error propagates out of `handleCommand` instead of being turned into an `error` frame.

- [ ] **Step 3: Handle the third class**

In `apps/server/src/core/pipeline.ts`, extend the import:

```ts
import {
  EventStoreUnavailableError,
  SequenceConflictError,
  SessionMismatchError,
} from "@ai-dm/memory";
```

Update the catch block's comment and condition:

```ts
    // C-29: the store throws three error classes on a failed append or read
    // (SequenceConflictError, SessionMismatchError, EventStoreUnavailableError).
    // None has a dedicated ServerErrorCode, so all fold onto internal_error.
    // Because this sits outside `emit`, a failed append never bumps
    // `nextSequence` or mutates `session.state` — the append-and-yield
    // invariant holds by never letting either half happen without the other.
    // Anything else still rethrows: a programmer error must not be swallowed
    // into a frame, which is why the store wraps its own failures in a class
    // rather than this catching everything.
    if (
      error instanceof SequenceConflictError ||
      error instanceof SessionMismatchError ||
      error instanceof EventStoreUnavailableError
    ) {
```

- [ ] **Step 4: Run it and watch it pass**

```bash
pnpm --filter @ai-dm/server test src/core/pipeline.test.ts
```

- [ ] **Step 5: Run everything**

```bash
pnpm test 2>&1 | tail -5
pnpm typecheck && npx eslint packages apps tools && echo "LINT+TYPES OK"
```

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "fix(server): restore affordances when the event store is unavailable

pipeline.ts special-cased two error classes, and that special case is what
re-yields playerAffordances(). A durable store adds a third; unhandled it
reached ws.ts's catch-all, which sends internal_error and restores nothing,
leaving the board inert on the player's own turn (C-1's failure mode)."
```

---

## Task 8: One load per session, not one per concurrent join

`registry.get` is check-then-`await loadSession`-then-`set`. Today that gap closes in a tick; against Postgres it is a round trip, and `join` sits outside the session lock by design. Two concurrent joins — a reconnect after restart, which is this plan's own exit criterion — can each fold a separate `Session` with its own `nextSequence`.

**Files:**
- Modify: `apps/server/src/transport/http.ts`
- Modify: `apps/server/src/transport/http.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `apps/server/src/transport/http.test.ts`, in a new `describe("SessionRegistry.get")` block. It builds on that file's existing `appWith()` helper and needs one new type import: `import type { EventStore } from "@ai-dm/memory";`.

```ts
describe("SessionRegistry.get", () => {
  it("folds a session once when two joins race", async () => {
    const { registry, store } = appWith();
    const created = await registry.create("goblin-ambush");
    const sessionId = created.state.sessionId;

    // A second registry over the same store is what a restarted process
    // looks like: nothing in `live`, everything in the log. The gate holds
    // the fold open so both `get` calls are genuinely in flight at once —
    // which against Postgres is just a network round trip, and `join` sits
    // outside the session lock by design (ws.ts).
    let reads = 0;
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow: EventStore = {
      ...store,
      async readSince(id, afterSequence) {
        reads += 1;
        await gate;
        return store.readSince(id, afterSequence);
      },
    };
    const restarted = createSessionRegistry({
      store: slow,
      uuid: () => "00000000-0000-4000-8000-000000000099",
      clock: () => "2026-08-19T10:00:00.000Z",
      seed: () => 42,
    });

    const both = Promise.all([restarted.get(sessionId), restarted.get(sessionId)]);
    release();
    const [first, second] = await both;

    expect(first).not.toBeNull();
    // One object, not two: two Sessions would each carry their own
    // nextSequence and both keep appending to the same log.
    expect(first).toBe(second);
    expect(reads).toBe(1);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm --filter @ai-dm/server test src/transport/http.test.ts
```

Expected: `expected 2 to be 1` — both calls loaded independently.

- [ ] **Step 3: Memoize the in-flight load**

In `apps/server/src/transport/http.ts`, inside `createSessionRegistry`, add beside `live`:

```ts
  // In-flight `loadSession` calls, keyed the same way. `live` alone was
  // enough while the store was synchronous; a durable store puts a real
  // await between the miss and the set, and `join` is outside the session
  // lock by design, so without this two concurrent joins fold two Sessions
  // and the loser keeps appending from its own nextSequence.
  const loading = new Map<string, Promise<Session | null>>();
```

Replace `get`:

```ts
    get(sessionId) {
      const cached = live.get(sessionId);
      if (cached !== undefined) return Promise.resolve(cached);

      const inFlightLoad = loading.get(sessionId);
      if (inFlightLoad !== undefined) return inFlightLoad;

      // Not in memory: fold it back from the log. This is what makes a
      // reconnect after a process restart possible now that the store is
      // durable.
      const load = loadSession({ sessionId, store: input.store })
        .then((loaded) => {
          if (loaded !== null) live.set(sessionId, loaded);
          return loaded;
        })
        .finally(() => {
          // Cleared on both paths: a failed load must not be cached as a
          // permanently pending promise.
          loading.delete(sessionId);
        });
      loading.set(sessionId, load);
      return load;
    },
```

`get` is no longer `async`, so drop that keyword from the method — it returns promises directly, matching the in-memory store's own style and satisfying `require-await`.

- [ ] **Step 4: Run it and watch it pass**

```bash
pnpm --filter @ai-dm/server test src/transport/http.test.ts
```

- [ ] **Step 5: Run everything**

```bash
pnpm test 2>&1 | tail -5
pnpm typecheck && npx eslint packages apps tools && echo "LINT+TYPES OK"
```

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "fix(server): memoize the in-flight session load

registry.get was check-then-await-then-set. With a synchronous store the
gap closed in a tick; with Postgres it is a round trip, and join sits
outside the session lock by design, so two concurrent joins could fold two
Session objects each with its own nextSequence."
```

---

## Task 9: Run the database tests in CI

**Files:**
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Add the service, the variable and the migrate step**

Replace `.github/workflows/ci.yml` with:

```yaml
name: CI
on:
  push: { branches: [main] }
  pull_request:
jobs:
  ci:
    runs-on: ubuntu-latest
    # The image apps/server/docker-compose.yml already pins, with the same
    # credentials, so a contributor's local database and CI's are the same
    # thing. Without this the two tests that prove the event log is durable
    # would skip on every push.
    services:
      postgres:
        image: pgvector/pgvector:pg17
        env:
          POSTGRES_USER: aidm
          POSTGRES_PASSWORD: aidm
          POSTGRES_DB: aidm
        ports: ["5432:5432"]
        options: >-
          --health-cmd "pg_isready -U aidm"
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5
    env:
      DATABASE_URL: postgres://aidm:aidm@localhost:5432/aidm
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm typecheck
      - run: pnpm lint
      # drizzle.config.ts reads the same DATABASE_URL, so this needs no
      # configuration of its own. Applied explicitly rather than at server
      # boot: a process that rewrites its own schema on start is hard to
      # reason about during a rollout.
      - run: pnpm --filter @ai-dm/memory db:migrate
      - run: pnpm test
```

- [ ] **Step 2: Verify the tests would actually run**

There is no way to execute the workflow locally, so verify the two things that would silently make it a no-op:

```bash
export DATABASE_URL=postgres://aidm:aidm@localhost:5432/aidm
pnpm --filter @ai-dm/memory test 2>&1 | grep -c "skipped"
```

Expected: `0` — no skipped blocks when the variable is set. If the Postgres describe still reports as skipped with `DATABASE_URL` exported, the `skipIf` predicate is wrong and CI would be green for the wrong reason.

- [ ] **Step 3: Commit and push, then read the run**

```bash
git add -A
git commit -m "ci: run the event-store tests against a real Postgres

A bare ubuntu runner meant the two tests that prove step 10 works could
only ever skip. Adds the pgvector/pgvector:pg17 service compose already
pins, DATABASE_URL, and an explicit migrate step before the suite."
git push -u origin step-10-event-log-persistence
```

Then open the run and confirm the `db:migrate` step reports applied migrations and the memory package's test output shows the Postgres block running rather than skipped.

---

## Task 10: Documentation and the stale-reference sweep

**Files:**
- Modify: `apps/server/.env.example`
- Modify: `packages/memory/CLAUDE.md`
- Modify: `apps/server/CLAUDE.md`
- Modify: `PROJECT_PLAN.md`
- Modify: `apps/server/src/core/pipeline.test.ts`, `apps/server/src/core/replay.test.ts` (prose only)

- [ ] **Step 1: Uncomment DATABASE_URL**

In `apps/server/.env.example`, replace:

```
# Not yet used — the event store is in-memory until the persistence spec.
# DATABASE_URL=postgres://aidm:aidm@localhost:5432/aidm
```

with:

```
# Absent or blank selects the in-memory event store: the game plays, but
# sessions are lost on restart. Start the database with
# `docker compose -f apps/server/docker-compose.yml up -d`.
DATABASE_URL=postgres://aidm:aidm@localhost:5432/aidm
```

Keep the full URL rather than leaving it bare — a copied template that reads `DATABASE_URL=` would silently select the history-losing configuration.

- [ ] **Step 2: Sweep the stale references**

```bash
grep -rn "event-store" apps/server/src packages/memory | grep -v node_modules
```

Two prose comments still name the old path — one in `core/pipeline.test.ts`, one in `core/replay.test.ts`. Rewrite each to name `@ai-dm/memory` instead. Match the claim being made, not just the string: a comment saying "the store's own test file covers X" needs to point at the conformance suite now.

Also check the moved header in `packages/memory/src/event-store/port.ts` no longer points forward to a Postgres implementation "in `@ai-dm/memory`" as though from outside — Task 1 Step 2 already rewrote it, so this is a confirmation, not an edit.

- [ ] **Step 3: Narrow the memory charter**

In `packages/memory/CLAUDE.md`, replace the Tables bullet:

```markdown
- Tables (snake_case): `game_events` (append-only, composite PK `(session_id, sequence)`), `session_snapshots`. Planned, not yet built: `entities`, `faction_relations`, `quest_nodes` (deferred past step 10 — no campaign concept exists yet) and `episodic_memories (embedding vector)` (spec #2).
```

And add, under Rules:

```markdown
- Both stores answer to one conformance suite (`src/event-store/contract.ts`). A behaviour only one of them has is a bug in the contract, not a feature — add it to the suite or remove it.
```

- [ ] **Step 4: Record the store choice in the server charter**

Add to `apps/server/CLAUDE.md`, near the event-log section:

```markdown
- The event store is selected in `main.ts` from `DATABASE_URL`: set means Postgres (probed at boot), absent means in-memory with a warning. Both implementations live in `@ai-dm/memory`; `apps/server` never imports a database driver.
```

- [ ] **Step 5: Add PROJECT_PLAN §4.6 and update the roadmap row**

Append after §4.5 in `PROJECT_PLAN.md`:

```markdown
### 4.6 Step 10 decomposition (designed 2026-08-22)

Step 10's row reads "pgvector episodic store, scene summarization, quest
DAG". Only the first of those has a consumer today, and none of them has a
place to live: `@ai-dm/memory` was three files and eight lines, all
`export {}`. So the step splits.

**Spec #1 — event-log persistence.**
[`docs/superpowers/specs/2026-08-22-event-log-persistence-design.md`](docs/superpowers/specs/2026-08-22-event-log-persistence-design.md),
plan at
[`docs/superpowers/plans/2026-08-22-event-log-persistence.md`](docs/superpowers/plans/2026-08-22-event-log-persistence.md).
Moves the `EventStore` contract out of `apps/server` — a Postgres store
cannot import it from there under invariant 5 — holds both implementations
to one conformance suite, and makes `DATABASE_URL` optional so the
in-memory path survives for tests and for `pnpm dev` without docker.

**Spec #2 — episodic memory**, not yet designed. It needs a scene-summary
producer and a prompt tier that reads retrieval back; today the narrator's
history is `recentNarrations`, a two-turn window of raw strings. It also
needs an embedding port, which does not exist in `@ai-dm/agents` and cannot
simply be imported: `@ai-dm/memory` depends only on `@ai-dm/schemas`.

**The quest DAG is deferred out of step 10 entirely.** A grep for
"campaign" across the repo returns a line of `packages/memory`'s charter, a
comment on the static prompt tier, and that comment's copy in an older
spec — no code, no schema, no second encounter. `SessionState` is
combat-only. `quest_nodes` would be a table nothing reads, and the shape it
should have is not knowable until there is a campaign concept to serve.
```

Update the step 10 row in the §4 table to `🟡 spec #1 shipped; episodic memory not started` once Task 9's CI run is green, and add a line to §5 Open Risks if the in-memory fallback's silent-data-loss mode is worth tracking there.

- [ ] **Step 6: Run everything one last time**

```bash
pnpm test 2>&1 | tail -5
pnpm typecheck && npx eslint packages apps tools && echo "LINT+TYPES OK"
```

- [ ] **Step 7: The manual exit criterion**

This is the claim `http.ts` has been making since the server slice, and it has never once been true. Verify it by hand:

```bash
docker compose -f apps/server/docker-compose.yml up -d
PORT=3000 ANTHROPIC_API_KEY=<real key> DATABASE_URL=postgres://aidm:aidm@localhost:5432/aidm \
  pnpm dev
```

1. Open the web client, start a `goblin-ambush` session, take two or three turns.
2. Kill the server process.
3. Restart it with the same command.
4. Reload the browser.

Expected: the session resumes with the board, the roll log and the Hebrew narration exactly where they were, rather than a fresh encounter or an error. Confirm the same session id in the URL and that a new turn appends at the sequence the log left off at.

If it resumes but the board is a turn behind, check the snapshot cadence interacted correctly — `putSnapshot` fires at sequence 50, so a short session exercises the `readSince(-1)` path rather than the snapshot path, and both need checking.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "docs: record step 10's decomposition and the durable store

PROJECT_PLAN gains §4.6: spec #1 shipped, spec #2 (episodic memory) not
designed, quest DAG deferred out of the step because no campaign concept
exists for it to serve. .env.example's DATABASE_URL is live rather than
commented out, and the memory charter's table list is narrowed to what
actually exists."
```

---

## Verification checklist

Before calling this done, all of these must hold.
**Status as of 2026-08-23** (measured on `f974c4b`, after the final whole-branch
review's fix wave; test counts re-measured after the web-resume follow-up that
closed the Step 7 gap): every item verified except CI, noted inline.

- [x] `pnpm test` green, with the memory package's Postgres block **running** (not skipped) when `DATABASE_URL` is set, and **skipped** (not failed) when it is not — 1263 passed / 90 files with it set; 1234 passed / 29 skipped / 90 without. (1252 / 89 and 1223 / 29 / 89 before the web-resume follow-up added 11 tests and one file.) A blank `DATABASE_URL=""` skips identically to absent.
- [x] `pnpm typecheck` exit 0
- [x] `npx eslint packages apps tools` exit 0
- [ ] CI green on the branch, with the `db:migrate` step reporting applied migrations — **NOT VERIFIED.** `ci.yml` triggers on `push:{branches:[main]}` and `pull_request` only, so pushing this branch fires no run and none exists. The service block ships reviewed but unexecuted; it runs for the first time on the eventual PR or merge.
- [x] `grep -rn "event-store" apps/server/src` returns no import lines — 2 hits, both prose in comments
- [x] `apps/server/package.json` has gained no dependency — no `postgres`, no `drizzle-orm`
- [x] A server restart mid-encounter resumes the session in the browser (Task 10, Step 7) — **PARTIAL on the first run, closed by a follow-up the same day. Both runs 2026-08-23.**
  First run: fought two rounds (Eldad 28->20 HP, one goblin killed), SIGTERM'd the server, restarted, reloaded the tab. **Board state, session id and the log all survived**: identical combatant HP, the dead goblin correctly no longer targetable, and the next turn appended at sequence 29 on top of a max of 28 rather than restarting at 0. Both boots logged `event log: postgres`; the SIGTERM exit was clean.
  **What did not survive: the roll log and the Hebrew narration**, which this checklist item's Step 7 text also names. Not a store defect — all 39 events including every `dice_rolled` and `narrative_emitted` were in Postgres. Pre-existing web-client limitation that durability newly exposed: before this branch a restart lost the session outright.
  **The first diagnosis was wrong, and is corrected here because acting on it would not have worked.** It read: the client never sends `resumeFrom` (`sequenceRef` is in-memory and a reload resets it to 0), so persist the sequence beside the id and the server's snapshot-plus-tail path restores the history. Persisting the sequence does not restore either thing, for two independent reasons. (1) The server only replays when `resumeFrom` predates a snapshot, and `SNAPSHOT_EVERY` is 50, so a fight of 39 events has no snapshot at all: `readSince(38)` is empty and the join is answered with the same bare `session_state` as before. Worse, when the client's stored sequence is *behind* the log — the server appended a turn the dying socket never delivered, which a kill mid-turn does — the answer is a run of bare `event` frames, and `applyFrame` drops every one of them while `snapshot` is null, hanging the tab on "connecting…". That is exactly the hazard the comment at `App.tsx:158` predicted. (2) Neither the roll log nor the narration is in the event stream's projection *or* reachable by replaying it: `combatLog` is folded client-side from events `SessionState` does not carry, and `narrative` is accumulated from `narrative_token` frames, which are not events — `applyFrame` has no `narrative_emitted` case, so even a full replay would leave the pane empty.
  **Actual fix** (`apps/web/src/state/persistence.ts`, new): the client writes its display state — sequence, `combatLog`, `narrative`, `narrativeStreamId`, tagged with the session id — to `sessionStorage` beside the session id, and seeds `useState` from it on mount. The join stays `resumeFrom`-less, which is the correct request for a client holding no snapshot. `applyFrame` keeps the restored log and narration when the arriving `session_state` is at exactly the sequence they were folded at, and drops both otherwise, so the server's projection always wins the moment the two disagree. Both keys are cleared together in both teardowns (`resetToStart`, and the fight-concluded effect). No server, protocol or schema change.
  Second run, after the fix: two rounds, SIGTERM to the process on port 3000, cold restart, tab reload. **Board, roll log (four turn groups, every die and total intact) and narration all survived**; the dead goblin was still untargetable; the next turn appended on top of the restored log at sequence 36. No console errors beyond the retry-loop `ECONNREFUSED`s from the window when the server was genuinely down.
  Two corrections to Step 7's own text: the session id lives in `sessionStorage`, **not the URL** (the URL stays `/`), and `apps/server/.env` sets `PORT=3001` while the Vite proxy targets `3000`, so the `PORT=3000` override in the command is load-bearing.
- [x] Starting with a bad `DATABASE_URL` exits at boot, not on the first turn — verified in Task 6 (port 9999, crashes inside `probe()` before any listen)
- [x] Starting with no `DATABASE_URL` logs the in-memory warning and plays normally
