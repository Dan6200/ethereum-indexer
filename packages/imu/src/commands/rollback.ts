import { Command } from "commander";
import { IndexerDb } from "@app/db-core";
import { BlockchainClient } from "@app/blockchain";

const chain = BlockchainClient.fromEnv();
const db = IndexerDb.fromEnv();

function parseBlockNumber(s: string): bigint | null {
  if (!/^\d+$/.test(s.trim())) return null;
  try {
    return BigInt(s.trim());
  } catch {
    return null;
  }
}

export const rollbackCommand = new Command("rollback")
  .description("Manually rollback the indexer database to a specific block number")
  .argument("<blockNumber>", "The block number to roll back to (data *after* this block will be deleted)")
  .action(async (blockNumberStr) => {
    const blockNumber = parseBlockNumber(blockNumberStr);

    if (blockNumber === null || blockNumber < 0n) {
      console.error("Error: Block number must be a non-negative integer.");
      process.exit(1);
    }

    try {
      const head = await db.getHeadBlock();
      if (!head) {
        console.log("Database is empty or has no checkpoint. Nothing to rollback.");
        return;
      }

      if (blockNumber > head.number) {
        console.error(
          `Error: Target block ${blockNumber} is higher than current head ${head.number}. Cannot roll forward.`,
        );
        process.exit(1);
      }

      console.log(`Current Head: ${head.number} (${head.hash})`);
      console.log(`Target Rollback: ${blockNumber}`);
      console.log("Initiating atomic rollback...");

      const header = await chain.fetchBlockHeader(blockNumber);
      if (!header || !header.hash) {
        console.error(`Error: Could not fetch header for block ${blockNumber}.`);
        process.exit(1);
      }
      await db.rollbackState(blockNumber, header.hash);

      console.log("Rollback successful.");
      process.exit(0);
    } catch (error) {
      console.error("Rollback failed:", error);
      process.exit(1);
    }
  });
