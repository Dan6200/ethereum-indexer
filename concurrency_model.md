# Concurrency & Leadership Model

## The invariant

The daemon's correctness is a cross-operation invariant, not a single transaction:

> `checkpoints.block_number == max(blocks.block_number)`, and `blocks` form a contiguous lineage on one canonical branch.

This spans a full read → compute → verify → write-data → write-checkpoint cycle; individual transactions cover only the write steps.

## Approach 1 — Multiple daemons + atomic transactions only

Every write is transactional and idempotent:

- `transactions`: `ON CONFLICT (tx_hash, block_number) DO NOTHING`
- `logs`: `ON CONFLICT (block_number, log_index) DO NOTHING`
- `blocks`: `ON CONFLICT (block_number) DO NOTHING`
- `checkpoints`: `ON CONFLICT (id) DO UPDATE` (upsert)
- partitions: `CREATE TABLE IF NOT EXISTS`

**Benefits**

- Crash/retry safety: replaying a write converges to the same rows.
- Duplicate-operation safety: identical ingests or identical rollbacks serialize and converge.
- No leader election, no single point of failure, no failover latency — every daemon can make progress.

**Drawbacks**

- Does NOT protect against different writers with different views interleaving.
- Ingest-vs-rollback race: daemon A inserts `Xₙ₊₂` (a new row) while daemon B rolls back to `n` (`DELETE … > n`). A's insert commits after B's delete, leaving orphan `Xₙ₊₂` data above checkpoint `n` and a gap at `n+1`.
- Rollback-to-different-targets: last-writer-wins on the checkpoint can leave it inconsistent with the data.
- Duplicate work: each block fetched/inserted N times.
- Steady-state ingestion is safe (idempotent + monotonic); it is reorgs that break it.

See ADR-005 for the considered-and-rejected alternative of enforcing this with foreign keys (rejected for hot-path performance cost).

## Approach 2 — Singleton lock

A session-scoped PostgreSQL advisory lock (`pg_try_advisory_lock`) on a dedicated connection elects one active writer.

**Benefits**

- Single-writer ⇒ the read-compute-write cycle is safe by construction.
- No duplicate RPC/insert work.
- Cheap HA failover: the lock auto-releases on disconnect, so a standby can take over.

**Drawbacks**

1. Locks guarantee exclusivity, not liveness — a hung-but-alive leader holds the lock, blocking failover.
2. Failover latency — a gap between leader death and standby acquisition.
3. Split-brain risk if using a time-based lease (clock skew, GC pause, partition). Session locks avoid this but couple to the DB connection's lifetime.
4. Advisory locks are cooperative (unenforced) — any writer that ignores the convention can still write.
5. Couples availability to Postgres (the lock arbiter).
6. Operational/test friction (stale locks, running two daemons intentionally).
7. Pool/connection complexity — an advisory lock needs a dedicated, long-lived connection, not the shared `pg.Pool`.

## Approach 3 — Both (recommended)

- **Idempotent, transactional writes** are the correctness foundation — always present, because crashes and retries happen even with a single writer.
- **A leadership lock** is the efficiency + race-elimination layer — it ensures at most one active writer.
- The lock is not a correctness requirement; it is a coordination requirement. Idempotency is the backstop that keeps the system correct if coordination fails (split-brain) or a retry occurs.

## Alternative — optimistic concurrency (compare-and-swap on checkpoint)

`UPDATE … WHERE block_number = <expected>`, retry on mismatch. Correct without a lock, but subtle (the data writes are not naturally tied to the winning CAS branch), still does duplicate work, and is more code. Not worth it for a single-writer indexer.

## Decision

Use a session-scoped `pg_try_advisory_lock` on a dedicated connection at startup, combined with the existing idempotent transactions. The residual "hung-but-alive leader" drawback is mitigated by per-block progress logging.
