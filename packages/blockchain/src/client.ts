import { createPublicClient, http, fallback, PublicClient, Hash } from 'viem';
import { mainnet } from 'viem/chains';
import { ValidatedTransaction } from '@app/schemas';

// Singleton client instance
let clientInstance: PublicClient | null = null;

export function getClient(): PublicClient {
  if (clientInstance) return clientInstance;

  const rpcUrls = (process.env.RPC_URLS || '').split(',').map(url => url.trim()).filter(Boolean);

  if (rpcUrls.length === 0) {
    console.warn('⚠️ No RPC_URLS provided. Defaulting to a public node (not recommended for production).');
    // We add a default for dev convenience, but it will likely rate limit quickly.
    rpcUrls.push('https://cloudflare-eth.com');
  }

  // Use Viem's fallback transport for automatic failover
  const transport = fallback(
    rpcUrls.map(url => http(url)), 
    { rank: true } // Try the first one, then the next if it fails
  );

  clientInstance = createPublicClient({
    chain: mainnet,
    transport,
  });

  return clientInstance;
}

/**
 * Fetches a block and all its transactions, transforming them into our schema format.
 */
export async function fetchBlockData(blockNumber: number): Promise<ValidatedTransaction[]> {
  const client = getClient();

  try {
    const block = await client.getBlock({
      blockNumber: BigInt(blockNumber),
      includeTransactions: true,
    });

    const validatedTxs: ValidatedTransaction[] = [];

    for (const tx of block.transactions) {
      // In viem, if includeTransactions is true, tx is the full object (Transaction)
      // We must check if it's a string (hash) just in case, though types say otherwise with includeTransactions: true
      if (typeof tx === 'string') continue;

      // Transform to our Schema
      // Note: We convert BigInts to Strings for safety/schema compliance
      validatedTxs.push({
        blockNumber: Number(block.number),
        blockHash: block.hash!,
        
        transactionHash: tx.hash,
        transactionIndex: Number(tx.transactionIndex),
        
        from: tx.from,
        to: tx.to || undefined, // Viem uses null, Zod schema allows optional/nullable
        
        amount: tx.value.toString(), // Convert BigInt to string
        
        // Basic heuristic for internal calls/contract interaction
        // In a real indexer, you might trace the transaction or check logs.
        // For now, we'll default false as per the basic requirements.
        isInternalCall: false, 
      });
    }

    return validatedTxs;

  } catch (error) {
    console.error(`Error fetching block ${blockNumber}:`, error);
    throw error;
  }
}
