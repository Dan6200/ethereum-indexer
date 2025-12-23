-- Checkpoint Table: The source of truth for the indexer's state
CREATE TABLE IF NOT EXISTS checkpoints (
    id VARCHAR(64) PRIMARY KEY, -- usually 'chain_head'
    block_number NUMERIC NOT NULL,
    block_hash VARCHAR(66) NOT NULL,
    last_updated TIMESTAMP DEFAULT NOW()
);

-- Core Data Table: Transactions
-- PARTITIONED BY RANGE (block_number) for scalability
CREATE TABLE IF NOT EXISTS transactions (
    tx_hash VARCHAR(66) NOT NULL,
    block_number NUMERIC NOT NULL,
    block_hash VARCHAR(66) NOT NULL,
    transaction_index NUMERIC NOT NULL,
    from_address VARCHAR(42) NOT NULL,
    to_address VARCHAR(42), -- Nullable for contract creations
    amount NUMERIC NOT NULL, -- NUMERIC for exact financial precision
    is_internal_call BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT NOW(),
    
    -- Primary Key must include the partition key (block_number)
    PRIMARY KEY (tx_hash, block_number)
) PARTITION BY RANGE (block_number);

-- Initial Partition (e.g., blocks 0 to 1,000,000)
-- In production, you would automate partition creation.
CREATE TABLE IF NOT EXISTS transactions_p0_1m PARTITION OF transactions
    FOR VALUES FROM (0) TO (1000000);

CREATE TABLE IF NOT EXISTS transactions_p1m_2m PARTITION OF transactions
    FOR VALUES FROM (1000000) TO (2000000);

-- INDEXES

-- 1. BRIN Index for Block Number (Memory Efficient Range Lookups)
-- Excellent for "Get all txs in block range X-Y"
CREATE INDEX IF NOT EXISTS idx_transactions_block_number_brin 
ON transactions USING BRIN (block_number);

-- 2. B-Tree for Address Lookups (High Cardinality)
-- "Show me all transactions for user X"
CREATE INDEX IF NOT EXISTS idx_transactions_from 
ON transactions (from_address);

CREATE INDEX IF NOT EXISTS idx_transactions_to 
ON transactions (to_address);

-- 3. B-Tree for specific Transaction Hash lookup
-- (Covered by Primary Key, but explicit index can be useful if PK changes)
-- CREATE INDEX IF NOT EXISTS idx_transactions_tx_hash ON transactions (tx_hash);
