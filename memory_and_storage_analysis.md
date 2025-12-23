# **Indexer Resource Strategy: Memory, Indexing, and Partitioning**

This document outlines the memory footprint and storage strategy for a production-grade Node.js/PostgreSQL Indexer.

## **1\. Node.js Memory Footprint (The Process)**

Since the **Indexer Daemon** and **IMU Ingesters** are I/O-bound, the memory usage per process is relatively low, but scales with the "batch size."

| Process Type           | Estimated RAM  | Key Driver                                                             |
| :--------------------- | :------------- | :--------------------------------------------------------------------- |
| **Aggregator Daemon**  | 512MB \- 1GB   | Cache of the last \~100 blocks to handle micro-reorgs without DB hits. |
| **Ingester Worker**    | 256MB \- 512MB | Buffer size of fetched RPC logs before they are committed to Postgres. |
| **Total (10 Workers)** | \~6GB          | Total overhead for a high-throughput parallel backfill.                |

## **2\. PostgreSQL Memory (The Engine)**

The real memory requirement is dictated by the **Working Set** (the data and indexes currently being queried/updated).

- **Shared Buffers:** Should be \~25% of system RAM.
- **Maintenance Work Mem:** Needs to be high (1GB+) because you are creating and merging indexes on large partitions.

## **3\. Storage & Disk Space Requirements (GB)**

Storage is the most significant long-term cost for an indexer. Blockchain data grows linearly and indefinitely.

### **A. Data Density Estimation**

On average, a single indexed "Event" or "Transaction" row in PostgreSQL (including metadata like hashes and block numbers) occupies approximately **0.5KB to 1KB** of raw disk space.

### **B. Index Overhead**

Indexes (B-Tree/GIN) typically double the storage requirement of the raw data.

| Data Volume          | Raw Data (GB) | Index Overhead (GB) | Total Disk Needed (GB) |
| :------------------- | :------------ | :------------------ | :--------------------- |
| **10 Million Rows**  | \~10 GB       | \~10 GB             | **20 GB**              |
| **100 Million Rows** | \~100 GB      | \~100 GB            | **200 GB**             |
| **1 Billion Rows**   | \~1 TB        | \~1 TB              | **2,000 GB (2 TB)**    |

### **C. The WAL (Write-Ahead Log)**

PostgreSQL requires extra space for its WAL to ensure durability. You should always maintain a **20-30% disk buffer** to prevent "Disk Full" crashes during high-throughput ingestion.

## **4\. Indexing Strategy & Memory Trade-offs**

You mentioned using three distinct index types. Each has a specific memory and CPU profile:

### **A. B-Tree (The Standard)**

- **Usage:** Primary Keys (block_number, transaction_index, log_index).
- **Memory Impact:** High. B-Trees are fast but large.
- **Strategy:** Only use for unique identification and high-cardinality lookups (e.g., tx_hash).

### **B. BRIN (Block Range INdex)**

- **Usage:** block_number or timestamp.
- **Memory Impact:** **Extremely Low.** \* **Advantage:** Blockchain data is naturally sorted by time. BRIN indexes the min/max for range pages. Instead of a 1GB B-Tree, a BRIN index for the same data might be only **10-50 MB**.

### **C. GIN (Generalized Inverted Index)**

- **Usage:** topics or JSONB data.
- **Memory Impact:** Moderate to High.
- **Optimization:** Use fastupdate=on to buffer GIN updates.

## **5\. Table Partitioning (The Scaling Secret)**

For an indexer, **Range Partitioning by block_number** is mandatory once you cross \~50 million rows.

1. **Index Locality:** PostgreSQL keeps the "active" partition's index in RAM, ensuring $O(1)$ insert speeds.
2. **Vacuuming:** You can VACUUM old partitions without locking the current ingestion head.
3. **Archiving:** Move partitions older than 1 year to cheaper, slower HDD storage or detach them to save NVMe space.

## **6\. Final Hardware Recommendation**

For a mid-sized indexer tracking high-volume contracts:

- **CPU:** 4-8 Cores.
- **RAM:** 16GB \- 32GB (Ensures active partition indexes stay in memory).
- **Storage:** **Minimum 500GB \- 1TB NVMe SSD.** \* _Why NVMe?_ IOPS is the primary bottleneck. Standard SSDs or HDDs will "choke" during a re-org rollback or a massive parallel backfill.

### **Summary Formula**

Total Disk Space \= (Estimated Row Count \* 1.5KB) \* 1.3 (Safety Buffer)

