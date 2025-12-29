import { Command } from "commander";
import { rollbackState, getHeadBlock } from "@app/db-core";

export const rollbackCommand = new Command("rollback")
  .description(
    "Manually rollback the indexer database to a specific block number",
  )
  .argument(
    "<blockNumber>",
    "The block number to roll back to (data *after* this block will be deleted)",
  )
  .action(async (blockNumberStr) => {
    const blockNumber = parseInt(blockNumberStr, 10);

    if (isNaN(blockNumber) || blockNumber < 0) {
      console.error("Error: Block number must be a non-negative integer.");
      process.exit(1);
    }

    try {
      const head = await getHeadBlock();
      if (!head) {
        console.log(
          "Database is empty or has no checkpoint. Nothing to rollback.",
        );
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

      await rollbackState(blockNumber);

      console.log("Rollback successful.");
      process.exit(0);
    } catch (error) {
      console.error("Rollback failed:", error);
      process.exit(1);
    }
  });
