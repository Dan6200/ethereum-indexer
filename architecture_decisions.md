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
