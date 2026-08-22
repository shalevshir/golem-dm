# Event-log persistence — design

Spec #1 of step 10. The step's roadmap row reads "pgvector episodic store,
scene summarization, quest DAG"; this spec builds none of that. It builds the
thing all of it stands on: a Postgres implementation of the event log, so a
session survives the process that created it.

The split is deliberate and recorded in `PROJECT_PLAN.md` §4.6. Episodic
memory needs a scene summary to embed and a prompt tier to read it back, and
neither exists yet — the narrator's history is `recentNarrations`, a two-turn
window of raw strings. That is spec #2. The quest DAG needs a quest, and a
grep for "campaign" across the repo returns a line of `packages/memory`'s own
charter, a comment on the static prompt tier, and that comment's copy inside
an older spec — no code, no schema, no second encounter. It is deferred out of
step 10 entirely rather than built as a table nothing reads.

Exit criterion: the contract suite passes against both stores in CI, the
append→replay→identical-projection round-trip passes against a real
Postgres, and a server restarted mid-encounter still resumes the session in
the browser.

## Context

Six facts were checked against the repo rather than recalled.

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
durable." Nothing in the server changes to make that true. Only the store does.

**Snapshot cadence is already implemented.** `SNAPSHOT_EVERY = 50` in
`apps/server/src/core/pipeline.ts`, with the write fired on
`event.sequence % SNAPSHOT_EVERY === 0`. §3 of `PROJECT_PLAN.md` asks for
snapshots every 50 events and gets them today. This spec adds durability
beneath that write, not the write.

**`@ai-dm/memory` is a stub with a full charter.** Three files, eight lines:
`world-state.ts` and `episodic.ts` are a comment and an `export {}` apiece,
and `index.ts` re-exports the pair. Its `CLAUDE.md`, written well ahead of the
code, already fixes the stack (drizzle-orm, the `postgres` driver, migrations
committed under `drizzle/`), the table names, the append-only rule, and the
two required tests. `@ai-dm/memory` is already a declared dependency of
`@ai-dm/server`, so nothing in either manifest changes.

**CI has no database.** `.github/workflows/ci.yml` is a bare ubuntu runner
that installs and runs `typecheck`, `lint`, `test`. The package charter
requires tests against a real Postgres, so either CI grows a service or the
two tests that prove step 10 works never run on a push. It grows a service.

**The event envelope is already storage-shaped.** `GameEvent`
(`packages/schemas/src/events.ts`) is a flat object — `eventId`, `sessionId`,
`sequence`, `timestamp`, `type`, and a `payload` typed
`z.record(z.string(), z.unknown())`. It maps to columns and one `jsonb`
without an intermediate representation.

## Decisions

**The contract moves into `@ai-dm/memory`.** Invariant 5 says nothing depends
on `server`, so a Postgres store living in `@ai-dm/memory` cannot import an
interface defined in `apps/server`. Redefining the interface on the memory
side would satisfy the compiler through structural typing and satisfy nothing
else: the contract's careful prose would live in one file while a second file
silently re-implemented it, and the first drift would be invisible. The
interface moves, both implementations sit behind it, and one shared suite
holds them to it.

**Both stores share a pure conflict validator.** The in-memory store checks
each event's `sessionId` before its sequence, walking the batch in order — so
a batch whose first event conflicts and whose second mismatches raises
`SequenceConflictError`, not `SessionMismatchError`. That precedence is
observable, currently undocumented, and precisely what a SQL rewrite gets
wrong. Extracting it into a pure function makes both stores agree by
construction.

**`DATABASE_URL` is optional.** Set, the server uses Postgres; absent, it uses
the in-memory store and says so loudly at boot. This keeps `pnpm dev` working
without docker and keeps every existing server test — e2e, ws, http, pipeline,
replay — running unchanged against the in-memory store. The cost is that a
misconfigured deploy loses history silently, which is answered by making the
boot log unmissable rather than by a second code path.

**Migrations are explicit.** `drizzle-kit generate` output is committed and
applied by `pnpm --filter @ai-dm/memory db:migrate`, the script the manifest
already declares. The server does not migrate at boot: a process that rewrites
its own schema on start is hard to reason about during a rollout, and harder
to reason about when two of them start at once.

