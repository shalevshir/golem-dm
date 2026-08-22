# Event-log persistence — design

Spec #1 of step 10. The step's roadmap row reads "pgvector episodic store,
scene summarization, quest DAG"; this spec builds none of that. It builds the
thing all of it stands on: a Postgres implementation of the event log, so a
session survives the process that created it.

The split is deliberate and is recorded in `PROJECT_PLAN.md` §4.6, which this
spec's implementation adds. Episodic memory needs a scene summary to embed and
a prompt tier to read it back, and neither exists yet — the narrator's history
is `recentNarrations`, a two-turn window of raw strings. That is spec #2. The
quest DAG needs a quest, and a grep for "campaign" across the repo returns a
line of `packages/memory`'s own charter, a comment on the static prompt tier,
and that comment's copy inside an older spec — no code, no schema, no second
encounter. It is deferred out of step 10 entirely rather than built as a table
nothing reads.

Exit criterion: the contract suite passes against both stores in CI, the
append→replay→identical-projection round-trip passes against a real Postgres,
and a server restarted mid-encounter still resumes the session in the browser.

## Context

Facts checked against the repo rather than recalled.

**The seam already exists, and says so.** `apps/server/src/core/event-store.ts`
opens with: "The event log's storage boundary. Shaped around the SQL it will
become: `append` is an atomic batch that conflicts on (sessionId, sequence),
which is exactly `game_events`' unique constraint. The Postgres implementation
in `@ai-dm/memory` is then a second implementation of this interface, not a
refactor of its callers." This spec is that sentence, executed.

**The restore path is built and waiting.** `createSessionRegistry` in
`apps/server/src/transport/http.ts` misses the live `Map`, then folds the
session back from the log via `loadSession`, under a comment reading "This is
what makes a reconnect after a process restart possible once the store is
durable."

**But the server is not untouched by durability.** Three places assume the
store is fast and fails in exactly two ways:

- `pipeline.ts` special-cases `SequenceConflictError | SessionMismatchError`
  and rethrows everything else. That special case is what re-yields
  `playerAffordances()`, and its absence is what the C-1 soft-lock was. A
  durable store adds a third failure class, and an unhandled one reaches
  `ws.ts`'s catch-all, which sends `internal_error` **without** restoring
  affordances.
