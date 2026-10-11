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

export interface BlockRecord {
  blockNumber: bigint;
  blockHash: string;
  parentHash: string;
}

export interface IngestData {
  transactions: ValidatedTransaction[];
  logs: ValidatedLog[];
  blocks: BlockRecord[];
}

const PARTITION_BLOCK_SIZE = 1_000_000n; // blocks per partition
function partitionName(tableName: string, startM: bigint): string {
  return `${tableName}_p${startM}m_${startM + 1n}m`;
}

function getMaxBlock(
  items: { blockNumber: bigint; blockHash: string }[],
): { blockNumber: bigint; blockHash: string } | null {
  let maxBlock: { blockNumber: bigint; blockHash: string } | null = null;
  for (const item of items) {
    if (maxBlock === null || item.blockNumber > maxBlock.blockNumber) {
      maxBlock = { blockNumber: item.blockNumber, blockHash: item.blockHash };
    }
  }
  return maxBlock;
}

export class IndexerDb {
  private pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  getPool(): Pool {
    return this.pool;
  }

  /**
   * Executes the core rollback logic necessary to handle a blockchain re-org.
   * This deletes all data from the fork point onwards in a single atomic transaction.
   */
  async rollbackState(newHeadBlockNumber: bigint, newHeadHash: string): Promise<void> {
    console.log(`[DB] Re-org detected. Rolling back state up to and including block ${newHeadBlockNumber}...`);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      // 1. Delete transactions and logs strictly after the new head
      await client.query(`DELETE FROM transactions WHERE block_number > $1`, [newHeadBlockNumber.toString()]);
      await client.query(`DELETE FROM logs WHERE block_number > $1`, [newHeadBlockNumber.toString()]);
      await client.query(`DELETE FROM blocks WHERE block_number > $1`, [newHeadBlockNumber.toString()]);

      // 2. Set the checkpoint to the new head (number and hash)
      await this.saveCheckpoint(client, newHeadBlockNumber, newHeadHash);

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

  /**
   * Saves a batch of validated transactions AND logs into the database using standard INSERT.
   */
  async insertRows(data: IngestData): Promise<void> {
    if (data.transactions.length === 0 && data.logs.length === 0) return;

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      const maxBlock = getMaxBlock([...data.transactions, ...data.logs]);
      if (maxBlock) {
        await this.ensurePartition(client, "transactions", maxBlock.blockNumber);
        await this.ensurePartition(client, "logs", maxBlock.blockNumber);
      }

      if (data.blocks.length > 0) {
        await this.saveBlocks(client, data.blocks);
      }

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
            tx.blockNumber.toString(),
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
            log.blockNumber.toString(),
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
      if (maxBlock) {
        await this.saveCheckpoint(client, maxBlock.blockNumber, maxBlock.blockHash);
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
  async bulkInsert(data: IngestData): Promise<void> {
    if (data.transactions.length === 0 && data.logs.length === 0) return;
    const client = await this.pool.connect();

    try {
      await client.query("BEGIN");

      const maxBlock = getMaxBlock([...data.transactions, ...data.logs]);
      if (maxBlock) {
        await this.ensurePartition(client, "transactions", maxBlock.blockNumber);
        await this.ensurePartition(client, "logs", maxBlock.blockNumber);
      }

      if (data.blocks.length > 0) {
        await this.saveBlocks(client, data.blocks);
      }

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
      if (maxBlock) {
        await this.saveCheckpoint(client, maxBlock.blockNumber, maxBlock.blockHash);
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
   * Persists a single (typically empty) block: writes its ancestry row and advances
   * the checkpoint in one transaction. No partition setup is required (no tx/log writes).
   */
  async saveBlock(block: BlockRecord): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await this.saveBlocks(client, [block]);
      await this.saveCheckpoint(client, block.blockNumber, block.blockHash);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async getHeadBlock(): Promise<{
    number: bigint;
    hash: string;
  } | null> {
    const res = await this.pool.query(`SELECT block_number, block_hash FROM checkpoints WHERE id = 'chain_head'`);
    if (res.rows.length === 0) return null;
    return {
      number: BigInt(res.rows[0].block_number),
      hash: res.rows[0].block_hash,
    };
  }

  async getBlock(blockNumber: bigint): Promise<{ number: bigint; hash: string } | null> {
    const res = await this.pool.query(`SELECT block_number, block_hash FROM blocks WHERE block_number = $1`, [
      blockNumber.toString(),
    ]);
    if (res.rows.length === 0) return null;
    return { number: BigInt(res.rows[0].block_number), hash: res.rows[0].block_hash };
  }

  static fromEnv(): IndexerDb {
    return new IndexerDb(
      new Pool({
        host: process.env.DB_HOST || "localhost",
        port: parseInt(process.env.DB_PORT || "5432"),
        user: process.env.DB_USER || "postgres",
        password: process.env.DB_PASSWORD || "postgres",
        database: process.env.DB_NAME || "indexer",
      }),
    );
  }

  private async saveBlocks(client: PoolClient, blocks: BlockRecord[]): Promise<void> {
    const queryBlock = `
      INSERT INTO blocks (block_number, block_hash, parent_hash)
      VALUES ($1, $2, $3)
      ON CONFLICT (block_number) DO NOTHING
    `;

    for (const block of blocks) {
      await client.query(queryBlock, [block.blockNumber.toString(), block.blockHash, block.parentHash]);
    }
  }

  private async ensurePartition(
    client: PoolClient,
    tableName: "transactions" | "logs",
    blockNumber: bigint,
  ): Promise<void> {
    const startM = blockNumber / PARTITION_BLOCK_SIZE; // integer division
    const start = startM * PARTITION_BLOCK_SIZE;
    const end = start + PARTITION_BLOCK_SIZE;
    const name = partitionName(tableName, startM);
    await client.query(
      `CREATE TABLE IF NOT EXISTS ${name} PARTITION OF ${tableName} FOR VALUES FROM (${start}) TO (${end})`,
    );
  }

  // Helper for checkpoint updates to avoid duplication
  private async saveCheckpoint(client: PoolClient, blockNumber: bigint, blockHash: string): Promise<void> {
    await client.query(
      `INSERT INTO checkpoints (id, block_number, block_hash) 
           VALUES ('chain_head', $1, $2)
           ON CONFLICT (id) DO UPDATE SET block_number = $1, block_hash = $2, last_updated = NOW()`,
      [blockNumber.toString(), blockHash],
    );
  }
}
