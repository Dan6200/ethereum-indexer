# Referential Integrity: Foreign Keys on Ingestion Tables

## Purpose

Analysis behind ADR-005 on whether to add foreign keys to `blocks`, `transactions`, and `logs` to enforce lineage at the database level. Today the relationships are enforced only by application convention (sequential ingestion + `reconcileFork`'s walk-back).

Two distinct guarantees are at stake, enforced by two different FK classes:

1. **Block→block lineage** — every block's parent exists. Enforced by a _self-referential FK_ on `blocks`.
2. **Data→block lineage** — every transaction/log has a parent block. Enforced by _child FKs_ on `transactions`/`logs` referencing `blocks`.

## Current state

- `blocks.parent_hash` is a plain `VARCHAR(66)` — no FK, no unique constraint.
- `transactions.block_number` / `logs.block_number` are plain `NUMERIC` — no FK.
- Lineage is maintained by the daemon's ordering and walk-back, not by any database constraint.

## Points against the self-referential FK (block→block)

1. **The table is a suffix, not the full chain.** The daemon seeds at the current head, so the first row's parent (head − 1) is never stored. A `NOT NULL` self-FK rejects the very first block. Enforcing it requires making `parent_hash` nullable and storing `NULL` for the root — a schema + ingest change, and the root is then invisible to the FK check (NULLs skip it), so the "start of lineage" is unverified.
2. **Existing data is sparse.** `blocks` has historical gaps (pre-feature ingestion + interleaved code versions). A VALID FK cannot be added over that data; it must be `NOT VALID` (checks new rows only), giving zero enforcement over the pre-existing rows.
3. **`DEFERRABLE` requirement.** `rollbackState` does `DELETE FROM blocks WHERE block_number > N` in one statement. Under an immediate self-FK, PostgreSQL can delete a parent before the child that references it and spuriously fail. The FK must be `DEFERRABLE INITIALLY DEFERRED`.
4. **Unique index or extra column.** `parent_hash → block_hash` requires a `UNIQUE` index on `block_hash` (currently none). The alternative — a `parent_block_number` column referencing the PK — adds a column for a relationship (N → N−1) already implied by the contiguous primary key.
5. **Conflicts with retention.** The self-FK means old `blocks` rows cannot be pruned without breaking the chain (RESTRICT blocks the delete; CASCADE would cascade-delete the whole retained window). This forces `blocks` to be kept in full.
6. **Forward-looking only.** With `NOT VALID`, the FK prevents _new_ orphans but does nothing about existing gaps — exactly where `reconcileFork` currently fails. Gap-tolerance is still required regardless.
7. **Narrow value.** It only bites in the concurrent-writer race (inserting block N+2 while another writer rolled back N+1), which the advisory lock (ADR-004) already eliminates. It is a split-brain backstop, not a primary guarantee.
8. **Does not touch the checkpoint or the data tables.** It constrains `blocks` against `blocks` only.

## Points against the child FKs (data→block)

1. **Forced B-tree indexes (the dominant cost).** A FK's DELETE path is the referential-action check: deleting a `blocks` row requires finding any referencing `transactions`/`logs` rows. Those tables have only a BRIN index on `block_number` (unusable for FK exact-match) and a PK `(tx_hash, block_number)` with the wrong leading column. Enforcing the child FKs therefore requires a B-tree index on `block_number` for **every partition** of `transactions` and `logs` — two indexes on the highest-volume tables, a real storage + write-amplification cost.
2. **Per-row insert overhead.** Every transaction/log insert fires a per-row FK trigger that probes `blocks`. At ~400–650 rows/block and millions of rows, that is millions of trigger invocations and index probes on the hot path, even though each probe is cheap.
3. **Rollback coupling.** `rollbackState` deletes `blocks`, firing the referential check against the child tables. The check runs even though children are deleted first (PostgreSQL cannot know in advance), so the B-tree indexes are mandatory for rollback performance — not optional.
4. **Partitioned-table overhead.** The child tables are range-partitioned; the FK propagates to each partition and each partition pays the per-partition FK machinery.
5. **Enforces a stronger invariant than the ingestion model guarantees.** The indexer is an eventually-consistent mirror; during a reorg there is no instant at which "every tx has a block" holds across writers. The FK would turn benign in-flight states into hard constraint errors the daemon must already handle.
6. **Does not fix the checkpoint.** Even with perfect data→block lineage, `checkpoints.block_number` can disagree with `max(blocks.block_number)`.

## Using both together

A self-FK plus child FKs would enforce full lineage end-to-end. The cost is the sum: nullable root + `NOT VALID` + `DEFERRABLE` + unique index + two B-tree indexes on the big tables + per-row triggers + the retention coupling. That is a material increase in schema complexity and write amplification for guarantees that only matter in the narrow concurrent-writer case the advisory lock already handles.

## What we do instead

1. **Advisory lock (ADR-004)** — elect a single writer; eliminates the race that produces orphans.
2. **Gap-tolerant `reconcileFork`** — walk back to the last known-good ancestor rather than failing on a gap (handles pre-existing sparse data).
3. **Retention by partition drop** — prune `transactions`/`logs` partitions; keep `blocks` (small) for ancestry.
4. **Optional offline integrity check** — a periodic `NOT EXISTS` query to detect any orphan a hot-path FK would have prevented, without the write cost.
