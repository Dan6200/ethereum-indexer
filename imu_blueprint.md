# **Indexer Management Utility (IMU) \- System Design Blueprint**

This blueprint demonstrates the core architectural components for a custom indexer toolkit, focusing on Data Integrity and Maintainability.

## **1\. schemas.ts (Data Integrity Layer)**

This file contains the runtime schema definition for data coming off the blockchain, enforcing data quality before storage.

* **Purpose:** Replaces passive SQL validation with active, runtime validation of the data structure.  
* **Key Concept:** Using Zod to ensure that the decoded event data (which is messy raw bytes) transforms into a clean, expected format before hitting the database.

// schemas.ts  
import { z } from 'zod';

// Define the schema for a confirmed transaction to be stored in Postgres  
export const TransactionSchema \= z.object({  
  // Crucial for re-org management  
  blockNumber: z.number().int().positive(),  
  blockHash: z.string().startsWith('0x').length(66),   
    
  // Financial data fields  
  from: z.string().startsWith('0x'),  
  to: z.string().startsWith('0x'),  
  amount: z.string().refine(s \=\> \!isNaN(Number(s)) && Number(s) \>= 0, "Amount must be a non-negative number string"), // Must be string for large numbers  
    
  // Custom business logic field  
  isInternalCall: z.boolean().default(false),   
});

// A Zod schema for a function that runs against raw event data:  
export type ValidatedTransaction \= z.infer\<typeof TransactionSchema\>;

## **2\. postgres.ts (Persistence Layer Abstraction)**

This file demonstrates the intention to connect to a high-integrity database (Postgres) and the design needed for reliable writes during indexing.

* **Purpose:** Shows understanding of transactional safety and separation of concerns (decoupling from Firestore).  
* **Key Concept:** Abstracting the persistence layer so that the validator doesn't care if it's Postgres or another SQL database.

// postgres.ts  
import { ValidatedTransaction } from './schemas';  
import { Pool } from 'pg'; // Placeholder for PostgreSQL library

const pool \= new Pool(/\* connection details \*/);

/\*\*  
 \* Executes the core rollback logic necessary to handle a blockchain re-org.  
 \* In a production indexer, this is the most critical function.  
 \*/  
export async function rollbackState(forkBlockNumber: number): Promise\<void\> {  
  console.log(\`\[DB\] Re-org detected. Rolling back state to block ${forkBlockNumber}...\`);  
  const client \= await pool.connect();  
  try {  
    await client.query('BEGIN');  
    // The atomic SQL statement that reverts all incorrect state data  
    await client.query(\`DELETE FROM transactions WHERE block\_number \>= $1\`, \[forkBlockNumber\]);  
    await client.query('COMMIT');  
    console.log(\`\[DB\] Rollback complete. State is now consistent up to block ${forkBlockNumber \- 1}.\`);  
  } catch (error) {  
    await client.query('ROLLBACK');  
    console.error('\[DB ERROR\] Rollback failed. Indexer halted.', error);  
    // In production, this would trigger an immediate PagerDuty alert.  
    throw error;  
  } finally {  
    client.release();  
  }  
}

/\*\*  
 \* Saves a batch of validated transactions into the database.  
 \*/  
export async function insertBatch(data: ValidatedTransaction\[\]): Promise\<void\> {  
  // In a real app, this would use pg-format or bulk insert library for speed.  
  // For design purposes, this shows the intent to commit validated data.  
  // ... insertion logic ...  
}

## **3\. index.ts (The Management Utility Logic)**

This is the main loop where the IMU uses the validation and database components.

* **Purpose:** Demonstrates the application of the Zod validation and the handling of failures, linking the utility back to your core skill set.

// index.ts  
import { TransactionSchema } from './schemas';  
import { rollbackState } from './postgres';

// Mock data representing a raw log retrieved from the Ethereum RPC  
const rawChainData \= \[  
  { block: 100, hash: '0xabc...', from: '0x123...', to: '0x456...', value: 1000000n },  
  { block: 100, hash: '0xabc...', from: '0x789...', to: '0x000...', value: \-500n }, // \<-- ERROR DATA POINT  
\];

export async function processRawLogs(logs: any\[\]) {  
  const validatedData \= \[\];  
  const failureReport \= \[\];

  for (const log of logs) {  
    // 1\. Transformation (Example: converting BigInt to string, running business logic)  
    const transformedData \= {   
      blockNumber: log.block,  
      blockHash: log.hash,  
      from: log.from,  
      to: log.to,  
      amount: String(log.value), // Convert large number to string for storage  
    };

    // 2\. Data Integrity Check (The Zod Validation)  
    const result \= TransactionSchema.safeParse(transformedData);

    if (result.success) {  
      validatedData.push(result.data);  
    } else {  
      // CRITICAL: Log the failure and CONTINUE, preventing the whole indexer from crashing  
      failureReport.push({   
        type: 'VALIDATION\_FAILURE',  
        block: log.block,  
        error: result.error.errors.map(e \=\> \`${e.path}: ${e.message}\`).join('; '),  
      });  
    }  
  }

  // 3\. Output/Action  
  console.log(\`Processed ${logs.length} logs. Successes: ${validatedData.length}. Failures: ${failureReport.length}.\`);  
  // await insertBatch(validatedData); // Commit the clean data  
    
  if (failureReport.length \> 0\) {  
    console.error("--- FAILURE REPORT \---");  
    console.log(failureReport);  
    // In production, this report is emailed to the Engineering Manager.  
  }  
}

// \--- Example usage for demonstrating the Re-org logic \---  
// Simulating a detected re-org back to block 90  
// await rollbackState(95);

// processRawLogs(rawChainData);  