## Non-goals

- **Episodic memory, embeddings, and the `vector` extension.** Spec #2.
- **`entities`, `faction_relations`, `quest_nodes`.** Deferred past step 10.
  `SessionState` is combat-only and there is no second encounter to carry
  world state between.
- **Retention and pruning.** The log grows without bound. `latestSnapshot`'s
  contract already anticipates a store that prunes (`pipeline.ts` handles a
  `resumeFrom` older than the newest snapshot), so adding it later needs no
  interface change.
- **Undo.** Events are append-only and corrections are new events; nothing
  here reverses one.
- **Multi-process coordination** beyond what the unique constraint provides.
  No leader election, no advisory locks.
- **Connection-pool tuning.** Driver defaults.

## Structure

`apps/server/src/core/event-store.ts` moves into `@ai-dm/memory`, splitting
along the seam between contract, rule, and implementation:

| File | Contents |
|---|---|
| `src/event-store/port.ts` | `EventStore`, `EventSnapshot`, `SequenceConflictError`, `SessionMismatchError` — the contract and its doc comments, moved verbatim |
| `src/event-store/validate.ts` | `findAppendConflict(sessionId, events, taken)` — pure; returns the error to throw, or `null` |
| `src/event-store/in-memory.ts` | `createInMemoryEventStore`, rewritten to call `findAppendConflict` |
| `src/event-store/postgres.ts` | `createPostgresEventStore(sql)` |
| `src/event-store/contract.ts` | `describeEventStoreContract(label, makeStore)` — a plain source file, so both test files can import it |

Ten files import `event-store` today — `main.ts`, `core/session.ts`,
`core/pipeline.ts`, `transport/http.ts`, the three tests beside them
(`session.test.ts`, `pipeline.test.ts`, `http.test.ts`), and `e2e.test.ts`,
`replay.test.ts`, `ws.test.ts`. Each changes a relative import to
`@ai-dm/memory`. The eleventh file, `core/event-store.test.ts`, moves rather
than re-imports: its contract assertions become the shared suite, and anything
server-specific stays behind.

## Schema

One migration, two tables.

```sql
create table game_events (
  session_id text        not null,
  sequence   integer     not null,
  event_id   uuid        not null,
  timestamp  text        not null,
  type       text        not null,
  payload    jsonb       not null,
  created_at timestamptz not null default now(),
  primary key (session_id, sequence)
);

create table session_snapshots (
  session_id text        primary key,
  sequence   integer     not null,
  state      jsonb       not null,
  updated_at timestamptz not null default now()
);
```

**`timestamp` is `text`, holding the ISO string verbatim.** `GameEvent`
declares it `z.string().datetime()`, and a round-trip through `timestamptz`
normalizes any non-`Z` offset — what comes back is no longer what went in.
Ordering is by `sequence` and never by time, so the column has no query duty
to justify that risk. `created_at` is the operational column for when a row
actually landed.

**`type` is `text`, not a Postgres enum.** The zod enum is the authority
(invariant 4); a database enum would mean a migration every time an event type
is added, and a second place for the list to be wrong.

**No unique constraint on `event_id`.** It is unique in practice and the
constraint would be free, but the in-memory store does not enforce it — so the
two implementations would diverge on an input the shared suite can construct.
A constraint one store has and the other does not is the exact drift that
moving the contract was meant to prevent. Deliberate omission.

**The primary key is the conflict semantics.** `(session_id, sequence)` means
a duplicate *within* one multi-row `INSERT` violates it too, so the
batch-internal case the in-memory `taken` set handles is caught by the same
guard inside the same transaction.

## Semantics

`append` is a single transaction: read the sequences the batch itself claims,
hand them to the shared validator, then throw or insert.

```ts
await sql.begin(async (tx) => {
  const taken = new Set(
    (await tx`select sequence from game_events
              where session_id = ${sessionId} and sequence in ${sql(sequences)}`)
      .map((row) => row.sequence),
  );
  const conflict = findAppendConflict(sessionId, events, taken);
  if (conflict !== null) throw conflict;
  await tx`insert into game_events ${sql(rows)}`;
});
```

