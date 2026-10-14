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

See ADR-005: the self-referential FK on blocks is rejected for complexity (deferred checking + unique index/parent column), and child FKs (transactions/logs → blocks) carry a hidden cost — they force B-tree indexes on block_number across every partition.

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

## Approach 4 — Optimistic concurrency via Serializable Snapshot Isolation (future consideration)

PostgreSQL's `SERIALIZABLE` isolation level is Serializable Snapshot Isolation (SSI): Snapshot Isolation plus detection of write-skew-class anomalies. It does not block or deadlock. Instead it records read-write dependencies (via `SIREAD` locks) and, at commit, aborts a transaction when those dependencies form a cycle that no serial order can explain — raising SQLSTATE `40001` (`could not serialize access due to concurrent update`), which the application must retry.

Relevance to the indexer: the ingest-vs-rollback race is exactly such an anomaly. An ingest transaction reads `head = N` and writes block `N+2`; a rollback reads `head = N` and deletes everything `> N`. The combined state (block `N+2` present while `checkpoint = N`) cannot be produced by any serial order, so SSI would abort one transaction and force a retry — giving correctness under concurrent writers with no single-writer lock.

Why this is a future option rather than the current choice:

1. **SSI only protects what happens inside the serializable transaction.** The daemon's read-compute-write cycle currently reads the head _outside_ the ingest/rollback transaction, so the dependency is invisible to the detector. It would require moving the guard read (`SELECT … FROM checkpoints WHERE id = 'chain_head'`) into `BEGIN ISOLATION LEVEL SERIALIZABLE`.
2. **It requires retry logic** around every ingest and rollback to handle `40001`.
3. **It churns under same-head contention.** Two writers racing the same cursor take `SIREAD` locks on the checkpoint and write it, so one aborts even though the writes are idempotent — repeated abort/retry. SSI pays off for _disjoint_ work (parallel backfills over disjoint ranges, per-chain writers on separate cursors), not for racing a single head.
4. **Idempotency is still required**, since aborts cause the transaction to re-run.

Decision (unchanged): retain the session-scoped advisory lock (ADR-004) as the concurrency layer. Revisit SERIALIZABLE when work is sharded across disjoint cursors (e.g. parallel backfills or multi-chain writers), where optimistic concurrency outperforms a global lock.

## Decision

Use a session-scoped `pg_try_advisory_lock` on a dedicated connection at startup, combined with the existing idempotent transactions. The residual "hung-but-alive leader" drawback is mitigated by per-block progress logging.
