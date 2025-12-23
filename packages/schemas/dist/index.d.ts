import { z } from 'zod';
export declare const TransactionSchema: z.ZodObject<{
    blockNumber: z.ZodNumber;
    blockHash: z.ZodString;
    from: z.ZodString;
    to: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    transactionHash: z.ZodString;
    transactionIndex: z.ZodNumber;
    amount: z.ZodEffects<z.ZodString, string, string>;
    isInternalCall: z.ZodDefault<z.ZodBoolean>;
}, "strip", z.ZodTypeAny, {
    blockNumber: number;
    blockHash: string;
    from: string;
    transactionHash: string;
    transactionIndex: number;
    amount: string;
    isInternalCall: boolean;
    to?: string | null | undefined;
}, {
    blockNumber: number;
    blockHash: string;
    from: string;
    transactionHash: string;
    transactionIndex: number;
    amount: string;
    to?: string | null | undefined;
    isInternalCall?: boolean | undefined;
}>;
export type ValidatedTransaction = z.infer<typeof TransactionSchema>;
export declare const CheckpointSchema: z.ZodObject<{
    id: z.ZodString;
    blockNumber: z.ZodNumber;
    blockHash: z.ZodString;
}, "strip", z.ZodTypeAny, {
    blockNumber: number;
    blockHash: string;
    id: string;
}, {
    blockNumber: number;
    blockHash: string;
    id: string;
}>;
export type Checkpoint = z.infer<typeof CheckpointSchema>;
