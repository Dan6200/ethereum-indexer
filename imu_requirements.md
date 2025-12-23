# **Indexer Management Utility (IMU) Project Requirements**

## **I. Overview and Purpose**

The Indexer Management Utility (IMU) is a critical, decoupled infrastructure tool designed to ensure the stability, integrity, and operational safety of the primary Real-Time Indexer Daemon. The IMU's primary function is to handle high-risk, synchronous, and developer-initiated maintenance tasks that would otherwise interrupt the mission-critical, low-latency indexing process.  
**Technology Stack:** Node.js / TypeScript / PostgreSQL  
**Key Goals:**

1. **Decoupling:** Ensure the IMU and the Real-Time Indexer Daemon are separate processes.  
2. **Data Integrity:** Enforce strict schema and business logic validation before database commit.  
3. **Operational Safety:** Provide atomic, single-command solutions for re-org recovery and database migration.

## **II. Core Functional Requirements (F-Requirements)**

### **F1: Data Integrity & Validation Layer**

The IMU must leverage shared schemas to perform active, runtime validation of data.

* **F1.1 Shared Schema:** Must utilize a decoupled, internal package (@app/schemas) containing Zod definitions for all core indexed entities (e.g., TransactionSchema).  
* **F1.2 Runtime Checks:** Implement a pipeline to run complex validation logic (e.g., non-negative financial values, correct address formats) on transformed data.  
* **F1.3 Failure Reporting:** Must generate a detailed failure report (file or console log) listing records that failed validation, allowing for developer inspection without halting the process.

### **F2: Reorganization (Re-org) Recovery Tool**

The IMU must provide a safe, developer-initiated mechanism to force a database rollback in case of a sustained or complicated chain fork.

* **F2.1 Atomic Rollback:** Provide a command (imu rollback \<blockNumber\>) that executes an **atomic PostgreSQL transaction** to delete all data and state checkpoints recorded at or after the specified block number.  
* **F2.2 Checkpoint Update:** Must atomically update the Checkpoint table's block\_number and block\_hash to the state preceding the rollback.  
* **F2.3 State Consistency Guarantee (ACID):** The rollback operation must adhere to ACID principles (Atomicity), guaranteeing that the database is either fully reverted or the operation fails cleanly.

### **F3: Historical Data Migration and Backfilling**

The IMU must facilitate backfilling, often required when a new contract is added or the indexer logic is updated.

* **F3.1 Block Range Processing:** Must accept a defined block range (imu backfill \--start 0 \--end 100000\) and process historical logs within that range.  
* **F3.2 Database Transaction Size:** Batch database inserts into appropriately sized PostgreSQL transactions to prevent connection timeouts while maximizing throughput (e.g., 5,000 records per transaction).

## **III. Architectural and Non-Functional Requirements (NFRs)**

### **NFR1: Decoupling and Isolation**

The IMU must be completely independent of the Indexer Daemon's main execution loop.

* **NFR1.1 Separate Entry Point:** Must be a separate Node.js application (CLI) with its own process and lifecycle.  
* **NFR1.2 Shared DB Layer:** The IMU will share the connection pool (pg or similar) and data schemas with the Indexer Daemon but must not share any in-memory state.

### **NFR2: Performance and Scalability**

The database structure must be optimized for the most frequent high-risk operation: the atomic rollback.

* **NFR2.1 Indexed Rollback:** The core data tables in PostgreSQL must be indexed on the block\_number column (e.g., idx\_block\_number in indexer\_postgres\_schema.md) to ensure the DELETE operation is near-instantaneous.  
* **NFR2.2 Data Typing:** Must use the PostgreSQL NUMERIC type for all financial and large number (uint256) values to prevent precision loss, as defined in the schema.

### **NFR3: Protobuf Readiness**

The IMU's data structures must be designed for eventual integration with Protobuf.

* **NFR3.1 Field Simplicity:** While Zod is used for runtime validation, the underlying data structure should avoid complex nesting or non-primitive types (e.g., nested arrays) that are difficult to translate directly into a .proto definition, easing the future migration to a Protobuf-enabled API layer.