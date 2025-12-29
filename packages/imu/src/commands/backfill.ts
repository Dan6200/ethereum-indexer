import { Command } from "commander";
import { bulkInsert } from "@app/db-core";
import { fetchBlockData } from "@app/blockchain";
import { ValidatedTransaction } from "@app/schemas";

export const backfillCommand = new Command("backfill")
  .description("Backfill historical data for a specific block range")
  .requiredOption("-s, --start <number>", "Start block number")
  .requiredOption("-e, --end <number>", "End block number")
  .option(
    "-b, --batch-size <number>",
    "Number of blocks to commit in one transaction",
    "10",
  )
  .action(async (options) => {
    const start = parseInt(options.start, 10);
    const end = parseInt(options.end, 10);
    const batchSize = parseInt(options.batchSize, 10);

    if (isNaN(start) || isNaN(end) || start < 0 || end < 0) {
      console.error(
        "Error: Start and End blocks must be non-negative integers.",
      );
      process.exit(1);
    }

    if (start > end) {
      console.error(
        "Error: Start block must be less than or equal to End block.",
      );
      process.exit(1);
    }

    console.log(
      `Starting backfill from ${start} to ${end} (Batch Size: ${batchSize} blocks)...`,
    );

    let currentBlock = start;
    let pendingBatch: ValidatedTransaction[] = [];

    const MAX_RETRIES = 5;
    // Simple exponential backoff for fetching
    const fetchWithRetry = async (
      blockNum: number,
      retries = MAX_RETRIES,
    ): Promise<ValidatedTransaction[]> => {
      try {
        return await fetchBlockData(blockNum);
      } catch (err) {
        if (retries === 0) throw err;

        // Calculate attempt number (0, 1, 2...) based on MAX_RETRIES
        const attempt = MAX_RETRIES - retries;

        // Exponential Backoff: 1s * 2^attempt (using bit shift)
        // 1s, 2s, 4s, 8s, 16s...
        const delay = 1000 * (1 << attempt);

        console.warn(
          `[WARN] Failed to fetch block ${blockNum}. Retrying in ${delay}ms...`,
        );
        await new Promise((res) => setTimeout(res, delay));
        return fetchWithRetry(blockNum, retries - 1);
      }
    };

    try {
      while (currentBlock <= end) {
        const potentialBatchEnd = currentBlock + batchSize - 1;
        const batchEnd = potentialBatchEnd < end ? potentialBatchEnd : end;
        console.log(`Fetching blocks ${currentBlock} to ${batchEnd}...`);

        // Fetch blocks in parallel for the current batch
        const promises = [];
        for (let i = currentBlock; i <= batchEnd; i++) {
          promises.push(fetchWithRetry(i));
        }

        const results = await Promise.all(promises);
        const flatResults = results.flat();

        if (flatResults.length > 0) {
          console.log(
            `Committing ${flatResults.length} transactions for blocks ${currentBlock}-${batchEnd}...`,
          );
          await bulkInsert(flatResults);
        } else {
          console.log(
            `No transactions found in blocks ${currentBlock}-${batchEnd}.`,
          );
        }

        currentBlock = batchEnd + 1;
      }

      console.log("Backfill complete!");
      process.exit(0);
    } catch (error) {
      console.error("[ERROR] Backfill failed:", error);
      process.exit(1);
    }
  });
