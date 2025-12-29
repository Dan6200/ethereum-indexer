import { getClient, fetchBlockHeader, fetchBlockData } from "@app/blockchain";
import {
  getHeadBlock,
  rollbackState,
  insertBatch,
  saveCheckpoint,
  getPool,
} from "@app/db-core";

const POLLING_INTERVAL_MS = 2000;

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  console.log("Indexer Daemon starting...");

  // Ensure we have a valid client
  const client = getClient();
  const chainId = await client.getChainId();
  console.log(`Connected to Chain ID: ${chainId}`);

  while (true) {
    try {
      // 1. Get Current State
      const dbHead = await getHeadBlock();
      const onChainBlockNumber = await client.getBlockNumber();
      const targetBlockNum = dbHead
        ? dbHead.number + 1
        : Number(onChainBlockNumber);

      // If DB is empty, start at current chain head (simplified)
      if (!dbHead) {
        console.log(
          `[INFO] Database is empty. Initializing at chain head: ${onChainBlockNumber}`,
        );
        const txs = await fetchBlockData(Number(onChainBlockNumber));

        if (txs.length > 0) {
          await insertBatch(txs);
        } else {
          // We need to fetch the block header to get the hash for the checkpoint
          const header = await fetchBlockHeader(Number(onChainBlockNumber));
          if (header && header.hash) {
            await saveCheckpoint(
              getPool(),
              Number(onChainBlockNumber),
              header.hash,
            );
          }
        }

        await sleep(POLLING_INTERVAL_MS);
        continue;
      }

      // 2. Check if we are behind
      if (targetBlockNum > Number(onChainBlockNumber)) {
        // Synced. Wait.
        await sleep(POLLING_INTERVAL_MS);
        continue;
      }

      // 3. Fetch Target Block Header for Re-org Check
      const targetBlockHeader = await fetchBlockHeader(targetBlockNum);

      // 4. Re-org Detection
      if (targetBlockHeader.parentHash !== dbHead.hash) {
        console.warn(`[WARN] RE-ORG DETECTED!`);
        console.warn(
          `Target Block ${targetBlockNum} parent (${targetBlockHeader.parentHash}) !== DB Head (${dbHead.hash})`,
        );
        console.warn(`Initiating rollback of block ${dbHead.number}...`);

        // Rollback the current head. Next loop will retry the previous block (or further back).
        await rollbackState(dbHead.number);
        continue;
      }

      // 5. Lineage Verified - Process the Block
      console.log(`Processing block ${targetBlockNum}...`);
      const txs = await fetchBlockData(targetBlockNum);

      if (txs.length > 0) {
        await insertBatch(txs);
        console.log(
          `[SUCCESS] Indexed block ${targetBlockNum} (${txs.length} txs)`,
        );
      } else {
        // Handle Empty Block: Must explicitly advance checkpoint
        if (targetBlockHeader && targetBlockHeader.hash) {
          await saveCheckpoint(
            getPool(),
            targetBlockNum,
            targetBlockHeader.hash,
          );
          console.log(
            `[SUCCESS] Indexed block ${targetBlockNum} (0 txs) - Checkpoint Advanced`,
          );
        }
      }
    } catch (error) {
      console.error("[ERROR] Error in indexing loop:", error);
      await sleep(5000); // Backoff on error
    }
  }
}

main().catch(console.error);
