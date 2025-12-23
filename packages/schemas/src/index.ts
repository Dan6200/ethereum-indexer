import { z } from 'zod';

// Define the schema for a confirmed transaction to be stored in Postgres
export const TransactionSchema = z.object({
  // Crucial for re-org management
  blockNumber: z.number().int().positive(),
  blockHash: z.string().startsWith('0x').length(66),
  
  // Financial data fields
  from: z.string().startsWith('0x'),
  to: z.string().startsWith('0x').nullable().optional(), // Nullable for contract creation
  transactionHash: z.string().startsWith('0x').length(66),
  transactionIndex: z.number().int().nonnegative(),
  
  // Amount must be a non-negative number string to handle large values safely
  amount: z.string().refine(s => !isNaN(Number(s)) && Number(s) >= 0, "Amount must be a non-negative number string"),
  
  // Custom business logic field
  isInternalCall: z.boolean().default(false),
});

export type ValidatedTransaction = z.infer<typeof TransactionSchema>;

// Schema for the Checkpoint table
export const CheckpointSchema = z.object({
  id: z.string(),
  blockNumber: z.number().int().positive(),
  blockHash: z.string().startsWith('0x').length(66),
});

export type Checkpoint = z.infer<typeof CheckpointSchema>;
