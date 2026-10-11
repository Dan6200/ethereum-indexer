import "./load-env";
import { getClient, fetchBlockHeader, fetchBlockData, BlockIngestData } from "@app/blockchain";
import { getHeadBlock, getBlock, rollbackState, insertRows, saveBlock } from "@app/db-core";

const POLLING_INTERVAL_MS = 2000;

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ingest(block: BlockIngestData): Promise<void> {
  const record = {
    blockNumber: block.blockNumber,
    blockHash: block.blockHash,
    parentHash: block.parentHash,
  };
  if (block.transactions.length > 0 || block.logs.length > 0) {
    await insertRows({ transactions: block.transactions, logs: block.logs, blocks: [record] });
  } else {
    await saveBlock(record);
  }
}

async function reconcileFork(headNumber: bigint): Promise<void> {
  // Fast path (liveness): assume a 1-block reorg. If our previous block is still
  // canonical, roll back exactly one block and resume.
  if (headNumber === 0n) {
    throw new Error("Reorg at genesis — cannot roll back below block 0");
  }
  const prevNum = headNumber - 1n;
  const prevStored = await getBlock(prevNum);
  const prevCanonical = await fetchBlockHeader(prevNum);
  if (prevStored && prevCanonical.hash === prevStored.hash) {
    await rollbackState(prevNum, prevStored.hash);
    return;
  }

  // Slow path (walk-back): find the common ancestor by comparing our stored
  // hashes to the canonical chain, then roll back to it in one shot.
  for (let k = headNumber; k >= 0n; k -= 1n) {
    const stored = await getBlock(k);
    if (!stored) {
      throw new Error(`Missing block ancestry at ${k} — cannot safely roll back`);
    }
    const canonical = await fetchBlockHeader(k);
    if (canonical.hash === stored.hash) {
      await rollbackState(k, stored.hash);
      return;
    }
  }
  throw new Error("No common ancestor found on the canonical chain");
}

async function main() {
  console.log("Indexer Daemon starting...");

  // Ensure we have a valid client
  const client = getClient();
  const chainId = await client.getChainId();
  console.log(`Connected to Chain ID: ${chainId}`);

  while (true) {
    try {
      // Independent observations: external truth vs our mirrored cursor.
      const chainHead = await client.getBlockNumber();
      const dbHead = await getHeadBlock();

      if (dbHead === null) {
        // Empty mirror: seed from the chain (the one place the chain directly seeds the DB).
        await ingest(await fetchBlockData(chainHead));
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
      const nextHeader = await fetchBlockHeader(nextHeight);
      if (nextHeader.parentHash !== dbHead.hash) {
        await reconcileFork(dbHead.number);
        continue;
      }

      await ingest(await fetchBlockData(nextHeight));
    } catch (error) {
      console.error("[ERROR] Error in indexing loop:", error);
      await sleep(5000);
    }
  }
}

main().catch(console.error);
