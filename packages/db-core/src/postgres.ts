import { Pool, PoolClient } from 'pg';
import { ValidatedTransaction } from '@app/schemas';

// In a real app, these would come from environment variables
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
  database: process.env.DB_NAME || 'indexer',
});

export const getPool = () => pool;

/**
 * Executes the core rollback logic necessary to handle a blockchain re-org.
 * This deletes all data from the fork point onwards in a single atomic transaction.
 */
export async function rollbackState(forkBlockNumber: number): Promise<void> {
  console.log(`[DB] Re-org detected. Rolling back state to block ${forkBlockNumber}...`);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    // 1. Delete transactions from the forked block onwards
    // efficient due to the BRIN index and Partitioning
    await client.query(`DELETE FROM transactions WHERE block_number >= $1`, [forkBlockNumber]);
    
    // 2. Update the checkpoint to the previous block
    // We assume the checkpoint ID is 'chain_head'
    const prevBlock = forkBlockNumber - 1;
    await client.query(
      `UPDATE checkpoints SET block_number = $1, last_updated = NOW() WHERE id = 'chain_head'`,
      [prevBlock]
    );

    await client.query('COMMIT');
    console.log(`[DB] Rollback complete. State is now consistent up to block ${prevBlock}.`);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('[DB ERROR] Rollback failed. Indexer halted.', error);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Saves a batch of validated transactions into the database.
 */
export async function insertBatch(data: ValidatedTransaction[]): Promise<void> {
  if (data.length === 0) return;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // In a real production scenario, we would use 'pg-format' or UNNEST for bulk inserts.
    // For this prototype, we'll iterate (which is slower but safer for demonstration).
    const query = `
      INSERT INTO transactions 
      (tx_hash, block_number, block_hash, transaction_index, from_address, to_address, amount, is_internal_call)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (tx_hash, block_number) DO NOTHING
    `;

    let maxBlockNum = -1;
    let maxBlockHash = '';

    for (const tx of data) {
      await client.query(query, [
        tx.transactionHash,
        tx.blockNumber,
        tx.blockHash,
        tx.transactionIndex,
        tx.from,
        tx.to || null,
        tx.amount,
        tx.isInternalCall
      ]);

      if (tx.blockNumber > maxBlockNum) {
        maxBlockNum = tx.blockNumber;
        maxBlockHash = tx.blockHash;
      }
    }

    // Update Checkpoint to the highest block in this batch
    if (maxBlockNum !== -1 && maxBlockHash) {
       await client.query(
        `INSERT INTO checkpoints (id, block_number, block_hash) 
         VALUES ('chain_head', $1, $2)
         ON CONFLICT (id) DO UPDATE SET block_number = $1, block_hash = $2, last_updated = NOW()`,
        [maxBlockNum, maxBlockHash]
      );
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function getHeadBlock(): Promise<{ number: number; hash: string } | null> {
    const res = await pool.query(`SELECT block_number, block_hash FROM checkpoints WHERE id = 'chain_head'`);
    if (res.rows.length === 0) return null;
    return {
        number: parseFloat(res.rows[0].block_number),
        hash: res.rows[0].block_hash
    };
}
