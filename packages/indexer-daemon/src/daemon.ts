import { BlockchainClient, BlockIngestData } from "@app/blockchain";
import { IndexerDb } from "@app/db-core";

const POLLING_INTERVAL_MS = 2000;

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function ingest(db: IndexerDb, block: BlockIngestData): Promise<void> {
  console.log(`Processing block ${block.blockNumber}...`);
  const record = {
    blockNumber: block.blockNumber,
    blockHash: block.blockHash,
    parentHash: block.parentHash,
  };
  if (block.transactions.length > 0 || block.logs.length > 0) {
    await db.insertRows({ transactions: block.transactions, logs: block.logs, blocks: [record] });
    console.log(
      `[SUCCESS] Indexed block ${block.blockNumber} (${block.transactions.length} txs, ${block.logs.length} logs)`,
    );
  } else {
    await db.saveBlock(record);
    console.log(`[SUCCESS] Indexed block ${block.blockNumber} (0 txs) - Checkpoint Advanced`);
  }
}

export async function reconcileFork(chain: BlockchainClient, db: IndexerDb, headNumber: bigint): Promise<void> {
  // Fast path (liveness): assume a 1-block reorg. If our previous block is still
  // canonical, roll back exactly one block and resume.
  if (headNumber === 0n) {
    throw new Error("Reorg at genesis — cannot roll back below block 0");
  }
  const prevNum = headNumber - 1n;
  const prevStored = await db.getBlock(prevNum);
  const prevCanonical = await chain.fetchBlockHeader(prevNum);
  if (prevStored && prevCanonical.hash === prevStored.hash) {
    await db.rollbackState(prevNum, prevStored.hash);
    return;
  }

  // Slow path (walk-back): find the common ancestor by comparing our stored
  // hashes to the canonical chain, then roll back to it in one shot.
  for (let k = headNumber; k >= 0n; k -= 1n) {
    const stored = await db.getBlock(k);
    if (!stored) {
      throw new Error(`Missing block ancestry at ${k} — cannot safely roll back`);
    }
    const canonical = await chain.fetchBlockHeader(k);
    if (canonical.hash === stored.hash) {
      await db.rollbackState(k, stored.hash);
      return;
    }
  }
  throw new Error("No common ancestor found on the canonical chain");
}

export async function main(chain: BlockchainClient, db: IndexerDb): Promise<void> {
  console.log("Indexer Daemon starting...");

  // Ensure we have a valid client
  const chainId = await chain.getClient().getChainId();
  console.log(`Connected to Chain ID: ${chainId}`);

  while (true) {
    try {
      // Independent observations: external truth vs our mirrored cursor.
      const chainHead = await chain.getBlockNumber();
      const dbHead = await db.getHeadBlock();

      if (dbHead === null) {
        // Empty mirror: seed from the chain (the one place the chain directly seeds the DB).
        await ingest(db, await chain.fetchBlockData(chainHead));
        await sleep(POLLING_INTERVAL_MS);
        continue;
      }

      // The next block to mirror is the canonical chain's block at dbHead.number + 1.
      const nextHeight = dbHead.number + 1n;
      if (nextHeight > chainHead) {
        await sleep(POLLING_INTERVAL_MS);
        continue;
      }

      // Only mirror it after the chain confirms lineage (its parent == our mirrored head).
      const nextHeader = await chain.fetchBlockHeader(nextHeight);
      if (nextHeader.parentHash !== dbHead.hash) {
        await reconcileFork(chain, db, dbHead.number);
        continue;
      }

      await ingest(db, await chain.fetchBlockData(nextHeight));
    } catch (error) {
      console.error("[ERROR] Error in indexing loop:", error);
      await sleep(5000);
    }
  }
}
