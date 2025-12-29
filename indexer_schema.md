# **Foundational Blockchain Indexer Schema (PostgreSQL)**

This schema outlines the minimum required tables and columns for a production-grade EVM indexer, designed to handle chain reorganizations (re-orgs) and provide fast, queryable data.

## **1\. The Checkpoint Table (State Management)**

This table is **critical** for reliability. It acts as the "source of truth" for where your indexer last successfully committed data. This is how your indexer detects and recovers from a re-org.

| Column       | Type        | Purpose                                                                                                                    |
| :----------- | :---------- | :------------------------------------------------------------------------------------------------------------------------- |
| id           | VARCHAR(64) | Primary key. Should be a constant like 'chain_head' (only one row).                                                        |
| block_number | NUMERIC     | **The highest block number successfully processed and committed.**                                                         |
| block_hash   | VARCHAR(66) | **The hash of that block.** Used to verify that the next incoming block's parent hash matches this one (re-org detection). |
| last_updated | TIMESTAMP   | When the state was last updated.                                                                                           |

## **2\. Core Data Table (e.g., Transactions)**

This table stores your custom application data (matching your TransactionSchema from the IMU blueprint). **Every single row must contain the block metadata.**

| Column       | Type               | Purpose                                                                                                                               |
| :----------- | :----------------- | :------------------------------------------------------------------------------------------------------------------------------------ |
| id           | SERIAL PRIMARY KEY | Standard SQL primary key.                                                                                                             |
| tx_hash      | VARCHAR(66)        | Transaction hash. Useful for linking back to Etherscan.                                                                               |
| from_address | VARCHAR(42)        | Indexed address (0x...).                                                                                                              |
| to_address   | VARCHAR(42)        | Indexed address (0x...).                                                                                                              |
| amount       | NUMERIC            | **CRUCIAL: Use NUMERIC for financial values.** JavaScript's number and SQL's FLOAT lose precision. NUMERIC preserves the exact value. |
| block_number | NUMERIC            | **MANDATORY for Rollback.** Used in your rollbackState function to target data to delete during a re-org.                             |
| block_hash   | VARCHAR(66)        | Contextual link to the block.                                                                                                         |
| log_index    | NUMERIC            | Position of the event within the block (useful for ordering).                                                                         |

## **3\. Indexes (Performance)**

To make your rollbackState function run instantly, and to make your app fast, you need indexes.

| Index Name       | Columns                      | Purpose                                                                                                                                      |
| :--------------- | :--------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------- |
| idx_block_number | (block_number)               | **Most critical index.** Makes the DELETE WHERE block_number \>= $forkBlockNumber query fast and efficient, ensuring speedy re-org recovery. |
| idx_address_time | (from_address, block_number) | Allows fast retrieval of historical activity for a single user (e.g., "Show all transactions by this user").                                 |
| idx_tx_hash      | (tx_hash)                    | Ensures fast lookups by transaction identifier.                                                                                              |

## **4\. Addressing EVM Data Types**

| EVM Type                | PostgreSQL Type | Notes                                                                                                                            |
| :---------------------- | :-------------- | :------------------------------------------------------------------------------------------------------------------------------- |
| address                 | VARCHAR(42)     | Hex strings are best stored as fixed-length text.                                                                                |
| uint256 (Token Balance) | NUMERIC         | **Always use NUMERIC.** Do not use BigInt or Float. This prevents truncation and precision loss, preserving financial integrity. |
| bytes32 (Hash)          | VARCHAR(66)     | Standard length for hash hex strings.                                                                                            |
