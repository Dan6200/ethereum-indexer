import { Pool, PoolClient } from "pg";
import { ValidatedTransaction, ValidatedLog } from "@app/schemas";
import { from as copyFrom } from "pg-copy-streams";
import { Readable } from "stream";
import { pipeline } from "stream/promises";

const COPY_CHUNK_BYTES = 1024 * 1024; // ~1MB per CopyData frame

function pushCopyChunks<T>(readable: Readable, items: T[], formatLine: (item: T) => string): void {
  let buf = "";
  for (const item of items) {
    buf += formatLine(item);
    if (buf.length >= COPY_CHUNK_BYTES) {
      readable.push(buf);
      buf = "";
    }
  }
  if (buf.length > 0) readable.push(buf);
  readable.push(null);
}

const pool = new Pool({
  host: process.env.DB_HOST || "localhost",
  port: parseInt(process.env.DB_PORT || "5432"),
  user: process.env.DB_USER || "postgres",
  password: process.env.DB_PASSWORD || "postgres",
  database: process.env.DB_NAME || "indexer",
});

export const getPool = () => pool;

/**
 * Executes the core rollback logic necessary to handle a blockchain re-org.
 * This deletes all data from the fork point onwards in a single atomic transaction.
 */
export async function rollbackState(newHeadBlockNumber: number, newHeadHash: string): Promise<void> {
  console.log(`[DB] Re-org detected. Rolling back state up to and including block ${newHeadBlockNumber}...`);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // 1. Delete transactions and logs strictly after the new head
    await client.query(`DELETE FROM transactions WHERE block_number > $1`, [newHeadBlockNumber]);
    await client.query(`DELETE FROM logs WHERE block_number > $1`, [newHeadBlockNumber]);

    // 2. Set the checkpoint to the new head (number and hash)
    await saveCheckpoint(client, newHeadBlockNumber, newHeadHash);

    await client.query("COMMIT");
    console.log(`[DB] Rollback complete. State is now consistent up to and including block ${newHeadBlockNumber}.`);
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("[DB ERROR] Rollback failed. Indexer halted.", error);
    throw error;
  } finally {
    client.release();
  }
}

interface IngestData {
  transactions: ValidatedTransaction[];
  logs: ValidatedLog[];
}

/**
 * Saves a batch of validated transactions AND logs into the database using standard INSERT.
 */