The `in (...)` restriction keeps the read to the batch's own sequences rather
than scanning the session's log. Rollback is what delivers the interface's
"either rejection leaves the store exactly as it was". An empty batch returns
before a transaction is opened.

Two processes can both clear the pre-check and race to insert; the loser gets
`23505` on `game_events_pkey`, mapped to `SequenceConflictError` with the
sequence parsed from the error detail and falling back to the batch's lowest
sequence when the detail does not parse. The window is narrow by construction:
`createSessionRegistry`'s `inFlight` set already serializes commands per
session within a process, so the race needs a second process, and nothing in
the POC starts one. The constraint exists so the invariant holds regardless.

`readSince` selects `sequence > $2` ordered ascending and parses each row back
through `GameEvent`, so a row written under an older shape fails loudly
instead of flowing into `fold` as an untyped object. `latestSnapshot` parses
`state` through `SessionState` and therefore returns a fresh object every
call, matching the in-memory store's deliberate copy. `putSnapshot` is an
upsert whose `do update` carries
`where session_snapshots.sequence < excluded.sequence`, so a stale *or equal*
sequence is a no-op — the interface's wording exactly.

`createPostgresEventStore(sql)` takes an open `postgres.Sql` rather than a
connection string, so tests share one connection and `main.ts` owns the
lifecycle.

## Wiring

`config.ts` gains `DATABASE_URL` through the existing `optionalSecret`
transform, which collapses a blank `.env` line to `undefined`. It carries a
password and is never logged. `ServerConfig` gains `databaseUrl?: string`.

`main.ts` branches once. With a URL it opens the connection, probes `select 1`
so a bad URL fails at boot rather than on the first player's first turn —
the reasoning `config.ts` already applies to provider keys — builds the
Postgres store, and logs `event log: postgres`. Without one it builds the
in-memory store and warns that sessions are lost on restart. Shutdown closes
the connection.

## Testing

`describeEventStoreContract` is run unconditionally by `in-memory.test.ts` and
under `describe.skipIf(process.env.DATABASE_URL === undefined)` by
`postgres.test.ts`, which uses a fresh uuid session id per test so tests need
no truncation and stay parallel-safe.

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

The charter's round-trip — `fold(events)` equals `fold(snapshot, since)` —
runs Postgres-only over a synthetic stream built from `@ai-dm/schemas` alone:
a `session_snapshot` genesis plus a run of deltas. It cannot reuse
`replay.test.ts`'s `goblin-ambush` fixture, which lives in `apps/server` and
is out of reach under invariant 5. That encounter-level replay test stays
where it is, on the in-memory store, unchanged.

## CI

`.github/workflows/ci.yml` gains a `services: postgres` block on
`pgvector/pgvector:pg17` — the image `apps/server/docker-compose.yml` already
pins — with a health check, the same `aidm`/`aidm`/`aidm` credentials, and
`DATABASE_URL` in the environment. `pnpm --filter @ai-dm/memory db:migrate`
runs before `pnpm test`.

One thing to verify while doing it: `config.test.ts` passes explicit env
objects to `loadConfig`, so a real `DATABASE_URL` in the runner's environment
must not leak into its expectations.

## Documentation

- `.env.example` gains a blank `DATABASE_URL=`.
- `packages/memory/CLAUDE.md`'s table list is narrowed to what exists after
  this spec, with the rest marked as belonging to spec #2 or deferred.
- `apps/server/CLAUDE.md` records how the store is selected.
- `PROJECT_PLAN.md` gains §4.6: the two-spec decomposition, the deferred quest
  DAG and why, and the step 10 row's status.

## Limitations this spec knowingly ships

- **A misconfigured deploy loses history silently.** `DATABASE_URL` absent is
  a valid configuration that boots and plays; only the log line distinguishes
  it.
- **The log grows without bound.** No retention, no pruning, no archival.
- **Concurrency is guarded by a constraint, not a design.** Two server
  processes against one database will produce `SequenceConflictError`s under
  contention rather than coordinating.
- **A schema change to `GameEvent` invalidates stored rows.** Reads parse and
  therefore fail loudly, which is the intent, but no migration path for
  existing logs is defined.
- **The round-trip test uses synthetic events**, not a real encounter stream;
  the encounter-level replay test still runs only against the in-memory store.
