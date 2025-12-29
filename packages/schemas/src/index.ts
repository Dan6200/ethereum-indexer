import { z } from "zod";

// Define the schema for a confirmed transaction to be stored in Postgres
export const TransactionSchema = z.object({
  // Crucial for re-org management
  blockNumber: z.number().int().positive(),
  blockHash: z.string().startsWith("0x").length(66),

  // Financial data fields
  from: z.string().startsWith("0x"),
  to: z.string().startsWith("0x").nullable().optional(), // Nullable for contract creation
  transactionHash: z.string().startsWith("0x").length(66),
  transactionIndex: z.number().int().nonnegative(),

  // Amount must be a non-negative number string to handle large values safely
  amount: z
    .string()
    .refine(
      (s) => !isNaN(Number(s)) && Number(s) >= 0,
      "Amount must be a non-negative number string",
    ),

  // Custom business logic field
  isInternalCall: z.boolean().default(false),
});

export type ValidatedTransaction = z.infer<typeof TransactionSchema>;

// Define the schema for Event Logs
export const LogSchema = z.object({
  blockNumber: z.number().int().positive(),
  blockHash: z.string().startsWith("0x").length(66),
  transactionHash: z.string().startsWith("0x").length(66),
  transactionIndex: z.number().int().nonnegative(),
  logIndex: z.number().int().nonnegative(),

  address: z.string().startsWith("0x"), // Contract Address
  data: z.string().startsWith("0x"), // Non-indexed data

  // Topics: Array of up to 4 hex strings (Topic0 is event signature)
  topics: z.array(z.string().startsWith("0x")).max(4),
});

export type ValidatedLog = z.infer<typeof LogSchema>;

// Combined Block Data (What our ingestor passes around)
export const BlockDataSchema = z.object({
  blockNumber: z.number(),
  blockHash: z.string(),
  parentHash: z.string(),
  transactions: z.array(TransactionSchema),
  logs: z.array(LogSchema),
});

export type BlockData = z.infer<typeof BlockDataSchema>;

// Schema for the Checkpoint table
export const CheckpointSchema = z.object({
  id: z.string(),
  blockNumber: z.number().int().positive(),
  blockHash: z.string().startsWith("0x").length(66),
});

export type Checkpoint = z.infer<typeof CheckpointSchema>;