export async function insertRows(data: IngestData): Promise<void> {
  if (data.transactions.length === 0 && data.logs.length === 0) return;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // 1. Insert Transactions
    if (data.transactions.length > 0) {
      const queryTx = `
          INSERT INTO transactions 
          (tx_hash, block_number, block_hash, transaction_index, from_address, to_address, amount, is_internal_call)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          ON CONFLICT (tx_hash, block_number) DO NOTHING
        `;

      for (const tx of data.transactions) {
        await client.query(queryTx, [
          tx.transactionHash,
          tx.blockNumber,
          tx.blockHash,
          tx.transactionIndex,
          tx.from,
          tx.to || null,
          tx.amount,
          tx.isInternalCall,
        ]);
      }
    }

    // 2. Insert Logs
    if (data.logs.length > 0) {
      const queryLog = `
          INSERT INTO logs 
          (block_number, block_hash, tx_hash, tx_index, log_index, address, data, topics)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          ON CONFLICT (block_number, log_index) DO NOTHING
        `;

      for (const log of data.logs) {
        await client.query(queryLog, [
          log.blockNumber,
          log.blockHash,
          log.transactionHash,
          log.transactionIndex,
          log.logIndex,
          log.address,
          log.data,
          log.topics, // Postgres handles array insertion natively
        ]);
      }
    }

    // 3. Update Checkpoint (using the max block from transactions, or logs if no txs)
    const maxBlock = getMaxBlock([...data.transactions, ...data.logs]);
    if (maxBlock) {
      await saveCheckpoint(client, maxBlock.blockNumber, maxBlock.blockHash);
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * High-performance bulk ingestion using COPY + Temp Table Staging.
 */
export async function bulkInsert(data: IngestData): Promise<void> {
  if (data.transactions.length === 0 && data.logs.length === 0) return;
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // === PROCESS TRANSACTIONS ===
    if (data.transactions.length > 0) {
      await client.query(`
          CREATE TEMP TABLE staging_transactions 
          (LIKE transactions INCLUDING DEFAULTS) 
          ON COMMIT DROP
        `);

      const streamTx = client.query(
        copyFrom(
          "COPY staging_transactions (tx_hash, block_number, block_hash, transaction_index, from_address, to_address, amount, is_internal_call) FROM STDIN",
        ),
      );

      const inputTx = new Readable({ read() {} });
      pushCopyChunks(
        inputTx,
        data.transactions,
        (tx) =>
          [
            tx.transactionHash,
            tx.blockNumber,
            tx.blockHash,
            tx.transactionIndex,
            tx.from,
            tx.to || "\\N",
            tx.amount,
            tx.isInternalCall,
          ].join("\t") + "\n",
      );
      await pipeline(inputTx, streamTx);

      await client.query(`
          INSERT INTO transactions 
          SELECT * FROM staging_transactions 
          ON CONFLICT (tx_hash, block_number) DO NOTHING
        `);
    }

    // === PROCESS LOGS ===
    if (data.logs.length > 0) {
      await client.query(`
          CREATE TEMP TABLE staging_logs 
          (LIKE logs INCLUDING DEFAULTS) 
          ON COMMIT DROP
        `);

      // Note: Copying Arrays (TEXT[]) via COPY in Postgres typically uses format "{item1,item2}"
      const streamLog = client.query(
        copyFrom(
          "COPY staging_logs (block_number, block_hash, tx_hash, tx_index, log_index, address, data, topics) FROM STDIN",
        ),
      );

      const inputLog = new Readable({ read() {} });
      pushCopyChunks(
        inputLog,
        data.logs,
        (log) =>
          [
            log.blockNumber,
            log.blockHash,
            log.transactionHash,
            log.transactionIndex,
            log.logIndex,
            log.address,
            log.data,
            `{${log.topics.join(",")}}`,
          ].join("\t") + "\n",
      );
      await pipeline(inputLog, streamLog);

      await client.query(`
          INSERT INTO logs 
          SELECT * FROM staging_logs 
          ON CONFLICT (block_number, log_index) DO NOTHING
        `);
    }

    // === CHECKPOINT ===
    const maxBlock = getMaxBlock([...data.transactions, ...data.logs]);
    if (maxBlock) {
      await saveCheckpoint(client, maxBlock.blockNumber, maxBlock.blockHash);
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

// Helper for checkpoint updates to avoid duplication
export async function saveCheckpoint(clientOrPool: PoolClient | Pool, blockNumber: number, blockHash: string) {
  await clientOrPool.query(
    `INSERT INTO checkpoints (id, block_number, block_hash) 
         VALUES ('chain_head', $1, $2)
         ON CONFLICT (id) DO UPDATE SET block_number = $1, block_hash = $2, last_updated = NOW()`,
    [blockNumber, blockHash],
  );
}

function getMaxBlock(
  items: { blockNumber: number; blockHash: string }[],
): { blockNumber: number; blockHash: string } | null {
  let maxBlock: { blockNumber: number; blockHash: string } | null = null;
  for (const item of items) {
    if (maxBlock === null || item.blockNumber > maxBlock.blockNumber) {
      maxBlock = { blockNumber: item.blockNumber, blockHash: item.blockHash };
    }
  }
  return maxBlock;
}

export async function getHeadBlock(): Promise<{
  number: number;
  hash: string;
} | null> {
  const res = await pool.query(`SELECT block_number, block_hash FROM checkpoints WHERE id = 'chain_head'`);
  if (res.rows.length === 0) return null;
  return {
    // Safe: Ethereum block heights are far below Number.MAX_SAFE_INTEGER
    number: Number(res.rows[0].block_number),
    hash: res.rows[0].block_hash,
  };
}
