# Reorg Handling Design

## Principle: chain is source of truth

The indexer is a mirror. The chain decides what blocks exist and what they contain; the database records a _verified prefix_ of it. Each cycle reads two independent observations and never fuses them into one value:

- `chainHead` (from the RPC) — external truth.
- `dbHead` (from `checkpoints`/`blocks`) — our mirrored cursor.

The target block is the canonical chain's block at height `dbHead.number + 1`, and it is ingested only after its `parentHash` matches our mirrored head. The DB's cursor only marks progress; it never drives content or lineage.

## The `blocks` table

Records every processed block so the indexer can walk its own mirrored chain:

```sql
CREATE TABLE IF NOT EXISTS blocks (
    block_number NUMERIC NOT NULL PRIMARY KEY,
    block_hash   VARCHAR(66) NOT NULL,
    parent_hash  VARCHAR(66) NOT NULL,
    created_at   TIMESTAMP DEFAULT NOW()
);
```

One row per block, written even for empty blocks (which today only advance the checkpoint). `checkpoints` remains as a fast O(1) "current head" cursor; it is a materialized view over the head of `blocks`.

## Fork-point detection

When the next canonical block's `parentHash` does not match our mirrored head, a reorg has occurred.

- **Fast path (liveness):** assume a 1-block reorg. Roll back the head by one block, re-fetch the canonical block at that height, and verify its `parentHash` now matches the new head. If it does, resume ingesting. One extra RPC call; covers the overwhelming majority of cases.
- **Slow path (walk-back):** if the fast path still mismatches, walk back: for `k = dbHead.number, dbHead.number - 1, …`, fetch canonical block `k` and compare its hash to `blocks.block_hash[k]`. The first `k` where they agree is the common ancestor.

## Rollback (single-shot)

Given the common ancestor `A`, in one transaction:

1. `DELETE` from `transactions`, `logs`, and `blocks` where `block_number > A`.
2. Restore `checkpoints` to `(A, blocks[A].hash)`.
3. Resume ingesting from `A + 1` on the canonical branch.
