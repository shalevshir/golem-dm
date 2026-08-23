# ADR-0004: Campaign vs. session identity

Status: ACCEPTED (2026-08-23) — step 0 of `PROJECT_PLAN.md` §4.7.
Amended at acceptance: decisions 2 and 4 below, per the step-1 spec.

Options considered: rename the stream to the campaign (A); keep `sessionId` as
the stream key and widen its meaning (B); one campaign log plus a separate log
per encounter (C).

## Decision

**A. The campaign is the log. An encounter is a bracketed span inside it.**

1. `campaignId` replaces `sessionId` as the event stream's key, in the wire
   protocol, the schemas, and the `game_events` / `session_snapshots` columns.
   One sequence space, one append-only stream, one fold.
2. The projection splits. Today's `SessionState` becomes
   `CampaignState = { world: WorldState, encounter: EncounterState | null }`.
   `EncounterState` holds what `SessionState` holds now — grid, combatants,
   turn order, current actor, round — and is non-null only between
   `encounter_started` and `encounter_resolved`. At most one encounter is
   active at a time, which is what makes it a nullable field rather than a map.
   **Mode is derived, not stored.** A draft of this ADR carried a `mode` field;
   at this point it would be exactly `encounter === null`, and §4.7 argues
   against storing what can be derived. The three-valued
   `exploration | social | encounter` enum earns its place in §4.7's step 4,
   when those cases actually diverge.
3. `appliedClientMessageIds` moves to the campaign level, not the encounter's.
   Idempotency has to cover free text and narrative moves, not just turns.
4. Seeds derive from the campaign root seed and a log sequence, never from
   fresh randomness. The root seed is declared at genesis; a turn's seed stays
   `seedFor(rootSeed, sequence)` exactly as today, now over the campaign's
   sequence space, which is still globally unique per turn; encounter-scoped
   randomness uses the same port at the `encounter_started` sequence. An
   earlier draft chained turn seeds off a per-encounter seed and claimed that
   was current behaviour — it is not (`pipeline.ts:548`), and the extra link
   would buy nothing.
5. Genesis stops naming an encounter. Its payload declares the campaign's root
   seed and opening quest node; `encounterId` moves onto `EncounterState`.

Combat event types and payloads are unchanged. They simply live in the
campaign's sequence space.

## Rationale

B is cheaper — no column rename, no protocol change — and it is the reason to
decide this now rather than drift into it. But it makes "session" mean
"campaign" permanently, in a codebase whose stated discipline is that a shape
is defined once and named honestly. The rename is affordable exactly once:
there is no deployment (no Dockerfile, no hosting config), the branch has never
run in CI, and the closed beta was deferred behind this work precisely so the
load-bearing refactors could happen before real data exists (§4.7). After a
beta it costs a migration or a discarded dataset.

C was rejected outright. Two streams reopen every ordering question the single
log closes: which stream is authoritative when they disagree, how a fold spans
both, what `resumeFrom` means to a client. Invariant 3 — state is a projection
of one append-only stream — is worth more than the separation buys.

The split in (2) is what lets the same `reduce` serve both modes without the
combat cases having to guard on "is there a fight happening": they move under
`encounter`, and a combat event arriving with `encounter === null` is a bug the
exhaustiveness check and a parse failure will both catch.

## Consequences

- **`reduce` gains a mode dispatch** and the existing combat cases move under
  `EncounterState`. `reduce.ts`'s exhaustiveness check (no `default` branch)
  keeps forcing every new event type to be handled explicitly.
- **The drizzle baseline migration is regenerated, not altered.** The
  `(session_id, sequence)` primary key becomes `(campaign_id, sequence)`.
  Nothing anywhere holds data that matters — anyone with a local docker volume
  drops it.
- **The web client follows.** `App.tsx`'s `SESSION_STORAGE_KEY` and session id,
  and `apps/web/src/state/persistence.ts` (landed in `0b8e10f`), all key on
  `sessionId` and will need renaming with everything else.
- **A long campaign's fold gets expensive.** `SNAPSHOT_EVERY = 50` already
  solves this for sessions and generalizes unchanged; `session_snapshots`
  becomes `campaign_snapshots` and stores `CampaignState`.
- **Restart mid-encounter behaves as it does today** — fold snapshot plus tail.
  The bracket means `EncounterState` is reconstructed rather than persisted
  separately.
- **ADR-0002 is untouched.** A campaign is still one human-controlled
  character; nothing here moves toward party play.
- Step 10's spec #2 depends on this: episodic memory has no corpus until a
  campaign spans more than one encounter (§4.7).
