import { Command } from "commander";
import { bulkInsert } from "@app/db-core";
import { fetchBlockData, BlockIngestData } from "@app/blockchain";

function parseBlockNumber(s: string): bigint | null {
  if (!/^\d+$/.test(s.trim())) return null;
  try {
    return BigInt(s.trim());
  } catch {
    return null;
  }
}

export const backfillCommand = new Command("backfill")
  .description("Backfill historical data for a specific block range")
  .requiredOption("-s, --start <number>", "Start block number")
  .requiredOption("-e, --end <number>", "End block number")
  .option("-b, --batch-size <number>", "Number of blocks to commit in one transaction", "10")
  .action(async (options) => {
    const start = parseBlockNumber(options.start);
    const end = parseBlockNumber(options.end);
    const batchSize = parseInt(options.batchSize, 10);

    if (start === null || end === null || start < 0n || end < 0n) {
      console.error("Error: Start and End blocks must be non-negative integers.");
      process.exit(1);
    }

    if (start > end) {
      console.error("Error: Start block must be less than or equal to End block.");
      process.exit(1);
    }

    console.log(`Starting backfill from ${start} to ${end} (Batch Size: ${batchSize} blocks)...`);

    let currentBlock = start;

    const MAX_RETRIES = 5;
    // Simple exponential backoff for fetching
    const fetchWithRetry = async (blockNum: bigint, retries = MAX_RETRIES): Promise<BlockIngestData> => {
      try {
        return await fetchBlockData(blockNum);
      } catch (err) {
        if (retries === 0) throw err;

        // Calculate attempt number (0, 1, 2...) based on MAX_RETRIES
        const attempt = MAX_RETRIES - retries;

        // Exponential Backoff: 1s * 2^attempt (using bit shift)
        // 1s, 2s, 4s, 8s, 16s...
        const delay = 1000 * (1 << attempt);

        console.warn(`[WARN] Failed to fetch block ${blockNum}. Retrying in ${delay}ms...`);
        await new Promise((res) => setTimeout(res, delay));
        return fetchWithRetry(blockNum, retries - 1);
      }
    };

    try {
      while (currentBlock <= end) {
        const potentialBatchEnd = currentBlock + BigInt(batchSize) - 1n;
        const batchEnd = potentialBatchEnd < end ? potentialBatchEnd : end;
        console.log(`Fetching blocks ${currentBlock} to ${batchEnd}...`);

        // Fetch blocks in parallel for the current batch
        const promises = [];
        for (let i = currentBlock; i <= batchEnd; i++) {
          promises.push(fetchWithRetry(i));
        }

        const results = await Promise.all(promises);
        const transactions = results.flatMap((r) => r.transactions);
        const logs = results.flatMap((r) => r.logs);

        if (transactions.length > 0 || logs.length > 0) {
          console.log(
            `Committing ${transactions.length} transactions and ${logs.length} logs for blocks ${currentBlock}-${batchEnd}...`,
          );
          await bulkInsert({ transactions, logs });
        } else {
          console.log(`No transactions or logs found in blocks ${currentBlock}-${batchEnd}.`);
        }

        currentBlock = batchEnd + 1n;
      }

      console.log("Backfill complete!");
      process.exit(0);
    } catch (error) {
      console.error("[ERROR] Backfill failed:", error);
      process.exit(1);
    }
  });
