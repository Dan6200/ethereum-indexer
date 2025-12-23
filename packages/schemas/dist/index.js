"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CheckpointSchema = exports.TransactionSchema = void 0;
const zod_1 = require("zod");
// Define the schema for a confirmed transaction to be stored in Postgres
exports.TransactionSchema = zod_1.z.object({
    // Crucial for re-org management
    blockNumber: zod_1.z.number().int().positive(),
    blockHash: zod_1.z.string().startsWith('0x').length(66),
    // Financial data fields
    from: zod_1.z.string().startsWith('0x'),
    to: zod_1.z.string().startsWith('0x').nullable().optional(), // Nullable for contract creation
    transactionHash: zod_1.z.string().startsWith('0x').length(66),
    transactionIndex: zod_1.z.number().int().nonnegative(),
    // Amount must be a non-negative number string to handle large values safely
    amount: zod_1.z.string().refine(s => !isNaN(Number(s)) && Number(s) >= 0, "Amount must be a non-negative number string"),
    // Custom business logic field
    isInternalCall: zod_1.z.boolean().default(false),
});
// Schema for the Checkpoint table
exports.CheckpointSchema = zod_1.z.object({
    id: zod_1.z.string(),
    blockNumber: zod_1.z.number().int().positive(),
    blockHash: zod_1.z.string().startsWith('0x').length(66),
});
