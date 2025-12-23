# **Real-Time Indexer Daemon Project Requirements**

## **I. Overview and Purpose**

The Indexer Daemon is the mission-critical, long-running service responsible for maintaining a real-time, eventual consistent copy of the blockchain data within the PostgreSQL database. Its core function is to listen for new blocks, detect chain reorganizations (re-orgs), and commit new data with minimal latency.  
**Technology Stack:** Node.js / TypeScript / Ethers.js (or Viem) / PostgreSQL  
**Key Goals:**

1. **Uptime & Reliability:** Achieve near-100% operational uptime, tolerating transient network failures.  
2. **Low Latency:** Process and commit new blocks to the database within seconds of finalization.  
3. **Re-org Defense:** Automatically and seamlessly detect and handle chain reorganizations.

## **II. Core Functional Requirements (F-Requirements)**

### **F1: Continuous Block Processing**

The Daemon must operate 24/7 without manual intervention.

* **F1.1 Head Tracking:** Must continuously subscribe to the EVM network head (via WebSocket or polling) to receive notifications of new blocks.  
* **F1.2 Checkpoint Reading:** Must read the last known good state (block\_number, block\_hash) from the PostgreSQL Checkpoint Table upon startup and before processing each new block.  
* **F1.3 Transformation Pipeline:** Must utilize the shared @app/schemas package (Zod) to validate and transform all decoded event logs before insertion.

### **F2: Chain Reorganization (Re-org) Detection and Self-Correction**

This is the single most critical function of the Indexer Daemon.

* **F2.1 Detection Logic:** Before processing a new block, the Daemon must compare the incoming block's parentHash with the previously stored block\_hash in the Checkpoint Table.  
  * If they match, process the block normally.  
  * If they do not match, a re-org has occurred.  
* **F2.2 Automated Rollback (Self-Correction):** Upon detecting a re-org, the Daemon must **automatically** trigger the same rollbackState logic used by the IMU (delete data from the fork point onward) and then immediately revert to polling for the correct historical block to resume indexing.  
* **F2.3 Alerting:** Must log and trigger a high-severity alert (e.g., Slack/PagerDuty) whenever a re-org is detected, even if successful.

### **F3: Robust RPC Handling and Failover**

The Daemon's primary bottleneck is network latency and RPC reliability.

* **F3.1 Exponential Backoff:** All RPC calls (fetch logs, get block data) must implement **exponential backoff** and retry logic to mitigate transient network errors and soft rate limits.  
* **F3.2 Provider Routing (Future State):** The system must be designed to easily integrate multiple RPC providers (e.g., Alchemy, Infura) and implement a simple routing layer to switch to a healthy provider if a primary one fails or returns a persistent 429 (Rate Limit) error.

## **III. Architectural and Non-Functional Requirements (NFRs)**

### **NFR1: Performance and Data Consistency**

* **NFR1.1 Transaction Batching:** New data should be inserted into PostgreSQL using bulk/batch inserts to minimize I/O trips and maximize commit speed.  
* **NFR1.2 Database Lock Minimization:** The continuous operation must avoid any database operations (like schema alterations) that could introduce long-running locks, which are reserved for the IMU.

### **NFR2: Observability and Monitoring**

* **NFR2.1 Key Metrics:** Must expose core metrics (e.g., Prometheus/Grafana) including: latest\_indexed\_block\_number, indexing\_latency\_seconds, and reorgs\_detected\_total.  
* **NFR2.2 Logging:** Must use structured JSON logging (e.g., Pino or Winston) for easy filtering and analysis in log management systems.

### **NFR3: Decoupling Compliance**

* **NFR3.1 No Maintenance Tasks:** The Daemon must never execute high-risk, long-running tasks like schema migration or historical backfilling; these are strictly delegated to the **Indexer Management Utility (IMU)**.  
* **NFR3.2 Shared Code:** The Daemon must link the same shared dependencies (@app/schemas, @app/db-core) as the IMU to guarantee that validation and database primitives (like the atomic rollback) are consistent across the entire infrastructure.