- `createSessionRegistry.get` is check-then-`await loadSession`-then-`set`,
  and `join` is deliberately outside the session lock (`ws.ts`, "join is
  deliberately EXCLUDED from the session lock"). Today `loadSession` resolves
  in the same tick; against Postgres it is a real round trip, so two
  concurrent joins can each fold a separate `Session`.
- `main.ts` has no shutdown path at all — no `SIGTERM`, no `onClose`; the file
  ends at `await app.listen`. A connection to close is new machinery.

**Snapshot cadence is already implemented.** `SNAPSHOT_EVERY = 50` in
`pipeline.ts`, fired on `event.sequence > 0 && event.sequence % SNAPSHOT_EVERY === 0`.
The `> 0` guard is load-bearing: sequence 0 is the genesis event and
`0 % 50 === 0`. This spec adds durability beneath that write, not the write.

**`@ai-dm/memory` is a stub with a full charter.** Three files, eight lines:
`world-state.ts` and `episodic.ts` are a comment and an `export {}` apiece,
and `index.ts` re-exports the pair. Its `CLAUDE.md` already fixes the stack
(drizzle-orm, the `postgres` driver, migrations committed under `drizzle/`),
the table names, the append-only rule and the two required tests. The package
is already a declared dependency of `@ai-dm/server`, so no manifest changes.

**The migration tooling is declared but not wired.** `package.json` has
`db:generate` and `db:migrate` pointing at drizzle-kit, and there is no
`drizzle.config.ts` anywhere in the repo — neither subcommand runs without
one. Nothing has ever been generated.

**CI has no database.** `.github/workflows/ci.yml` is a bare ubuntu runner
running `typecheck`, `lint`, `test`. The charter requires tests against a real
Postgres, so either CI grows a service or the two tests that prove step 10
works never run on a push. It grows a service.

**The event envelope is storage-shaped, with caveats.** `GameEvent`
(`packages/schemas/src/events.ts`) is flat — `eventId`, `sessionId`,
`sequence`, `timestamp`, `type`, and a `payload` typed
`z.record(z.string(), z.unknown())`. Two details matter later:
`z.string().datetime()` rejects offsets by default but accepts arbitrary
sub-second precision, and `z.string().uuid()` is case-insensitive.

## Decisions

**The contract moves into `@ai-dm/memory`.** Invariant 5 says nothing depends
on `server`, so a Postgres store cannot import an interface defined in
`apps/server`. That rules out the current home without by itself selecting the
new one — `@ai-dm/schemas` is also compliant. It is rejected because schemas
is zod shapes and generated JSON-schema, and a behavioural port carrying
transaction and conflict semantics is not a shape. The remaining tension is
real and worth naming: `packages/memory/CLAUDE.md` scopes the package as "the
only package that talks to the database", and `createInMemoryEventStore` talks
to none. It lives there anyway, as the contract's reference implementation and
test double, because splitting the two stores across packages is exactly how
they drift.

**Both stores share a pure conflict validator.** The in-memory store checks
each event's `sessionId` before its sequence, walking the batch in order — so
a batch whose first event conflicts and whose second mismatches raises
`SequenceConflictError`, not `SessionMismatchError`. That precedence is
observable, currently undocumented, and precisely what a rewrite gets wrong.

**Schema is declared in drizzle's table DSL; the SQL is generated.**
`packages/memory/CLAUDE.md` already committed to "drizzle-orm + `postgres`
driver; migrations via drizzle-kit (checked into `drizzle/`)" and "Schema
changes only via generated migrations". Hand-writing DDL would leave
`drizzle-orm` an unused dependency and both charter lines false. Queries go
through drizzle too rather than raw `postgres.js` template literals — mixing
the two would mean the column-name mapping exists twice, and drizzle's `jsonb`
column serializes objects correctly where a bare `${sql(rows)}` interpolation
silently stringifies them to `[object Object]`.

**`DATABASE_URL` is optional.** Set, the server uses Postgres; absent, it uses
the in-memory store and says so at boot. This keeps `pnpm dev` working without
docker and every existing server test — e2e, ws, http, pipeline, replay —
running unchanged. The cost is that a misconfigured deploy loses history
silently, answered by making the boot log unmissable rather than by a second
code path.

**Migrations are explicit.** Generated output is committed and applied by
`pnpm --filter @ai-dm/memory db:migrate`. The server does not migrate at boot:
a process that rewrites its own schema on start is hard to reason about during
a rollout, and harder when two of them start at once.

## Non-goals

- **Episodic memory, embeddings, and the `vector` extension.** Spec #2.
- **`entities`, `faction_relations`, `quest_nodes`.** Deferred past step 10.
- **Retention and pruning.** The log grows without bound. `latestSnapshot`'s
  contract already anticipates a pruning store (`pipeline.ts` handles a
  `resumeFrom` older than the newest snapshot), so adding it later needs no
  interface change.
- **Eviction from the `live` session Map (C-30).** `http.ts`'s comment says
  the Map and the in-memory store "are replaced together by the persistence
  spec", and that its unbounded within-a-run growth is "deliberately left to
  the persistence spec". Half of that lands here: the store becomes durable.
  Eviction does not. A cached `Session` is a projection that can always be
  rebuilt from the log now, which makes eviction *possible* for the first
  time — but a policy for it (idle timeout? LRU?) is a separate change with
  its own failure modes, and no session in the POC lives long enough to need
  one. Re-deferred explicitly rather than silently.
- **Undo.** Events are append-only; corrections are new events.
- **Multi-process coordination** beyond the unique constraint. No leader
  election, no advisory locks.
- **Connection-pool tuning.** Driver defaults.

## Structure

`apps/server/src/core/event-store.ts` moves into `@ai-dm/memory`, splitting
along the seam between contract, rule, and implementation:

| File | Contents |
|---|---|
| `src/schema.ts` | the two tables in drizzle's `pgTable` DSL — the schema's single source |
| `drizzle.config.ts` | dialect, `schema`, `out`, and `dbCredentials` from `process.env.DATABASE_URL` |
| `drizzle/` | generated migration plus `meta/` snapshots, committed |
| `src/event-store/port.ts` | `EventStore`, `EventSnapshot`, `SequenceConflictError`, `SessionMismatchError`, `EventStoreUnavailableError` |
| `src/event-store/validate.ts` | `findAppendConflict(sessionId, events, taken)` — pure; returns the error to throw, or `null` |
| `src/event-store/in-memory.ts` | `createInMemoryEventStore` |
| `src/event-store/postgres.ts` | `createPostgresEventStore(db)` |
| `src/event-store/contract.ts` | `describeEventStoreContract(label, makeStore)` — a plain source file both test files import |

`src/index.ts` must re-export all of it. The package's `exports` map is
`{ ".": "./src/index.ts" }` with no subpath patterns, so anything not reached
from `index.ts` is unreachable from `@ai-dm/server`.

Ten files change a relative import to `@ai-dm/memory`: `main.ts`,
`core/session.ts`, `core/pipeline.ts`, `transport/http.ts`, the three tests
beside them, and `e2e.test.ts`, `replay.test.ts`, `ws.test.ts`. The eleventh,
`core/event-store.test.ts`, moves rather than re-imports: its contract
assertions become the shared suite, anything server-specific stays behind.

Two prose references to `event-store.ts` by path survive in
`core/pipeline.test.ts` and `core/replay.test.ts` and need updating; so does
the moved file's own header comment, which currently points forward to the
implementation it will then sit beside.

`drizzle.config.ts` sits outside `src/` and reads `process.env`, so it needs
either inclusion in the package's tsconfig or an explicit lint/type exclusion
— whichever the repo's existing config makes cleaner.

## Schema

Declared in `src/schema.ts`; the migration is `drizzle-kit generate`'s output,
not written by hand.

```ts
export const gameEvents = pgTable(
  "game_events",
  {
    sessionId: text("session_id").notNull(),
    sequence: integer("sequence").notNull(),
    eventId: text("event_id").notNull(),
    timestamp: text("timestamp").notNull(),
    type: text("type").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.sessionId, table.sequence] })],
);

export const sessionSnapshots = pgTable("session_snapshots", {
  sessionId: text("session_id").primaryKey(),
  sequence: integer("sequence").notNull(),
  state: jsonb("state").$type<SessionState>().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
```

Four choices worth defending:

**`timestamp` is `text`, holding the ISO string verbatim.**
`z.string().datetime()` rejects offsets, so the usual argument — that
`timestamptz` normalizes `+02:00` to `Z` — describes an input `GameEvent`
cannot hold. The real loss is precision: `.datetime()` accepts arbitrary
sub-second digits, and a round trip through `timestamptz` and a JS `Date`
truncates to milliseconds. Ordering is by `sequence` and never by time, so the
column has no query duty to justify that. `createdAt` is the operational
column for when a row actually landed.

**`event_id` is `text`, not `uuid`.** `z.string().uuid()` is case-insensitive;
Postgres's `uuid` type normalizes to lowercase. An uppercase `eventId` would
come back changed from one store and unchanged from the other — a divergence
the shared suite can construct. Same reasoning as `timestamp`.

**`type` is `text`, not a Postgres enum.** The zod enum is the authority
(invariant 4); a database enum would mean a migration per new event type and a
second place for the list to be wrong.

**No unique constraint on `event_id`.** It is unique in practice and the
constraint would be free, but the in-memory store does not enforce it, so the
two implementations would diverge on an input the suite can construct. The
composite primary key is the conflict semantics — and because it is one
constraint, a duplicate *within* a single multi-row insert violates it too,
catching the batch-internal case inside the same transaction.

`sequence` is `integer`, which silently bounds a `z.number().int().min(0)`
that has no upper bound. Real sequences are turn counts; the suite keeps its
sequences small, and the bound is documented rather than defended.

## Semantics

`append` is one transaction: read the sequences the batch itself claims, hand
them to the shared validator, then throw or insert.

```ts
await db.transaction(async (tx) => {
  const taken = new Set(
    (
      await tx
        .select({ sequence: gameEvents.sequence })
        .from(gameEvents)
        .where(and(eq(gameEvents.sessionId, sessionId), inArray(gameEvents.sequence, sequences)))
    ).map((row) => row.sequence),
  );
  const conflict = findAppendConflict(sessionId, events, taken);
  if (conflict !== null) throw conflict;
  await tx.insert(gameEvents).values(rows);
});
```

The `inArray` restriction keeps the read to the batch's own sequences rather
than scanning the session's log. Rollback on a thrown error is what delivers
the interface's "either rejection leaves the store exactly as it was". An
empty batch returns before a transaction is opened. Every query inside the
callback must use `tx`, never the outer `db` — the latter takes a different
pooled connection and would deadlock against the transaction's own uncommitted
insert.

Two processes can both clear the pre-check and race to insert; the loser gets
`23505`. Recognition is by the driver's `constraint_name` field, never by
parsing `detail`: `detail` is emitted in the server's `lc_messages` locale,
is suppressed when the role lacks column privileges, and formats the key as
`Key (session_id, sequence)=(<id>, 5) already exists.` — which a `sessionId`
containing `, ` or `)` splits wrongly, and `sessionId` is a bare `z.string()`.
The conflicting sequence is then recovered by re-selecting, so
`SequenceConflictError.sequence` — a public readonly field that reaches the
client in a message — is never a guess. The window is narrow by construction:
`inFlight` already serializes commands per session within a process, so the
race needs a second process, and nothing in the POC starts one.

Everything else the driver can raise — a connection reset, a statement or lock
timeout, a deadlock — and any `ZodError` from parsing a row on read is wrapped
in `EventStoreUnavailableError`, which `port.ts` exports alongside the other
two. This is what keeps the store's failure surface a closed set: see Wiring.

`readSince` selects `sequence > $2` ordered ascending, builds a `GameEvent`
from the named columns (`createdAt` is not one of them) and parses it, so a
row written under an older shape fails loudly instead of flowing into `fold`
as an untyped object. `latestSnapshot` parses `state` through `SessionState`.
`putSnapshot` is `onConflictDoUpdate` on `sessionId` with
`setWhere: lt(sessionSnapshots.sequence, excluded.sequence)`, so a stale *or
equal* sequence is a silent no-op — the interface's wording exactly — and the
`set` list includes `updatedAt` or the column goes stale.

**Both stores hand back objects the caller owns.** The in-memory store today
returns `{ ...snapshot }`, a shallow copy whose `state` is the store's own
object, and `readSince` returns the very `GameEvent` objects that were
appended. A Postgres store returns freshly parsed objects both times. That
asymmetry is observable — mutate a returned snapshot's `state` and re-read —
and the existing comment claiming "a caller mutating the result must not be
able to reach into the cache" is only half true. The in-memory store therefore
`structuredClone`s on `putSnapshot`, `latestSnapshot` and `readSince`. The
cost is a clone per snapshot (one per 50 events) and per replayed batch (once
per reconnect), which buys a contract that is true in both stores instead of
one the suite has to tiptoe around.

**What the suite may construct.** `payload` is `z.record(z.string(), z.unknown())`,
which accepts values a jsonb round trip cannot preserve: a key whose value is
`undefined` survives zod and vanishes through `JSON.stringify`, `Date` becomes
a string, `NaN` and `Infinity` become `null`, `-0` becomes `0`, and a `BigInt`
throws on write in Postgres while succeeding in memory. `GameEvent` is also a
non-strict object, so an extra top-level key survives in memory and is dropped
on a Postgres read. The conformance suite therefore uses only JSON-round-trip-safe
payloads, and says so where it builds them. This is a constraint on the tests,
not a claim about the events the server actually emits.

`createPostgresEventStore(db)` takes an initialized drizzle instance rather
than a connection string, so tests share one connection and `main.ts` owns the
lifecycle.

## Wiring

`config.ts` gains `DATABASE_URL` through the existing `optionalSecret`
transform, which collapses a blank `.env` line to `undefined`. It carries a
password and is never logged. `ServerConfig` gains
`databaseUrl?: string | undefined` — written with the explicit `| undefined`
because `tsconfig.base.json` sets `exactOptionalPropertyTypes: true`, under
which a plain `databaseUrl?: string` will not accept the transform's output.

`main.ts` branches once. With a URL it opens the connection, probes it with a
trivial query so a bad URL fails at boot rather than on the first player's
first turn — the reasoning `config.ts` already applies to provider keys —
builds the Postgres store and logs `event log: postgres`. Without one it
builds the in-memory store and warns that sessions are lost on restart. The
store is constructed before `buildApp`, because it feeds both
`createSessionRegistry` and `ports`, while `app.log` only exists afterwards;
the boot line therefore goes through the `logHolder` indirection `main.ts`
already uses for the same reason. A `SIGTERM`/`SIGINT` handler closing the
server and then the connection is new — the file has no shutdown path today.

`pipeline.ts` adds `EventStoreUnavailableError` to the two error classes it
already special-cases, so a transient store failure yields an `error` frame
*and* re-yields `playerAffordances()` rather than falling through to
`ws.ts`'s catch-all, which restores nothing and would leave the board inert on
the player's own turn. The C-29 comment naming "two error classes" is updated
with it. Genuine programmer errors still rethrow: that is why the store wraps
its failures in a class rather than the pipeline catching everything.

`createSessionRegistry.get` memoizes the in-flight `loadSession` promise in
the `live` map instead of awaiting bare between the check and the set. Today
that gap closes within a tick; against Postgres it is a round trip, and `join`
sits outside the session lock by design, so two concurrent joins — a
reconnect-after-restart, which is this spec's own exit criterion — could each
fold a separate `Session` with its own `nextSequence`, with the loser still
bound to a live socket.

## Testing

`describeEventStoreContract` is run unconditionally by `in-memory.test.ts` and
under `describe.skipIf(process.env.DATABASE_URL === undefined)` by
`postgres.test.ts`. Session ids are minted per case *inside the suite*, not by
the Postgres test file: several ported assertions need two distinct ids
(session isolation, the mismatch case), and against Postgres every case shares
one table, so unique ids are what replace truncation and keep the file
parallel-safe.

The suite asserts what the interface's prose promises, including what nothing
tests today:

- a batch rejected mid-way leaves the store unchanged, verified by reading
  back after the rejection
- a sequence duplicated *within* one batch
- an event whose own `sessionId` disagrees with the call's
- the precedence above: conflict-then-mismatch raises the conflict
- an empty batch resolves
- `readSince` is exclusive at its boundary and ascending
- an unknown session reads empty and snapshots `null`
- `putSnapshot` with a stale, an equal, and a newer sequence
- mutating anything a store returns does not reach back into it

Assertions are on value, never on object identity, since only one store could
ever satisfy identity.

The charter's round-trip — `fold(events)` equals `fold(snapshot, since)` —
runs Postgres-only over a synthetic stream built from `@ai-dm/schemas` alone:
a `session_snapshot` genesis plus a run of deltas. It cannot reuse
`replay.test.ts`'s `goblin-ambush` fixture, which lives in `apps/server` and
is out of reach under invariant 5. That encounter-level replay test stays
where it is, on the in-memory store, unchanged.

## CI

`.github/workflows/ci.yml` gains a `services: postgres` block on
`pgvector/pgvector:pg17` — the image `apps/server/docker-compose.yml` already
pins — with a health check and the same `aidm`/`aidm`/`aidm` credentials, plus
`DATABASE_URL` in the environment and `pnpm --filter @ai-dm/memory db:migrate`
before `pnpm test`. `drizzle.config.ts` reads that same variable, so the
migrate step needs no separate configuration.

No existing test is affected by the variable's presence: `config.test.ts`
passes explicit object literals to `loadConfig` on every case and never reads
`process.env`, and `RawEnv` is a non-strict object that would strip an unknown
key regardless. Verified, not assumed.

## Documentation

- `apps/server/.env.example` already carries a commented
  `DATABASE_URL=postgres://aidm:aidm@localhost:5432/aidm` under "Not yet used —
  the event store is in-memory until the persistence spec." The comment goes;
  the line is uncommented. It keeps the full URL rather than becoming a bare
  `DATABASE_URL=`, so copying the template does not silently select the
  history-losing configuration.
- `packages/memory/CLAUDE.md`'s table list is narrowed to what exists after
  this spec, with the rest marked as spec #2's or deferred.
- `apps/server/CLAUDE.md` records how the store is selected.
- `PROJECT_PLAN.md` gains §4.6: the two-spec decomposition, the deferred quest
  DAG and why, and the step 10 row's status.

## Limitations this spec knowingly ships

- **A misconfigured deploy loses history silently.** `DATABASE_URL` absent is
  a valid configuration that boots and plays; only the log line distinguishes
  it.
- **The log grows without bound**, and so does the `live` session map within a
  run (C-30, re-deferred above).
- **Concurrency is guarded by a constraint, not a design.** Two server
  processes against one database produce `SequenceConflictError`s under
  contention rather than coordinating.
- **A schema change to `GameEvent` invalidates stored rows.** Reads parse and
  therefore fail loudly, which is the intent, but no migration path for
  existing logs is defined.
- **`payload` is trusted to be JSON-round-trip-safe.** Nothing enforces it at
  the type level; a future payload holding a `Date` would diverge between the
  stores before any test noticed.
- **The round-trip test uses synthetic events**, not a real encounter stream;
  the encounter-level replay test still runs only against the in-memory store.
