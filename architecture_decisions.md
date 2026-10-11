# Architecture Decision Log

## ADR-001: Bulk Ingestion Strategy (COPY vs. INSERT)

**Date:** 2025-12-09
**Status:** Accepted

### Context

We need to ingest large volumes of blockchain data (millions of rows) efficiently during historical backfills (IMU) and handle frequent small batches during real-time indexing.
Crucially, the system must remain **idempotent** to handle crashes and chain re-orgs safely. If a batch fails or is retried, we cannot create duplicate records.

### The Problem

- **Standard `INSERT`**: Safe (supports `ON CONFLICT DO NOTHING`) but slow due to SQL parsing overhead per row.
- **`COPY`**: Extremely fast (streams raw binary/text) but unsafe. It lacks `ON CONFLICT` support; a single duplicate key causes the entire batch to fail.

### The Solution: Temp Table Staging

We will use a hybrid approach to achieve both speed and safety:

1.  **Stage:** Create an unlogged `TEMPORARY TABLE` (exists only for the DB transaction).
2.  **Stream:** Use `COPY` to blast raw data into this temp table. (Fastest possible ingest).
3.  **Merge:** Execute `INSERT INTO target SELECT * FROM temp ... ON CONFLICT DO NOTHING`.
4.  **Commit:** `COMMIT` the transaction.

### Implementation Details

- **Location:** `@app/db-core`
- **Function:** `bulkInsert(data)`
- **Mechanism:** usage of `pg-copy-streams` to pipe formatted CSV/TSV data into the temp table.

### Consequences

- **Pros:** Max throughput, full data integrity, handles re-entries/re-orgs gracefully.
- **Cons:** Slightly higher complexity than a simple loop; requires `pg-copy-streams` dependency.

## ADR-002: Polling vs. WebSockets for Head Tracking

**Date:** 2025-12-09
**Status:** Accepted

### Context

The Real-Time Indexer Daemon needs to detect new blocks and chain re-orgs as fast as possible.
We have two options:

1.  **WebSockets (`eth_subscribe`):** Push-based, low latency.
2.  **Polling (`eth_blockNumber`):** Pull-based, higher latency.

### The Problem

- **WebSockets**: While fast, they are notoriously unstable. Connections drop silently, and "missed events" can cause the indexer to stall or miss a re-org.
- **Polling**: Adds latency (e.g., 2 seconds) but is strictly consistent. If a request fails, we just retry. It guarantees we eventually see the "longest chain."

### The Solution: Polling First

We choose **Polling** as the primary mechanism for the Daemon.

1.  **Reliability:** It is the only way to guarantee sequential block processing and robust "catch-up" after downtime.
2.  **Re-org Logic:** Polling simplifies the state machine (`Target = Head + 1`).
3.  **Simplicity:** No need for complex heartbeat/reconnection logic required by WS.

_Note: In the future, we can add WebSockets merely as a trigger to "Poll Now," reducing latency without sacrificing the reliability of the polling loop._

## ADR-003: Reorg Handling — Liveness-First with a Fast Path

**Date:** 2026-10-10
**Status:** Accepted

### Context

The daemon ingests blocks by polling the chain head and must remain correct when the chain reorgs. The current implementation compares the next block's `parentHash` to the stored head and rolls back one block at a time. This is only correct for exactly 1-block reorgs; deeper reorgs leave stale rows between the fork point and the head (the lineage check trusts the checkpoint hash, not the stored data). Separately, a line like `targetBlockNum = dbHead ? dbHead.number + 1n : onChainBlockNumber` treats the database as if it were authoritative over block content.

### Decision

1. **The chain is the source of truth; the database is a derived mirror.** The daemon reads the chain head and the DB head as two independent observations and reconciles them only after verifying agreement. The DB head is a _cursor_ ("how far we have mirrored"), never a source of block content. The next block to ingest is the canonical chain's block at height `dbHead.number + 1`, accepted only after its `parentHash` matches our mirrored head — the chain always has the final say on content and lineage.

2. **Store block ancestry in a `blocks` table** (`block_number`, `block_hash`, `parent_hash`) for every processed block, including empty blocks. This is the foundation that makes arbitrary-depth reorg detection possible.

3. **Fork-point detection by walk-back.** On a `parentHash` mismatch, walk back from the head comparing our stored `blocks` hashes against the canonical chain until the hashes agree; the first agreeing block is the common ancestor.

4. **Single-shot rollback.** Roll back to the common ancestor in one transaction — delete all rows after it from `transactions`, `logs`, and `blocks`, and restore the checkpoint to the ancestor.

5. **Fast path first (liveness bias).** ~99% of reorgs are 1-block, so keep the cheap parent-hash check plus a single-block rollback as the primary path. Only escalate to the walk-back when the fast path proves insufficient. This minimizes extra RPC round-trips and keeps ingestion moving (liveness over exhaustive re-verification).

### Consequences

- **Pros:** Correct for reorgs of any depth; near-zero overhead in the common case, preserving liveness.
- **Cons:** An additional `blocks` table (one write per block) and a more complex reconciliation state machine.

## ADR-004: Concurrency Model — Single Writer via Advisory Lock + Idempotent Writes

**Date:** 2026-10-11
**Status:** Accepted

### Context

Multiple daemons can run concurrently (accidental double-start, or HA failover). Atomic transactions + idempotency alone are insufficient: they prevent duplicates and serialize identical rollbacks, but do not prevent an ingest-vs-rollback interleaving from leaving the checkpoint inconsistent with stored data. See `concurrency_model.md`.

### Decision

Elect a single active writer with a session-scoped PostgreSQL advisory lock (`pg_try_advisory_lock`) on a dedicated connection, while keeping the existing idempotent, transactional writes as a correctness backstop.

### Consequences

- **Pros:** single-writer semantics eliminate interleaving races; no duplicate work; cheap HA failover (the lock auto-releases on disconnect).
- **Cons:** the lock guarantees exclusivity but not liveness (a hung leader holds it); there is failover latency; advisory locks are cooperative (unenforced).
